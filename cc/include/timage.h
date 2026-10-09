/* timage — PNG (LodePNG), BMP BI_RGB 24/32, PPM P3/P6. Native TRI-27 C.
   Serialized bytes occupy one tryte each, values 0..255. Output is RGBA8,
   likewise one component per tryte: sizeof(char) is NOT an 8-bit byte. */
#ifndef TIMAGE_H
#define TIMAGE_H
#include <stddef.h>
#define TIMAGE_MAX_SOURCE 1900000L
#define TIMAGE_MAX_PIXELS 400000L
#define TIMAGE_MAX_WIDTH 1920
#define TIMAGE_MAX_HEIGHT 1080
enum { TIMAGE_OK=0, TIMAGE_BAD_DATA=1, TIMAGE_UNSUPPORTED=2,
       TIMAGE_TOO_LARGE=3, TIMAGE_NO_MEMORY=4, TIMAGE_DECODE_ERROR=5,
       TIMAGE_NOT_FOUND=6 };
typedef struct { unsigned width,height; unsigned char *rgba; } TImage;
/* Initialize with {0}; free before reusing an already decoded image. On error,
   the output is empty. PNG CRC/Adler validation remains enabled. */
int timage_decode(TImage *out,const unsigned char *data,size_t length);
void timage_free(TImage *image);
const char *timage_error(int error);
/* Optional 3FS adapter: link cc/lib/timage_io.c and cc/lib/sys.tas. */
int timage_load(TImage *out,const char *name);
/* Composite RGBA over packed RGB8 background (R*65536+G*256+B), quantize
   to framebuffer depth 1,9,27. No host Canvas/Image decoder involved. */
long timage_color(const unsigned char *rgba,int depth,long background);
#endif
