/**
 * Vite config for the memory explorer UI.
 *
 * The daemon (ADR-0010) serves `/v1/*` from `host:port` in `@onememory-ai/config`
 * (`DEFAULT_DAEMON_PORT` = 7331) and has **no CORS middleware** — so both the dev
 * server and `vite preview` proxy `/v1` to the daemon and the client defaults to
 * same-origin relative URLs. Override the target with `ONEMEMORY_API_PROXY_TARGET`
 * (both servers) or set `VITE_ONEMEMORY_API` (client base, absolute URL — requires
 * CORS on the API) for a deployed build.
 */

import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

const proxyTarget = process.env.ONEMEMORY_API_PROXY_TARGET ?? 'http://127.0.0.1:7331';

/** Same rule for the dev server and `vite preview` — a built bundle must not lose `/v1`. */
const proxy: Record<string, string | ProxyOptions> = {
  '/v1': { target: proxyTarget, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  server: {
    // The known dev port (Vite bumps to 5174+ only when 5173 is taken).
    port: 5173,
    proxy,
  },
  preview: {
    // `docker compose --profile web up` serves the built bundle here (see docker/web.Dockerfile).
    port: 4173,
    proxy,
  },
  build: {
    outDir: 'dist',
  },
});
