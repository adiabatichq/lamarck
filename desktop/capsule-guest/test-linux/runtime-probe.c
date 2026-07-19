#define _GNU_SOURCE

#include <errno.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef __NR_io_uring_setup
#error "io_uring_setup syscall number is required"
#endif
#ifndef __NR_io_uring_enter
#error "io_uring_enter syscall number is required"
#endif
#ifndef __NR_io_uring_register
#error "io_uring_register syscall number is required"
#endif

static void fail(const char *message) {
  dprintf(STDERR_FILENO, "capsule runtime probe: %s (errno=%d: %s)\n",
          message, errno, strerror(errno));
  _exit(1);
}

static void require_errno_eperm(const char *name, long result) {
  if (result != -1 || errno != EPERM) {
    dprintf(STDERR_FILENO,
            "capsule runtime probe: %s was not denied with EPERM "
            "(result=%ld errno=%d: %s)\n",
            name, result, errno, strerror(errno));
    _exit(1);
  }
}

static void write_bytes(int fd, const void *value, size_t length) {
  size_t offset = 0;
  const char *bytes = value;
  while (offset < length) {
    ssize_t written = write(fd, bytes + offset, length - offset);
    if (written < 0) {
      if (errno == EINTR) continue;
      fail("write failed");
    }
    offset += (size_t)written;
  }
}

static void write_all(int fd, const char *value) {
  write_bytes(fd, value, strlen(value));
}

static void read_exact(int fd, void *value, size_t length) {
  size_t offset = 0;
  char *bytes = value;
  while (offset < length) {
    ssize_t received = read(fd, bytes + offset, length - offset);
    if (received < 0) {
      if (errno == EINTR) continue;
      fail("read failed");
    }
    if (received == 0) {
      errno = 0;
      fail("channel ended before a complete frame");
    }
    offset += (size_t)received;
  }
}

static void assert_process_boundary(void) {
  if (getuid() != 1000 || geteuid() != 1000 ||
      getgid() != 1000 || getegid() != 1000) {
    errno = 0;
    fail("workload did not run as mapped uid/gid 1000");
  }
  if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) {
    fail("no_new_privs was not active");
  }
  const char *sdk_path = getenv("LAMARCK_SDK_SOCKET");
  if (sdk_path == NULL || strcmp(sdk_path, "/run/lamarck/system.sock") != 0) {
    errno = 0;
    fail("fixed workload SDK socket is absent");
  }

  FILE *status = fopen("/proc/self/status", "re");
  if (status == NULL) fail("cannot read process status");
  char line[256];
  unsigned long long effective = ~0ULL;
  while (fgets(line, sizeof(line), status) != NULL) {
    if (sscanf(line, "CapEff:\t%llx", &effective) == 1) break;
  }
  if (fclose(status) != 0) fail("cannot close process status");
  if (effective != 0) {
    errno = 0;
    fail("effective Linux capabilities were not empty");
  }

  errno = 0;
  int root_write = open("/rootfs-write-probe", O_CREAT | O_WRONLY | O_CLOEXEC, 0600);
  if (root_write >= 0) {
    close(root_write);
    errno = 0;
    fail("read-only OCI rootfs accepted a write");
  }
  if (errno != EROFS) fail("rootfs write was not rejected as read-only");
}

static int connect_sdk(void) {
  const char *path = getenv("LAMARCK_SDK_SOCKET");
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  if (path == NULL || strlen(path) >= sizeof(address.sun_path)) {
    errno = 0;
    fail("SDK socket path is invalid");
  }
  memcpy(address.sun_path, path, strlen(path) + 1);
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) fail("cannot create SDK Unix socket");
  if (connect(fd, (const struct sockaddr *)&address, sizeof(address)) != 0) {
    fail("cannot connect to workload SDK bridge");
  }
  return fd;
}

static void assert_seccomp_boundary(void) {
  errno = 0;
  require_errno_eperm("AF_VSOCK", socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0));
  errno = 0;
  require_errno_eperm("AF_PACKET", socket(AF_PACKET, SOCK_RAW | SOCK_CLOEXEC, 0));
  errno = 0;
  require_errno_eperm(
      "io_uring_setup",
      syscall(__NR_io_uring_setup, 0U, NULL));
  errno = 0;
  require_errno_eperm(
      "io_uring_enter",
      syscall(__NR_io_uring_enter, -1, 0U, 0U, 0U, NULL, 0U));
  errno = 0;
  require_errno_eperm(
      "io_uring_register",
      syscall(__NR_io_uring_register, -1, 0U, NULL, 0U));
}

