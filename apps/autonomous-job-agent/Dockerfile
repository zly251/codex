FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3456

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

EXPOSE 3456

CMD ["node", "server.mjs"]
