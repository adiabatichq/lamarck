#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Not installed in either App rootfs; root-only trusted worker launcher. */
int main(int argc, char **argv) {
    const char *prefix = "/sys/fs/cgroup/lamarck/builds/b-";
    if (getuid() != 0 || argc != 3 || strlen(argv[1]) != strlen(prefix) + 32 ||
        strncmp(argv[1], prefix, strlen(prefix)) || strlen(argv[2]) > 16384) return 64;
    for (const char *p = argv[1] + strlen(prefix); *p; ++p)
        if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f'))) return 64;
    char path[256];
    snprintf(path, sizeof(path), "%s/memory.max", argv[1]);
    int limit_fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    char limit[64] = {0};
    ssize_t length = limit_fd < 0 ? -1 : read(limit_fd, limit, sizeof(limit) - 1);
    if (limit_fd >= 0) close(limit_fd);
    if (length < 1) return 70;
    char *end;
    errno = 0;
    unsigned long long bytes = strtoull(limit, &end, 10);
    if (errno || end == limit || (*end && strcmp(end, "\n")) || bytes < (512ULL << 20) || bytes > (2ULL << 30)) return 70;
    char heap[64];
    snprintf(heap, sizeof(heap), "--max-old-space-size=%llu", (bytes >> 20) * 5 / 8);
    snprintf(path, sizeof(path), "%s/worker/cgroup.procs", argv[1]);
    int fd = open(path, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0 || write(fd, "0", 1) != 1) { perror("enter Build cgroup"); return 70; }
    close(fd);
    char *args[] = {"/usr/local/bin/node", heap,
        "/usr/libexec/lamarck-build-phase-worker.js", argv[2], NULL};
    execv(args[0], args);
    perror("exec Build worker");
    return 70;
}
