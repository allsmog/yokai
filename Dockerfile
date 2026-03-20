FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

FROM node:22-slim
WORKDIR /app
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

VOLUME ["/data"]
ENV YOKAI_DB_PATH=/data/yokai.sqlite3

EXPOSE 4873

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["deploy", "--port", "4873", "--host", "0.0.0.0"]
