#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/if.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define NETNS_PREFIX "/run/lamarck/netns/"
#define BUFFER_BYTES 65536
#define VIEWER_PROBE_RESPONSE_BYTES 8192

enum viewer_http_result {
  VIEWER_HTTP_INCOMPLETE = 0,
  VIEWER_HTTP_READY = 1,
  VIEWER_HTTP_RETRY = 2,
  VIEWER_HTTP_REJECT = 3,
};

static long remaining_milliseconds(const struct timespec *deadline);

static int valid_netns_path(const char *path) {
  size_t prefix = strlen(NETNS_PREFIX);
  if (strncmp(path, NETNS_PREFIX, prefix) != 0 || strlen(path) != prefix + 34) return 0;
  const char *key = path + prefix;
  if (!((key[0] == 'a' || key[0] == 'b') && key[1] == '-')) return 0;
  for (const char *cursor = key + 2; *cursor; cursor++) {
    if (!((*cursor >= '0' && *cursor <= '9') || (*cursor >= 'a' && *cursor <= 'f'))) return 0;
  }
  return 1;
}

static int parse_port(const char *value) {
  char *end = NULL;
  errno = 0;
  long port = strtol(value, &end, 10);
  if (errno != 0 || !end || *end || port < 1 || port > 65535) return -1;
  return (int)port;
}

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

static int proxy_stdio(int socket_fd) {
  int input_open = 1;
  int socket_open = 1;
  unsigned char buffer[BUFFER_BYTES];
  signal(SIGPIPE, SIG_IGN);
  while (input_open || socket_open) {
    struct pollfd fds[2] = {
      { .fd = STDIN_FILENO, .events = input_open ? POLLIN : 0 },
      { .fd = socket_fd, .events = socket_open ? POLLIN : 0 },
    };
    int result;
    do result = poll(fds, 2, -1); while (result < 0 && errno == EINTR);
    if (result < 0) return -1;
    if (input_open && (fds[0].revents & (POLLIN | POLLHUP))) {
      ssize_t bytes = read(STDIN_FILENO, buffer, sizeof(buffer));
      if (bytes <= 0) {
        input_open = 0;
        shutdown(socket_fd, SHUT_WR);
      } else if (write_all(socket_fd, buffer, (size_t)bytes) != 0) return -1;
    }
    if (socket_open && (fds[1].revents & (POLLIN | POLLHUP))) {
      ssize_t bytes = read(socket_fd, buffer, sizeof(buffer));
      if (bytes <= 0) {
        socket_open = 0;
        close(STDOUT_FILENO);
      } else if (write_all(STDOUT_FILENO, buffer, (size_t)bytes) != 0) return -1;
    }
    if ((fds[0].revents | fds[1].revents) & (POLLERR | POLLNVAL)) return -1;
  }
  return 0;
}

static int enter_namespace(const char *path) {
  if (!valid_netns_path(path)) return -1;
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  int result = setns(fd, CLONE_NEWNET);
  close(fd);
  return result;
}

static int connect_loopback(int port) {
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return -1;
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

static int connect_loopback_until(int port, const struct timespec *deadline) {
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  if (fd < 0) return -1;
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int connect_result = connect(fd, (struct sockaddr *)&address, sizeof(address));
  if (connect_result != 0 && errno != EINPROGRESS && errno != EINTR) {
    close(fd);
    return -1;
  }

  while (connect_result != 0) {
    long timeout_ms = remaining_milliseconds(deadline);
    if (timeout_ms <= 0) {
      errno = ETIMEDOUT;
      close(fd);
      return -1;
    }
    struct pollfd pending = { .fd = fd, .events = POLLOUT };
    int result;
    do result = poll(&pending, 1, (int)timeout_ms); while (result < 0 && errno == EINTR);
    if (result <= 0) {
      if (result == 0) errno = ETIMEDOUT;
      close(fd);
      return -1;
    }
    if (pending.revents & POLLNVAL) {
      errno = EBADF;
      close(fd);
      return -1;
    }
    int socket_error = 0;
    socklen_t socket_error_bytes = sizeof(socket_error);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &socket_error, &socket_error_bytes) != 0) {
      close(fd);
      return -1;
    }
    if (socket_error != 0) {
      errno = socket_error;
      close(fd);
      return -1;
    }
    connect_result = 0;
  }
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0 || fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

