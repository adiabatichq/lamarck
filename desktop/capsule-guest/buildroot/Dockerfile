FROM debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df

# The immutable Debian snapshot is part of the builder identity. Do not switch
# this back to a rolling bookworm mirror: host tools affect generated images.
RUN printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260624T000000Z bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260624T000000Z bookworm-security main' \
      > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash bc bison build-essential ca-certificates cpio file flex git libncurses-dev \
      openssl patchelf python3 rsync sed unzip wget xz-utils \
    && rm -rf /var/lib/apt/lists/*

# The privileged Guest supervisor is compiled in this builder, never by an
# ambient Host node_modules tree. Node's official arm64 archive is pinned by
# full SHA-256 and includes the pinned npm 11.6.1 CLI.
RUN wget -O /tmp/node-v24.10.0-linux-arm64.tar.xz \
      https://nodejs.org/dist/v24.10.0/node-v24.10.0-linux-arm64.tar.xz \
    && printf '%s  %s\n' \
      '07f0558316ebb8977dd6fb29b4de8d369a639d3d8cef544293852a6f5eea6af8' \
      '/tmp/node-v24.10.0-linux-arm64.tar.xz' | sha256sum -c - \
    && tar -C /usr/local --strip-components=1 \
      -xf /tmp/node-v24.10.0-linux-arm64.tar.xz \
    && rm -f /tmp/node-v24.10.0-linux-arm64.tar.xz \
    && test "$(node --version)" = v24.10.0 \
    && test "$(npm --version)" = 11.6.1

WORKDIR /work
