FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
COPY assets ./assets
COPY seed.json ./seed.json
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node","server.mjs"]
