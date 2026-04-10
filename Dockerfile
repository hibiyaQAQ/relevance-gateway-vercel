FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /build-frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY --from=frontend-builder /static/admin ./static/admin

RUN mkdir -p /app/data

EXPOSE 8080
CMD ["node", "src/server.js"]
