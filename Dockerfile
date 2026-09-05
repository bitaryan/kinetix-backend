FROM node:22-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY prisma ./prisma
RUN DATABASE_URL=postgresql://unused:unused@localhost:5432/unused \
    ./node_modules/.bin/prisma generate

# Run once during a release, separately from API replicas. The migration image
# retains the CLI; the serving image below contains production dependencies only.
FROM build AS migrate

COPY scripts ./scripts
COPY src ./src
USER node
CMD ["node", "scripts/prisma-cli.js", "migrate", "deploy"]

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM base AS runtime

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY prisma ./prisma
COPY src ./src

RUN mkdir -p /app/uploads && chown -R node:node /app
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
