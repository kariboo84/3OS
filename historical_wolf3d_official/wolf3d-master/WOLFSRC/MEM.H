#ifndef TNA_MEM_H
#define TNA_MEM_H
void *memcpy(void *dst, const void *src, unsigned len);
void *memset(void *dst, int value, unsigned len);
int memcmp(const void *a, const void *b, unsigned len);
#endif
