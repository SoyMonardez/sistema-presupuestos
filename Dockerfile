FROM node:20-alpine

WORKDIR /app

# better-sqlite3 compila nativo: necesita toolchain en alpine
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3002

VOLUME /app/data

CMD ["node", "server/index.js"]
