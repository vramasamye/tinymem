# Memory API image — the daemon process (apps/api), used by the `web` compose profile.
#
# Serves the REST surface (/v1) and the Streamable HTTP MCP surface (/mcp) on 7331.
# Build context is the monorepo root (docker/compose.yaml sets `context: ..`), so the
# workspace install resolves every package exactly as it does on the host.
#
# Run it with: docker compose --profile web up memory-api

FROM oven/bun:1.3.14

WORKDIR /app

# Whole-context copy (see .dockerignore, which excludes host node_modules/.onememory/dist).
# `--ignore-scripts` mirrors the host install exactly: Bun blocks the tree-sitter grammar
# packages' `install: node-gyp-build` scripts there too (mission-4d report), and the repo reads
# grammar bytes from the shipped `.wasm` files via `web-tree-sitter` — no native addon is ever
# loaded. Running those scripts in the image would compile a binding the code never uses, and
# fails outright on a slim base image with no gyp toolchain.
#
# Tradeoff: `COPY . .` before install means a source edit invalidates the install layer. For
# iterative work, run the apps on the host (`onemem serve` + `cd apps/web && bun run dev`), which
# apps/web/README.md documents; this profile is for a one-command working stack.
COPY . .

RUN bun install --frozen-lockfile --ignore-scripts

WORKDIR /app/apps/api

# The daemon reads ONEMEMORY_CONFIG and its storage.pg_url from ONEMEMORY_PG_URL;
# compose mounts docker/api-config.yaml at that path. data_dir (/data/data) and the
# daemon lock (/data) both live on the compose `api-data` volume.
ENV ONEMEMORY_CONFIG=/data/onememory.yaml

EXPOSE 7331

# --listen-public is required to bind 0.0.0.0: the daemon refuses a non-loopback bind
# otherwise. Publish on host loopback only (compose maps 127.0.0.1:7331).
CMD ["bun", "run", "src/bin.ts", "--listen-public"]
