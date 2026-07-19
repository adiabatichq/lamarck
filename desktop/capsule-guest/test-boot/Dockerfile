FROM debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df

# QEMU is a release-test tool, not a Guest image component. Pin it to the same
# authenticated Debian snapshot as the Buildroot builder so the smoke runner is
# reproducible and cannot drift with a rolling package mirror.
RUN printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260624T000000Z bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260624T000000Z bookworm-security main' \
      > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      qemu-system-arm \
    && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["/usr/bin/qemu-system-aarch64"]
