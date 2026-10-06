#ifndef TNA_IO_H
#define TNA_IO_H
int open(const char *path, int flags, ...);
int close(int fd);
long lseek(int fd, long offset, int whence);
int read(int fd, void *buf, unsigned len);
int write(int fd, const void *buf, unsigned len);
int creat(const char *path, int mode);
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
#endif
