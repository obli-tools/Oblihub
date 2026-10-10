FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json ./
COPY shared/ ./shared/
RUN cd shared && npm install && npm run build

COPY server/package.json ./server/
RUN cd server && npm install

COPY server/tsconfig.json server/knexfile.ts ./server/
COPY server/src/ ./server/src/
RUN cd server && npm run build

FROM node:24-alpine AS production

# Install Docker CLI (compose operations) + openssh-client (DOCKER_HOST=ssh://...) + git.
# - docker CLI shells out to `ssh` when the host scheme is ssh, so openssh-client is mandatory.
# - git is required for the build-pipeline "clone from repo" source type (managed stacks
#   created from a git URL). Installed unconditionally because the binary is ~12 MB.
# - gcompat + libc6-compat provide glibc shim so glibc-linked binaries injected by the
#   nvidia-container-toolkit (e.g. nvidia-smi from the host) can exec on Alpine's musl. Without
#   these, `exec /usr/bin/nvidia-smi: no such file or directory` appears even though the file
#   is present — kernel returns ENOENT when the dynamic linker can't be resolved.
RUN apk add --no-cache docker-cli docker-cli-compose openssh-client git gcompat libc6-compat

WORKDIR /app

COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/shared/dist/ ./shared/dist/

COPY --from=builder /app/server/package.json ./server/
COPY package.json ./
RUN cd server && npm install --omit=dev

COPY --from=builder /app/server/dist/ ./server/dist/

COPY server/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

WORKDIR /app/server
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
