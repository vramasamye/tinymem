# Web UI image — the apps/web memory explorer, used by the `web` compose profile.
#
# Builds the production bundle and serves it with `vite preview` on 4173. The preview
# server proxies /v1 to the daemon (vite.config.ts `preview.proxy`), so the client stays
# same-origin relative and the daemon needs no CORS middleware.
#
# Run it with: docker compose --profile web up web

FROM oven/bun:1.3.14

WORKDIR /app

COPY . .

# Same rule as docker/api.Dockerfile: `--ignore-scripts` matches the host install (Bun blocks
# the tree-sitter grammar packages' native build scripts; the repo uses their `.wasm` files).
RUN bun install --frozen-lockfile --ignore-scripts

WORKDIR /app/apps/web

# Production build to dist/ (vite build; no typecheck — `bun run typecheck` is separate).
RUN bun run build

EXPOSE 4173

# The preview proxy target. Resolves over the compose network; the browser never sees
# this hostname because /v1 stays same-origin (proxied by the preview server).
ENV ONEMEMORY_API_PROXY_TARGET=http://memory-api:7331

CMD ["bun", "run", "preview", "--host", "0.0.0.0", "--port", "4173"]
