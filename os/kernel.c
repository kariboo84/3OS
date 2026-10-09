/* kernel.c — noyau 3OS v0.4 pour TRI-27 (mode -1).
 *
 * - Processus en mode utilisateur (+1), chacun dans un emplacement de 3^12 trytes,
 *   isolé par UBASE/ULIMIT (la VM traduit et borne toutes ses adresses).
 * - Pièges : timer (ordonnanceur préemptif), ECALL (appels système), fautes.
 * - Matériel virtualisé : un accès MMIO (adresse < 0) depuis le mode utilisateur
 *   faute ; le noyau décode l'instruction et l'émule. Écran, clavier et souris
 *   appartiennent au processus au premier plan (fg).
 * - Disque 3FS : secteur 0 = répertoire, fichiers contigus (SPEC §9).
 */
#include <stdio.h>
#include <stdlib.h>
#include <tri27io.h>

#define SLOT_MIN 531441L      /* 3^12 trytes : taille minimale d'un emplacement de processus */
#define KERNEL_END 1062882L   /* 2 * 3^12 : noyau + pile noyau */
#define NPROC 24
#define QUANTUM 60000
#define SECT 729

#define DISK_SECTOR TRI27_MMIO(-20)
#define DISK_ADDR   TRI27_MMIO(-21)
#define DISK_CMD    TRI27_MMIO(-22)
#define DISK_STATUS TRI27_MMIO(-23)
#define DISK_COUNT  TRI27_MMIO(-24)

/* Disposition connue de kentry.tas : r à 0, pc à 81, ubase à 84, ulimit à 87, ioperm à 90, vl à 93, vsave à 96. */
struct proc {
  long r[27];
  long pc, ubase, ulimit;
  long ioperm;     /* 1 = premier plan : périphériques en accès direct (CSR IOPERM) */
  long vl;         /* CSR VL (longueur vectorielle) du processus */
  long vsave;      /* adresse de sa banque vectorielle sauvegardée (27 x 27 trytes) */
  long state;      /* 0 libre, 1 prêt, 2 attend un enfant */
  long parent;
  long vmode, fbaddr, fbw, fbh, fbdepth;
  char name[16];
};
enum { FREE, READY, WAITING };

struct proc procs[NPROC];
static char vstate[NPROC][729];   /* registres vectoriels sauvegardés, un bloc par processus */
struct proc *cur;
extern long ram_size;
static long nslots, fg = -1;
static long SLOT = SLOT_MIN;   /* fixé au démarrage selon la RAM détectée */
static char dir[SECT];

long csr_cause(void);
long csr_tval(void);
void set_timecmp(long t);
void kresume(void);

#define R(p, k) ((p)->r[(k) + 13])
#define A0 1
#define SP (-1)

/* ---------- utilitaires ternaires ---------- */
static long bal(long x, long m) {
  long h = (m - 1) / 2, r = (x + h) % m;
  if (r < 0) r += m;
  return r - h;
}
static long word_at(char *p) { return p[0] + p[1] * 19683L + p[2] * 19683L * 19683L; }
static long pid(struct proc *p) { return p - procs; }

/* adresse utilisateur → pointeur physique, ou 0 si hors de l'espace du processus */
static char *uptr(struct proc *p, long v, long len) {
  if (v < 0 || len < 0 || v + len > p->ulimit) return 0;
  return (char *)(p->ubase + v);
}

/* ---------- disque et répertoire ---------- */
static void disk_read(long sector, long phys) {
  DISK_SECTOR = sector;
  DISK_ADDR = phys;
  DISK_CMD = 1;
}
static void disk_write(long sector, long phys) {
  DISK_SECTOR = sector;
  DISK_ADDR = phys;
  DISK_CMD = 2;
}
static void put_word(char *p, long v) {      /* mot équilibré sur 3 trytes */
  long t0 = v % 19683; if (t0 > 9841) t0 -= 19683; if (t0 < -9841) t0 += 19683;
  long r = (v - t0) / 19683;
  long t1 = r % 19683; if (t1 > 9841) t1 -= 19683; if (t1 < -9841) t1 += 19683;
  p[0] = t0; p[1] = t1; p[2] = (r - t1) / 19683;
}
static long dir_count(void) { return word_at(dir) == 27027 ? word_at(dir + 3) : 0; }
static char *dir_entry(long i) { return dir + 6 + i * 30; }
static int name_eq(char *a, const char *b) {
  for (int k = 0; k < 16; k++) {
    if (a[k] != b[k]) return 0;
    if (a[k] == 0) return 1;
  }
  return 1;
}
static long dir_find(const char *name) {
  for (long i = 0; i < dir_count(); i++)
    if (name_eq(dir_entry(i), name)) return i;
  return -1;
}

