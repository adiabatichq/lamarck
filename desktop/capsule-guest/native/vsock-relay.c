#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#ifndef LAMARCK_TEST_HOST_CONTROL_SOCKET
#include <linux/vm_sockets.h>
#include <sys/prctl.h>
#endif

#define CONTROL_PORT 40001U
#define DATA_PORT 40002U
#ifndef LAMARCK_GUEST_CONTROL_SOCKET
#define LAMARCK_GUEST_CONTROL_SOCKET "/run/lamarck/supervisor-control.sock"
#endif
#ifndef LAMARCK_GUEST_DATA_SOCKET
#define LAMARCK_GUEST_DATA_SOCKET "/run/lamarck/supervisor-data.sock"
#endif
#define CONNECT_ATTEMPTS 200
#define CONNECT_RETRY_USEC 50000
#define RELAY_MAGIC_0 ((unsigned char)'L')
#define RELAY_MAGIC_1 ((unsigned char)'V')
#define RELAY_MAGIC_2 ((unsigned char)'R')
#define RELAY_MAGIC_3 ((unsigned char)'M')
#define RELAY_VERSION 2U
#define RELAY_KIND_DATA 1U
#define RELAY_KIND_FIN 2U
#define RELAY_KIND_RESET 3U
#define RELAY_KIND_CLOSE 4U
#define RELAY_HEADER_BYTES 12U
#define RELAY_DATA_BYTES 65536U
#define RELAY_FRAME_BYTES (RELAY_HEADER_BYTES + RELAY_DATA_BYTES)
#define RESET_FLUSH_TIMEOUT_MS 1000

/*
 * One bounded record is admitted in each direction. The same storage is used
 * first to assemble the record and then to forward its exact bytes.
 */
struct relay_direction {
  unsigned char bytes[RELAY_FRAME_BYTES];
  size_t read_bytes;
  size_t frame_bytes;
  size_t write_offset;
  uint16_t kind;
  bool header_parsed;
  bool ready;
  bool fin_forwarded;
  bool close_forwarded;
  bool reset_after_current;
  bool close_transport_after_current;
};

static void put_u16be(unsigned char *target, uint16_t value) {
  target[0] = (unsigned char)(value >> 8);
  target[1] = (unsigned char)value;
}

static void put_u32be(unsigned char *target, uint32_t value) {
  target[0] = (unsigned char)(value >> 24);
  target[1] = (unsigned char)(value >> 16);
  target[2] = (unsigned char)(value >> 8);
  target[3] = (unsigned char)value;
}

static uint16_t get_u16be(const unsigned char *source) {
  return (uint16_t)(((uint16_t)source[0] << 8) | (uint16_t)source[1]);
}

static uint32_t get_u32be(const unsigned char *source) {
  return ((uint32_t)source[0] << 24)
    | ((uint32_t)source[1] << 16)
    | ((uint32_t)source[2] << 8)
    | (uint32_t)source[3];
}

static bool record_pending(const struct relay_direction *direction) {
  return direction->ready && direction->write_offset < direction->frame_bytes;
}

static bool record_in_progress(const struct relay_direction *direction) {
  return direction->read_bytes > 0 || direction->ready;
}

static void clear_record(struct relay_direction *direction) {
  direction->read_bytes = 0;
  direction->frame_bytes = 0;
  direction->write_offset = 0;
  direction->kind = 0;
  direction->header_parsed = false;
  direction->ready = false;
  direction->reset_after_current = false;
  direction->close_transport_after_current = false;
}

static int queue_generated_record(
  struct relay_direction *direction,
  uint16_t kind,
  const unsigned char *payload,
  size_t payload_length
) {
  if (record_in_progress(direction)) {
    errno = EBUSY;
    return -1;
  }
  if (
    (kind == RELAY_KIND_DATA && (payload_length < 1 || payload_length > RELAY_DATA_BYTES))
    || ((kind == RELAY_KIND_FIN
      || kind == RELAY_KIND_RESET
      || kind == RELAY_KIND_CLOSE) && payload_length != 0)
    || (kind != RELAY_KIND_DATA
      && kind != RELAY_KIND_FIN
      && kind != RELAY_KIND_RESET
      && kind != RELAY_KIND_CLOSE)
  ) {
    errno = EINVAL;
    return -1;
  }
  direction->bytes[0] = RELAY_MAGIC_0;
  direction->bytes[1] = RELAY_MAGIC_1;
  direction->bytes[2] = RELAY_MAGIC_2;
  direction->bytes[3] = RELAY_MAGIC_3;
  put_u16be(direction->bytes + 4, RELAY_VERSION);
  put_u16be(direction->bytes + 6, kind);
  put_u32be(direction->bytes + 8, (uint32_t)payload_length);
  if (payload_length > 0) {
    memcpy(direction->bytes + RELAY_HEADER_BYTES, payload, payload_length);
  }
  direction->read_bytes = RELAY_HEADER_BYTES + payload_length;
  direction->frame_bytes = direction->read_bytes;
  direction->write_offset = 0;
  direction->kind = kind;
  direction->header_parsed = true;
  direction->ready = true;
  return 0;
}

