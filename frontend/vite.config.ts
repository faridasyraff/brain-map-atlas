/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // `@/components/...` -> src/app/components/... (the React app)
    alias: { '@': here('./src/app') },
  },
  // While testing locally (`npm run dev`), forward API and mesh requests to
  // the Flask backend on port 5000, so the code can always ask for "/api/...".
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
      '/meshes': 'http://localhost:5000',
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: here('./index.html'),   // current atlas   -> /app
        home: here('./home.html'),    // landing page    -> /
        // The React rewrite, built alongside the current app while it's
        // migrated stage by stage -> /next. Replaces index.html at the end.
        next: here('./next.html'),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/app/test/setup.ts'],
    include: ['src/app/**/*.test.{ts,tsx}'],
    css: false,
  },
});
