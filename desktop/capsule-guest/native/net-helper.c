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
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define NETNS_PREFIX "/run/lamarck/netns/"
#define BUFFER_BYTES 65536

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

static int probe_namespace(const char *path, const char *port_value, const char *timeout_value) {
  int port = parse_port(port_value);
  char *end = NULL;
  long timeout = strtol(timeout_value, &end, 10);
  if (port < 0 || !end || *end || timeout < 100 || timeout > 60000 || enter_namespace(path) != 0) return 1;
  struct timespec delay = { .tv_sec = 0, .tv_nsec = 20000000 };
  long attempts = timeout / 20;
  for (long attempt = 0; attempt <= attempts; attempt++) {
    int fd = connect_loopback(port);
    if (fd >= 0) {
      close(fd);
      return 0;
    }
    nanosleep(&delay, NULL);
  }
  return 2;
}

int main(int argc, char **argv) {
  if (geteuid() != 0) return 1;
  if (argc == 3 && strcmp(argv[1], "create") == 0) return create_namespace(argv[2]);
  if (argc == 3 && strcmp(argv[1], "delete") == 0) return delete_namespace(argv[2]);
  if (argc == 4 && strcmp(argv[1], "proxy") == 0) return proxy_namespace(argv[2], argv[3]);
  if (argc == 5 && strcmp(argv[1], "probe") == 0) return probe_namespace(argv[2], argv[3], argv[4]);
  return 64;
}
