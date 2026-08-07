import { defineConfig } from 'vite';
import { resolve } from 'path';

// While testing locally (`npm run dev`), this automatically forwards any
// request the website makes to '/api/...' or '/meshes/...' over to the
// Python backend running on port 5000. That way the website's code can
// always just ask for "/api/..." without needing to know or care whether
// it's running on your computer or somewhere out on the internet.
export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
      '/meshes': 'http://localhost:5000',
    },
  },
  build: {
    outDir: 'dist',
    // Two separate pages now instead of one: the landing page (home.html,
    // served at "/") and the atlas itself (index.html, served at "/app").
    // Without listing both here, Vite would only build index.html and
    // home.html would be left out of dist/ entirely.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        home: resolve(__dirname, 'home.html'),
      },
    },
  },
});
