/**
 * Vite config for the memory explorer UI.
 *
 * The daemon (ADR-0010) serves `/v1/*` from `host:port` in `@onememory/config`
 * (`DEFAULT_DAEMON_PORT` = 7331) and has **no CORS middleware** — so the dev server
 * proxies `/v1` to the daemon and the client defaults to same-origin relative URLs.
 * Override with `ONEMEMORY_API_PROXY_TARGET` (proxy) for the dev server or
 * `VITE_ONEMEMORY_API` (client base, absolute URL — requires CORS on the API) for
 * a deployed build.
 */

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const proxyTarget = process.env.ONEMEMORY_API_PROXY_TARGET ?? 'http://127.0.0.1:7331';

export default defineConfig({
  plugins: [react()],
  server: {
    // The known dev port (Vite bumps to 5174+ only when 5173 is taken).
    port: 5173,
    proxy: {
      '/v1': { target: proxyTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
  },
});
