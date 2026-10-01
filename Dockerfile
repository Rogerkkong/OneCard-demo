# OneCard Lab in a container: docker compose up --build
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY web ./web
# Listen on all interfaces inside the container; docker-compose.yml only publishes the
# ports on this computer (127.0.0.1).
ENV LAB_HOST=0.0.0.0 LAB_HTTP_PORT=8080 LAB_MQTT_PORT=1883
EXPOSE 8080 1883 2323
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
