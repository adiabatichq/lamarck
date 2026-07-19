#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
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
#define BUFFER_BYTES 65536

static int write_all(int fd, const unsigned char *buffer, size_t bytes) {
  size_t offset = 0;
  while (offset < bytes) {
    ssize_t written = write(fd, buffer + offset, bytes - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return -1;
    offset += (size_t)written;
  }
  return 0;
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

static int proxy_duplex(int left, int right) {
  int left_open = 1;
  int right_open = 1;
  unsigned char buffer[BUFFER_BYTES];
  while (left_open || right_open) {
    struct pollfd pollfds[2] = {
      { .fd = left, .events = left_open ? POLLIN : 0 },
      { .fd = right, .events = right_open ? POLLIN : 0 },
    };
    int result;
    do result = poll(pollfds, 2, -1); while (result < 0 && errno == EINTR);
    if (result < 0) return -1;
    if (left_open && (pollfds[0].revents & (POLLIN | POLLHUP))) {
      ssize_t bytes;
      do bytes = read(left, buffer, sizeof(buffer)); while (bytes < 0 && errno == EINTR);
      if (bytes <= 0) {
        left_open = 0;
        shutdown(right, SHUT_WR);
      } else if (write_all(right, buffer, (size_t)bytes) != 0) {
        return -1;
      }
    }
    if (right_open && (pollfds[1].revents & (POLLIN | POLLHUP))) {
      ssize_t bytes;
      do bytes = read(right, buffer, sizeof(buffer)); while (bytes < 0 && errno == EINTR);
      if (bytes <= 0) {
        right_open = 0;
        shutdown(left, SHUT_WR);
      } else if (write_all(left, buffer, (size_t)bytes) != 0) {
        return -1;
      }
    }
    if ((pollfds[0].revents | pollfds[1].revents) & (POLLERR | POLLNVAL)) return -1;
  }
  return 0;
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
  if (write_all(STDERR_FILENO, (const unsigned char *)"READY\n", 6) != 0) {
    close(host);
    close(guest);
    return 113;
  }
#ifndef LAMARCK_TEST_HOST_CONTROL_SOCKET
  prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
#endif
  int result = proxy_duplex(host, guest);
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
