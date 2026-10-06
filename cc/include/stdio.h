#ifndef TRI_STDIO_H
#define TRI_STDIO_H
#include <stddef.h>
#include <stdarg.h>
#define EOF (-1)
int putchar(int); int puts(const char*);
int printf(const char*,...);
int sprintf(char*,const char*,...);
int snprintf(char*,size_t,const char*,...);
int vsprintf(char*,const char*,va_list);
int vsnprintf(char*,size_t,const char*,va_list);
int vprintf(const char*,va_list);
#endif
