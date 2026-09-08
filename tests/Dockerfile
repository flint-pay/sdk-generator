FROM composer:2.10.3 AS composer
FROM node:22.16.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    php8.2-cli php8.2-curl php8.2-sqlite3 php8.2-zip git unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
WORKDIR /workspace
RUN chown node:node /workspace
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY --chown=node:node src ./src
COPY --chown=node:node templates ./templates
COPY --chown=node:node tests ./tests
COPY --chown=node:node docs ./docs
COPY --chown=node:node examples ./examples
COPY --chown=node:node LICENSE README.md CONTRIBUTING.md SECURITY.md tsconfig.json ./
CMD ["npm", "test"]
