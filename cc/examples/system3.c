/* system3.c — bureau 3OS, chrome gris System 7 et accents TRGB.
 * C : couleur / trois niveaux de gris. Clic : selection, double-clic / Entree : ouvrir.
 * Menus, fenetres mobiles/redimensionnables, defilement. F2 : editeur. Q : quitter.
 * Pas de fausse corbeille : 3FS ne propose pas encore de suppression.
 *
 * Curseur : le framebuffer contient TOUJOURS le curseur. Avant tout dessin on le
 * retire (cur_hide = restaure le fond sauvegardé), après on le remet (cur_show =
 * sauvegarde le fond à la position courante puis dessine), puis on présente.
 * Pas de & | << >> (émulés, lents) : bitmaps en chaînes, bouton gauche = btn % 3.
 */
#include <stdio.h>
#include <string.h>
#include <tri27io.h>
#include <tgfx.h>
#include <dgfx.h>
#include <3os.h>

static int mode = 2;
static int display_res=0,display_depth=27,color_depth=27,display_saved;
static const int widths[3]={576,1280,1920},heights[3]={360,720,1080},depths[3]={1,9,27};

/* ---------- couleurs logiques ---------- */
#define K_BLACK 0
#define K_GRAY  1
#define K_WHITE 2
#define K_TITLE 3
#define K_DESK  4
#define K_ACCENT 5
#define K_LIGHT 6
#define K_DARK 7
#define K_BLUE 8
#define K_GREEN 9
static long rgb(int r,int g,int b) {
  if(display_depth==27)return HD_RGB(r*757L,g*757L,b*757L);
  return TRGB(r,g,b);
}
static long col(int k) {
  if (display_depth == 1) {
    if (k == K_BLACK || k == K_DARK || k == K_BLUE) return TG_BLACK;
    if (k == K_WHITE || k == K_LIGHT) return TG_WHITE;
    return TG_GRAY;
  }
  if (k == K_BLACK) return rgb(-11,-11,-10);
  if (k == K_GRAY) return rgb(6,6,6);
  if (k == K_WHITE) return rgb(13,13,12);
  if (k == K_LIGHT) return rgb(10,10,10);
  if (k == K_DARK) return rgb(-3,-3,-2);
  if (k == K_TITLE) return rgb(8,8,8);
  if (k == K_DESK) return rgb(-1,2,3);
  if (k == K_BLUE) return rgb(-7,-2,7);
  if (k == K_GREEN) return rgb(-7,3,0);
  return rgb(10,5,-5);
}

/* ---------- primitives en coordonnées logiques ---------- */
static void pset(int x,int y,int k) { dg_pixel(x,y,col(k)); }
static void fill(int x,int y,int w,int h,int k) { dg_fill(x,y,w,h,col(k)); }
static void frame(int x,int y,int w,int h,int k) { dg_frame(x,y,w,h,col(k)); }
static void text(int x,int y,const char *s,int k) { dg_text(x,y,s,k); }
static void bevel(int x,int y,int w,int h) {
  frame(x,y,w,h,K_BLACK); fill(x+1,y+1,w-2,h-2,K_LIGHT);
  fill(x+1,y+1,w-2,1,K_WHITE); fill(x+1,y+1,1,h-2,K_WHITE);
  fill(x+2,y+h-2,w-3,1,K_DARK); fill(x+w-2,y+2,1,h-3,K_DARK);
}
static void fittext(int x,int y,const char *s,int width,int k) {
  char b[96]; int n=width/6,i=0;
  if(n>95)n=95; if(n<1)return;
  while(s[i]&&i<n) { b[i]=s[i]; i++; }
  if(s[i]&&n>3) { b[n-3]='.'; b[n-2]='.'; b[n-1]='.'; }
  b[i]=0; text(x,y,b,k);
}
static int in(int x,int y,int rx,int ry,int rw,int rh) {
  return x>=rx&&x<rx+rw&&y>=ry&&y<ry+rh;
}
static void present(void) { FB_PRESENT = 0; }

/* ---------- curseur flèche 8x12 ---------- */
static const char *ARROW[12] = {
  "X.......", "XX......", "XoX.....", "XooX....", "XoooX...", "XooooX..",
  "XoooooX.", "XooooXXX", "XoXooX..", "XX.XooX.", "X..XooX.", "....XX..",
};
static int cx = 288, cy = 180, shown = 0, sx, sy;
static long cursor_bg[8*12*3*3];

