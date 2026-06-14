# Build context is the FullStackHub/ monorepo root:
#   docker build -f apps/web/Dockerfile -t shipping-hub-web .
FROM node:22-slim
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @shipping-hub/web build

ENV NODE_ENV=production
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["pnpm", "start"]
