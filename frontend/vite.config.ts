import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 4300,
    host: '0.0.0.0',
    proxy: {
      // Forward API calls to the Go backend in dev. Override the target via
      // the VITE_KNAIC_API_TARGET env var (e.g. when the backend runs in a
      // sibling container) — defaults to localhost:8080.
      '/api': {
        target: process.env.VITE_KNAIC_API_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
