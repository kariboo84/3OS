/* Images — vrai fichier 3FS, décodage C TRI-27, pixels natifs 1:1.
 * Une image par processus : libc a encore un allocateur-arène sans free réel. */
#include <3os.h>
#include <timage.h>
#include <dgfx.h>
#include <tri27io.h>
#include <tgfx.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static long palette[10];
static long rgb(int r,int g,int b,int depth) {
  unsigned char p[4]={r,g,b,255};return timage_color(p,depth,0);
}
int main(void) {
  long stack_anchor;dg_reserve((char *)&stack_anchor-32768);
  char config[80]={0},name[17]={0},title[96];
  int w=576,h=360,depth=27;long n=sys_readfile("config",config,79);
  if(n>0){char *p=config;w=strtol(p,&p,10);h=strtol(p,&p,10);depth=strtol(p,&p,10);}
  if(!((w==576&&h==360)||(w==1280&&h==720)||(w==1920&&h==1080))){w=576;h=360;}
  if(depth!=1&&depth!=9&&depth!=27)depth=27;
  n=sys_readfile("image-cible",name,16);if(n<1)strcpy(name,"demo.png");
  else {name[n]=0;while(n>0&&(name[n-1]==10||name[n-1]==13||name[n-1]==' '))name[--n]=0;}
  dg_config(w,h,depth);
  palette[0]=rgb(0,0,0,depth);palette[1]=rgb(255,255,255,depth);
  palette[2]=rgb(214,214,214,depth);palette[3]=rgb(70,70,70,depth);
  for(int i=4;i<10;i++)palette[i]=palette[0];dg_palette(palette);
  dg_fill(0,0,w,h,palette[2]);dg_fill(8,8,w-16,26,palette[1]);
  dg_text(18,16,"Images - lecture PNG / BMP / PPM dans TRI-27",0);FB_PRESENT=1;
  TImage image={0};int e=timage_load(&image,name);
  if(e){snprintf(title,sizeof(title),"%s : %s",name,timage_error(e));dg_text(18,52,title,0);printf("[images] erreur %d : %s\n",e,title);}
  else {
    int x=(w-(int)image.width)/2,y=(h-(int)image.height)/2;
    if(x<8)x=8;if(y<60)y=60;
    int vw=w-x-8,vh=h-y-40;if(vw>image.width)vw=image.width;if(vh>image.height)vh=image.height;
    dg_frame(x-1,y-1,vw+2,vh+2,palette[0]);
    for(int j=0;j<vh;j++)for(int i=0;i<vw;i++) {
      int gray=((i/8+j/8)%2)?224:192;
      long bg=(long)gray*65793;
      dg_pixel(x+i,y+j,timage_color(image.rgba+4*((long)j*image.width+i),depth,bg));
    }
    snprintf(title,sizeof(title),"%s - %u x %u - RGBA - 1:1%s",name,image.width,image.height,
      vw<image.width||vh<image.height?" (zone visible recadree)":"");
    dg_text(18,46,title,0);
    printf("[images] %s %u x %u RGBA native depth=%d origin=%d,%d\n",name,image.width,image.height,depth,x,y);
  }
  dg_fill(8,h-30,w-16,22,palette[1]);dg_text(18,h-24,"Echap : retour au Finder. Aucun decodeur d'images hote.",0);FB_PRESENT=1;
  for(;;){int k=KEY_EVENT;if(k==27||k==13)break;if(CONSOLE_IN=='q')break;wfi();}
  timage_free(&image);return e;
}
