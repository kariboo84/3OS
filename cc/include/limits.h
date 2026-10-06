#ifndef TRI_LIMITS_H
#define TRI_LIMITS_H
/* Not a binary C byte: CHAR_TRITS is the exact width; CHAR_BIT is the
   largest binary payload that fits every nonnegative char value. */
#define CHAR_TRITS 9
#define WORD_TRITS 27
#define CHAR_BIT 13
#define SCHAR_MIN (-9841)
#define SCHAR_MAX 9841
#define UCHAR_MAX 19682
#define CHAR_MIN SCHAR_MIN
#define CHAR_MAX SCHAR_MAX
#define SHRT_MIN (-3812798742493L)
#define SHRT_MAX 3812798742493L
#define USHRT_MAX 7625597484986UL
#define INT_MIN SHRT_MIN
#define INT_MAX SHRT_MAX
#define UINT_MAX USHRT_MAX
#define LONG_MIN SHRT_MIN
#define LONG_MAX SHRT_MAX
#define ULONG_MAX USHRT_MAX
#define LLONG_MIN SHRT_MIN
#define LLONG_MAX SHRT_MAX
#define ULLONG_MAX USHRT_MAX
#endif
