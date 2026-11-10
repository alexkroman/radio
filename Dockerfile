# One image for the site and admin servers (compose picks the entry point),
# plus an `e2e` target with Playwright for the end-to-end suite.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# The two secrets are optional (normal builds have neither): an .npmrc and a CA
# bundle for building behind a TLS-intercepting proxy (see CLAUDE.md).
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc --mount=type=secret,id=ca \
    npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
COPY site site
COPY admin admin
COPY shared shared
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS app
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
USER node
CMD ["node", "dist/site/server.js"]

FROM mcr.microsoft.com/playwright:v1.65.0-noble AS e2e
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json playwright.config.ts tsconfig.json ./
COPY test test
CMD ["npx", "playwright", "test"]
