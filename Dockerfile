# syntax=docker/dockerfile:1.7

# 1. Web app: the same files on every architecture, so it is built once, on the build machine.
FROM --platform=$BUILDPLATFORM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS web
WORKDIR /src/web
# pnpm-workspace.yaml holds the install settings (build-script allowlist, trust policy, overrides):
# without it, the install would not be the one the lockfile was made with.
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
# The exact pnpm of `packageManager`, installed with npm: Corepack is gone from Node 25 on.
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY web/ ./
# The build appends the notices of the server's Rust crates to the web app's own.
COPY crates/binsight/third-party-licenses.txt /src/crates/binsight/third-party-licenses.txt
RUN pnpm build

# 2. Rust dependencies, built once per lockfile change thanks to cargo-chef.
FROM lukemathwalker/cargo-chef:0.1.78-rust-1.99.0-slim-trixie@sha256:bcda2cef02bedabfaf433379d82fecd02c0a428fb66fe28ab2d65c25c3db3b5e AS chef
WORKDIR /src

FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY crates crates
COPY xtask xtask
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /src/recipe.json recipe.json
RUN cargo chef cook --release --locked --recipe-path recipe.json -p binsight
COPY Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY crates crates
COPY xtask xtask
# The binary embeds web/dist at compile time.
COPY --from=web /src/web/dist web/dist
RUN cargo build --release --locked -p binsight \
 && cp target/release/binsight /binsight \
 && mkdir /data-skeleton

# 3. Runtime: no shell, no package manager, not root.
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2
# GHCR links the package to the repository through the source label.
LABEL org.opencontainers.image.source="https://github.com/RedBoardDev/binsight" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="Self-hostable tracker for Meteora DLMM liquidity positions, with exact on-chain PnL."
COPY --from=builder /binsight /usr/local/bin/binsight
COPY --from=builder --chown=65532:65532 /data-skeleton /data
ENV BINSIGHT_DATA_DIR=/data \
    BINSIGHT_BIND=0.0.0.0:8080
VOLUME ["/data"]
EXPOSE 8080
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/usr/local/bin/binsight", "healthcheck"]
# binsight is PID 1 and handles SIGTERM itself, so `docker stop` shuts it down gracefully.
ENTRYPOINT ["/usr/local/bin/binsight"]
CMD ["run"]