static int set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);
  if (flags < 0) return -1;
  if ((flags & O_NONBLOCK) != 0) return 0;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int64_t monotonic_milliseconds(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return -1;
  return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static void report_failure(const char *message) {
  fprintf(stderr, "relay failure: %s\n", message);
}

static int queue_terminal_reset(
  struct relay_direction *direction,
  const char *message,
  int64_t *deadline
) {
  report_failure(message);
  int64_t now = monotonic_milliseconds();
  *deadline = now < 0 ? 0 : now + RESET_FLUSH_TIMEOUT_MS;
  /*
   * CLOSE is irrevocable. Once one has been queued, no later failure may turn
   * that direction back into RESET. A CLOSE which physically began gets one
   * bounded chance to finish; otherwise closing the transport is the only
   * valid failure signal left.
   */
  if (direction->close_forwarded) return 1;
  if (record_pending(direction) && direction->kind == RELAY_KIND_CLOSE) {
    if (direction->write_offset > 0) {
      direction->close_transport_after_current = true;
      return 0;
    }
    return 1;
  }
  if (record_pending(direction) && direction->write_offset > 0) {
    /*
     * A record which has physically begun cannot be truncated and followed by
     * RESET without corrupting the byte stream. Finish that one record, purge
     * anything else, then send RESET as the next complete record.
     */
    direction->reset_after_current = true;
    return 0;
  }
  clear_record(direction);
  if (queue_generated_record(direction, RELAY_KIND_RESET, NULL, 0) != 0) return -1;
  return 0;
}

static void begin_explicit_reset(
  struct relay_direction *direction,
  const char *message,
  int64_t *deadline
) {
  report_failure(message);
  int64_t now = monotonic_milliseconds();
  *deadline = now < 0 ? 0 : now + RESET_FLUSH_TIMEOUT_MS;
  direction->reset_after_current = false;
}

static int remaining_reset_timeout(int64_t deadline) {
  int64_t now = monotonic_milliseconds();
  if (deadline == 0 || now < 0 || now >= deadline) return 0;
  int64_t remaining = deadline - now;
  return remaining > INT32_MAX ? INT32_MAX : (int)remaining;
}

static int validate_header(
  struct relay_direction *direction,
  const struct relay_direction *opposite
) {
  const unsigned char *header = direction->bytes;
  if (
    header[0] != RELAY_MAGIC_0
    || header[1] != RELAY_MAGIC_1
    || header[2] != RELAY_MAGIC_2
    || header[3] != RELAY_MAGIC_3
  ) {
    errno = EPROTO;
    return -1;
  }
  if (get_u16be(header + 4) != RELAY_VERSION) {
    errno = EPROTO;
    return -1;
  }
  direction->kind = get_u16be(header + 6);
  uint32_t payload_length = get_u32be(header + 8);
  if (
    (direction->kind == RELAY_KIND_DATA
      && (payload_length < 1 || payload_length > RELAY_DATA_BYTES))
    || ((direction->kind == RELAY_KIND_FIN
      || direction->kind == RELAY_KIND_RESET
      || direction->kind == RELAY_KIND_CLOSE) && payload_length != 0)
    || (direction->kind != RELAY_KIND_DATA
      && direction->kind != RELAY_KIND_FIN
      && direction->kind != RELAY_KIND_RESET
      && direction->kind != RELAY_KIND_CLOSE)
    || (direction->kind == RELAY_KIND_DATA
      && (direction->fin_forwarded || direction->close_forwarded))
    || (direction->kind == RELAY_KIND_FIN
      && (direction->fin_forwarded || direction->close_forwarded))
    || direction->close_forwarded
    || (direction->kind == RELAY_KIND_CLOSE
      && (direction->close_forwarded
        || !direction->fin_forwarded
        || !opposite->fin_forwarded))
  ) {
    errno = EPROTO;
    return -1;
  }
  direction->header_parsed = true;
  direction->frame_bytes = RELAY_HEADER_BYTES + (size_t)payload_length;
  if (payload_length == 0) direction->ready = true;
  return 0;
}

/*
 * Reads at most one framed record. Reading exactly the current header or
 * payload remainder prevents the relay from buffering a second frame.
 *
 * Returns 1 when a record becomes ready, 0 when more bytes are needed, -1 for
 * I/O/protocol failure, and -2 for physical EOF before explicit CLOSE.
 */
static int read_record(
  int source,
  struct relay_direction *direction,
  const struct relay_direction *opposite
) {
  for (;;) {
    size_t remaining;
    if (direction->read_bytes < RELAY_HEADER_BYTES) {
      remaining = RELAY_HEADER_BYTES - direction->read_bytes;
    } else {
      if (!direction->header_parsed
        && validate_header(direction, opposite) != 0) return -1;
      if (direction->ready) return 1;
      remaining = direction->frame_bytes - direction->read_bytes;
    }

    ssize_t bytes = read(
      source,
      direction->bytes + direction->read_bytes,
      remaining
    );
    if (bytes > 0) {
      direction->read_bytes += (size_t)bytes;
      if (direction->read_bytes == RELAY_HEADER_BYTES
        && !direction->header_parsed
        && validate_header(direction, opposite) != 0) return -1;
      if (direction->header_parsed
        && direction->read_bytes == direction->frame_bytes) {
        direction->ready = true;
        return 1;
      }
      continue;
    }
    if (bytes == 0) return -2;
    if (errno == EINTR) continue;
    if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
    return -1;
  }
}

/*
 * Writes part or all of the one queued record. Returns 1 after the exact frame
 * crossed the destination, 0 on backpressure, and -1 on failure.
 */
static int write_record(int destination, struct relay_direction *direction) {
  while (record_pending(direction)) {
    ssize_t bytes = write(
      destination,
      direction->bytes + direction->write_offset,
      direction->frame_bytes - direction->write_offset
    );
    if (bytes > 0) {
      direction->write_offset += (size_t)bytes;
      continue;
    }
    if (bytes == 0) {
      errno = EIO;
      return -1;
    }
    if (errno == EINTR) continue;
    if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
    return -1;
  }
  return 1;
}

/*
 * Applies state only after a complete record crossed the destination. Returns
 * 1 after a terminal failure record/path and 0 otherwise. If a failure
 * occurred after a non-CLOSE record physically began, this queues RESET behind
 * that one record. A physically-started CLOSE finishes and then terminates.
 */
static int complete_record(struct relay_direction *direction) {
  uint16_t completed_kind = direction->kind;
  bool reset_after_current = direction->reset_after_current;
  bool close_transport_after_current = direction->close_transport_after_current;
  if (completed_kind == RELAY_KIND_FIN) {
    direction->fin_forwarded = true;
  } else if (completed_kind == RELAY_KIND_CLOSE) {
    direction->close_forwarded = true;
  }
  clear_record(direction);
  if (close_transport_after_current) return 1;
  if (reset_after_current) {
    return queue_generated_record(direction, RELAY_KIND_RESET, NULL, 0);
  }
  return completed_kind == RELAY_KIND_RESET ? 1 : 0;
}

static int socket_cloexec(int domain, int type, int protocol) {
#ifdef SOCK_CLOEXEC
  int fd = socket(domain, type | SOCK_CLOEXEC, protocol);
#else
  int fd = socket(domain, type, protocol);
#endif
  if (fd < 0) return -1;
#ifndef SOCK_CLOEXEC
  if (fcntl(fd, F_SETFD, FD_CLOEXEC) != 0) {
    int saved = errno;
    close(fd);
    errno = saved;
    return -1;
  }
#endif
  return fd;
}

static void retry_delay(void) {
  struct timespec delay = { .tv_sec = 0, .tv_nsec = CONNECT_RETRY_USEC * 1000L };
  while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
}

static int proxy_framed(int host, int guest) {
  if (set_nonblocking(host) != 0 || set_nonblocking(guest) != 0) {
    report_failure("could not enable nonblocking relay I/O");
    return -1;
  }

  struct relay_direction host_to_guest = {0};
  struct relay_direction guest_to_host = {0};
  bool failing = false;
  struct relay_direction *failure_direction = NULL;
  int failure_destination = -1;
  int64_t reset_deadline = 0;

  for (;;) {
    if (!failing
      && host_to_guest.close_forwarded
      && guest_to_host.close_forwarded
      && !record_in_progress(&host_to_guest)
      && !record_in_progress(&guest_to_host)) {
      return 0;
    }

    struct pollfd pollfds[2] = {
      { .fd = host, .events = 0, .revents = 0 },
      { .fd = guest, .events = 0, .revents = 0 },
    };
    int timeout = -1;
    if (failing) {
      if (failure_direction == NULL
        || failure_destination < 0
        || !record_pending(failure_direction)) return -1;
      if (failure_destination == host) {
        pollfds[0].events = POLLOUT;
      } else {
        pollfds[1].events = POLLOUT;
      }
      timeout = remaining_reset_timeout(reset_deadline);
      if (timeout == 0) return -1;
    } else {
      if (!host_to_guest.ready) pollfds[0].events |= POLLIN;
      if (record_pending(&guest_to_host)) pollfds[0].events |= POLLOUT;
      if (!guest_to_host.ready) pollfds[1].events |= POLLIN;
      if (record_pending(&host_to_guest)) pollfds[1].events |= POLLOUT;
    }

    int result;
    do result = poll(pollfds, 2, timeout); while (result < 0 && errno == EINTR);
    if (result < 0) {
      report_failure("poll failed");
      return -1;
    }
    if (result == 0) return -1;

    if (failing) {
      short destination_events = failure_destination == host
        ? pollfds[0].revents
        : pollfds[1].revents;
      if (destination_events & POLLNVAL) {
        report_failure("RESET destination descriptor became invalid");
        return -1;
      }
      if (destination_events & (POLLOUT | POLLERR | POLLHUP)) {
        int write_result = write_record(failure_destination, failure_direction);
        if (write_result < 0) {
          report_failure("could not flush terminal RESET");
          return -1;
        }
        if (write_result == 1) {
          int completed = complete_record(failure_direction);
          if (completed < 0) return -1;
          if (completed == 1) return -1;
        }
      }
      continue;
    }

    if (pollfds[0].revents & (POLLERR | POLLNVAL)) {
      if (queue_terminal_reset(
        &host_to_guest,
        "Host relay socket reported an I/O error",
        &reset_deadline
      ) != 0) return -1;
      failing = true;
      failure_direction = &host_to_guest;
      failure_destination = guest;
      continue;
    }
    if (pollfds[1].revents & (POLLERR | POLLNVAL)) {
      if (queue_terminal_reset(
        &guest_to_host,
        "Guest relay socket reported an I/O error",
        &reset_deadline
      ) != 0) return -1;
      failing = true;
      failure_direction = &guest_to_host;
      failure_destination = host;
      continue;
    }

    if (!host_to_guest.ready
      && (pollfds[0].revents & (POLLIN | POLLHUP))) {
      int read_result = read_record(host, &host_to_guest, &guest_to_host);
      if (read_result < 0) {
        const char *message = read_result == -2
          ? "Host relay socket closed before explicit two-CLOSE completion"
          : "Host sent a malformed LVRM record";
        if (queue_terminal_reset(
          &host_to_guest,
          message,
          &reset_deadline
        ) != 0) return -1;
        failing = true;
        failure_direction = &host_to_guest;
        failure_destination = guest;
        continue;
      }
      if (host_to_guest.ready
        && host_to_guest.kind == RELAY_KIND_RESET) {
        begin_explicit_reset(
          &host_to_guest,
          "Host sent an explicit LVRM RESET",
          &reset_deadline
        );
        failing = true;
        failure_direction = &host_to_guest;
        failure_destination = guest;
        continue;
      }
    }

    if (!guest_to_host.ready
      && (pollfds[1].revents & (POLLIN | POLLHUP))) {
      int read_result = read_record(guest, &guest_to_host, &host_to_guest);
      if (read_result < 0) {
        const char *message = read_result == -2
          ? "Guest relay socket closed before explicit two-CLOSE completion"
          : "Guest sent a malformed LVRM record";
        if (queue_terminal_reset(
          &guest_to_host,
          message,
          &reset_deadline
        ) != 0) return -1;
        failing = true;
        failure_direction = &guest_to_host;
        failure_destination = host;
        continue;
      }
      if (guest_to_host.ready
        && guest_to_host.kind == RELAY_KIND_RESET) {
        begin_explicit_reset(
          &guest_to_host,
          "Guest sent an explicit LVRM RESET",
          &reset_deadline
        );
        failing = true;
        failure_direction = &guest_to_host;
        failure_destination = host;
        continue;
      }
    }

    if (record_pending(&host_to_guest)
      && (pollfds[1].revents & POLLOUT)) {
      int write_result = write_record(guest, &host_to_guest);
      if (write_result < 0) {
        if (queue_terminal_reset(
          &guest_to_host,
          "could not forward an LVRM record to the Guest",
          &reset_deadline
        ) != 0) return -1;
        failing = true;
        failure_direction = &guest_to_host;
        failure_destination = host;
        continue;
      }
      if (write_result == 1) {
        int completed = complete_record(&host_to_guest);
        if (completed != 0) return -1;
      }
    }

    if (record_pending(&guest_to_host)
      && (pollfds[0].revents & POLLOUT)) {
      int write_result = write_record(host, &guest_to_host);
      if (write_result < 0) {
        if (queue_terminal_reset(
          &host_to_guest,
          "could not forward an LVRM record to the Host",
          &reset_deadline
        ) != 0) return -1;
        failing = true;
        failure_direction = &host_to_guest;
        failure_destination = guest;
        continue;
      }
      if (write_result == 1) {
        int completed = complete_record(&guest_to_host);
        if (completed != 0) return -1;
      }
    }
  }
}

static int connect_unix_once(const char *path) {
  int fd = socket_cloexec(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(address.sun_path)) {
    close(fd);
    errno = ENAMETOOLONG;
    return -1;
  }
  strcpy(address.sun_path, path);
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0) return fd;
  int saved = errno;
  close(fd);
  errno = saved;
  return -1;
}

