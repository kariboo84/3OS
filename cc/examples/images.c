/* Images — décodage C TRI-27, zoom et déplacement dans le guest.
 * Une image par processus : libc a encore un allocateur-arène sans free réel. */
#include <3os.h>
#include <timage.h>
#include <dgfx.h>
#include <tri27io.h>
#include <tgfx.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static long palette[10],row_dark[1920],row_light[1920];
static TImage image;
static int w=576,h=360,depth=27,zi=3,x,y,sw,sh,view_top;
static const int zooms[9]={25,50,75,100,125,150,200,300,400};
static char name[17],title[128];
static long rgb(int r,int g,int b,int d) {
  unsigned char p[4]={r,g,b,255};return timage_color(p,d,0);
}
static int clamp(int v,int lo,int hi){return v<lo?lo:(v>hi?hi:v);}
static void bounds(void) {
  sw=(long)image.width*zooms[zi]/100;sh=(long)image.height*zooms[zi]/100;
  if(sw<1)sw=1;if(sh<1)sh=1;
  int ex=w-8-sw,ey=h-40-sh;
  x=clamp(x,ex<8?ex:8,ex<8?8:ex);
  y=clamp(y,ey<view_top?ey:view_top,ey<view_top?view_top:ey);
}
static void reset_view(void) {
  zi=3;x=(w-(int)image.width)/2;y=(h-(int)image.height)/2;bounds();
}
static int zoom_to(int target,int mx,int my) {
  target=clamp(target,0,8);if(target==zi)return 0;
  int old=zooms[zi];zi=target;
  /* Garder le point image sous le curseur ; les limites peuvent contraindre les bords. */
  x=mx-(long)(mx-x)*zooms[zi]/old;y=my-(long)(my-y)*zooms[zi]/old;
  bounds();return 1;
}
static void draw_view(void) {
  dg_fill(6,view_top-2,w-12,h-40-view_top+4,palette[2]);
  dg_fill(8,40,w-16,view_top-42,palette[2]);
  int left=x<8?8:x,top=y<view_top?view_top:y;
  int right=x+sw>w-8?w-8:x+sw,bottom=y+sh>h-40?h-40:y+sh;
  dg_frame(left-1,top-1,right-left+2,bottom-top+2,palette[0]);
  long *fb27=(long *)FB_ADDR;char *fb9=(char *)FB_ADDR;int cached=-1;
  /* Cache de scanline : un calcul couleur/alpha par pixel source, pas par copie zoomée. */
  for(int dy=top;dy<bottom;dy++) {
    int sy=(long)(dy-y)*100/zooms[zi];if(sy>=image.height)sy=image.height-1;
    if(sy!=cached) {
      const unsigned char *p=image.rgba+4L*sy*image.width;
      for(int sx=0;sx<image.width;sx++,p+=4) {
        row_dark[sx]=timage_color(p,depth,12632256L);
        row_light[sx]=p[3]==255?row_dark[sx]:timage_color(p,depth,14737632L);
      }
      cached=sy;
    }
    for(int dx=left;dx<right;dx++) {
      int sx=(long)(dx-x)*100/zooms[zi];if(sx>=image.width)sx=image.width-1;
      long c=(((dx-x)/8+(dy-y)/8)%2)?row_light[sx]:row_dark[sx];
      if(depth==27)fb27[(long)dy*w+dx]=c;
      else if(depth==9)fb9[(long)dy*w+dx]=c;
      else dg_pixel(dx,dy,c);
    }
  }
  snprintf(title,sizeof(title),"%s - %u x %u - RGBA - %d%%%s",name,image.width,image.height,
    zooms[zi],zi==3?" (1:1)":"");dg_text(18,46,title,0);
  FB_PRESENT=1;
}
static void view_log(const char *action) {
  printf("[images] %s zoom=%d origin=%d,%d size=%d,%d\n",action,zooms[zi],x,y,sw,sh);
}
int main(void) {
  long stack_anchor;dg_reserve((char *)&stack_anchor-32768);
  char config[80]={0};long n=sys_readfile("config",config,79);
  if(n>0){char *p=config;w=strtol(p,&p,10);h=strtol(p,&p,10);depth=strtol(p,&p,10);}
  if(!((w==576&&h==360)||(w==1280&&h==720)||(w==1920&&h==1080))){w=576;h=360;}
  if(depth!=1&&depth!=9&&depth!=27)depth=27;
  n=sys_readfile("image-cible",name,16);if(n<1)strcpy(name,"demo.png");
  else {name[n]=0;while(n>0&&(name[n-1]==10||name[n-1]==13||name[n-1]==' '))name[--n]=0;}
  dg_config(w,h,depth);view_top=dg_fonth>12?72:60;
  palette[0]=rgb(0,0,0,depth);palette[1]=rgb(255,255,255,depth);
  palette[2]=rgb(214,214,214,depth);palette[3]=rgb(70,70,70,depth);
  for(int i=4;i<10;i++)palette[i]=palette[0];dg_palette(palette);
  dg_fill(0,0,w,h,palette[2]);dg_fill(8,8,w-16,26,palette[1]);
  dg_text(18,16,"Images - lecture PNG / BMP / PPM dans TRI-27",0);FB_PRESENT=1;
  int e=timage_load(&image,name);
  if(e){snprintf(title,sizeof(title),"%s : %s",name,timage_error(e));dg_text(18,52,title,0);printf("[images] erreur %d : %s\n",e,title);}
  dg_fill(8,h-30,w-16,22,palette[1]);
  dg_text(18,h-24,"Molette:zoom | Glisser:deplacer | 0:1:1 | Echap:Finder",0);
  if(!e) {
    reset_view();draw_view();
    printf("[images] %s %u x %u RGBA native depth=%d origin=%d,%d\n",name,image.width,image.height,depth,x,y);
  } else FB_PRESENT=1;
  int prev=0,drag=0,lx=0,ly=0;
  for(;;) {
    int k=KEY_EVENT;if(k==27||k==13)break;if(CONSOLE_IN=='q')break;
    int mx=MOUSE_X,my=MOUSE_Y,left=MOUSE_BTN%3,dirty=0,zoomed=0;
    long wheel=MOUSE_WHEEL;
    if(!e) {
      if(wheel&&mx>=8&&mx<w-8&&my>=view_top&&my<h-40)zoomed=zoom_to(zi-(int)wheel,mx,my);
      /* Ne pas effacer un changement déjà produit par la molette dans ce tour. */
      if((k==187||k==107)&&zoom_to(zi+1,w/2,(view_top+h-40)/2))zoomed=1;
      if((k==189||k==109)&&zoom_to(zi-1,w/2,(view_top+h-40)/2))zoomed=1;
      if(k==48||k==96){reset_view();dirty=1;view_log("reset");}
      if(k>=37&&k<=40){x+=k==37?-32:(k==39?32:0);y+=k==38?-32:(k==40?32:0);bounds();dirty=1;}
      if(left&&!prev) {
        drag=mx>=8&&mx<w-8&&my>=view_top&&my<h-40&&mx>=x&&mx<x+sw&&my>=y&&my<y+sh;
        lx=mx;ly=my;
      }
      if(left&&drag&&(mx!=lx||my!=ly)) {
        int ox=x,oy=y;x+=mx-lx;y+=my-ly;lx=mx;ly=my;bounds();
        if(x!=ox||y!=oy)dirty=1;
      }
      if(!left&&prev&&drag){view_log("pan");drag=0;}
      if(zoomed){dirty=1;view_log("zoom");}
      if(dirty)draw_view();
    }
    prev=left;wfi();
  }
  timage_free(&image);return e;
}
