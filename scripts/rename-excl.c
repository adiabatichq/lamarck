#if defined(__APPLE__)
#include <stdio.h>
#elif defined(__linux__)
#define _GNU_SOURCE
#include <fcntl.h>
#include <linux/fs.h>
#include <sys/syscall.h>
#include <unistd.h>
#else
#error "rename-excl is supported only on macOS and Linux"
#endif

#include <errno.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: rename-excl <source> <destination>\n");
    return 64;
  }

#if defined(__APPLE__)
  const int result = renamex_np(argv[1], argv[2], RENAME_EXCL);
#elif defined(__linux__)
  const int result = (int)syscall(
    SYS_renameat2,
    AT_FDCWD,
    argv[1],
    AT_FDCWD,
    argv[2],
    RENAME_NOREPLACE
  );
#endif
  if (result != 0) {
    fprintf(stderr, "rename-excl: %s\n", strerror(errno));
    return 73;
  }
  return 0;
}
