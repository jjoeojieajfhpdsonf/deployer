# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN pnpm install --no-frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm -r build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
# pnpm legt die Abhaengigkeiten jedes Pakets als Symlinks in dessen eigenem
# node_modules ab. Ohne dieses Verzeichnis findet shared/dist sein zod nicht.
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/packages/api/package.json ./packages/api/package.json
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/api/migrations ./packages/api/migrations
COPY --from=build /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=build /app/packages/web/dist ./packages/web/dist
ENV WEB_DIST=/app/packages/web/dist

# Laeuft bewusst als root INNERHALB des Containers: der Prozess braucht den
# Caddy-Admin-Socket (von Caddy mit 0200 root angelegt). Ein unprivilegierter
# Benutzer waere hier Theater - der Zugang zur Container-API ueber den
# Socket-Proxy ist ohnehin gleichwertig mit Root auf dem Host.
EXPOSE 3000
CMD ["node", "packages/api/dist/index.js"]
