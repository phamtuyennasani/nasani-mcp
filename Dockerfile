FROM node:22-bookworm-slim
ENV NODE_ENV=production NASANI_HOST=0.0.0.0 PORT=8787 TMPDIR=/tmp
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node bin ./bin
COPY --chown=node:node lib ./lib
COPY --chown=node:node skills ./skills
USER node
EXPOSE 8787
CMD ["node", "bin/nasani.cjs", "serve"]
