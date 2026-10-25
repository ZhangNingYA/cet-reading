# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json

FROM dependencies AS build
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --workspace apps/api --workspace packages/contracts --no-audit --no-fund
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN npm run build:contracts && npm run build:api

FROM dependencies AS production-dependencies
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --omit=dev --omit=optional --workspace apps/api --workspace packages/contracts --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
# Keep sharp's platform binaries while excluding unrelated optional dev peers.
COPY --from=build /app/node_modules/@img ./node_modules/@img
COPY --from=production-dependencies /app/packages/contracts ./packages/contracts
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=production-dependencies /app/apps/api ./apps/api
CMD ["node", "apps/api/dist/server.js"]