/* ---------- affichage du processus au premier plan ---------- */
static void apply_display(void) {
  if (fg < 0) return;
  struct proc *p = &procs[fg];
  FB_WIDTH = p->fbw;
  FB_HEIGHT = p->fbh;
  FB_DEPTH = p->fbdepth;
  VMODE = p->vmode;
  long fb = p->fbaddr;
  /* taille du framebuffer selon le mode ; adresse validée dans l'espace du processus */
  long pixels = p->fbw * p->fbh;
  long hdsize = p->fbdepth == 1 ? (pixels + 8) / 9 : (p->fbdepth == 9 ? pixels : pixels * 3);
  long sz = p->vmode == 1 ? 23040 : (p->vmode == 2 ? 207360 : (p->vmode == 3 ? hdsize : 64000));
  FB_ADDR = (fb > 0 && uptr(p, fb, sz)) ? p->ubase + fb : 0;
}
static void silence(void) {
  for (int v = 0; v < 9; v++) SND_GATE(v) = 0;
}

/* Le premier plan change : on fige l'écran du sortant (il a pu le modifier en accès
 * direct), on coupe le son, on donne les périphériques au nouveau. */
static void set_fg(long n) {
  if (fg >= 0 && procs[fg].state != FREE) {
    struct proc *o = &procs[fg];
    o->vmode = VMODE;
    o->fbw = FB_WIDTH;
    o->fbh = FB_HEIGHT;
    o->fbdepth = FB_DEPTH;
    o->fbaddr = FB_ADDR > 0 ? FB_ADDR - o->ubase : 0;
  }
  silence();
  TRI27_MMIO(-13) = 0;                        /* saisie de texte : au nouveau premier plan de la redemander */
  for (int i = 0; i < NPROC; i++) procs[i].ioperm = 0;
  fg = n;
  if (fg >= 0) { procs[fg].ioperm = 1; apply_display(); }
}

/* ---------- processus ---------- */
static struct proc *spawn(const char *name, long parent) {
  long e = dir_find(name);
  if (e < 0) return 0;
  char *d = dir_entry(e);
  long start = word_at(d + 16), len = word_at(d + 19), entry = word_at(d + 22);
  if (entry < 0 || len > SLOT - 3000) return 0;
  /* emplacement libre : le processus i occupe l'emplacement i */
  struct proc *p = 0;
  for (long i = 0; i < NPROC && i < nslots; i++)
    if (procs[i].state == FREE) { p = &procs[i]; break; }
  if (!p) return 0;
  long base = KERNEL_END + pid(p) * SLOT;
  for (long k = 0; k * SECT < len; k++) disk_read(start + k, base + k * SECT);
  for (int k = 0; k < 27; k++) p->r[k] = 0;
  p->vl = 0;
  for (int k = 0; k < 729; k++) vstate[pid(p)][k] = 0;   /* pas de fuite entre processus */
  R(p, SP) = SLOT;
  p->pc = entry;
  p->ubase = base;
  p->ulimit = SLOT;
  p->state = READY;
  p->parent = parent;
  p->vmode = 0;
  p->fbaddr = 0;
  p->fbw = 1920;
  p->fbh = 1080;
  p->fbdepth = 27;
  p->ioperm = 0;
  for (int k = 0; k < 16; k++) p->name[k] = d[k];
  return p;
}

static void schedule(void) {
  long n = pid(cur);
  for (long k = 1; k <= NPROC; k++) {
    struct proc *p = &procs[(n + k) % NPROC];
    if (p->state == READY) { cur = p; break; }
  }
  set_timecmp(CYCLES + QUANTUM);
}

static void boot_init(void);

static void proc_exit(struct proc *p, long code) {
  long me = pid(p);
  p->state = FREE;
  p->ioperm = 0;
  if (fg == me) set_fg(p->parent);
  if (p->parent >= 0) {
    struct proc *par = &procs[p->parent];
    if (par->state == WAITING) { R(par, A0) = code; par->state = READY; }
  }
  int alive = 0;
  for (int i = 0; i < NPROC; i++) if (procs[i].state != FREE) alive = 1;
  if (!alive) { printf("\n[3OS] plus aucun processus : relance de init\n"); boot_init(); return; }
  schedule();
}

static void kill(struct proc *p, const char *why, long val) {
  printf("\n[3OS] %s tue : %s (%ld) pc=%ld\n", p->name, why, val, p->pc);
  proc_exit(p, -1);
}

