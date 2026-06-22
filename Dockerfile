# Stage 1: build the React client
FROM node:20-alpine AS client-build
WORKDIR /build
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: production server
FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
# Client build lands in /app/public — Express serves it as static files
COPY --from=client-build /build/dist ./public
EXPOSE 3001
CMD ["node", "server.js"]
