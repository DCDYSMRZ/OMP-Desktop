// Build entry layout adapted from PI-Desktop-main (vastsa), LGPL-3.0.
// OMP-Desktop removes the PI runtime/host/plugin entries and adds a local-only CSP.
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const developmentCsp: Plugin = {
  name: 'omp-development-csp',
  apply: 'serve',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      // Vite's React refresh preamble is inline; authorize this response, not all inline JS.
      const nonce = randomBytes(18).toString('base64');
      return html
        .replace("connect-src 'none'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:*")
        .replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`)
        .replace(/<script\b/g, `<script nonce="${nonce}"`);
    },
  },
};
export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve(root, 'src/main/index.ts') } },
  },
  preload: {
    build: { rollupOptions: {
      input: resolve(root, 'src/preload/index.ts'),
      output: { format: 'cjs', entryFileNames: '[name].cjs' },
    } },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [react(), tailwindcss(), developmentCsp],
    worker: { format: 'es' },
    build: { minify: 'esbuild', rollupOptions: { input: resolve(root, 'src/renderer/index.html') } },
  },
});
