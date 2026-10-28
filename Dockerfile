FROM node:20-alpine

WORKDIR /app

# Python para: (1) compilar better-sqlite3 nativo y (2) el lector de archivos
# (openpyxl=Excel, pdfplumber=PDF; csv es built-in). Usamos wheels de Alpine
# para las pesadas (pillow) y pip --break-system-packages para pdfplumber.
RUN apk add --no-cache python3 py3-pip py3-openpyxl py3-pillow libheif-tools make g++ su-exec \
 && pip install --no-cache-dir --break-system-packages pdfplumber

ENV PYTHON_BIN=python3

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3002

VOLUME /app/data

# La app corre como el usuario "node", no como root: si alguien llegara a
# ejecutar algo adentro (un PDF armado para el lector de Python, por ejemplo),
# no tendría root en el container. Arranca como root solo para dejar la base
# a nombre de "node" —el volumen de antes quedó de root— y enseguida cambia.
CMD ["sh", "-c", "chown -R node:node /app/data && exec su-exec node node server/index.js"]
