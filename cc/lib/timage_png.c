/* LodePNG 20261006, zlib license: see cc/third_party/lodepng/LICENSE.
   Native C build; no filesystem, encoder, C++ or metadata-text dependencies.
   The altered scanline predictor explicitly wraps binary octets on TRI-27. */
#define LODEPNG_NO_COMPILE_DISK
#define LODEPNG_NO_COMPILE_ENCODER
#define LODEPNG_NO_COMPILE_CPP
#define LODEPNG_NO_COMPILE_ANCILLARY_CHUNKS
#define LODEPNG_NO_COMPILE_ERROR_TEXT
#include "../third_party/lodepng/lodepng.cpp"
