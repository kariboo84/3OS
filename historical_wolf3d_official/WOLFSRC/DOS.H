#ifndef TNA_DOS_H
#define TNA_DOS_H
typedef unsigned char byte;
typedef unsigned int word;
typedef unsigned long longword;
union REGS { struct { word ax,bx,cx,dx,si,di,cflag,flags; } x; struct { byte al,ah,bl,bh,cl,ch,dl,dh; } h; };
struct SREGS { word es,cs,ss,ds; };
struct diskfree_t { unsigned total_clusters; unsigned avail_clusters; unsigned sectors_per_cluster; unsigned bytes_per_sector; };
struct dostime_t { unsigned hour, minute, second, hsecond; };
void int86(int intno, union REGS *inregs, union REGS *outregs);
void int86x(int intno, union REGS *inregs, union REGS *outregs, struct SREGS *segregs);
void segread(struct SREGS *segregs);
void delay(int ms);
void getdfree(int drive, struct diskfree_t *info);
void _dos_gettime(struct dostime_t *time);
#endif
