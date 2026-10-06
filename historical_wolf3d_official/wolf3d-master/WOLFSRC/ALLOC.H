#ifndef TNA_ALLOC_H
#define TNA_ALLOC_H
typedef unsigned int size_t;
void *farmalloc(unsigned long size);
void farfree(void far *ptr);
void *malloc(unsigned int size);
void free(void *ptr);
#endif