static int create_namespace(const char *path) {
  if (!valid_netns_path(path)) return 1;
  int target = open(path, O_CREAT | O_EXCL | O_RDONLY | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (target < 0) return 1;
  close(target);
  if (unshare(CLONE_NEWNET) != 0) goto fail;
  int control = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (control < 0) goto fail;
  struct ifreq request;
  memset(&request, 0, sizeof(request));
  strncpy(request.ifr_name, "lo", IFNAMSIZ - 1);
  if (ioctl(control, SIOCGIFFLAGS, &request) != 0) {
    close(control);
    goto fail;
  }
  request.ifr_flags |= IFF_UP;
  if (ioctl(control, SIOCSIFFLAGS, &request) != 0) {
    close(control);
    goto fail;
  }
  close(control);
  if (mount("/proc/self/ns/net", path, NULL, MS_BIND, NULL) != 0) goto fail;
  return 0;
fail:
  unlink(path);
  return 1;
}

static int delete_namespace(const char *path) {
  if (!valid_netns_path(path)) return 1;
  int missing = 0;
  if (umount2(path, MNT_DETACH) != 0) {
    if (errno == ENOENT) missing = 1;
    else if (errno != EINVAL) return 1;
  }
  if (unlink(path) != 0) {
    if (errno == ENOENT) missing = 1;
    else return 1;
  }
  return missing ? 2 : 0;
}

static int proxy_namespace(const char *path, const char *port_value) {
  int port = parse_port(port_value);
  if (port < 0 || enter_namespace(path) != 0) return 1;
  int fd = connect_loopback(port);
  if (fd < 0) return 2;
  if (dprintf(STDERR_FILENO, "READY\n") < 0) return 1;
  prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
  int result = proxy_stdio(fd);
  close(fd);
  return result == 0 ? 0 : 1;
}

static enum viewer_http_result classify_viewer_http_response(
    const unsigned char *response,
    size_t length) {
  size_t header_end = 0;
  for (size_t index = 3; index < length; index++) {
    if (response[index - 3] == '\r'
        && response[index - 2] == '\n'
        && response[index - 1] == '\r'
        && response[index] == '\n') {
      header_end = index + 1;
      break;
    }
  }
  if (header_end == 0) return VIEWER_HTTP_INCOMPLETE;

  size_t status_line_end = 0;
  for (size_t index = 1; index < header_end; index++) {
    if (response[index - 1] == '\r' && response[index] == '\n') {
      status_line_end = index - 1;
      break;
    }
  }
  if (status_line_end < 12
      || memcmp(response, "HTTP/1.", 7) != 0
      || response[7] < '0' || response[7] > '9'
      || response[8] != ' '
      || response[9] < '0' || response[9] > '9'
      || response[10] < '0' || response[10] > '9'
      || response[11] < '0' || response[11] > '9'
      || (status_line_end > 12 && response[12] != ' ')) {
    return VIEWER_HTTP_REJECT;
  }
  for (size_t index = 0; index < header_end; index++) {
    if (response[index] == '\0') return VIEWER_HTTP_REJECT;
    if (response[index] == '\n' && (index == 0 || response[index - 1] != '\r')) {
      return VIEWER_HTTP_REJECT;
    }
  }

  int status = (response[9] - '0') * 100
      + (response[10] - '0') * 10
      + (response[11] - '0');
  if (status >= 200 && status <= 299) return VIEWER_HTTP_READY;
  if (status == 502 || status == 503 || status == 504) return VIEWER_HTTP_RETRY;
  return VIEWER_HTTP_REJECT;
}

static int set_socket_timeout_until(int fd, const struct timespec *deadline) {
  long timeout_ms = remaining_milliseconds(deadline);
  if (timeout_ms <= 0) return -1;
  struct timeval timeout = {
    .tv_sec = timeout_ms / 1000,
    .tv_usec = (timeout_ms % 1000) * 1000,
  };
  if (setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) != 0
      || setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0) {
    return -1;
  }
  return 0;
}