static int connect_unix(const char *path) {
  for (int attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    int fd = connect_unix_once(path);
    if (fd >= 0) return fd;
    if (errno != ENOENT && errno != ECONNREFUSED) return -1;
    retry_delay();
  }
  errno = ETIMEDOUT;
  return -1;
}

#ifdef LAMARCK_TEST_HOST_CONTROL_SOCKET
static int connect_test_host(uint32_t port) {
  if (port == CONTROL_PORT) return connect_unix(LAMARCK_TEST_HOST_CONTROL_SOCKET);
  if (port == DATA_PORT) return connect_unix(LAMARCK_TEST_HOST_DATA_SOCKET);
  errno = EINVAL;
  return -1;
}
#endif

static int connect_host_vsock_once(uint32_t port) {
#ifdef LAMARCK_TEST_HOST_CONTROL_SOCKET
  return connect_test_host(port);
#else
  int fd = socket_cloexec(AF_VSOCK, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_vm address;
  memset(&address, 0, sizeof(address));
  address.svm_family = AF_VSOCK;
  address.svm_cid = VMADDR_CID_HOST;
  address.svm_port = port;
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0) return fd;
  int saved = errno;
  close(fd);
  errno = saved;
  return -1;
#endif
}

static int connect_host_vsock(uint32_t port) {
  for (int attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    int fd = connect_host_vsock_once(port);
    if (fd >= 0) return fd;
    if (
      errno != ECONNREFUSED && errno != ENODEV && errno != ENOENT
      && errno != ENETUNREACH && errno != EADDRNOTAVAIL
    ) return -1;
    retry_delay();
  }
  errno = ETIMEDOUT;
  return -1;
}

