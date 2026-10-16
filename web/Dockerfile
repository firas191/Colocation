# Website and BFF (platform P1). Build context: web/. Versions in docs/VERSIONS.md.
FROM node:24.21.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24.21.0-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/scripts/start.sh ./start.sh
COPY --from=build --chown=node:node /app/scripts/run-as-node.cjs ./run-as-node.cjs
# No USER line: start.sh runs as root to read the root-only secrets file, then run-as-node.cjs switches to node
# before the server starts (F-071).
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=12 CMD node -e "fetch('http://127.0.0.1:3000/fr').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "./start.sh"]