static void exercise_overlay(void) {
  int existing = open("/app/existing.txt", O_WRONLY | O_APPEND | O_CLOEXEC);
  if (existing < 0) fail("cannot copy-up existing artifact file");
  write_all(existing, "append");
  if (close(existing) != 0) fail("cannot close copied-up artifact file");

  int fresh = open("/app/new.txt", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  if (fresh < 0) fail("cannot create runtime overlay file");
  write_all(fresh, "new");
  if (close(fresh) != 0) fail("cannot close runtime overlay file");
  if (rename("/app/new.txt", "/app/renamed.txt") != 0) {
    fail("cannot rename runtime overlay file");
  }

  if (mkdir("/app/node_modules/.vite/cache", 0700) != 0 && errno != EEXIST) {
    fail("cannot create generated artifact directory");
  }
  int generated = open(
      "/app/node_modules/.vite/cache/result.txt",
      O_CREAT | O_TRUNC | O_WRONLY | O_CLOEXEC,
      0600);
  if (generated < 0) fail("cannot write generated artifact");
  write_all(generated, "cache");
  if (close(generated) != 0) fail("cannot close generated artifact");
}

static int open_isolation_listener(void) {
  int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listener < 0) fail("cannot create isolation listener");
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons(34567);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(listener, (const struct sockaddr *)&address, sizeof(address)) != 0) {
    fail("cannot bind the shared isolation probe port");
  }
  if (listen(listener, 1) != 0) fail("cannot listen on the isolation probe port");
  return listener;
}

static void write_owner_file(const char *label) {
  int file = open(
      "/app/isolation-owner.txt",
      O_CREAT | O_TRUNC | O_WRONLY | O_CLOEXEC,
      0600);
  if (file < 0) fail("cannot create isolation owner marker");
  write_all(file, label);
  if (close(file) != 0) fail("cannot close isolation owner marker");
}

static ssize_t read_line(int fd, char *buffer, size_t capacity) {
  size_t length = 0;
  while (length + 1 < capacity) {
    char byte;
    ssize_t received = read(fd, &byte, 1);
    if (received < 0) {
      if (errno == EINTR) continue;
      fail("cannot read isolation command");
    }
    if (received == 0) {
      buffer[length] = '\0';
      return length == 0 ? 0 : (ssize_t)length;
    }
    if (byte == '\n') {
      buffer[length] = '\0';
      return (ssize_t)length;
    }
    buffer[length++] = byte;
  }
  errno = 0;
  fail("isolation command exceeds the fixed buffer");
  return -1;
}

static void assert_hidden_path(const char *path) {
  if (path[0] != '/') {
    errno = 0;
    fail("hidden-path probe requires an absolute path");
  }
  errno = 0;
  int file = open(path, O_RDONLY | O_CLOEXEC);
  if (file >= 0) {
    close(file);
    errno = 0;
    fail("another App runtime path became visible");
  }
  if (errno != ENOENT && errno != EACCES && errno != EPERM) {
    fail("hidden App path failed for an unexpected reason");
  }
}

static void assert_hidden_host_pid(const char *value) {
  char *end = NULL;
  errno = 0;
  long pid = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || pid <= 1 || pid > INT_MAX) {
    errno = 0;
    fail("invalid Host pid probe");
  }
  char path[64];
  if (snprintf(path, sizeof(path), "/proc/%ld", pid) >= (int)sizeof(path)) {
    errno = 0;
    fail("Host pid path exceeds the fixed buffer");
  }
  errno = 0;
  if (access(path, F_OK) == 0 || errno != ENOENT) {
    errno = 0;
    fail("another App init pid became visible in /proc");
  }
  errno = 0;
  if (kill((pid_t)pid, 0) == 0 || errno != ESRCH) {
    errno = 0;
    fail("another App init pid became signalable");
  }
}

