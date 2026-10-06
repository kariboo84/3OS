#ifndef TNA_STDIO_H
#define TNA_STDIO_H
typedef struct FILE FILE;
FILE *fopen(const char *path, const char *mode);
int fclose(FILE *fp);
int fprintf(FILE *fp, const char *fmt, ...);
int printf(const char *fmt, ...);
#endif
