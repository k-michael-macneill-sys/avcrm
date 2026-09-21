import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The client lives under /app — the API owns the root paths, see
 * src/app.ts — so every asset URL this build emits needs that prefix.
 *
 * Output goes to client/dist, a directory of its own rather than into
 * public/, because public/ also holds card-complete.html: a standalone page
 * outside the SPA that a full build must not overwrite or delete.
 * src/app.ts serves client/dist for everything under /app.
 */
export default defineConfig({
  root: __dirname,
  base: '/app/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Every top-level resource the API owns (see src/routes/index.ts),
      // proxied to the API server in dev so a relative fetch('/customers')
      // from the client reaches it without a CORS dance.
      '^/(auth|uploads|files|branches|users|operators|document-requirements|customers|properties|pricing-guide|quotes|checklist-requirements|contracts|work-orders|message-templates|message-log|review-requests|card-setups|invoices|payments|reports|settings|audit-log|webhooks|health|ready|card-complete)(/|$)':
        {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
});