static int run_isolation_probe(const char *label) {
  if (label[0] == '\0' || strlen(label) > 64 || strchr(label, '\n') != NULL) {
    errno = 0;
    fail("invalid isolation label");
  }
  if (signal(SIGTERM, SIG_IGN) == SIG_ERR) fail("cannot ignore graceful stop");
  write_owner_file(label);
  int listener = open_isolation_listener();
  int sdk = connect_sdk();
  char response[128];
  if (snprintf(response, sizeof(response), "isolation-ready:%s\n", label) >= (int)sizeof(response)) {
    errno = 0;
    fail("isolation readiness marker exceeds the fixed buffer");
  }
  write_all(sdk, response);

  char command[1024];
  for (;;) {
    ssize_t length = read_line(sdk, command, sizeof(command));
    if (length == 0) break;
    if (strcmp(command, "ping") == 0) {
      if (snprintf(response, sizeof(response), "pong:%s\n", label) >= (int)sizeof(response)) {
        errno = 0;
        fail("isolation pong exceeds the fixed buffer");
      }
      write_all(sdk, response);
      continue;
    }
    if (strncmp(command, "assert-hidden ", 14) == 0) {
      assert_hidden_path(command + 14);
      write_all(sdk, "hidden-path-ok\n");
      continue;
    }
    if (strncmp(command, "assert-pid-hidden ", 18) == 0) {
      assert_hidden_host_pid(command + 18);
      write_all(sdk, "hidden-pid-ok\n");
      continue;
    }
    errno = 0;
    fail("unknown isolation command");
  }

  if (close(sdk) != 0) fail("cannot close isolation SDK socket");
  if (close(listener) != 0) fail("cannot close isolation listener");
  return 0;
}

static int run_system_rpc_probe(void) {
  static const char request[] =
      "{\"version\":1,\"requestId\":1,\"operation\":\"mutate\","
      "\"input\":{\"sql\":\"INSERT INTO capsule_items (id, value) VALUES (?, ?)\","
      "\"params\":[\"from-real-runc\",\"committed\"]}}";
  int sdk = connect_sdk();
  uint32_t request_length = (uint32_t)strlen(request);
  uint32_t request_header = htonl(request_length);
  write_bytes(sdk, &request_header, sizeof(request_header));
  write_bytes(sdk, request, request_length);

  uint32_t response_header;
  read_exact(sdk, &response_header, sizeof(response_header));
  uint32_t response_length = ntohl(response_header);
  if (response_length == 0 || response_length > 65536) {
    errno = 0;
    fail("System SDK response length is outside the probe bound");
  }
  char response[65537];
  read_exact(sdk, response, response_length);
  response[response_length] = '\0';
  if (strstr(response, "\"ok\":true") == NULL ||
      strstr(response, "\"auditEventIds\":[\"") == NULL) {
    errno = 0;
    fail("System SDK mutation did not return a successful audited result");
  }
  if (close(sdk) != 0) fail("cannot close System SDK mutation socket");
  return 0;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (argc < 2) {
    errno = 0;
    fail("expected a probe mode");
  }
  assert_process_boundary();
  assert_seccomp_boundary();

  if (strcmp(argv[1], "system-rpc") == 0) {
    if (argc != 2) {
      errno = 0;
      fail("system-rpc mode takes no arguments");
    }
    return run_system_rpc_probe();
  }
  if (strcmp(argv[1], "isolation") == 0) {
    if (argc != 3) {
      errno = 0;
      fail("isolation mode requires one label");
    }
    return run_isolation_probe(argv[2]);
  }
  if (argc != 2) {
    errno = 0;
    fail("unexpected probe arguments");
  }

  if (strcmp(argv[1], "oneshot") == 0) {
    exercise_overlay();
    int sdk = connect_sdk();
    write_all(sdk, "oneshot-ready\n");
    if (close(sdk) != 0) fail("cannot close SDK socket");
    return 0;
  }
  if (strcmp(argv[1], "long-running") != 0) {
    errno = 0;
    fail("unknown probe mode");
  }

  if (signal(SIGTERM, SIG_IGN) == SIG_ERR) fail("cannot ignore graceful stop");
  int sdk = connect_sdk();
  write_all(sdk, "long-running-ready\n");
  if (close(sdk) != 0) fail("cannot close SDK socket");
  for (;;) pause();
}
