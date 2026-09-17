# The remote-mode container.
#
# Build context is this directory, and the image is assembled from the package
# as npm would publish it — `server.js` alone is not a server. `server.js`
# statically imports `./core.js` and dynamically imports `arkg.js`, `git.js`,
# `otel.js`, `rsc.js`, `replay.js` and the regression CLI; an image carrying
# only `server.js` throws MODULE_NOT_FOUND on `./core.js` before it binds a
# port, which is a container that starts, fails, and restarts forever.
#
# `core.js` is a build artifact, gitignored and bundled from `src/core/` by the
# repository root's `npm run build:mcp`. It is COPYed rather than built here on
# purpose: building it needs the whole extension repo, its dev dependencies and
# Vite, none of which belong in a 256MB runtime image. The consequence is that
# the build fails loudly if you skipped that step, which is the right failure —
# see the two commands in mcp-server/README.md's "Docker" section.
#
# Debian slim rather than Alpine: `better-sqlite3` (the knowledge graph) ships
# prebuilt binaries for glibc, and on musl npm falls back to compiling it from
# source, which needs a toolchain this image would otherwise not carry.
FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Every file `mcp-server/package.json` lists under "files" — the published
# package's own manifest of what the server needs at runtime.
COPY server.js install.js core.js arkg.js replay.js git.js otel.js rsc.js regression.js regression-cli.js README.md ./

# Flows live outside the code so the image stays disposable and a volume can
# outlive it. DEVFLOW_DIR is what `server.js` reads; `flows/` under it is where
# recordings land.
ENV DEVFLOW_DIR=/data
RUN mkdir -p /data/flows && chown -R node:node /data
VOLUME ["/data"]

ENV MCP_MODE=remote
ENV PORT=8080
# MCP_API_KEY is deliberately not defaulted here. A key baked into a public
# image is not a key; pass it at run time (`-e MCP_API_KEY=…`, or `fly secrets
# set MCP_API_KEY=…`). Without it the server starts and warns on stderr that it
# is unauthenticated.
EXPOSE 8080

USER node

# `/health` is the one route with no key check, so a health probe never needs
# the deployment's secret to say whether the process is up.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server.js"]
