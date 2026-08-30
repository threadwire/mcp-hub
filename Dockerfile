# syntax=docker/dockerfile:1
# mcp-hub — Streamable HTTP gateway. Zero runtime deps, nonroot, loopback-safe.
# Build the TypeScript once, throw the toolchain away, run the compiled dist.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production MCP_HUB_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 8801

# /health is auth-protected (401 unauth) — alive is enough
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8801/health').then(r=>process.exit(r.ok||r.status===401?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["start", "--host", "0.0.0.0", "--port", "8801"]