#ifndef TRI_STDARG_H
#define TRI_STDARG_H
typedef char *va_list;
#define va_start(ap,last) ((ap)=*(char**)__va_area__)
#define va_arg(ap,t) (*(t*)((ap+=3)-3))
#define va_end(ap) ((void)0)
#define va_copy(dst,src) ((dst)=(src))
#define __GNUC_VA_LIST 1
typedef va_list __gnuc_va_list;
#endif
