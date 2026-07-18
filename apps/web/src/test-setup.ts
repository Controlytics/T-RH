// Vitest setup for apps/web. Loaded via `setupFiles` in `vitest.config.ts`.
// Today the only diff-engine suite (`routes/version-history/__tests__/diff.test.ts`)
// doesn't render React, so jest-dom matchers are unused — but future component
// tests will rely on `toBeInTheDocument()`, `toHaveTextContent()`, etc., so we
// register the matchers here once.
import '@testing-library/jest-dom/vitest';