static enum viewer_http_result read_viewer_http_status(
    int fd,
    const struct timespec *deadline) {
  if (set_socket_timeout_until(fd, deadline) != 0) return VIEWER_HTTP_RETRY;
  static const unsigned char request[] =
      "GET / HTTP/1.1\r\n"
      "Host: localhost\r\n"
      "Accept: text/html,application/xhtml+xml\r\n"
      "Connection: close\r\n"
      "\r\n";
  if (write_all(fd, request, sizeof(request) - 1) != 0) return VIEWER_HTTP_RETRY;

  unsigned char response[VIEWER_PROBE_RESPONSE_BYTES];
  size_t length = 0;
  while (length < sizeof(response)) {
    if (set_socket_timeout_until(fd, deadline) != 0) return VIEWER_HTTP_RETRY;
    ssize_t received = read(fd, response + length, sizeof(response) - length);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) return VIEWER_HTTP_RETRY;
    length += (size_t)received;
    enum viewer_http_result result = classify_viewer_http_response(response, length);
    if (result != VIEWER_HTTP_INCOMPLETE) return result;
  }
  return VIEWER_HTTP_REJECT;
}

static long remaining_milliseconds(const struct timespec *deadline) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  int64_t seconds = (int64_t)deadline->tv_sec - (int64_t)now.tv_sec;
  int64_t nanoseconds = (int64_t)deadline->tv_nsec - (int64_t)now.tv_nsec;
  int64_t remaining = seconds * 1000 + nanoseconds / 1000000;
  if (nanoseconds > 0 && nanoseconds % 1000000 != 0) remaining += 1;
  return remaining > 0 ? (long)remaining : 0;
}

static int bounded_deadline(
    struct timespec *result,
    const struct timespec *outer_deadline,
    long maximum_ms) {
  if (clock_gettime(CLOCK_MONOTONIC, result) != 0) return -1;
  result->tv_sec += maximum_ms / 1000;
  result->tv_nsec += (maximum_ms % 1000) * 1000000;
  if (result->tv_nsec >= 1000000000) {
    result->tv_sec += 1;
    result->tv_nsec -= 1000000000;
  }
  if (result->tv_sec > outer_deadline->tv_sec
      || (result->tv_sec == outer_deadline->tv_sec
          && result->tv_nsec > outer_deadline->tv_nsec)) {
    *result = *outer_deadline;
  }
  return 0;
}

static int probe_loopback_port(int port, const struct timespec *deadline) {
  while (1) {
    if (remaining_milliseconds(deadline) <= 0) return 2;
    struct timespec attempt_deadline;
    if (bounded_deadline(&attempt_deadline, deadline, 250) != 0) return 1;
    int fd = connect_loopback_until(port, &attempt_deadline);
    if (fd >= 0) {
      enum viewer_http_result result = read_viewer_http_status(fd, &attempt_deadline);
      close(fd);
      if (result == VIEWER_HTTP_READY) return 0;
      if (result == VIEWER_HTTP_REJECT) return 3;
    }
    long remaining = remaining_milliseconds(deadline);
    if (remaining <= 0) return 2;
    long delay_ms = remaining < 20 ? remaining : 20;
    struct timespec delay = {
      .tv_sec = delay_ms / 1000,
      .tv_nsec = (delay_ms % 1000) * 1000000,
    };
    nanosleep(&delay, NULL);
  }
}

static int probe_namespace(const char *path, const char *port_value, const char *timeout_value) {
  int port = parse_port(port_value);
  char *end = NULL;
  long timeout = strtol(timeout_value, &end, 10);
  if (port < 0 || !end || *end || timeout < 100 || timeout > 60000 || enter_namespace(path) != 0) return 1;
  signal(SIGPIPE, SIG_IGN);
  struct timespec deadline;
  if (clock_gettime(CLOCK_MONOTONIC, &deadline) != 0) return 1;
  deadline.tv_sec += timeout / 1000;
  deadline.tv_nsec += (timeout % 1000) * 1000000;
  if (deadline.tv_nsec >= 1000000000) {
    deadline.tv_sec += 1;
    deadline.tv_nsec -= 1000000000;
  }
  return probe_loopback_port(port, &deadline);
}

int main(int argc, char **argv) {
  if (geteuid() != 0) return 1;
  if (argc == 3 && strcmp(argv[1], "create") == 0) return create_namespace(argv[2]);
  if (argc == 3 && strcmp(argv[1], "delete") == 0) return delete_namespace(argv[2]);
  if (argc == 4 && strcmp(argv[1], "proxy") == 0) return proxy_namespace(argv[2], argv[3]);
  if (argc == 5 && strcmp(argv[1], "probe") == 0) return probe_namespace(argv[2], argv[3], argv[4]);
  return 64;
}