/* ---------- matériel virtualisé ---------- */
static long dev_read(long a) {
  int f = pid(cur) == fg;
  if (a == -2 || a == -7) return f ? TRI27_MMIO(a) : (a == -2 ? -1 : 0);   /* CONSOLE_IN, KEY */
  if (a == -10 || a == -11 || a == -12 || a == -13) return f ? TRI27_MMIO(a) : 0;  /* souris, saisie */
  if (a == -4 || a == -8) return TRI27_MMIO(a);                            /* CYCLES, TIME_MS */
  if (a == -5) return cur->fbaddr;
  if (a == -9) return cur->vmode;
  if (a == -14) return cur->fbw;
  if (a == -15) return cur->fbh;
  if (a == -16) return cur->fbdepth;
  if (a <= -100 && a >= -202) return TRI27_MMIO(a);                        /* son */
  return 0;
}
static void dev_write(long a, long v) {
  int f = pid(cur) == fg;
  if (a == -1) { CONSOLE_OUT = v; return; }
  if (a == -3) { proc_exit(cur, v); return; }
  if (a == -5) { cur->fbaddr = v; if (f) apply_display(); return; }
  if (a == -9) { cur->vmode = v; if (f) apply_display(); return; }
  if (a == -14) { cur->fbw = v < 16 ? 16 : (v > 3840 ? 3840 : v); if (f) apply_display(); return; }
  if (a == -15) { cur->fbh = v < 16 ? 16 : (v > 2160 ? 2160 : v); if (f) apply_display(); return; }
  if (a == -16) { cur->fbdepth = v == 1 || v == 9 ? v : 27; if (f) apply_display(); return; }
  if (a == -6) { if (f) FB_PRESENT = 0; return; }
  if (a == -13) { if (f) TRI27_MMIO(-13) = v; return; }
  if (a <= -100 && a >= -202) { if (f) TRI27_MMIO(a) = v; return; }
}

/* l'instruction fautive est un LDT/LDW/STT/STW sur une adresse négative : l'émuler */
static void emulate_mmio(long a) {
  char *ip = uptr(cur, cur->pc, 3);
  if (!ip) { kill(cur, "pc hors espace", cur->pc); return; }
  long w = word_at(ip);
  long op = bal(w, 243); w = (w - op) / 243;
  long rd = bal(w, 27);
  struct proc *me = cur;
  me->pc += 3;
  if (op == 23 || op == 24) {                 /* LDT, LDW */
    long v = dev_read(a);
    if (op == 23) v = bal(v, 19683);
    if (rd != 0) R(me, rd) = v;
  } else if (op == 25 || op == 26) {          /* STT, STW */
    dev_write(a, R(me, rd));
  } else {
    me->pc -= 3;
    kill(me, "acces memoire invalide", a);
  }
}

