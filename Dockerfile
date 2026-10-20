FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/redditapis/reddit-rss" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
# The server must listen on every interface inside the container for a published port to reach it.
# The container cannot see how that port is published, so the start-up check for FEED_TOKEN is off
# here (ALLOW_PUBLIC=1): publishing on 127.0.0.1 is what keeps it private, and FEED_TOKEN is needed
# as soon as you publish it anywhere else.
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 ALLOW_PUBLIC=1
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "src/index.js"]