static void cur_hide(void) {
  if (!shown) return;
  dg_cursor_restore(sx,sy,cursor_bg);
  shown = 0;
}
static void cur_show(void) {
  sx = cx; sy = cy;
  dg_cursor_save(sx,sy,cursor_bg);
  for (int r = 0; r < 12; r++)
    for (int q = 0; q < 8; q++) {
      char c = ARROW[r][q];
      if (c == 'X') pset(cx + q, cy + r, K_BLACK);
      else if (c == 'o') pset(cx + q, cy + r, K_WHITE);
    }
  shown = 1;
}

/* Real disk content, not painted application names. */
typedef struct { int x,y,w,h,open,scroll; const char *title; } Win;
#define NWINS 4
static Win win[NWINS]={
  {24,38,304,258,1,0,"Disque 3OS"},
  {344,110,200,190,1,0,"Lisez-moi"},
  {143,90,290,184,0,0,"A propos de 3OS"},
  {143,80,290,208,0,0,"Affichage"}};
static int order[NWINS]={1,2,3,0},selected=0,menu=-1;
static char names[24][16],readme[2188];
static long kinds[24],nfiles;
static char status[96]="Double-clic ou Entree pour ouvrir.";
static int read_lines,quit;
static int whitespace(int c) { return c==' '||c==10||c==13||c==9; }
static void load_config(void) {
  char b[64]; long n=sys_readfile("config",b,63);
  int values[3],p=0,valid=n>0&&n<63;
  display_res=0; display_depth=27; display_saved=0;
  if(valid) {
    b[n]=0;
    for(int i=0;i<3&&valid;i++) {
      while(whitespace(b[p]))p++;
      int v=0,start=p;
      while(b[p]>='0'&&b[p]<='9') {
        v=v*10+b[p++]-'0'; if(v>10000) { valid=0; break; }
      }
      if(p==start||(!whitespace(b[p])&&b[p]!=0))valid=0;
      values[i]=v;
    }
    while(whitespace(b[p]))p++;
    if(p!=n)valid=0;  /* Rejeter aussi les NUL internes et les suffixes. */
    if(valid) {
      valid=0;
      for(int i=0;i<3;i++)if(values[0]==widths[i]&&values[1]==heights[i]) { display_res=i; valid=1; }
      if(values[2]!=1&&values[2]!=9&&values[2]!=27)valid=0;
    }
    if(valid) { display_depth=values[2]; display_saved=1; }
    else display_res=0;
  }
  if(display_depth!=1)color_depth=display_depth;
}
static int save_config(void) {
  char b[64]; sprintf(b,"%d %d %d\n",widths[display_res],heights[display_res],display_depth);
  long n=strlen(b); return sys_writefile("config",b,n)==n;
}

