/**
 * A minimal canvas + image-decode surface for jsdom.
 *
 * WHY THIS EXISTS. jsdom implements no 2D canvas: `getContext` calls jsdom's
 * `notImplemented()`, which raises an error on the virtual console. Vitest
 * surfaces those, and whether one fails the run depends on when it lands
 * relative to the test that caused it — so the instrument suites passed on one
 * machine and failed on another with
 * `Not implemented: HTMLCanvasElement.prototype.getContext`. A test result that
 * depends on thread scheduling is not a test result.
 *
 * Installing a stub means `chart-image.ts` never reaches the unimplemented API,
 * so nothing is raised anywhere, and — the point — the rasterising path is
 * actually EXERCISED rather than short-circuited at its first guard. Before
 * this, every chart test in CI took the "no canvas" fallback, which is the one
 * branch a real browser should never take.
 *
 * WHAT IT CANNOT PROVE. `toDataURL` returns a canned 1×1 PNG. So a passing test
 * shows that the pipeline ran and that jsPDF was handed an image — it says
 * NOTHING about whether the pixels are a chart, are legible, or are the right
 * shape. No test in this repo has seen the rendered image. That needs a real
 * browser and a human.
 *
 * `chart-image.ts` is the only canvas consumer in `apps/web` (grep: `getContext`
 * / `toDataURL`), so installing this globally cannot affect anything else.
 */

/** A real, decodable 1×1 transparent PNG. */
export const STUB_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type Saved = {
  getContext?: PropertyDescriptor;
  toDataURL?: PropertyDescriptor;
  imageSrc?: PropertyDescriptor;
};

let saved: Saved | null = null;

/** A 2D context that accepts the calls `chart-image.ts` makes and records nothing. */
function stubContext(): CanvasRenderingContext2D {
  return {
    fillStyle: '',
    fillRect: () => {},
    drawImage: () => {},
  } as unknown as CanvasRenderingContext2D;
}

export function installCanvasStub(): void {
  if (saved) return;
  const proto = HTMLCanvasElement.prototype as any;
  saved = {
    getContext: Object.getOwnPropertyDescriptor(proto, 'getContext'),
    toDataURL: Object.getOwnPropertyDescriptor(proto, 'toDataURL'),
    imageSrc: Object.getOwnPropertyDescriptor(globalThis.Image.prototype, 'src'),
  };

  proto.getContext = function (kind: string) {
    return kind === '2d' ? stubContext() : null;
  };
  proto.toDataURL = function () { return STUB_PNG; };

  // jsdom fetches nothing and decodes nothing, so an `Image` given a data: URL
  // fires NEITHER `load` NOR `error` — it just sits there. `loadImage`'s own
  // timeout would eventually rescue that, but only after eight seconds per
  // call, which is why these suites once timed out rather than failed.
  let last = '';
  Object.defineProperty(globalThis.Image.prototype, 'src', {
    configurable: true,
    set(this: HTMLImageElement, value: string) {
      last = value;
      setTimeout(() => (this as any).onload?.(), 0);
    },
    get() { return last; },
  });
}

/** Put jsdom's real (unimplemented) canvas back. Only for tearing the stub down. */
export function uninstallCanvasStub(): void {
  if (!saved) return;
  const proto = HTMLCanvasElement.prototype as any;
  if (saved.getContext) Object.defineProperty(proto, 'getContext', saved.getContext);
  else delete proto.getContext;
  if (saved.toDataURL) Object.defineProperty(proto, 'toDataURL', saved.toDataURL);
  else delete proto.toDataURL;
  if (saved.imageSrc) Object.defineProperty(globalThis.Image.prototype, 'src', saved.imageSrc);
  saved = null;
}

/**
 * Run `fn` against a canvas that REFUSES a 2D context, for the tests that prove
 * the fallback: a report with a stated reason instead of a chart.
 *
 * `getContext` returns `null` rather than being handed back to jsdom's real
 * unimplemented version. That is deliberate on two counts. It is what the DOM
 * specifies for an unsupported context type and what a browser blocking canvas
 * actually does, so it is the honest simulation of the production failure this
 * asserts against. And jsdom's version RAISES on the virtual console, which is
 * the very thing that made these suites pass or fail by thread scheduling —
 * reintroducing it for the fallback tests would reintroduce the flake they are
 * meant to be free of. The point is to test our guard, not jsdom's stub.
 */
export async function withoutCanvas<T>(fn: () => Promise<T>): Promise<T> {
  const proto = HTMLCanvasElement.prototype as any;
  const previous = Object.getOwnPropertyDescriptor(proto, 'getContext')!;
  proto.getContext = () => null;
  try {
    return await fn();
  } finally {
    Object.defineProperty(proto, 'getContext', previous);
  }
}
