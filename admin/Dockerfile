FROM node:22-alpine
RUN apk add --no-cache ffmpeg
COPY server.mjs /app/server.mjs
USER node
CMD ["node", "/app/server.mjs"]
