// Vitest setup for apps/web. Loaded via `setupFiles` in `vitest.config.ts`.
// The suites here are currently pure-logic (no React rendering), so jest-dom
// matchers are unused — but future component tests will rely on
// `toBeInTheDocument()`, `toHaveTextContent()`, etc., so we register the
// matchers here once. (The diff-engine suite this note used to cite,
// `routes/version-history/__tests__/diff.test.ts`, went with that page.)
import '@testing-library/jest-dom/vitest';
