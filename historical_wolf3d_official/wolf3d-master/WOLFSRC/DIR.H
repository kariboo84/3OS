#ifndef TNA_DIR_H
#define TNA_DIR_H
struct ffblk { char ff_name[13]; };
int findfirst(const char *path, struct ffblk *blk, int attrib);
int findnext(struct ffblk *blk);
#endif