static int rows(int j) { return j==0?(win[0].h-68)/17:(win[1].h-56)/12; }
static int row_y(int i) { return win[0].y+43+(i-win[0].scroll)*17; }
static void load_disk(void) {
  nfiles=0;
  for(long i=0;i<24;i++) {
    long k=sys_readdir(i,names[nfiles]); if(!k)break;
    kinds[nfiles++]=k;
  }
  long n=sys_readfile("lisez-moi",readme,2187); readme[n>0?n:0]=0;
  if(selected>=nfiles)selected=nfiles-1;
  win[1].scroll=0;
}
static int active(void) {
  for(int i=NWINS-1;i>=0;i--)if(win[order[i]].open)return order[i];
  return -1;
}
static void front(int j) {
  int p=0; while(p<NWINS&&order[p]!=j)p++;
  for(;p<NWINS-1;p++)order[p]=order[p+1]; order[NWINS-1]=j; win[j].open=1;
}
static void ensure_selection(void) {
  int *s=&win[0].scroll,n=rows(0);
  if(selected<*s)*s=selected;
  if(selected>=*s+n)*s=selected-n+1;
  if(*s<0)*s=0;
}
static void small_icon(int x,int y,int kind,int accent) {
  if(kind==1) {
    frame(x,y,12,11,K_BLACK); fill(x+1,y+1,10,9,K_WHITE);
    fill(x+1,y+1,10,3,accent); fill(x+3,y+5,3,3,accent);
    fill(x+7,y+5,3,1,K_DARK); fill(x+7,y+7,3,1,K_DARK);
  } else {
    frame(x+1,y,9,12,K_BLACK); fill(x+2,y+1,7,10,K_WHITE);
    fill(x+3,y+4,5,1,K_GRAY); fill(x+3,y+7,5,1,K_GRAY);
  }
}
static void desktop_icon(int x,int y,int help) {
  if(!help) {
    bevel(x,y,34,29); frame(x+5,y+4,24,10,K_BLACK);
    fill(x+6,y+5,22,8,K_WHITE); fill(x+8,y+7,4,4,K_ACCENT);
    fill(x+6,y+21,21,2,K_DARK); fill(x+26,y+21,2,2,K_GREEN);
  } else {
    frame(x+5,y,24,30,K_BLACK); fill(x+6,y+1,22,28,K_WHITE);
    fill(x+8,y+3,18,4,K_BLUE); text(x+15,y+10,"?",K_BLUE);
    fill(x+10,y+22,14,1,K_GRAY); fill(x+10,y+25,10,1,K_GRAY);
  }
  int tx=x+(help?-1:7),tw=help?36:20;
  fill(tx-2,y+34,tw+4,11,K_LIGHT); text(tx,y+36,help?"Aide":"3OS",K_BLACK);
}
static void scroll_bar(int j,int total,int count) {
  Win *w=&win[j]; int x=w->x+w->w-15,y=w->y+39,h=w->h-57;
  fill(x,y,14,h,K_LIGHT); frame(x,y,14,h,K_DARK);
  bevel(x,y,14,13); text(x+4,y+3,"^",K_BLACK);
  bevel(x,y+h-13,14,13); text(x+4,y+h-10,"v",K_BLACK);
  int track=h-28,thumb=total>count?track*count/total:track;
  if(thumb<9)thumb=9; if(thumb>track)thumb=track;
  int pos=total>count?(track-thumb)*w->scroll/(total-count):0;
  bevel(x+2,y+14+pos,10,thumb);
}
/* Wrap disk text at word boundaries without dropping right-edge characters. */
static void read_content(Win *w) {
  const char *p=readme; int ln=0,n=(w->w-34)/6;
  if(n>85)n=85;
  while(*p) {
    char b[90]; int k=0,space=-1;
    while(p[k]&&p[k]!=10&&k<n) { b[k]=p[k]; if(p[k]==' ')space=k; k++; }
    int step=k;
    if(p[k]&&p[k]!=10&&k==n&&space>0) { k=space; step=space+1; }
    else if(p[k]==10)step++;
    b[k]=0;
    if(ln>=w->scroll&&ln<w->scroll+rows(1))text(w->x+10,w->y+43+(ln-w->scroll)*12,b,K_BLACK);
    p+=step; ln++;
  }
  read_lines=ln;
}
static void draw_window(int j) {
  Win *w=&win[j]; if(!w->open)return;
  int a=active()==j;
  fill(w->x+3,w->y+3,w->w,w->h,K_DARK); bevel(w->x,w->y,w->w,w->h);
  fill(w->x+2,w->y+2,w->w-4,17,K_LIGHT);
  if(a)for(int r=4;r<17;r+=3)fill(w->x+4,w->y+r,w->w-8,1,K_DARK);
  int tw=tg_textw(w->title)+12,tx=w->x+(w->w-tw)/2;
  fill(tx,w->y+3,tw,13,K_LIGHT); text(tx+6,w->y+6,w->title,a?K_BLACK:K_DARK);
  fill(w->x+5,w->y+3,14,13,K_LIGHT); bevel(w->x+7,w->y+5,10,10);
  fill(w->x,w->y+19,w->w,1,K_BLACK);
  fill(w->x+2,w->y+20,w->w-4,w->h-22,K_WHITE);
  if(j==3) {
    static const char *resolution[3]={"576 x 360","1280 x 720","1920 x 1080"};
    static const char *depth[3]={"1 trit / gris","9 trits / TRGB","27 trits / RGB"};
    text(w->x+16,w->y+38,"Resolution",K_BLACK);
    text(w->x+164,w->y+38,"Profondeur",K_BLACK);
    for(int i=0;i<3;i++) {
      int y=w->y+58+i*24;
      bevel(w->x+16,y,126,20); bevel(w->x+164,y,110,20);
      if(display_res==i)frame(w->x+17,y+1,124,18,K_BLUE);
      if(display_depth==depths[i])frame(w->x+165,y+1,108,18,K_BLUE);
      text(w->x+22,y+6,display_res==i?"*":" ",K_BLUE);
      text(w->x+34,y+6,resolution[i],K_BLACK);
      text(w->x+170,y+6,display_depth==depths[i]?"*":" ",K_BLUE);
      text(w->x+182,y+6,depth[i],K_BLACK);
    }
    char b[64]; sprintf(b,"%dx%d @ %d trits / %dx",widths[display_res],heights[display_res],display_depth,dg_scale);
    text(w->x+16,w->y+134,b,K_DARK);
    text(w->x+16,w->y+151,display_saved?"Applique et sauvegarde sur 3FS.":"Configuration non sauvegardee.",K_DARK);
    bevel(w->x+w->w-68,w->y+w->h-30,54,19); text(w->x+w->w-47,w->y+w->h-24,"OK",K_BLACK);
    return;
  }
  if(j==2) {
    fill(w->x+14,w->y+36,48,44,K_BLUE);
    text(w->x+20,w->y+47,"- 0 +",K_WHITE); text(w->x+29,w->y+62,"3OS",K_WHITE);
    text(w->x+78,w->y+37,"3OS / TRI-27",K_BLACK);
    text(w->x+78,w->y+53,"Un ordinateur ternaire.",K_DARK);
    text(w->x+78,w->y+69,"27 registres. 3 etats.",K_DARK);
    text(w->x+16,w->y+96,"Noyau C, processus isoles, disque 3FS.",K_BLACK);
    char b[64]; sprintf(b,"%ld fichiers / %ld processus vivants",nfiles,sys_procs());
    text(w->x+16,w->y+112,b,K_BLACK);
    bevel(w->x+w->w-68,w->y+w->h-30,54,19); text(w->x+w->w-47,w->y+w->h-24,"OK",K_BLACK);
    return;
  }
  fill(w->x+2,w->y+20,w->w-4,18,K_LIGHT);
  char b[64];
  if(j==0)sprintf(b,"3FS  /  %ld fichiers",nfiles);
  else strcpy(b,"Document texte / disque 3OS");
  fittext(w->x+10,w->y+26,b,w->w-25,K_DARK);
  fill(w->x+2,w->y+38,w->w-4,1,K_GRAY);
  if(j==0) {
    for(int i=w->scroll;i<nfiles&&i<w->scroll+rows(0);i++) {
      int y=row_y(i),sel=i==selected;
      if(sel)fill(w->x+4,y-2,w->w-21,16,a?K_BLUE:K_LIGHT);
      small_icon(w->x+10,y,kinds[i],i%3==0?K_BLUE:(i%3==1?K_ACCENT:K_GREEN));
      char name[24];
      if(i<9)sprintf(name,"%d %s",i+1,names[i]); else { strcpy(name,"  "); strcpy(name+2,names[i]); }
      fittext(w->x+30,y+2,name,w->w-121,sel&&a?K_WHITE:K_BLACK);
      fittext(w->x+w->w-86,y+2,kinds[i]==1?"Appli":"Texte",60,sel&&a?K_WHITE:K_DARK);
    }
    scroll_bar(0,nfiles,rows(0));
  } else { read_content(w); scroll_bar(1,read_lines,rows(1)); }
  fill(w->x+2,w->y+w->h-17,w->w-4,15,K_LIGHT);
  fill(w->x+2,w->y+w->h-18,w->w-4,1,K_GRAY);
  fittext(w->x+8,w->y+w->h-12,j==0?status:"F2 : ouvrir dans l'editeur",w->w-28,K_DARK);
  for(int d=0;d<3;d++)fill(w->x+w->w-12+d*3,w->y+w->h-4-d*3,9-d*3,1,K_DARK);
}
#define NMENUS 5
static int menu_x[NMENUS]={5,44,110,182,236},menu_w[NMENUS]={32,60,66,48,78};
static int menu_count[NMENUS]={1,4,4,2,1};
static const char *menu_label[NMENUS][4]={
  {"A propos de 3OS",0,0,0},
  {"Ouvrir          Entree","Lire le document","Fermer la fenetre","Quitter le bureau   Q"},
  {"Couleur TRGB        C","Gris : 3 niveaux   C","Ranger les fenetres","Actualiser le disque"},
  {"Lisez-moi","Modifier le texte  F2",0,0},
  {"Affichage...",0,0,0}};
