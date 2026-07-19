#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
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
#ifndef EXT4_SUPER_MAGIC
#define EXT4_SUPER_MAGIC 0xEF53
#endif
#ifndef TMPFS_MAGIC
#define TMPFS_MAGIC 0x01021994
#endif

static const char *const cancel_mode = "/workspace/.lamarck-cancel-probe";
static const char *const cancel_ready = "/workspace/cancel-ready";
static const char *const cancel_descendant_ready = "/workspace/cancel-descendant-ready";
static const char *const cancel_term_seen = "/workspace/cancel-term-seen";

static void fail(const char *message) {
  dprintf(STDERR_FILENO, "capsule build probe: %s (errno=%d: %s)\n",
          message, errno, strerror(errno));
  _exit(1);
}

static void write_all(int fd, const char *value) {
  size_t offset = 0;
  const size_t length = strlen(value);
  while (offset < length) {
    ssize_t written = write(fd, value + offset, length - offset);
    if (written < 0) {
      if (errno == EINTR) continue;
      fail("write failed");
    }
    offset += (size_t)written;
  }
}

static void write_marker(const char *path, const char *value) {
  int fd = open(path, O_CREAT | O_TRUNC | O_WRONLY | O_CLOEXEC, 0644);
  if (fd < 0) fail("cannot create marker");
  write_all(fd, value);
  if (fsync(fd) != 0) fail("cannot fsync marker");
  if (close(fd) != 0) fail("cannot close marker");
}

static void require_errno_eperm(const char *name, long result) {
  if (result != -1 || errno != EPERM) {
    dprintf(STDERR_FILENO,
            "capsule build probe: %s was not denied with EPERM "
            "(result=%ld errno=%d: %s)\n",
            name, result, errno, strerror(errno));
    _exit(1);
  }
}

static void assert_process_boundary(void) {
  if (getuid() != 1000 || geteuid() != 1000 ||
      getgid() != 1000 || getegid() != 1000) {
    errno = 0;
    fail("Build did not run as mapped uid/gid 1000");
  }
  if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) {
    fail("no_new_privs was not active");
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
    fail("read-only Build rootfs accepted a write");
  }
  if (errno != EROFS) fail("Build rootfs write was not rejected as read-only");

  errno = 0;
  int dependency_write = open(
      "/dependencies/write-probe", O_CREAT | O_WRONLY | O_CLOEXEC, 0600);
  if (dependency_write >= 0) {
    close(dependency_write);
    errno = 0;
    fail("read-only dependency bundle accepted a write");
  }
  if (errno != EROFS) fail("dependency write was not rejected as read-only");
}

static void assert_seccomp_boundary(void) {
  errno = 0;
  require_errno_eperm("AF_VSOCK", socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0));
  errno = 0;
  require_errno_eperm("AF_PACKET", socket(AF_PACKET, SOCK_RAW | SOCK_CLOEXEC, 0));
  errno = 0;
  require_errno_eperm("io_uring_setup", syscall(__NR_io_uring_setup, 0U, NULL));
  errno = 0;
  require_errno_eperm(
      "io_uring_enter", syscall(__NR_io_uring_enter, -1, 0U, 0U, 0U, NULL, 0U));
  errno = 0;
  require_errno_eperm(
      "io_uring_register", syscall(__NR_io_uring_register, -1, 0U, NULL, 0U));

  int internet_socket = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (internet_socket < 0) fail("ordinary loopback-capable socket was unexpectedly denied");
  if (close(internet_socket) != 0) fail("cannot close ordinary socket");
}

