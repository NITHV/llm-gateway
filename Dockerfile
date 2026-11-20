# Gateway image. Plain Node, no dependencies, so there is no install step.
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

# Run as the unprivileged "node" user that ships with the image.
USER node

ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/server.js"]
