/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin API in development, mirroring the Firebase Hosting → Cloud Run
    // rewrite in production. The backend runs on :8080 (QWIKSPOT_API_PROXY overrides it,
    // e.g. for the screenshot run against an isolated backend).
    proxy: {
      '/api': process.env.QWIKSPOT_API_PROXY ?? 'http://localhost:8080',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 15_000,
  },
});
