# Multi-stage build producing one image for api + worker (choose the command at runtime)
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/widget/package.json apps/widget/
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build -w @agentdesk/widget \
 && npm run build -w @agentdesk/api \
 && VITE_API_URL="" npm run build -w @agentdesk/dashboard

FROM node:22-slim AS runtime
WORKDIR /app/apps/api
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production WIDGET_DIST_DIR=/app/apps/widget/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/prisma ./prisma
COPY --from=build /app/apps/api/package.json ./
COPY --from=build /app/apps/widget/dist /app/apps/widget/dist
COPY --from=build /app/apps/dashboard/dist /app/apps/dashboard/dist
EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