static int run_relay(uint32_t host_port, const char *guest_socket) {
  /* Dial the Host first. Host writes are buffered by the connected stream,
   * while attaching the Guest UDS first would start its bounded prelude timer
   * during a delayed Host listener. */
  int host = connect_host_vsock(host_port);
  if (host < 0) {
    perror("connect Host AF_VSOCK listener");
    return 111;
  }
  int guest = connect_unix(guest_socket);
  if (guest < 0) {
    perror("connect Guest supervisor socket");
    close(host);
    return 112;
  }
  ssize_t ready_bytes;
  do ready_bytes = write(STDERR_FILENO, "READY\n", 6); while (ready_bytes < 0 && errno == EINTR);
  if (ready_bytes != 6) {
    close(host);
    close(guest);
    return 113;
  }
#ifndef LAMARCK_TEST_HOST_CONTROL_SOCKET
  prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
#endif
  int result = proxy_framed(host, guest);
  close(host);
  close(guest);
  return result == 0 ? 0 : 114;
}

int main(int argc, char **argv) {
#ifndef LAMARCK_TEST_HOST_CONTROL_SOCKET
  if (geteuid() != 0) {
    fprintf(stderr, "lamarck-vsock-relay must run as root\n");
    return 1;
  }
#endif
  if (argc != 2 || (strcmp(argv[1], "control") != 0 && strcmp(argv[1], "data") != 0)) {
    fprintf(stderr, "usage: lamarck-vsock-relay control|data\n");
    return 2;
  }
  signal(SIGPIPE, SIG_IGN);
#ifndef LAMARCK_TEST_HOST_CONTROL_SOCKET
  prctl(PR_SET_PDEATHSIG, SIGTERM);
#endif
  if (strcmp(argv[1], "control") == 0) {
    return run_relay(CONTROL_PORT, LAMARCK_GUEST_CONTROL_SOCKET);
  }
  return run_relay(DATA_PORT, LAMARCK_GUEST_DATA_SOCKET);
}
