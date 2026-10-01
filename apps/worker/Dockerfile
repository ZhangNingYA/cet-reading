FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm install
COPY packages/contracts packages/contracts
COPY apps/worker apps/worker
RUN npm run build:contracts && npm run build:worker
CMD ["npm", "run", "start", "--workspace", "apps/worker"]

