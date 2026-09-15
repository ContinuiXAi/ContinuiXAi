FROM node:22-bookworm-slim AS base
WORKDIR /app
# Prisma needs OpenSSL at runtime. Use Debian's package manager here instead of Alpine's apk
# to avoid the container-start failure seen in Railway's build environment.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install

FROM deps AS build
ARG BUILD_SHA="unknown"
ENV BUILD_SHA=$BUILD_SHA
COPY . .
RUN npm run build -w packages/shared
# prisma generate does not connect to the DB, but prisma.config.ts requires DATABASE_URL.
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run prisma:generate -w apps/api
RUN npm run build -w apps/api

FROM base AS runner
ENV NODE_ENV=production
ARG BUILD_SHA="unknown"
ENV BUILD_SHA=$BUILD_SHA
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY --from=build /app/apps/api/assets ./apps/api/assets
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
RUN mkdir -p /app/uploads
EXPOSE 8080
# Keep production schema current before accepting traffic. If a migration fails, the
# service stays down instead of serving against an incompatible database schema.
CMD ["sh", "-c", "cd /app/apps/api && npm run prisma:migrate:deploy && node dist/index.js"]