static void menubar(void) {
  fill(0,0,dg_w,20,K_LIGHT); fill(0,20,dg_w,1,K_BLACK); fill(0,0,dg_w,1,K_WHITE);
  for(int i=0;i<NMENUS;i++)if(menu==i)fill(menu_x[i],1,menu_w[i],19,K_BLUE);
  text(10,7,"3OS",menu==0?K_WHITE:K_BLACK);
  text(48,7,"Fichier",menu==1?K_WHITE:K_BLACK);
  text(114,7,"Bureau",menu==2?K_WHITE:K_BLACK);
  text(186,7,"Aide",menu==3?K_WHITE:K_BLACK);
  text(240,7,"Preferences",menu==4?K_WHITE:K_BLACK);
  text(dg_w-99,7,mode==2?(display_depth==27?"Couleur / RGB":"Couleur / TRGB"):"Gris / 3 trits",K_DARK);
}
static void draw_menu(void) {
  if(menu<0)return;
  int x=menu_x[menu],h=menu_count[menu]*20+6;
  fill(x+2,23,158,h,K_DARK); fill(x,21,158,h,K_WHITE); frame(x,21,158,h,K_BLACK);
  for(int i=0;i<menu_count[menu];i++) {
    int hover=in(cx,cy,x+1,24+i*20,156,20);
    if(hover)fill(x+1,24+i*20,156,20,K_BLUE);
    text(x+8,30+i*20,menu_label[menu][i],hover?K_WHITE:K_BLACK);
    if(menu==2&&((i==0&&mode==2)||(i==1&&mode==1)))text(x+145,30+i*20,"*",hover?K_WHITE:K_BLACK);
  }
}
static void draw_all(void) {
  fill(0,21,dg_w,dg_h-21,K_DESK);
  if(mode==1)for(int y=21;y<dg_h;y+=2)fill(0,y,dg_w,1,K_WHITE);
  desktop_icon(dg_w-58,38,0); desktop_icon(dg_w-58,dg_h-75,1);
  text(16,dg_h-30,"3OS",mode==2?K_WHITE:K_BLACK);
  text(16,dg_h-16,"TRI-27 / -1 0 +1",mode==2?K_LIGHT:K_BLACK);
  for(int i=0;i<NWINS;i++)draw_window(order[i]); menubar(); draw_menu();
}
static void apply_display(void) {
  shown=0;
  dg_config(widths[display_res],heights[display_res],display_depth);
  mode=display_depth==1?1:2;
  long colors[10]; for(int k=0;k<10;k++)colors[k]=col(k); dg_palette(colors);
  for(int j=0;j<NWINS;j++) {
    Win *w=&win[j];
    if(w->w>dg_w-4)w->w=dg_w-4; if(w->h>dg_h-26)w->h=dg_h-26;
    if(w->x>dg_w-w->w-2)w->x=dg_w-w->w-2;
    if(w->y>dg_h-w->h-3)w->y=dg_h-w->h-3;
  }
  win[3].x=(dg_w-win[3].w)/2;
  if(cx>=dg_w)cx=dg_w-1; if(cy>=dg_h)cy=dg_h-1;
}
static void persist_display(void) {
  apply_display(); display_saved=save_config();
  strcpy(status,display_saved?"Affichage sauvegarde dans config.":"Erreur : config non sauvegardee.");
}
static void set_mode(int m) {
  cur_hide(); display_depth=m==1?1:color_depth; persist_display();
}
static void launch_name(const char *name) {
  if(strcmp(name,"system3")==0) {
    front(0); strcpy(status,"Vous etes deja dans le bureau 3OS."); return;
  }
  char app[16]; strcpy(app,name); menu=-1; cur_hide();
  while(KEY_EVENT!=0) {} /* Keep console scripts: native input arrives as a batch. */
  long code=sys_exec(app); load_disk();
  sprintf(status,"%s : retour %ld",app,code); load_config(); apply_display();
}
static void open_selected(void) {
  if(selected<0||selected>=nfiles)return;
  if(kinds[selected]==1)launch_name(names[selected]);
  else { front(1); win[1].scroll=0; }
}
static void reset_layout(void) {
  win[0].x=24; win[0].y=38; win[0].w=304; win[0].h=258;
  win[1].x=dg_w-232; win[1].y=110; win[1].w=200; win[1].h=190;
  win[0].scroll=0; win[1].scroll=0; front(1); front(0); ensure_selection();
}
static void menu_action(int m,int i) {
  menu=-1;
  if(m==0)front(2);
  if(m==1) {
    if(i==0)open_selected(); if(i==1)front(1);
    if(i==2&&active()>=0)win[active()].open=0;
    if(i==3)quit=1;
  }
  if(m==2) {
    if(i<2) { cur_hide(); set_mode(i==0?2:1); }
    if(i==2)reset_layout();
    if(i==3) { load_disk(); strcpy(status,"Disque actualise."); ensure_selection(); }
  }
  if(m==3) { if(i==0)front(1); else launch_name("editeur"); }
  if(m==4) { win[3].x=(dg_w-win[3].w)/2; front(3); }
}
static void scroll_win(int j,int delta) {
  Win *w=&win[j]; int max=(j==0?nfiles:read_lines)-rows(j);
  if(max<0)max=0; w->scroll+=delta;
  if(w->scroll<0)w->scroll=0; if(w->scroll>max)w->scroll=max;
}
int main(void) {
  long stack_anchor; dg_reserve((char *)&stack_anchor-32768);
  load_config(); load_disk(); apply_display(); draw_all(); cur_show(); present();
  int drag=-1,resize=-1,scroll_drag=-1,scroll_dy=0,dx=0,dy=0,prev_left=0,last_item=-1;
  long last_click=-1000;
  for(;;) {
    int dirty=0,k,ch;
    while((k=KEY_EVENT)!=0) {
      if(k<0)continue;
      if(k==67) { menu=-1; cur_hide(); set_mode(mode==2?1:2); dirty=1; }
      else if(k==81)quit=1;
      else if(k==27) { if(menu>=0)menu=-1; else if(active()>=2)win[active()].open=0; else quit=1; dirty=1; }
      else if(k==113) { launch_name("editeur"); dirty=1; }
      else if(k==13) { if(active()>=2)win[active()].open=0; else open_selected(); dirty=1; }
      else if(k>=49&&k<=57&&k-49<nfiles) { selected=k-49; ensure_selection(); open_selected(); dirty=1; }
      else if((k==38||k==40)&&active()==0&&nfiles>0) {
        selected+=k==40?1:-1; if(selected<0)selected=0; if(selected>=nfiles)selected=nfiles-1;
        ensure_selection(); dirty=1;
      } else if((k==38||k==40||k==33||k==34)&&active()==1) {
        scroll_win(1,(k==38||k==33)?-(k==33?rows(1):1):(k==34?rows(1):1)); dirty=1;
      } else if(k==9) { int a=active(); front(a==0?1:0); dirty=1; }
    }
    ch=CONSOLE_IN;
    if(ch>='1'&&ch<='9'&&ch-'1'<nfiles) { selected=ch-'1'; ensure_selection(); open_selected(); dirty=1; }
    if(quit)return 0;
    int mx=MOUSE_X/dg_scale,my=MOUSE_Y/dg_scale,left=MOUSE_BTN%3;
    if(mx<0)mx=0; if(mx>=dg_w)mx=dg_w-1; if(my<0)my=0; if(my>=dg_h)my=dg_h-1;
    if(menu>=0&&(mx!=cx||my!=cy))dirty=1;
    if(left&&!prev_left) {
      int handled=0;
      if(my<21) {
        int hit=-1; for(int i=0;i<NMENUS;i++)if(in(mx,my,menu_x[i],0,menu_w[i],21))hit=i;
        menu=menu==hit?-1:hit; dirty=1; handled=1;
      } else if(menu>=0) {
        int m=menu; menu=-1;
        for(int i=0;i<menu_count[m];i++)if(in(mx,my,menu_x[m],24+i*20,158,20))menu_action(m,i);
        handled=1; dirty=1;
      }
      for(int z=NWINS-1;z>=0&&!handled;z--) {
        int j=order[z]; Win *w=&win[j];
        if(!w->open||!in(mx,my,w->x,w->y,w->w,w->h))continue;
        front(j); handled=1; dirty=1;
        if(in(mx,my,w->x+5,w->y+3,14,13))w->open=0;
        else if(my<w->y+20) { drag=j; dx=mx-w->x; dy=my-w->y; }
        else if(j>=2) {
          if(in(mx,my,w->x+w->w-68,w->y+w->h-30,54,19))w->open=0;
          else if(j==3)for(int i=0;i<3;i++) {
            if(in(mx,my,w->x+16,w->y+58+i*24,126,20)) { cur_hide(); display_res=i; persist_display(); }
            else if(in(mx,my,w->x+164,w->y+58+i*24,110,20)) {
              cur_hide(); display_depth=depths[i]; if(display_depth!=1)color_depth=display_depth; persist_display();
            }
          }
        }
        else if(in(mx,my,w->x+w->w-16,w->y+w->h-16,16,16)) { resize=j; dx=w->w-mx; dy=w->h-my; }
        else if(in(mx,my,w->x+w->w-15,w->y+39,14,w->h-57)) {
          int total=j==0?nfiles:read_lines,count=rows(j),track=w->h-85;
          int thumb=total>count?track*count/total:track;
          if(thumb<9)thumb=9; if(thumb>track)thumb=track;
          int pos=total>count?(track-thumb)*w->scroll/(total-count):0;
          int ty=w->y+53+pos;
          if(my<w->y+52)scroll_win(j,-1);
          else if(my>=w->y+w->h-31)scroll_win(j,1);
          else if(total>count && in(mx,my,w->x+w->w-13,ty,10,thumb)) {
            scroll_drag=j; scroll_dy=my-ty;
          } else scroll_win(j,my<ty?-count:count);
        } else if(j==0&&mx<w->x+w->w-16&&my>=row_y(w->scroll)&&my<row_y(w->scroll+rows(0))) {
          int item=w->scroll+(my-row_y(w->scroll))/17;
          if(item<nfiles) {
            selected=item; long now=TIME_MS;
            if(last_item==item&&now-last_click<450) { open_selected(); last_item=-1; }
            else { last_item=item; last_click=now; strcpy(status,"Entree pour ouvrir la selection."); }
          }
        }
      }
      if(!handled) {
        if(in(mx,my,dg_w-63,34,48,52)) { front(0); dirty=1; }
        if(in(mx,my,dg_w-63,dg_h-79,48,52)) { front(1); dirty=1; }
        last_item=-1;
      }
    }
    if(!left) { drag=-1; resize=-1; scroll_drag=-1; }
    if(drag>=0) {
      Win *w=&win[drag]; int nx=mx-dx,ny=my-dy;
      if(nx<2)nx=2; if(ny<23)ny=23;
      if(nx>dg_w-2-w->w)nx=dg_w-2-w->w; if(ny>dg_h-3-w->h)ny=dg_h-3-w->h;
      if(nx!=w->x||ny!=w->y) { w->x=nx; w->y=ny; dirty=1; }
    }
    if(resize>=0) {
      Win *w=&win[resize]; int nw=mx+dx,nh=my+dy;
      if(nw<(resize==0?250:180))nw=resize==0?250:180; if(nh<140)nh=140;
      if(nw>dg_w-2-w->x)nw=dg_w-2-w->x; if(nh>dg_h-3-w->y)nh=dg_h-3-w->y;
      if(nw!=w->w||nh!=w->h) { w->w=nw; w->h=nh; w->scroll=0; dirty=1; }
    }
    if(scroll_drag>=0) {
      int j=scroll_drag; Win *w=&win[j];
      int total=j==0?nfiles:read_lines,count=rows(j),track=w->h-85;
      int thumb=track*count/total; if(thumb<9)thumb=9;
      int span=track-thumb;
      if(span>0) {
        int ns=(my-scroll_dy-w->y-53)*(total-count)/span;
        if(ns<0)ns=0; if(ns>total-count)ns=total-count;
        if(ns!=w->scroll) { w->scroll=ns; dirty=1; }
      }
    }
    prev_left=left;
    if(dirty) { cur_hide(); cx=mx; cy=my; draw_all(); cur_show(); present(); }
    else if(mx!=cx||my!=cy) { cur_hide(); cx=mx; cy=my; cur_show(); present(); }
    else wfi();
  }
}
