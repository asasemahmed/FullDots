# Runtime pins match the computer Dockerfile at the reviewed OpenBot revision.
FROM node:24.18.1-bookworm-slim AS node-toolchain
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun-toolchain
FROM ubuntu:24.04
ARG PLAYWRIGHT_VERSION=1.62.1
ENV BUN_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=node-toolchain /usr/local /usr/local
COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils \
  && ln -s bun /usr/local/bin/bunx \
  && bunx --bun "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
  && rm -rf /root/.cache /tmp/* /var/lib/apt/lists/*
WORKDIR /app
COPY --from=openbot agent-computer/package.json agent-computer/bun.lock ./
RUN bun install --frozen-lockfile
COPY --from=openbot agent-computer/src ./src
COPY deployment/computers/LICENSE.openbot ./LICENSE.openbot
RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace
ENV PORT=4100
EXPOSE 4100
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"
COPY deployment/computers/acp-bridge /app/acp-bridge
COPY --chown=0:0 --chmod=0444 deployment/computers/acp-bridge/managed-settings.json /etc/claude-code/managed-settings.json
COPY --chown=0:0 --chmod=0444 deployment/computers/acp-bridge/codex-requirements.toml /etc/codex/requirements.toml
RUN node /app/acp-bridge/patch.mjs /app/src/index.ts
CMD ["bun", "src/index.ts"]
