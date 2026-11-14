# One image for everything written in this repo: the gateway, the regtest setup helper, the mint auditor.
# Node 24 runs the TypeScript sources directly, so there is no server build step; only the four
# small web front ends are built (Vite) into apps/*/dist.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --no-audit --no-fund --include=dev
COPY . .
RUN npm run build:web
USER node
EXPOSE 8787
CMD ["node", "apps/gateway/src/main.ts"]
