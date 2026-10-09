// tri27io.h — accès aux périphériques TRI-27 (MMIO aux adresses négatives), cf. SPEC.md §6 et §8.
#ifndef TRI27IO_H
#define TRI27IO_H

#define TRI27_MMIO(a) (*(volatile long *)(long)(a))

#define CONSOLE_OUT TRI27_MMIO(-1)
#define CONSOLE_IN  TRI27_MMIO(-2)   /* -1 si vide */
#define SYS_EXIT    TRI27_MMIO(-3)
#define CYCLES      TRI27_MMIO(-4)
#define FB_ADDR     TRI27_MMIO(-5)
#define FB_PRESENT  TRI27_MMIO(-6)
#define KEY_EVENT   TRI27_MMIO(-7)   /* +code appui, -code relâche, 0 rien (codes KeyboardEvent.keyCode) */
#define TIME_MS     TRI27_MMIO(-8)
/* Dort jusqu'au prochain événement hôte (image suivante, entrée, 1 ms en CLI).
 * À appeler dans toute boucle d'attente au lieu de tourner à vide. */
void wfi(void);

#define VMODE       TRI27_MMIO(-9)   /* 0 = TRGB 320x200, 1 = TRIT 576x360 (1 trit/pixel), 2 = TRGB 576x360, 3 = dimensions et profondeur réglables */
#define FB_WIDTH    TRI27_MMIO(-14)  /* mode 3 : largeur (16..3840, défaut 1920) */
#define FB_HEIGHT   TRI27_MMIO(-15)  /* mode 3 : hauteur (16..2160, défaut 1080) */
#define FB_DEPTH    TRI27_MMIO(-16)  /* mode 3 : 1 trit, 9 TRGB, 27 profond (défaut ; toute autre valeur -> 27) */
/* Mode 3 : pixel = 1 mot = 3 trytes (B, V, R), chaque canal -9841..+9841 (19 683 niveaux). */
#define HD_RGB(r, g, b) ((long)(b) + (long)(g) * 19683L + (long)(r) * 387420489L)
#define MOUSE_X     TRI27_MMIO(-10)
#define MOUSE_Y     TRI27_MMIO(-11)
#define MOUSE_BTN   TRI27_MMIO(-12)  /* gauche + 3*droit (chacun 0/1) */
#define MOUSE_WHEEL TRI27_MMIO(-17)  /* crans signés (bas > 0), lecture consomme, écrire 0 efface */
#define TEXT_INPUT  TRI27_MMIO(-13)  /* 1 : recevoir les caractères (CONSOLE_IN) même écran focalisé */

#define TRIT_W 576
#define TRIT_H 360
#define TRGB_HI_W 576
#define TRGB_HI_H 360
#define FB_W 320
#define FB_H 200

/* couleur TRGB : chaque canal -13..+13 */
#define TRGB(r, g, b) ((r) * 729 + (g) * 27 + (b))

/* TSG-3 : 9 voix */
#define SND_REG(v, r) TRI27_MMIO(-100 - 9 * (v) - (r))
#define SND_FREQ(v)    SND_REG(v, 0)   /* millihertz */
#define SND_WAVE(v)    SND_REG(v, 1)
#define SND_VOL(v)     SND_REG(v, 2)   /* 0..9841 */
#define SND_ATTACK(v)  SND_REG(v, 3)   /* ms */
#define SND_RELEASE(v) SND_REG(v, 4)   /* ms */
#define SND_GATE(v)    SND_REG(v, 5)
#define WAVE_OFF    0
#define WAVE_SINE   1
#define WAVE_TRI3   2
#define WAVE_SQUARE 3
#define WAVE_SAW    4
#define WAVE_NOISE3 5
#define PCM_PUSH    TRI27_MMIO(-200)
#define PCM_FREE    TRI27_MMIO(-201)
#define SND_MASTER  TRI27_MMIO(-202)

#define KEY_LEFT 37
#define KEY_UP 38
#define KEY_RIGHT 39
#define KEY_DOWN 40
#define KEY_SPACE 32
#define KEY_ESC 27
#define KEY_ENTER 13

#endif
