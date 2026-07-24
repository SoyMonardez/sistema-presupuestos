FROM node:20-alpine

WORKDIR /app

# Python para: (1) compilar better-sqlite3 nativo y (2) el lector de archivos
# (openpyxl=Excel, pdfplumber=PDF; csv es built-in). Usamos wheels de Alpine
# para las pesadas (pillow) y pip --break-system-packages para pdfplumber.
RUN apk add --no-cache python3 py3-pip py3-openpyxl py3-pillow make g++ \
 && pip install --no-cache-dir --break-system-packages pdfplumber

ENV PYTHON_BIN=python3

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3002

VOLUME /app/data

CMD ["node", "server/index.js"]
