FROM debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df

# Keep the signed-Guest Node 24.10 runtime at /usr/local. The second pinned
# runtime models Electron's Host-side Node for Core/Guard in this all-in-one
# Linux gate; it is never mounted into the runc workload or Guest rootfs.
RUN printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260624T000000Z bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260624T000000Z bookworm-security main' \
      > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      busybox-static ca-certificates curl e2fsprogs erofs-utils iproute2 \
      musl-tools runc util-linux xz-utils \
    && curl --fail --location --proto '=https' --tlsv1.2 \
      https://nodejs.org/dist/v24.10.0/node-v24.10.0-linux-arm64.tar.xz \
      -o /tmp/node.tar.xz \
    && printf '%s  %s\n' \
      07f0558316ebb8977dd6fb29b4de8d369a639d3d8cef544293852a6f5eea6af8 \
      /tmp/node.tar.xz | sha256sum --check --strict \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm -f /tmp/node.tar.xz \
    && mkdir -p /opt/lamarck/host-node \
    && curl --fail --location --proto '=https' --tlsv1.2 \
      https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-arm64.tar.xz \
      -o /tmp/host-node.tar.xz \
    && printf '%s  %s\n' \
      58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6 \
      /tmp/host-node.tar.xz | sha256sum --check --strict \
    && tar -xJf /tmp/host-node.tar.xz \
      -C /opt/lamarck/host-node --strip-components=1 \
    && rm -f /tmp/host-node.tar.xz \
    && rm -rf /var/lib/apt/lists/*

COPY runtime-probe.c /tmp/runtime-probe.c
COPY build-policy-probe.c /tmp/build-policy-probe.c
RUN mkdir -p /usr/local/libexec \
    && musl-gcc -static -O2 -Wall -Wextra -Werror \
      /tmp/runtime-probe.c -o /usr/local/libexec/capsule-runtime-probe \
    && musl-gcc -static -O2 -Wall -Wextra -Werror \
      /tmp/build-policy-probe.c -o /usr/local/libexec/lamarck-build-policy-probe \
    && strip /usr/local/libexec/capsule-runtime-probe \
      /usr/local/libexec/lamarck-build-policy-probe \
    && rm -f /tmp/runtime-probe.c /tmp/build-policy-probe.c

COPY driver-harness.mjs /usr/local/libexec/lamarck-linux-driver-integration.mjs
COPY build-driver-harness.mjs /usr/local/libexec/lamarck-build-driver-integration.mjs
COPY warm-mount-harness.mjs /usr/local/libexec/lamarck-warm-mount-integration.mjs
COPY offline-npm.mjs /usr/local/libexec/lamarck-offline-npm.mjs
COPY core.mjs /usr/local/libexec/lamarck-core-e2e.mjs
COPY guard-service.cjs /usr/local/libexec/lamarck-guard-service-e2e.cjs
COPY run.sh /usr/local/bin/lamarck-linux-integration
COPY run-build.sh /usr/local/bin/lamarck-build-integration
RUN chmod 0755 \
      /usr/local/bin/lamarck-linux-integration \
      /usr/local/bin/lamarck-build-integration \
      /usr/local/libexec/capsule-runtime-probe \
      /usr/local/libexec/lamarck-build-policy-probe \
      /usr/local/libexec/lamarck-offline-npm.mjs \
    && test "$(node --version)" = v24.10.0
RUN test "$(/opt/lamarck/host-node/bin/node --version)" = v24.18.0

ENTRYPOINT ["/usr/local/bin/lamarck-linux-integration"]
