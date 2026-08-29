FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
RUN mkdir -p flows
ENV MCP_MODE=remote
EXPOSE 8080
CMD ["node", "server.js"]
