#ifndef TRI_STDINT_H
#define TRI_STDINT_H
#include <limits.h>
typedef signed char int8_t; typedef unsigned char uint8_t;
typedef int int16_t; typedef unsigned int uint16_t;
typedef int int32_t; typedef unsigned int uint32_t;
typedef long int64_t; typedef unsigned long uint64_t;
typedef long intptr_t; typedef unsigned long uintptr_t;
typedef long intmax_t; typedef unsigned long uintmax_t;
#define INT8_MIN SCHAR_MIN
#define INT8_MAX SCHAR_MAX
#define UINT8_MAX UCHAR_MAX
#define INT16_MIN INT_MIN
#define INT16_MAX INT_MAX
#define UINT16_MAX UINT_MAX
#define INT32_MIN INT_MIN
#define INT32_MAX INT_MAX
#define UINT32_MAX UINT_MAX
#define INT64_MIN LONG_MIN
#define INT64_MAX LONG_MAX
#define UINT64_MAX ULONG_MAX
#define SIZE_MAX ULONG_MAX
#define INT64_C(x) x##L
#define UINT64_C(x) x##UL
#endif
