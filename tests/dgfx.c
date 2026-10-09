/* Neuf formats : pixels 1:1, vraie AA, cache de fond, polices et curseur. */
#include <stdio.h>
#include <dgfx.h>
#include <gpu2d.h>
static int powers[9]={1,3,9,27,81,243,729,2187,6561};
static long raw(int x,int y) {
  long p=(long)y*FB_WIDTH+x;char *fb=(char *)FB_ADDR;
  if(dg_depth==27)return ((long *)fb)[p];if(dg_depth==9)return fb[p];
  return (fb[p/9]+9841)/powers[p%9]%3-1;
}
int main(void) {
  long anchor,colors[10],bg[864],before[400];
  int widths[3]={576,1280,1920},heights[3]={360,720,1080},depths[3]={1,9,27};
  dg_reserve((char *)&anchor-32768);
  for(int r=0;r<3;r++)for(int d=0;d<3;d++) {
    dg_config(widths[r],heights[r],depths[d]);dg_font(0,14,1);
    if(dg_scale!=1||dg_w!=widths[r]||dg_h!=heights[r])return 6;
    if(dg_fontw!=20||dg_fonth!=(r==0?12:20))return 7;
    if(dg_text_width("WWW")<=dg_text_width("iii"))return 10;
    long c=dg_depth==1?1:(dg_depth==9?TRGB(13,-13,-13):HD_RGB(9841,-9841,-9841));
    long b=dg_depth==1?-1:(dg_depth==9?TRGB(-13,-13,-13):HD_RGB(-9841,-9841,-9841));
    for(int k=0;k<10;k++)colors[k]=c;dg_palette(colors);dg_fill(0,0,dg_w,dg_h,0);
    long ops=G_OPS;dg_pixel(23,22,c);
    if(raw(23,22)!=c||raw(24,22)!=0||raw(23,23)!=0)return 8;
    dg_fill(-2,-2,6,6,c);dg_frame(dg_w-4,dg_h-4,6,6,c);
    if(raw(0,0)!=c||raw(4,0)!=0||raw(dg_w-4,dg_h-4)!=c)return 1;
    dg_fill(32,32,20,20,b);dg_text(32,32,"A",0);
    int ink=0,edges=0,nonzoom=0;
    for(int y=0;y<20;y++)for(int x=0;x<20;x++) {
      long v=raw(32+x,32+y);before[y*20+x]=v;
      if(v!=b)ink++;if(v!=b&&v!=c)edges++;
    }
    if(!ink||!edges)return 2; /* Ne peut pas passer avec la vieille fonte 1 bit. */
    for(int y=0;y<20;y+=2)for(int x=0;x<20;x+=2)
      if(raw(32+x,32+y)!=raw(33+x,32+y)||raw(32+x,32+y)!=raw(32+x,33+y))nonzoom++;
    if(!nonzoom)return 9;
    dg_cursor_save(0,0,bg);dg_fill(0,0,16,24,0);dg_cursor_restore(0,0,bg);
    if(raw(0,0)!=c)return 3;
    for(int k=0;k<10;k++)colors[k]=-c;dg_palette(colors);
    dg_fill(32,32,20,20,-b);dg_text(32,32,"A",0);
    for(int y=0;y<20;y++)for(int x=0;x<20;x++)if(raw(32+x,32+y)!=-before[y*20+x])return 4;
    dg_font(0,14,0);dg_fill(32,32,20,20,-b);dg_text(32,32,"A",0);
    for(int y=0;y<20;y++)for(int x=0;x<20;x++) {
      long v=raw(32+x,32+y);if(v!=-b&&v!=-c)return 11;
    }
    dg_font(1,16,1);if(dg_text_width("WWW")!=dg_text_width("iii"))return 12;
    dg_font(0,14,1);
    if((dg_depth==1&&G_OPS!=ops)||(dg_depth!=1&&G_OPS<=ops))return 5;
    printf("dgfx : %dx%d@%d pixels 1:1, AA %d pixels de bord, cache/fonte/curseur OK\n",widths[r],heights[r],depths[d],edges);
  }
  dg_config(123,456,8);if(FB_WIDTH!=576||FB_HEIGHT!=360||FB_DEPTH!=27)return 6;
  puts("dgfx : neuf formats, AA native et configuration invalide, OK");return 0;
}
