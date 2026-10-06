#ifndef TRI_STDLIB_H
#define TRI_STDLIB_H
#include <stddef.h>
#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
void exit(int); void abort(void);
void *malloc(size_t); void *calloc(size_t,size_t); void *realloc(void*,size_t); void free(void*);
int abs(int); long labs(long); int atoi(const char*); long atol(const char*); long strtol(const char*,char**,int);
#endif
