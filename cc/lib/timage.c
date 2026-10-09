#include <timage.h>
#include <stdlib.h>
#include <string.h>
#define LODEPNG_NO_COMPILE_DISK
#define LODEPNG_NO_COMPILE_ENCODER
#define LODEPNG_NO_COMPILE_CPP
#define LODEPNG_NO_COMPILE_ANCILLARY_CHUNKS
#define LODEPNG_NO_COMPILE_ERROR_TEXT
#include "../third_party/lodepng/lodepng.h"

static unsigned le16(const unsigned char *p) {return p[0]+256u*p[1];}
static unsigned le32(const unsigned char *p) {return le16(p)+65536u*le16(p+2);}
static long signed32(unsigned v) {return v>=2147483648u?(long)v-4294967296L:v;}
static int dims(unsigned w,unsigned h) {
  return !w||!h||w>TIMAGE_MAX_WIDTH||h>TIMAGE_MAX_HEIGHT||w>TIMAGE_MAX_PIXELS/h;
}
static int allocate(TImage *out,unsigned w,unsigned h) {
  if(dims(w,h))return TIMAGE_TOO_LARGE;
  out->rgba=malloc((size_t)w*h*4);
  if(!out->rgba)return TIMAGE_NO_MEMORY;
  out->width=w;out->height=h;return 0;
}
void timage_free(TImage *out) {
  if(out){free(out->rgba);out->rgba=0;out->width=out->height=0;}
}
static int png(TImage *out,const unsigned char *s,size_t n) {
  LodePNGState state;unsigned w=0,h=0,err;unsigned char *rgba=0;
  lodepng_state_init(&state);
  err=lodepng_inspect(&w,&h,&state,s,n);
  if(err){lodepng_state_cleanup(&state);return TIMAGE_DECODE_ERROR;}
  if(dims(w,h)){lodepng_state_cleanup(&state);return TIMAGE_TOO_LARGE;}
  /* libc currently limits each allocation to 2 Mtrytes. Bound the raw
     decompression, including Adam7 row padding, before decoding anything. */
  size_t raw=(size_t)w*h*lodepng_get_bpp(&state.info_png.color)/8+14u*h+1024;
  if(raw>TIMAGE_MAX_SOURCE){lodepng_state_cleanup(&state);return TIMAGE_TOO_LARGE;}
  state.decoder.zlibsettings.max_output_size=raw;
  state.info_raw.colortype=LCT_RGBA;state.info_raw.bitdepth=8;
  err=lodepng_decode(&rgba,&w,&h,&state,s,n);
  lodepng_state_cleanup(&state);
  if(err){free(rgba);return err==83?TIMAGE_NO_MEMORY:TIMAGE_DECODE_ERROR;}
  out->width=w;out->height=h;out->rgba=rgba;return 0;
}
static int bmp(TImage *out,const unsigned char *s,size_t n) {
  if(n<54)return TIMAGE_BAD_DATA;
  unsigned offset=le32(s+10),header=le32(s+14),bits=le16(s+28);
  long w=signed32(le32(s+18)),height=signed32(le32(s+22));
  if(header<40||header>n-14||offset<14+header||offset>n)return TIMAGE_BAD_DATA;
  if(le16(s+26)!=1||le32(s+30)!=0||(bits!=24&&bits!=32))return TIMAGE_UNSUPPORTED;
  if(w<=0||!height)return TIMAGE_BAD_DATA;
  long h=height<0?-height:height;if(dims(w,h))return TIMAGE_TOO_LARGE;
  size_t stride=((size_t)w*(bits/8)+3)/4*4;
  if(stride*h>n-offset)return TIMAGE_BAD_DATA;
  int e=allocate(out,w,h);if(e)return e;
  for(unsigned y=0;y<h;y++)for(unsigned x=0;x<w;x++) {
    const unsigned char *p=s+offset+(height<0?y:h-1-y)*stride+x*(bits/8);
    unsigned char *q=out->rgba+4*((size_t)y*w+x);
    q[0]=p[2];q[1]=p[1];q[2]=p[0];q[3]=255; /* BI_RGB alpha unspecified. */
  }
  return 0;
}
static int white(int c) {return c==32||c==9||c==10||c==13||c==11||c==12;}
static int token(const unsigned char *s,size_t n,size_t *p,long *v) {
  while(*p<n){if(white(s[*p])){(*p)++;continue;}
    if(s[*p]=='#'){while(*p<n&&s[*p]!=10)(*p)++;continue;}break;}
  if(*p>=n||s[*p]<'0'||s[*p]>'9')return 0;
  long a=0;while(*p<n&&s[*p]>='0'&&s[*p]<='9'){
    if(a>1000000)return 0;a=a*10+s[(*p)++]-'0';}
  if(*p<n&&!white(s[*p])&&s[*p]!='#')return 0;*v=a;return 1;
}
static int ppm(TImage *out,const unsigned char *s,size_t n) {
  size_t p=2;long w,h,max,v;
  if(!token(s,n,&p,&w)||!token(s,n,&p,&h)||!token(s,n,&p,&max))return TIMAGE_BAD_DATA;
  if(max<1||max>255)return TIMAGE_UNSUPPORTED;
  if(dims(w,h))return TIMAGE_TOO_LARGE;
  if(s[1]=='6'){
    if(p>=n||!white(s[p]))return TIMAGE_BAD_DATA;
    if(s[p++]==13&&p<n&&s[p]==10)p++;
    if((size_t)w*h*3>n-p)return TIMAGE_BAD_DATA;
  }
  int e=allocate(out,w,h);if(e)return e;
  for(size_t i=0;i<(size_t)w*h;i++) {
    for(int c=0;c<3;c++) {
      if(s[1]=='6')v=s[p++];else if(!token(s,n,&p,&v)){timage_free(out);return TIMAGE_BAD_DATA;}
      if(v>max){timage_free(out);return TIMAGE_BAD_DATA;}
      out->rgba[4*i+c]=(v*255+max/2)/max;
    }
    out->rgba[4*i+3]=255;
  }
  return 0;
}
int timage_decode(TImage *out,const unsigned char *s,size_t n) {
  if(!out)return TIMAGE_BAD_DATA;out->width=out->height=0;out->rgba=0;
  if(!s||n<2)return TIMAGE_BAD_DATA;
  if(n>TIMAGE_MAX_SOURCE)return TIMAGE_TOO_LARGE;
  for(size_t i=0;i<n;i++)if((long)s[i]<0||s[i]>255)return TIMAGE_BAD_DATA;
  if(n>=8&&s[0]==137&&memcmp(s+1,"PNG\r\n\032\n",7)==0)return png(out,s,n);
  if(s[0]=='B'&&s[1]=='M')return bmp(out,s,n);
  if(s[0]=='P'&&(s[1]=='3'||s[1]=='6'))return ppm(out,s,n);
  return TIMAGE_UNSUPPORTED;
}
long timage_color(const unsigned char *p,int depth,long bg) {
  int a=p[3],v[3];
  v[0]=(p[0]*a+(bg/65536%256)*(255-a)+127)/255;
  v[1]=(p[1]*a+(bg/256%256)*(255-a)+127)/255;
  v[2]=(p[2]*a+(bg%256)*(255-a)+127)/255;
  if(depth==1)return (((54*v[0]+183*v[1]+19*v[2]+128)/256)*2+127)/255-1;
  int base=depth==9?27:19683,half=(base-1)/2;
  for(int i=0;i<3;i++)v[i]=(v[i]*(base-1)+127)/255-half;
  return v[2]+(long)v[1]*base+(long)v[0]*base*base;
}
const char *timage_error(int e) {
  if(e==0)return "OK";if(e==1)return "Donnees invalides ou tronquees";
  if(e==2)return "Format non pris en charge";if(e==3)return "Image trop grande";
  if(e==4)return "Memoire insuffisante";if(e==5)return "Erreur PNG (flux/CRC)";
  return "Fichier introuvable";
}
