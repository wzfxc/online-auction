# Generic image for api / worker / web. Build arg APP selects the workspace package.
FROM node:22-alpine
ARG APP
ENV APP=${APP} NODE_ENV=production
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN if [ "$APP" = "web" ]; then pnpm --filter @auction/web build; fi
CMD ["sh", "-c", "pnpm --filter @auction/$APP start"]
