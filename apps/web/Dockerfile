# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --workspace apps/web --workspace packages/contracts --no-audit --no-fund
COPY packages/contracts packages/contracts
COPY apps/web apps/web
ARG PUBLIC_API_BASE_URL=
ENV PUBLIC_API_BASE_URL=$PUBLIC_API_BASE_URL
RUN npm run build:contracts && npm run build:web

FROM caddy:2-alpine
COPY --from=build /app/apps/web/dist /srv
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
