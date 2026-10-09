/* dgfx.c — framebuffer sous la pile ; pas de boucle CPU plein écran en couleur. */
#include <dgfx.h>
#include <gpu2d.h>
#include <tgfx.h>

int dg_w = 576, dg_h = 360, dg_scale = 1, dg_depth = 27;
static int pw = 576, ph = 360, atlas_w, atlas_depth, atlas_scale;
static char *screen, *atlas;
static long palette[10], key;
static int pow3[9] = {1,3,9,27,81,243,729,2187,6561};

void dg_reserve(char *top) {
  /* Maximum 1080p profond + atlas 570×80 logique à l'échelle 3, sous la réserve pile. */
  top -= (long)top % 3;  /* Alignement des mots de profondeur 27. */
  screen = top - 1920L * 1080 * 3;
  atlas = screen - 1710L * 240 * 3;
}
void dg_config(int w, int h, int depth) {
  if(!((w==576&&h==360)||(w==1280&&h==720)||(w==1920&&h==1080))) { w=576; h=360; }
  if(depth!=1&&depth!=9&&depth!=27)depth=27;
  pw=w; ph=h; dg_depth=depth; dg_scale=w==576?1:(w==1280?2:3);
  dg_w=w/dg_scale; dg_h=h/dg_scale;
  FB_WIDTH=w; FB_HEIGHT=h; FB_DEPTH=depth; VMODE=3; FB_ADDR=(long)screen;
  G_DEPTH=depth; gpu_dst(0,w,h);
}
static long get_raw(long p) {
  if(dg_depth==27)return ((long *)screen)[p];
  if(dg_depth==9)return screen[p];
  return (screen[p/9]+9841)/pow3[p%9]%3-1;
}
static void set_raw(long p,long c) {
  if(dg_depth==27) { ((long *)screen)[p]=c; return; }
  if(dg_depth==9) { screen[p]=c; return; }
  char *a=screen+p/9; int v=*a, power=pow3[p%9];
  *a=v+(c-((v+9841)/power%3-1))*power;
}
void dg_pixel(int x,int y,long c) {
  if(x<0||y<0||x>=dg_w||y>=dg_h)return;
  for(int r=0;r<dg_scale;r++)
    for(int q=0;q<dg_scale;q++)set_raw((long)(y*dg_scale+r)*pw+x*dg_scale+q,c);
}
void dg_fill(int x,int y,int w,int h,long c) {
  int x1=x+w,y1=y+h;
  if(x<0)x=0; if(y<0)y=0; if(x1>dg_w)x1=dg_w; if(y1>dg_h)y1=dg_h;
  if(x>=x1||y>=y1)return;
  if(dg_depth!=1) {
    gpu_fill(x*dg_scale,y*dg_scale,(x1-x)*dg_scale,(y1-y)*dg_scale,c); return;
  }
  /* Empaquetage continu, même lorsque la largeur n'est pas multiple de neuf. */
  for(int r=y*dg_scale;r<y1*dg_scale;r++) {
    long p=(long)r*pw+x*dg_scale,end=(long)r*pw+x1*dg_scale;
    while(p<end&&p%9) { set_raw(p,c); p++; }
    char *a=screen+p/9; long full=(end-p)/9;
    while(full-->0) { *a++=c*9841; p+=9; }
    while(p<end) { set_raw(p,c); p++; }
  }
}
void dg_frame(int x,int y,int w,int h,long c) {
  if(w<1||h<1)return;
  dg_fill(x,y,w,1,c); dg_fill(x,y+h-1,w,1,c);
  dg_fill(x,y,1,h,c); dg_fill(x+w-1,y,1,h,c);
}
void dg_palette(const long *colors) {
  int changed=0;
  for(int k=0;k<10;k++) { if(palette[k]!=colors[k])changed=1; palette[k]=colors[k]; }
  if(dg_depth==1)return;
  if(!changed&&atlas_depth==dg_depth&&atlas_scale==dg_scale)return;
  atlas_depth=dg_depth; atlas_scale=dg_scale; atlas_w=570*dg_scale;
  key=dg_depth==9?TRGB(13,-13,13):HD_RGB(9841,-9841,9841);
  gpu_dst((long *)atlas,atlas_w,80*dg_scale);
  gpu_fill(0,0,atlas_w,80*dg_scale,key);
  for(int k=0;k<10;k++)
    for(int c=0;c<95;c++)
      for(int q=0;q<5;q++) {
        int b=TG_FONT[c*5+q],r=0;
        while(b) {
          if(b%2) {
            int start=r;
            do { b/=2; r++; } while(b%2);
            gpu_fill((c*6+q)*dg_scale,(k*8+start)*dg_scale,dg_scale,(r-start)*dg_scale,palette[k]);
          } else { b/=2; r++; }
        }
      }
  gpu_dst(0,pw,ph);
}
void dg_text(int x,int y,const char *s,int k) {
  if(k<0||k>=10||y>=dg_h||y+8<=0)return;
  if(dg_depth==1) {
    for(;*s;s++,x+=6) {
      int c=*s; if(c<32||c>126)continue;
      for(int q=0;q<5;q++)
        for(int b=TG_FONT[(c-32)*5+q],r=0;b;b/=2,r++)
          if(b%2)dg_pixel(x+q,y+r,palette[k]);
    }
    return;
  }
  gpu_src((long *)atlas,atlas_w,80*dg_scale);
  G_COLOR=key; G_W=6*dg_scale; G_H=8*dg_scale; G_Y=y*dg_scale; G_SY=k*8*dg_scale;
  for(;*s;s++,x+=6) {
    if(x>=dg_w)break;
    int c=*s; if(c<=32||c>126||x+6<=0)continue;
    G_X=x*dg_scale; G_SX=(c-32)*6*dg_scale; G_CMD=GPU_COPY_KEY;
  }
}
void dg_cursor_save(int x,int y,long *bg) {
  int n=0;
  for(int r=0;r<12*dg_scale;r++)
    for(int q=0;q<8*dg_scale;q++,n++)
      if(y*dg_scale+r>=0&&x*dg_scale+q>=0&&y*dg_scale+r<ph&&x*dg_scale+q<pw)
        bg[n]=get_raw((long)(y*dg_scale+r)*pw+x*dg_scale+q);
}
void dg_cursor_restore(int x,int y,const long *bg) {
  int n=0;
  for(int r=0;r<12*dg_scale;r++)
    for(int q=0;q<8*dg_scale;q++,n++)
      if(y*dg_scale+r>=0&&x*dg_scale+q>=0&&y*dg_scale+r<ph&&x*dg_scale+q<pw)
        set_raw((long)(y*dg_scale+r)*pw+x*dg_scale+q,bg[n]);
}
