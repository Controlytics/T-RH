import { imageFormatByBytes, BRANDING_LOGO_URL_MAX } from '@digilog/shared';

/**
 * The Branding logo as an image a REPORT can print (2026-11-20).
 *
 * Reports draw the Branding logo with jsPDF, which prints PNG and JPEG only;
 * anything else refuses the download (ruling F-5, `pdf-report.ts`). The upload
 * used to store whatever image was chosen — the plant's logo went in as a WebP
 * and every report download was refused. So the upload now keeps a PNG or a
 * JPEG exactly as chosen (by its BYTES, the same shared rule the report uses)
 * and converts anything else the browser can show — WebP, GIF, SVG, BMP,
 * AVIF — to a PNG of the same picture: PNG, not JPEG, because a logo is
 * usually transparent and JPEG would put it on black.
 *
 * Only the longest side is bounded (`LOGO_MAX_SIDE`): the logo's bytes are
 * frozen into every report snapshot, and a 4000 px photograph would carry
 * megabytes into each one. A logo at or under the bound keeps its size.
 */
export const LOGO_MAX_SIDE = 1600;

/** `brandingConfigSchema.logoUrl`'s cap (the shared constant) — a longer logo is refused by the server. */
export const LOGO_DATA_URL_MAX = BRANDING_LOGO_URL_MAX;

export class LogoNotUsableError extends Error {}

/** A PNG / JPEG data URL as is; any other image decoded by the browser and re-encoded as PNG. */
export async function printableLogoDataUrl(dataUrl: string): Promise<string> {
  if (imageFormatByBytes(dataUrl) !== null) return dataUrl;

  const img = await decodeImage(dataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) {
    // An SVG with no width / height has no size to draw at.
    throw new LogoNotUsableError('This image has no size the app can read. Save it as a PNG or JPEG and upload that.');
  }
  const scale = Math.min(1, LOGO_MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new LogoNotUsableError('This browser could not convert the image. Save it as a PNG or JPEG and upload that.');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  let png: string;
  try {
    png = canvas.toDataURL('image/png');
  } catch (e) {
    throw new LogoNotUsableError('This browser could not convert the image. Save it as a PNG or JPEG and upload that.', { cause: e });
  }
  // A browser that cannot encode answers "data:," — never store that as the logo.
  if (imageFormatByBytes(png) !== 'PNG') {
    throw new LogoNotUsableError('This browser could not convert the image. Save it as a PNG or JPEG and upload that.');
  }
  if (png.length > LOGO_DATA_URL_MAX) {
    throw new LogoNotUsableError('The logo is too large once converted to PNG. Use a smaller image, or save it as a JPEG and upload that.');
  }
  return png;
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new LogoNotUsableError('This file could not be read as an image. Choose a PNG, JPEG, WebP, GIF or SVG file.'));
    img.src = src;
  });
}
