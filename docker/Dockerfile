FROM rust:bookworm AS builder

# Node is a build-time dependency only: the final daemon embeds the exact
# composed OA assets produced by the browser build pipeline.
COPY --from=node:24-bookworm /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-bookworm /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY package.json package-lock.json browser-sources.lock.json ./
RUN node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci
COPY crates ./crates
COPY funding-page ./funding-page
COPY protocol ./protocol
COPY oa-chat ./oa-chat
COPY scripts/compose-browser-client.mjs ./scripts/compose-browser-client.mjs

RUN cargo build --release -p zkapi-cli -p zkapi-clientd -p zkapi-indexerd

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 zkapi

WORKDIR /srv/zkapi

COPY --from=builder /app/target/release/zkapi /usr/local/bin/zkapi
COPY --from=builder /app/target/release/zkapi-clientd /usr/local/bin/zkapi-clientd
COPY --from=builder /app/target/release/zkapi-indexerd /usr/local/bin/zkapi-indexerd

USER zkapi

ENV RUST_LOG=info
VOLUME ["/data"]

ENTRYPOINT ["zkapi-clientd"]
CMD ["--listen", "0.0.0.0:11434", "--state-dir", "/data/.zkapi", "--protocol-server-url", "http://zkapi-serverd:3000", "--indexer-url", "http://zkapi-indexerd:3001"]
