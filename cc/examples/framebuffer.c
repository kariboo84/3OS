#include <stdio.h>
static char pixels[320*200];
int main(void) {
  for(int y=0;y<200;y++) for(int x=0;x<320;x++) {
    int r=x*26/319-13, g=y*26/199-13, b=((x/20+y/20)%2)?13:-13;
    pixels[y*320+x]=r*729+g*27+b;
  }
  *(volatile long*)-5=(long)pixels;
  *(volatile long*)-6=1;
  puts("TRGB: 320x200, one frame presented");
  return 0;
}
