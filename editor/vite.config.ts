import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/uploads': 'http://localhost:4000',
    },
  },
  build: {
    outDir: 'dist',
    // Skip the inline modulepreload polyfill so the built index.html carries no
    // inline <script>, letting the CSP keep script-src 'self' (see vercel.json).
    modulePreload: { polyfill: false },
  },
});
