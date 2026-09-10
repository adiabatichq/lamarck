#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <linux/magic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <unistd.h>

#ifndef EXT4_IOC_RESIZE_FS
#define EXT4_IOC_RESIZE_FS _IOW('f', 16, uint64_t)
#endif
int main(int argc, char **argv) {
    if (argc != 2 || getuid() != 0 || argv[1][0] < '0' || argv[1][0] > '9') return 64;
    char *end = NULL;
    errno = 0;
    uint64_t bytes = strtoull(argv[1], &end, 10);
    if (errno || !end || *end || bytes < (4ULL << 30) || bytes > (64ULL << 30) || bytes % (64ULL << 20)) return 64;
    int fd = open("/var/lib/lamarck", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int block = open("/dev/vdb", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct statfs fs;
    struct stat mount_stat, block_stat;
    uint64_t capacity = 0;
    if (fd < 0 || block < 0 || fstatfs(fd, &fs) || fstat(fd, &mount_stat) || fstat(block, &block_stat) ||
        fs.f_type != EXT4_SUPER_MAGIC || !S_ISBLK(block_stat.st_mode) || mount_stat.st_dev != block_stat.st_rdev ||
        ioctl(block, BLKGETSIZE64, &capacity) || bytes > capacity || fs.f_bsize != 4096) {
        perror("validate state filesystem"); return 70;
    }
    /* Read the ext4 superblock's true block count. statfs excludes metadata. */
    uint32_t low, high;
    if (pread(block, &low, 4, 1024 + 4) != 4 || pread(block, &high, 4, 1024 + 0x150) != 4) return 70;
    uint64_t blocks = bytes / 4096;
    uint64_t current = ((uint64_t)high << 32) | low;
    if (current > blocks) { fprintf(stderr, "state shrink is forbidden\n"); return 64; }
    if (current < blocks && ioctl(fd, EXT4_IOC_RESIZE_FS, &blocks)) { perror("grow ext4"); return 74; }
    if (pread(block, &low, 4, 1024 + 4) != 4 || pread(block, &high, 4, 1024 + 0x150) != 4 ||
        (((uint64_t)high << 32) | low) != blocks) { fprintf(stderr, "state growth not acknowledged\n"); return 74; }
    if (syncfs(fd)) { perror("sync state growth"); return 74; }
    printf("{\"bytes\":%llu}\n", (unsigned long long)bytes);
    close(block); close(fd);
    return 0;
}
