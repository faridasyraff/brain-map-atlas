/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
/** In `npm run dev`, the same page routes as backend/App.py. */
const appRoutes: Plugin = {
  name: 'app-routes',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const [path, query = ''] = (req.url ?? '').split('?');
      const q = query ? `?${query}` : '';
      if (path === '/') req.url = `/home.html${q}`;
      else if (path === '/app') req.url = `/index.html${q}`;
      else if (path === '/next') {
        res.writeHead(302, { Location: `/app${q}` });
        res.end();
        return;
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [appRoutes, react(), tailwindcss()],
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
        main: here('./index.html'),   // the atlas      -> /app
        home: here('./home.html'),    // landing page   -> /
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
