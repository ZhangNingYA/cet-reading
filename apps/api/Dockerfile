FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm install
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN npm run build:contracts && npm run build:api
CMD ["npm", "run", "start", "--workspace", "apps/api"]
