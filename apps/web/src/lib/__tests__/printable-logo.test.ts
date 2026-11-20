import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printableLogoDataUrl, LogoNotUsableError, LOGO_MAX_SIDE, LOGO_DATA_URL_MAX } from '../printable-logo';

/**
 * 2026-11-20: the plant's Branding logo was a WebP; reports print PNG / JPEG
 * only, so every report download was refused. The upload now keeps a PNG / JPEG
 * as is and converts anything else to a PNG. jsdom decodes no image and draws
 * no canvas, so both are stubbed — what is asserted is what this module asks of
 * them and what it does with the answer.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const WEBP = 'data:image/webp;base64,UklGRvS2AABXRUJQVlA4WAoAAAAQAAAA';

/** How the stubbed image decodes: its size, or a decode failure. */
let decode: { w: number; h: number } | 'error' = { w: 1280, h: 466 };
/** What the stubbed canvas encodes to (a function so a test can throw). */
let encode: () => string = () => PNG;
const drawImage = vi.fn();
const toDataURL = vi.fn((type: string) => { void type; return encode(); });
let canvas: { width: number; height: number; getContext: () => unknown; toDataURL: typeof toDataURL };
const decoded: string[] = [];

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(v: string) {
    decoded.push(v);
    queueMicrotask(() => {
      if (decode === 'error') { this.onerror?.(); return; }
      this.naturalWidth = decode.w;
      this.naturalHeight = decode.h;
      this.onload?.();
    });
  }
}

const realCreate = document.createElement.bind(document);
beforeEach(() => {
  decode = { w: 1280, h: 466 };
  encode = () => PNG;
  decoded.length = 0;
  drawImage.mockClear();
  toDataURL.mockClear();
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return realCreate(tag);
    canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toDataURL };
    return canvas;
  }) as typeof document.createElement);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('printableLogoDataUrl', () => {
  it('keeps a PNG and a JPEG EXACTLY as chosen — nothing decoded, nothing re-encoded', async () => {
    await expect(printableLogoDataUrl(PNG)).resolves.toBe(PNG);
    await expect(printableLogoDataUrl(JPEG)).resolves.toBe(JPEG);
    // A PNG under a WebP label is a PNG by its bytes — kept too.
    const mislabelled = PNG.replace('image/png', 'image/webp');
    await expect(printableLogoDataUrl(mislabelled)).resolves.toBe(mislabelled);
    expect(decoded).toEqual([]);
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it('converts a WebP to a PNG of the same size (the plant\'s 1280 x 466 logo keeps its size)', async () => {
    await expect(printableLogoDataUrl(WEBP)).resolves.toBe(PNG);
    expect(decoded).toEqual([WEBP]);
    expect(toDataURL).toHaveBeenCalledWith('image/png');
    expect([canvas.width, canvas.height]).toEqual([1280, 466]);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1280, 466);
  });

  it('bounds the LONGEST side of a big image, keeping its shape', async () => {
    decode = { w: 4000, h: 2000 };
    await printableLogoDataUrl(WEBP);
    expect([canvas.width, canvas.height]).toEqual([LOGO_MAX_SIDE, LOGO_MAX_SIDE / 2]);
    decode = { w: 1000, h: 3200 };
    await printableLogoDataUrl(WEBP);
    expect([canvas.width, canvas.height]).toEqual([500, LOGO_MAX_SIDE]);
  });

  it('refuses, saying why, an image with no size (an SVG with no width / height)', async () => {
    decode = { w: 0, h: 0 };
    await expect(printableLogoDataUrl(WEBP)).rejects.toThrow(/no size/);
    await expect(printableLogoDataUrl(WEBP)).rejects.toBeInstanceOf(LogoNotUsableError);
  });

  it('refuses a file the browser cannot decode', async () => {
    decode = 'error';
    await expect(printableLogoDataUrl(WEBP)).rejects.toThrow(/could not be read as an image/);
  });

  it('never stores what a browser that cannot encode answers ("data:,"), nor a canvas that throws', async () => {
    encode = () => 'data:,';
    await expect(printableLogoDataUrl(WEBP)).rejects.toThrow(/could not convert/);
    encode = () => { throw new DOMException('tainted', 'SecurityError'); };
    await expect(printableLogoDataUrl(WEBP)).rejects.toThrow(/could not convert/);
  });

  it('refuses a PNG longer than the server stores', async () => {
    // A PNG by its bytes (the magic, then valid base64), one past the cap.
    encode = () => 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(LOGO_DATA_URL_MAX);
    await expect(printableLogoDataUrl(WEBP)).rejects.toThrow(/too large/);
  });
});
