# syntax=docker/dockerfile:1

# ---- build ---------------------------------------------------------------
# Dev dependencies live here and nowhere else: TypeScript compiles the API to
# dist/ and the browser client to public/assets/, and neither the compiler nor
# the test suite has any business in the image that runs in production.
FROM node:22-slim AS build

WORKDIR /app

# bcrypt ships prebuilt binaries for common platforms but falls back to
# compiling, which needs a toolchain. Installed here and left behind.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copied before the source so a change to application code does not reinstall
# every dependency.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.web.json ./
COPY src ./src
COPY web ./web
COPY public ./public

RUN npm run build

# Drops the dev dependencies from the tree that gets copied forward.
RUN npm prune --omit=dev


# ---- run -----------------------------------------------------------------
FROM node:22-slim AS run

WORKDIR /app

# tini reaps zombies and forwards signals, so SIGTERM reaches the application
# and a deploy cannot cut a billing run in half.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Where the local storage driver writes signatures, photos and PDFs. A named
# volume is mounted here; without one, every deploy loses them.
ENV STORAGE_LOCAL_DIR=/data/storage

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json ./

# node, not root. The volume is chowned by the compose file's init.
RUN mkdir -p /data/storage && chown -R node:node /data
USER node

EXPOSE 3000

# No shell in front of it, so signals are not swallowed by one.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
