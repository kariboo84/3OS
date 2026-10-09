/* Régression native des primitives du bureau : neuf formats, bords, atlas, curseur. */
#include <stdio.h>
#include <dgfx.h>
#include <gpu2d.h>
static int powers[9]={1,3,9,27,81,243,729,2187,6561};
static long raw(int x,int y) {
  long p=(long)y*FB_WIDTH+x;
  char *fb=(char *)FB_ADDR;
  if(dg_depth==27)return ((long *)fb)[p];
  if(dg_depth==9)return fb[p];
  return (fb[p/9]+9841)/powers[p%9]%3-1;
}
int main(void) {
  long anchor,colors[10],bg[864];
  int widths[3]={576,1280,1920},heights[3]={360,720,1080},depths[3]={1,9,27};
  dg_reserve((char *)&anchor-32768);
  for(int r=0;r<3;r++)for(int d=0;d<3;d++) {
    dg_config(widths[r],heights[r],depths[d]);
    long c=dg_depth==1?1:(dg_depth==9?TRGB(13,-13,-13):HD_RGB(9841,-9841,-9841));
    for(int k=0;k<10;k++)colors[k]=c;
    dg_palette(colors); dg_fill(0,0,dg_w,dg_h,0);
    long ops=G_OPS;
    dg_fill(-2,-2,6,6,c); dg_frame(dg_w-4,dg_h-4,6,6,c);
    dg_text(12,14,"A",0);
    int s=dg_scale;
    if(raw(0,0)!=c||raw(4*s,0)!=0||raw(12*s,16*s)!=c||raw(14*s,14*s)!=c) {
      printf("ECHEC %dx%d@%d c=%ld pixels=%ld,%ld,%ld,%ld\n",widths[r],heights[r],depths[d],c,raw(0,0),raw(4*s,0),raw(12*s,16*s),raw(14*s,14*s)); return 1;
    }
    if(raw((dg_w-4)*s,(dg_h-4)*s)!=c)return 2;
    dg_cursor_save(0,0,bg); dg_fill(0,0,8,12,0); dg_cursor_restore(0,0,bg);
    if(raw(0,0)!=c)return 3;
    for(int k=0;k<10;k++)colors[k]=dg_depth==1?-1:-c;
    dg_palette(colors); dg_fill(12,14,6,8,0); dg_text(12,14,"A",0);
    if(raw(12*s,16*s)!=colors[0])return 4;
    if((dg_depth==1&&G_OPS!=ops)||(dg_depth!=1&&G_OPS<=ops))return 5;
    printf("dgfx : %dx%d@%d, echelle %d, GPU %ld commandes, OK\n",widths[r],heights[r],depths[d],s,G_OPS-ops);
  }
  dg_config(123,456,8);
  if(FB_WIDTH!=576||FB_HEIGHT!=360||FB_DEPTH!=27)return 6;
  puts("dgfx : neuf formats + configuration invalide, OK");
  return 0;
}
