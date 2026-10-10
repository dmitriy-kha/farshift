# syntax=docker/dockerfile:1
FROM rust:1.90-alpine3.22@sha256:b4b54b176a74db7e5c68fdfe6029be39a02ccbcfe72b6e5a3e18e2c61b57ae26 AS build

RUN apk upgrade --no-cache && apk add --no-cache musl-dev
# Use the runtime's updatable libc instead of embedding it in the server.
ENV RUSTFLAGS="-C target-feature=-crt-static"

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY server ./server

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build --locked --release -p farshift-server \
    && mkdir -p /out \
    && cp target/release/farshift-server /out/farshift-server \
    && ldd /out/farshift-server

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY web ./web
RUN npm run build

FROM nginx:stable-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94 AS nginx
RUN apk upgrade --no-cache

FROM ghcr.io/acmesh-official/acme.sh:latest@sha256:34d0c9a75e0f5222b9bab885cbb3c0c01ae4414f4bebbc16bdbc2298140970ef AS acme
RUN apk del yq-go supercronic && apk upgrade --no-cache
RUN chmod 700 /acmebin /acme.sh
CMD ["acme.sh", "--help"]

FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS runtime

RUN apk upgrade --no-cache \
    && apk add --no-cache libgcc \
    && addgroup -g 10001 -S farshift \
    && adduser -u 10001 -S -D -H -G farshift farshift

WORKDIR /app
COPY --from=build /out/farshift-server /usr/local/bin/farshift-server
COPY --from=frontend /out/web /app/web
COPY ui-config.yaml /app/web/ui-config.yaml
COPY LICENSE /app/LICENSE
COPY deploy/compose.yaml deploy/nginx.conf deploy/nginx-http.conf deploy/server-deploy.sh /app/deploy/

ENV FARSHIFT_BIND=0.0.0.0:8080 FARSHIFT_WEB_DIR=/app/web
USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGINT
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -T 2 -O - http://127.0.0.1:8080/health | grep -qx ok
ENTRYPOINT ["/usr/local/bin/farshift-server"]
