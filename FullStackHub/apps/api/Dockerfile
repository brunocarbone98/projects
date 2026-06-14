# Build context is the FullStackHub/ monorepo root:
#   docker build -f apps/api/Dockerfile -t shipping-hub-api .
FROM node:22-slim
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# Installs apps/api and its workspace deps; postinstall runs `prisma generate`.
RUN pnpm install --frozen-lockfile --filter "@shipping-hub/api..."

ENV NODE_ENV=production
EXPOSE 4000
WORKDIR /app/apps/api
# Apply migrations on boot, then start the API.
CMD ["sh", "-c", "pnpm prisma migrate deploy && pnpm start"]
