#include <timage.h>
#include <3os.h>
#include <stdlib.h>
int timage_load(TImage *out,const char *name) {
  if(!out)return TIMAGE_BAD_DATA;
  out->width=out->height=0;out->rgba=0;
  if(!name)return TIMAGE_NOT_FOUND;
  long length=sys_filesize(name);
  if(length<0)return TIMAGE_NOT_FOUND;
  if(length<2)return TIMAGE_BAD_DATA;
  if(length>TIMAGE_MAX_SOURCE)return TIMAGE_TOO_LARGE;
  /* One allocation/read: free() remains a no-op in the current libc. */
  unsigned char *data=malloc(length);
  if(!data)return TIMAGE_NO_MEMORY;
  long n=sys_readfile(name,(char *)data,length);
  if(n!=length){free(data);return TIMAGE_BAD_DATA;}
  int e=timage_decode(out,data,n);free(data);return e;
}
