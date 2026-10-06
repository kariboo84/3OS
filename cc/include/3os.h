/* 3os.h — appels système de 3OS v0.3 (programmes utilisateur). Lier avec lib/sys.tas.
 * Le matériel (écran, clavier, souris, son, console) s'utilise comme d'habitude via
 * tri27io.h : le noyau intercepte et virtualise ces accès. */
#ifndef THREEOS_H
#define THREEOS_H

/* Lance un programme du disque et attend sa fin ; renvoie son code de sortie
 * (-1 si introuvable ou plus de place). */
long sys_exec(const char *name);
/* Cède le processeur. */
long sys_yield(void);
/* Entrée i du répertoire : copie le nom (16 trytes) dans name ;
 * renvoie 0 si absente, 1 = programme, 2 = donnée. */
long sys_readdir(long i, char *name);
/* Lit le fichier `name` dans buf (max trytes) ; renvoie la longueur lue ou -1. */
long sys_readfile(const char *name, char *buf, long max);
/* Nombre de processus vivants. */
long sys_procs(void);

#endif