/* ---------- appels système ---------- */
static void syscall(long n) {
  struct proc *p = cur;
  long a0 = R(p, A0), a1 = R(p, A0 + 1), a2 = R(p, A0 + 2);
  p->pc += 3;
  if (n == 0) { proc_exit(p, a0); return; }
  if (n == 1) { CONSOLE_OUT = a0; return; }
  if (n == 2) { printf("%ld", a0); return; }
  if (n == 10) {                                   /* exec(nom) : lance et attend */
    char *s = uptr(p, a0, 16), name[16];
    if (!s) { R(p, A0) = -1; return; }
    for (int k = 0; k < 16; k++) name[k] = s[k];
    name[15] = 0;
    struct proc *c = spawn(name, pid(p));
    if (!c) { R(p, A0) = -1; return; }
    p->state = WAITING;
    set_fg(pid(c));
    cur = c;
    set_timecmp(CYCLES + QUANTUM);
    return;
  }
  if (n == 11) { schedule(); return; }
  if (n == 12) {                                   /* readdir(i, nom) */
    char *dst = uptr(p, a1, 16);
    if (a0 < 0 || a0 >= dir_count() || !dst) { R(p, A0) = 0; return; }
    char *d = dir_entry(a0);
    for (int k = 0; k < 16; k++) dst[k] = d[k];
    R(p, A0) = word_at(d + 22) >= 0 ? 1 : 2;
    return;
  }
  if (n == 13) {                                   /* readfile(nom, buf, max) */
    char *s = uptr(p, a0, 16), *dst = uptr(p, a1, a2), name[16];
    long e;
    if (!s || !dst) { R(p, A0) = -1; return; }
    for (int k = 0; k < 16; k++) name[k] = s[k];
    name[15] = 0;
    if ((e = dir_find(name)) < 0) { R(p, A0) = -1; return; }
    char *d = dir_entry(e);
    long start = word_at(d + 16), len = word_at(d + 19);
    if (len > a2) len = a2;
    static char sec[SECT];
    for (long k = 0; k * SECT < len; k++) {
      disk_read(start + k, (long)sec);
      for (long j = 0; j < SECT && k * SECT + j < len; j++) dst[k * SECT + j] = sec[j];
    }
    R(p, A0) = len;
    return;
  }
  if (n == 15) {                                   /* writefile(nom, buf, len) : réécrit dans la capacité */
    char *s = uptr(p, a0, 16), *src = uptr(p, a1, a2), name[16];
    long e;
    if (!s || !src || a2 < 0) { R(p, A0) = -1; return; }
    for (int k = 0; k < 16; k++) name[k] = s[k];
    name[15] = 0;
    if ((e = dir_find(name)) < 0) { R(p, A0) = -1; return; }
    char *d = dir_entry(e);
    long start = word_at(d + 16), cap = word_at(d + 25);
    if (word_at(d + 22) >= 0 || a2 > cap) { R(p, A0) = -1; return; }   /* programmes protégés */
    static char sec[SECT];
    for (long k = 0; k * SECT < a2 || k == 0; k++) {
      for (long j = 0; j < SECT; j++) sec[j] = k * SECT + j < a2 ? src[k * SECT + j] : 0;
      disk_write(start + k, (long)sec);
    }
    put_word(d + 19, a2);
    disk_write(0, (long)dir);
    R(p, A0) = a2;
    return;
  }
  if (n == 16) {                                   /* filesize(nom) : aucune lecture de contenu */
    char *s = uptr(p, a0, 16), name[16];
    if (!s) { R(p, A0) = -1; return; }
    for (int k = 0; k < 16; k++) name[k] = s[k];
    name[15] = 0;
    long e = dir_find(name);
    R(p, A0) = e < 0 ? -1 : word_at(dir_entry(e) + 19);
    return;
  }
  if (n == 14) {
    long c = 0;
    for (int i = 0; i < NPROC; i++) if (procs[i].state != FREE) c++;
    R(p, A0) = c;
    return;
  }
  kill(p, "appel systeme inconnu", n);
}

/* ---------- point d'entrée des pièges (kentry.tas) ---------- */
/* WFI du processus : céder à un autre prêt, sinon dormir nous-mêmes (mode noyau). */
static void user_wfi(void) {
  cur->pc += 3;
  for (int i = 0; i < NPROC; i++)
    if (&procs[i] != cur && procs[i].state == READY) { schedule(); return; }
  wfi();
}

void ktrap(void) {
  long c = csr_cause(), v = csr_tval();
  if (c == 9) schedule();
  else if (c == 2 && v == 52) user_wfi();
  else if (c == 8) syscall(v);
  else if (c == 3 && v < 0) emulate_mmio(v);
  else if (c == 3) kill(cur, "faute memoire", v);
  else if (c == 4) kill(cur, "division par zero", 0);
  else if (c == 1) kill(cur, "instruction illegale", v);
  else kill(cur, "piege", c);
}

static void boot_init(void) {
  struct proc *p = spawn("system3", -1);
  if (!p) p = spawn("hello", -1);
  if (!p) { printf("[3OS] aucun programme d'init sur le disque\n"); exit(1); }
  fg = -1;
  set_fg(pid(p));
  cur = p;
  set_timecmp(CYCLES + QUANTUM);
}

int kmain(void) {
  for (int i = 0; i < NPROC; i++) procs[i].vsave = (long)vstate[i];
  /* RAM dynamique : la RAM libre est partagée entre NPROC emplacements (multiples d'un secteur),
     jamais moins de 3^12 trytes chacun. */
  SLOT = (ram_size - KERNEL_END) / NPROC / SECT * SECT;
  if (SLOT < SLOT_MIN) SLOT = SLOT_MIN;
  nslots = (ram_size - KERNEL_END) / SLOT;
  if (nslots > NPROC) nslots = NPROC;
  printf("3OS v0.4 - noyau ternaire TRI-27\n");
  printf("RAM %ld trytes, %ld emplacements de processus de %ld trytes\n", ram_size, nslots, SLOT);
  if (DISK_COUNT < 1) { printf("[3OS] pas de disque\n"); exit(1); }
  disk_read(0, (long)dir);
  long n = dir_count();
  printf("disque : %ld secteurs, %ld fichiers\n", (long)DISK_COUNT, n);
  for (long i = 0; i < n; i++) {
    char *d = dir_entry(i);
    printf("  %-15s %7ld trytes  %s\n", d, word_at(d + 19), word_at(d + 22) >= 0 ? "programme" : "donnee");
  }
  boot_init();
  kresume();
  return 0;
}
