# Multi-stage Dockerfile for LedgerLine
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy sources and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY openapi.yaml ./
RUN npm run build

# Production runtime image
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled assets from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/migrations ./dist/db/migrations
COPY --from=builder /app/src/db/migrations ./src/db/migrations
COPY --from=builder /app/public ./public
COPY --from=builder /app/openapi.yaml ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
