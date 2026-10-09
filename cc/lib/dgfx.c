/* dgfx.c — framebuffer sous la pile ; pas de boucle CPU plein écran en couleur. */
#include <dgfx.h>
#include <gpu2d.h>
#include <tgfx.h>
#include <ui_font.h>

int dg_w = 576, dg_h = 360, dg_scale = 1, dg_depth = 27;
int dg_fontw=20,dg_fonth=12;
static int pw=576,ph=360,font_face,font_size=14,font_slot,font_aa=1;
static long bg_colors[10];
static int bg_count,bg_next,built[100];
static void invalidate(void) { bg_count=0;bg_next=0;for(int i=0;i<100;i++)built[i]=0; }
void dg_font(int face,int size,int aa) {
  if(face<0||face>1)face=0;if(size!=14&&size!=16)size=14;
  int slot=pw==576?0:(size==14?1:2);
  if(face!=font_face||slot!=font_slot||aa!=font_aa)invalidate();
  font_face=face;font_size=size;font_slot=slot;font_aa=aa!=0;
  dg_fontw=20;dg_fonth=pw==576?12:20;
}
static char *screen, *atlas;
static long palette[10], key;
static int pow3[9] = {1,3,9,27,81,243,729,2187,6561};

void dg_reserve(char *top) {
  /* Réserve maximale 1080p profond + atlas natif, sous la pile. */
  top -= (long)top % 3;  /* Alignement des mots de profondeur 27. */
  screen = top - 1920L * 1080 * 3;
  atlas = screen - 1900L * 2000 * 3; /* 10 fonds × 10 encres, atlas paresseux. */
}
void dg_config(int w, int h, int depth) {
  if(!((w==576&&h==360)||(w==1280&&h==720)||(w==1920&&h==1080))) { w=576; h=360; }
  if(depth!=1&&depth!=9&&depth!=27)depth=27;
  pw=w; ph=h; dg_depth=depth; dg_scale=1;
  dg_w=w; dg_h=h;
  invalidate();dg_font(font_face,font_size,font_aa);
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
  for(int k=0;k<10;k++){if(palette[k]!=colors[k])invalidate();palette[k]=colors[k];}
  key=dg_depth==9?TRGB(13,-13,13):HD_RGB(9841,-9841,9841);
}
static int coverage(int c,int x,int y) {
  int p=UI_ALPHA[font_face][font_slot][c][x*7+y/3];
  int a=(p+9841)/(y%3==0?1:(y%3==1?27:729))%27;
  return font_aa?a:(a>=13?26:0);
}
static void channels(long c,int base,int *v) {
  int half=(base-1)/2;
  v[2]=(c%base+base+half)%base-half;
  c=(c-v[2])/base;v[1]=(c%base+base+half)%base-half;v[0]=(c-v[1])/base;
}
static long blend(long fg,long bg,int a) {
  if(dg_depth==1)return ((fg+1)*a+(bg+1)*(26-a)+13)/26-1;
  int base=dg_depth==9?27:19683,half=(base-1)/2,f[3],b[3],v[3];
  channels(fg,base,f);channels(bg,base,b);
  for(int i=0;i<3;i++)v[i]=((f[i]+half)*a+(b[i]+half)*(26-a)+13)/26-half;
  return v[2]+(long)v[1]*base+(long)v[0]*base*base;
}
static int atlas_row(long bg,int k) {
  int slot=-1;
  for(int i=0;i<bg_count;i++)if(bg_colors[i]==bg)slot=i;
  if(slot<0) {
    slot=bg_count<10?bg_count++:bg_next++%10;bg_colors[slot]=bg;
    for(int i=0;i<10;i++)built[slot*10+i]=0;
  }
  int row=slot*10+k;
  if(!built[row]) {
    long colors[27];for(int a=0;a<27;a++)colors[a]=blend(palette[k],bg,a);
    gpu_dst((long *)atlas,1900,2000);gpu_fill(0,row*20,1900,20,key);
    for(int c=0;c<95;c++)for(int x=0;x<UI_ADV[font_face][font_slot][c];x++) {
      int y=0;
      while(y<dg_fonth) {
        int a=coverage(c,x,y),start=y++;while(y<dg_fonth&&coverage(c,x,y)==a)y++;
        if(a)gpu_fill(c*20+x,row*20+start,1,y-start,colors[a]);
      }
    }
    built[row]=1;gpu_dst(0,pw,ph);
  }
  return row;
}
int dg_char_width(int c) { return c<32||c>126?0:UI_ADV[font_face][font_slot][c-32]; }
int dg_text_width(const char *s) {
  int n=0;for(;*s;s++){int c=*s;if(c>=32&&c<=126)n+=UI_ADV[font_face][font_slot][c-32];}
  return n;
}
void dg_text(int x,int y,const char *s,int k) {
  if(!s||!*s||k<0||k>=10||y>=dg_h||y+dg_fonth<=0)return;
  int px=x<0?0:(x>=pw?pw-1:x),py=y<0?0:y;
  long bg=get_raw((long)py*pw+px);
  int row=dg_depth==1?0:atlas_row(bg,k);
  if(dg_depth!=1){gpu_src((long *)atlas,1900,2000);G_COLOR=key;G_H=dg_fonth;G_Y=y;G_SY=row*20;}
  for(;*s;s++) {
    int c=*s;if(c<32||c>126)continue;c-=32;
    int advance=UI_ADV[font_face][font_slot][c];
    if(x>=dg_w)break;
    if(dg_depth==1) {
      for(int q=0;q<advance;q++)for(int r=0;r<dg_fonth;r++) {
        int a=coverage(c,q,r);
        if(a&&x+q>=0&&x+q<pw&&y+r>=0&&y+r<ph) {
          long p=(long)(y+r)*pw+x+q;set_raw(p,blend(palette[k],get_raw(p),a));
        }
      }
    } else if(c&&x+advance>0){G_W=advance;G_X=x;G_SX=c*20;G_CMD=GPU_COPY_KEY;}
    x+=advance;
  }
}
void dg_cursor_save(int x,int y,long *bg) {
  int n=0;
  for(int r=0;r<12*(pw==576?1:2);r++)
    for(int q=0;q<8*(pw==576?1:2);q++,n++)
      if(y*dg_scale+r>=0&&x*dg_scale+q>=0&&y*dg_scale+r<ph&&x*dg_scale+q<pw)
        bg[n]=get_raw((long)(y*dg_scale+r)*pw+x*dg_scale+q);
}
void dg_cursor_restore(int x,int y,const long *bg) {
  int n=0;
  for(int r=0;r<12*(pw==576?1:2);r++)
    for(int q=0;q<8*(pw==576?1:2);q++,n++)
      if(y*dg_scale+r>=0&&x*dg_scale+q>=0&&y*dg_scale+r<ph&&x*dg_scale+q<pw)
        set_raw((long)(y*dg_scale+r)*pw+x*dg_scale+q,bg[n]);
}
