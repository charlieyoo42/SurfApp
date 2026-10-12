FROM node:22-slim
WORKDIR /app

# Build tools in case better-sqlite3 has no prebuilt binary for this CPU
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV DB_PATH=/data/surf_data.db
VOLUME /data
CMD ["node", "src/SurfScraper.js"]
