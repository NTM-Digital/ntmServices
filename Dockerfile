# ---- base ----
FROM node:20-bookworm-slim AS base

# ---- deps ----
FROM base AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# ---- builder ----
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner ----
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Non-root user
RUN groupadd -g 1001 nodejs && useradd -r -u 1001 -g nodejs appuser

# Copy built files and dependencies
COPY --from=builder --chown=appuser:nodejs /app/dist ./dist
COPY --from=deps --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --chown=appuser:nodejs package*.json ./
COPY --chown=appuser:nodejs .env* ./

USER appuser

CMD ["npm", "start"]
