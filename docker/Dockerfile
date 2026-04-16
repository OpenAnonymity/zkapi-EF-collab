FROM rust:bookworm AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY funding-page ./funding-page
COPY protocol ./protocol

RUN cargo build --release -p zkapi-cli -p zkapi-auth

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 zkapi

WORKDIR /srv/zkapi

COPY --from=builder /app/target/release/zkapi /usr/local/bin/zkapi
COPY --from=builder /app/target/release/zkapi-authd /usr/local/bin/zkapi-authd

USER zkapi

ENV RUST_LOG=info
VOLUME ["/data"]

ENTRYPOINT ["zkapi-authd"]
CMD ["--listen", "0.0.0.0:11434", "--state-dir", "/data/.zkapi", "--protocol-server-url", "http://protocol-server:3000", "--indexer-url", "http://protocol-indexer:3001"]
