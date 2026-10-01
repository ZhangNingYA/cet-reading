FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG PUBLIC_API_BASE_URL=
ENV PUBLIC_API_BASE_URL=$PUBLIC_API_BASE_URL
COPY package.json package-lock.json* ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm install
COPY apps/web apps/web
RUN npm run build:web

FROM caddy:2-alpine
COPY --from=build /app/apps/web/dist /srv
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
