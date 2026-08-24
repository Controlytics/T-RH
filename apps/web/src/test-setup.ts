// Vitest setup for apps/web. Loaded via `setupFiles` in `vitest.config.ts`.
// The suites here are currently pure-logic (no React rendering), so jest-dom
// matchers are unused — but future component tests will rely on
// `toBeInTheDocument()`, `toHaveTextContent()`, etc., so we register the
// matchers here once. (The diff-engine suite this note used to cite,
// `routes/version-history/__tests__/diff.test.ts`, went with that page.)
import '@testing-library/jest-dom/vitest';

// jsdom has no 2D canvas, and its `notImplemented()` raises on the virtual
// console — which vitest surfaces, and which failed or passed depending on
// thread scheduling. Stubbing it here makes the trend report's rasterising path
// deterministic AND actually exercised; without it every chart test took the
// "no canvas" fallback, the one branch a real browser should never take.
// It cannot prove the rendered pixels are a chart. See the module's own note.
import { installCanvasStub } from './test-support/canvas-stub';

installCanvasStub();