static void assert_loopback_only_network(void) {
  FILE *devices = fopen("/proc/net/dev", "re");
  if (devices == NULL) fail("cannot inspect network interfaces");
  int control = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (control < 0) fail("cannot inspect network interface flags");
  char line[512];
  int line_number = 0;
  int loopback_interfaces = 0;
  while (fgets(line, sizeof(line), devices) != NULL) {
    line_number += 1;
    if (line_number <= 2) continue;
    char name[64];
    if (sscanf(line, " %63[^:]:", name) != 1) fail("malformed /proc/net/dev");
    struct ifreq request;
    memset(&request, 0, sizeof(request));
    if (strlen(name) >= sizeof(request.ifr_name)) fail("network interface name is too long");
    strcpy(request.ifr_name, name);
    if (ioctl(control, SIOCGIFFLAGS, &request) != 0) fail("cannot inspect interface flags");
    if (strcmp(name, "lo") == 0) {
      loopback_interfaces += 1;
      if ((request.ifr_flags & IFF_UP) == 0) fail("Build loopback interface is down");
    } else if ((request.ifr_flags & IFF_UP) != 0) {
      errno = 0;
      fail("Build network namespace exposed an active non-loopback interface");
    }
  }
  if (fclose(devices) != 0) fail("cannot close network interface state");
  if (close(control) != 0) fail("cannot close interface control socket");
  if (loopback_interfaces != 1) {
    errno = 0;
    fail("Build network namespace did not expose one loopback interface");
  }

  FILE *routes = fopen("/proc/net/route", "re");
  if (routes == NULL) fail("cannot inspect network routes");
  while (fgets(line, sizeof(line), routes) != NULL) {
    char interface_name[64];
    char destination[32];
    if (sscanf(line, "%63s %31s", interface_name, destination) != 2) continue;
    if (strcmp(destination, "00000000") == 0) {
      errno = 0;
      fail("Build network namespace exposed a default route");
    }
  }
  if (fclose(routes) != 0) fail("cannot close network route state");
}

static void assert_bounded_scratch(void) {
  struct statfs workspace;
  struct statfs home;
  struct statfs temporary;
  if (statfs("/workspace", &workspace) != 0) fail("cannot stat Build workspace");
  if (statfs("/home/build", &home) != 0) fail("cannot stat Build home");
  if (statfs("/tmp", &temporary) != 0) fail("cannot stat Build tmpfs");
  if ((unsigned long)workspace.f_type != EXT4_SUPER_MAGIC ||
      (unsigned long)home.f_type != EXT4_SUPER_MAGIC) {
    errno = 0;
    fail("Build writable paths are not backed by bounded ext4");
  }
  if ((unsigned long)temporary.f_type != TMPFS_MAGIC) {
    errno = 0;
    fail("Build temporary storage is not bounded tmpfs");
  }
  unsigned long long workspace_bytes =
      (unsigned long long)workspace.f_blocks * (unsigned long long)workspace.f_bsize;
  unsigned long long temporary_bytes =
      (unsigned long long)temporary.f_blocks * (unsigned long long)temporary.f_bsize;
  if (workspace_bytes > 512ULL * 1024ULL * 1024ULL ||
      temporary_bytes > 512ULL * 1024ULL * 1024ULL) {
    errno = 0;
    fail("Build scratch exceeded the integration admission ceiling");
  }
}

static void term_handler(int signal_number) {
  (void)signal_number;
  int saved_errno = errno;
  int fd = open(cancel_term_seen, O_CREAT | O_TRUNC | O_WRONLY | O_CLOEXEC, 0644);
  if (fd >= 0) {
    static const char marker[] = "term-seen\n";
    (void)write(fd, marker, sizeof(marker) - 1);
    (void)close(fd);
  }
  errno = saved_errno;
}

static void install_stubborn_term_handler(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = term_handler;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0) fail("cannot install TERM handler");
}

static void run_cancel_probe(void) {
  install_stubborn_term_handler();
  pid_t child = fork();
  if (child < 0) fail("cannot create cancellation descendant");
  if (child == 0) {
    install_stubborn_term_handler();
    write_marker(cancel_descendant_ready, "descendant-ready\n");
    for (;;) pause();
  }
  for (int attempt = 0; attempt < 500; attempt += 1) {
    if (access(cancel_descendant_ready, F_OK) == 0) break;
    usleep(10000);
  }
  if (access(cancel_descendant_ready, F_OK) != 0) fail("descendant did not become ready");
  write_marker(cancel_ready, "cancel-ready\n");
  for (;;) pause();
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  assert_process_boundary();
  assert_seccomp_boundary();
  assert_loopback_only_network();
  assert_bounded_scratch();

  if (access(cancel_mode, F_OK) == 0) run_cancel_probe();
  if (argc != 2 || strcmp(argv[1], "success") != 0) {
    errno = 0;
    fail("expected the successful npm lifecycle probe mode");
  }
  write_marker("/workspace/build-policy-success.txt", "policy-ok\n");
  return 0;
}
