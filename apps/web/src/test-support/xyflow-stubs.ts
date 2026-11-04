/**
 * jsdom stand-ins for what `@xyflow/react` measures (rule chains editor, 2026-11-04).
 *
 * jsdom lays nothing out, and React Flow reads the layout four ways. Each stub
 * below answers one of them; without them the flow logs "The React Flow parent
 * container needs a width and a height", never measures a node, and a node it
 * never measured stays `visibility: hidden` with no handle bounds.
 *
 * - `ResizeObserver` — jsdom has none. Calling back at `observe` is what makes
 *   React Flow measure a node it has just mounted (React Flow's own testing
 *   recipe).
 * - `DOMMatrixReadOnly` — the viewport reads the zoom (`m22`) off the pane's
 *   CSS transform.
 * - `offsetWidth` / `offsetHeight` / `getBoundingClientRect` — every element
 *   answers its inline `style` width / height, else 1 px, so the flow container
 *   and each node have a size.
 * - `document.elementFromPoint` — click-to-connect asks which handle is under
 *   the pointer; jsdom does not implement it. `null` makes React Flow fall back
 *   to the handle that was clicked, which is the one under the pointer anyway.
 *
 * Imported by the rule-chains tests only, never by `test-setup.ts`: the size
 * stubs would change what every other page's test measures. Returns an undo.
 */
type Restore = () => void;

export function installXyflowStubs(): Restore {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    ResizeObserver: g.ResizeObserver,
    DOMMatrixReadOnly: g.DOMMatrixReadOnly,
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
    getBoundingClientRect: HTMLElement.prototype.getBoundingClientRect,
    getBBox: (SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox,
    elementFromPoint: (document as unknown as { elementFromPoint?: unknown }).elementFromPoint,
  };

  class ResizeObserverStub {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe(target: Element) {
      // React Flow 12.12 reads `contentRect` (the pane's zoom extent) as well as the target.
      const contentRect = target.getBoundingClientRect();
      const size = [{ inlineSize: contentRect.width, blockSize: contentRect.height }];
      const entry = { target, contentRect, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size };
      this.callback([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() { /* nothing is observed */ }
    disconnect() { /* nothing is observed */ }
  }

  class DOMMatrixReadOnlyStub {
    m22: number;
    constructor(transform?: string) {
      const scale = typeof transform === 'string' ? transform.match(/scale\(([0-9.]+)\)/)?.[1] : undefined;
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  }

  g.ResizeObserver = ResizeObserverStub;
  g.DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get() { return parseFloat((this as HTMLElement).style.width) || 1; } },
    offsetHeight: { configurable: true, get() { return parseFloat((this as HTMLElement).style.height) || 1; } },
  });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
    const width = this.offsetWidth;
    const height = this.offsetHeight;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
  };
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null;

  return () => {
    g.ResizeObserver = saved.ResizeObserver;
    g.DOMMatrixReadOnly = saved.DOMMatrixReadOnly;
    if (saved.offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', saved.offsetWidth);
    if (saved.offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', saved.offsetHeight);
    HTMLElement.prototype.getBoundingClientRect = saved.getBoundingClientRect;
    (SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox = saved.getBBox;
    (document as unknown as { elementFromPoint?: unknown }).elementFromPoint = saved.elementFromPoint;
  };
}
