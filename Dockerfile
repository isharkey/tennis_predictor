FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY index.html styles.css app.js server.mjs service-worker.js manifest.webmanifest ./
COPY matches_preload.json odds_preload.json ./
COPY icons ./icons

EXPOSE 5177

CMD ["node", "server.mjs"]
