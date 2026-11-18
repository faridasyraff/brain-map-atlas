// Adds DOM matchers like toBeInTheDocument() / toHaveAttribute().
// (Testing Library unmounts rendered components after each test by itself,
// because `globals: true` in vite.config.ts exposes afterEach.)
import '@testing-library/jest-dom/vitest';
