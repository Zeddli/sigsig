import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// The taste-skill kit lives in public/assets (served as plain files at /assets/...), so the app's own
// bundles go to /app/ to keep the two apart.
// Two HTML entries: index.html (the landing, prerendered by scripts/prerender.mjs so it reads without
// script) and app.html (the SPA shell every other route falls back to, see public/_redirects).
export default defineConfig({
  plugins: [react()],
  build: {
    assetsDir: 'app',
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
      },
    },
  },
  ssr: {
    noExternal: ['react-router-dom', 'react-router', '@tanstack/react-query'],
  },
});
