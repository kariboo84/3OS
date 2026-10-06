# TNA-VM / Wolf3D — État d'avancement inter-sessions
Dernière mise à jour : session 4

---

## 🎯 OBJECTIF
Wolf3D jouable via :
- **TNA VM** pour toute la logique de jeu (mouvement, IA, portes, score)
- **Host bridges** pour rendu → framebuffer, input, audio
- Pas d'émulation DOS/VGA/ASM

---

## ✅ CE QUI EST FAIT ET FONCTIONNE

### 1. Infrastructure de base
- `TernaryVM.enhanced.js` créé (alias vers `src/runtime/ternary_vm.js`) — 3OS.js peut démarrer
- Cible `patched` dans `ternary_vm.js` + `web/index.html` (sélectionnée par défaut)
- `package.json` : `npm run patch`, `npm run web-ui`
- `3OS boot → wolf3d patched` : mode graphics, halted=false, PC vivant ✅

### 2. `tools/patch_linker_stubs.js` — patcher complet ✅

**Étape A — Redirection TNA (19 fonctions, 437 stubs)**
Stubs JMP redirigés vers TNA natif :
- Input : IN_ReadControl, IN_Ack, IN_CheckAck, IN_ClearKeysDown, IN_Default,
  IN_GetJoyAbs, IN_GetJoyButtonsDB, IN_JoyButtons, IN_MouseButtons,
  IN_SetControlType, IN_SetKeyHook, IN_SetupJoy, IN_StartAck,
  IN_UserInput, IN_WaitForASCII, IN_WaitForKey
- Cache assets : CA_CacheMap, CA_FarRead, CA_FarWrite

**Étape B — HOST_OVERRIDES (25 fonctions)**
Restent en host bridge (DOS far-ptr model) :
- MM : MM_Startup/Shutdown/GetPtr/FreePtr/SetPurge/SetLock/SortMem/UnusedMemory/TotalFree/BombOnError, MML_UseSpace
- PM : PM_Startup/Shutdown/GetPage/GetPageAddress/Preload/Reset/SetPageLock/NextFrame/CheckMainMem
- VL copy : VL_MemToScreen, VL_MaskedToScreen, VL_LatchToScreen, VL_MemToLatch, VL_DePlaneVGA

**Étape C — DIRECT_NOOPS (25 fonctions, corps ENTIER rempli de RET)**
x86 ASM inline ou far-ptr VGA — corps intégral écrasé (pas juste 12 mots) :
- VL planar : VL_MungePic, VL_DrawTile8String, VL_DrawLatch8String, VL_SizeTile8String
- VL primitives : VL_Bar, VL_Hlin, VL_Vlin, VL_Plot
- 3D render : ThreeDRefresh, WallRefresh, DrawScaleds, DrawPlayerWeapon, VGAClearScreen
- Scale/ASM : ScalePost, FarScalePost, BadScale, SetupScaling, BuildCompScale, ScaleLine, ScaleShape, SimpleScaleShape
- Floor/ceiling : DrawPlanes (5070 mots!), DrawSpans, SetPlaneViewSize
- Screen update : VW_UpdateScreen

**Résultat `build/wolf3d_patched.tna` :**
- 600 000 cycles sans PC=0 ✅
- boot 3OS → wolf3d patched < 500ms ✅
- PC actif dans VL_FadeOut (init palette Wolf3D — normal) ✅

---

## 🚧 PROCHAINES ÉTAPES (ordre de priorité)

### 1. Valider via `npm run web-ui`
```bash
npm run web-ui   # → http://localhost:8080
# Sélectionner "patched ✓", cliquer LANCER WOLF3D
# Observer : framebuffer, logs, comportement au clavier
```

**Scénarios attendus et réponses :**
- Framebuffer noir → vérifier que renderWolfView lit bien viewx/viewy/viewangle depuis TNA globals
- Pas de réponse au clavier → vérifier MMIO 0xFE00 et la chaîne injectKey → hostRuntime.keyState
- Nouveau PC=0 → ajouter la fonction coupable à DIRECT_NOOPS, relancer `npm run patch`
- Halt inattendu → chercher HALT opcode hors du bootstrap (possible Quit() call)

### 2. Connecter le framebuffer

`ThreeDRefresh` est noop → le rendu 3D ne dessine rien en TNA.
`AsmRefresh → renderWolfView` dans host_runtime.js devrait lire les globaux TNA et rendre.

Pour trouver les adresses des globaux viewx/viewy/viewangle :
```javascript
const fs = require('fs');
const buf = fs.readFileSync('./build/wolf3d_patched.tna');
const mo=8+4+4+4+4+4, al=buf.readInt32LE(mo), ml=buf.readInt32LE(mo+4);
const meta = JSON.parse(buf.slice(mo+8+al, mo+8+al+ml).toString());
console.log('viewx:', meta.link.globals.viewx);
console.log('viewy:', meta.link.globals.viewy);
console.log('viewangle:', meta.link.globals.viewangle);
```
Ces adresses permettent à renderWolfView de lire la position du joueur directement en RAM TNA.

### 3. Implémenter Attack/Use/Search

Pas de corps C en WL6 (dans l'ASM non porté). Créer `historical_wolf3d_official/WOLFSRC/__tna_shims__.c` :
```c
#include "WL_DEF.H"
void Attack(void)           { T_Attack(player); }
void Use(void)              { Cmd_Use(player); }   // ligne 1008 WL_AGENT.C
void Search(objtype *ob)    { GetBonus(ob); }
void InitObjList(void)      { InitActorList(); }
```
Ajouter ce fichier à la liste des unités dans le linker.

### 4. Découvrir les prochains noops nécessaires

Ajouter ce log dans vm_controller.js pour tracer les fonctions actives :
```javascript
// Dans tick(), avant vm.run() :
if (this.session.ticks % 50 === 0) {
  const pc = os.vm.backend.cpu && os.vm.backend.cpu.PC;
  // logger pc + funcAt(pc) → visible dans /api/state logs
}
```

---

## 🔧 COMMANDES DE RÉFÉRENCE

```bash
# Régénérer le binaire patché
npm run patch

# Serveur web
npm run web-ui   # → http://localhost:8080

# Test non-régression (600k cycles sans PC=0)
node -e "
const {readExecutableFile}=require('./src/runtime/executable');
const {TernaryVM}=require('./src/runtime/ternary_vm');
const exe=readExecutableFile('./build/wolf3d_patched.tna');
const vm=new TernaryVM(1<<22,{videoWidth:160,videoHeight:120,backend:'interpreter'});
vm.reset(); vm.loadExecutable(exe);
let prev=exe.entry, bad=0;
for(let i=0;i<600000;i++){vm.run(1);const pc=vm.backend.cpu.PC;if(pc<1000&&prev>=1000)bad++;prev=pc;}
console.log(bad===0?'CLEAN ✓':'REGRESSIONS: '+bad);
"

# Trouver les adresses des globaux TNA (viewx, viewy, etc.)
node -e "
const fs=require('fs');
const b=fs.readFileSync('./build/wolf3d_patched.tna');
const mo=8+4+4+4+4+4,al=b.readInt32LE(mo),ml=b.readInt32LE(mo+4);
const m=JSON.parse(b.slice(mo+8+al,mo+8+al+ml).toString());
const g=m.link.globals;
['viewx','viewy','viewangle','player','tilemap','objarray'].forEach(k=>
  console.log(k,':',g[k]?'addr='+g[k].address:'NOT FOUND'));
"
```

---

## 🐛 BUGS RÉSOLUS

| Bug | Cause | Fix |
|-----|-------|-----|
| boot hang | MM_GetPtr TNA = goto/retry loop ; PM_Startup = 100 allocs | HOST_OVERRIDES |
| PC=0 (VL_MungePic) | far-ptr loop + adresse plate invalide | DIRECT_NOOP |
| PC=0 (DrawPlanes+4620) | ScalePost → CALL via fullscalefarcall[] nulle → jump dans corps DrawPlanes | DIRECT_NOOP corps entier (5070 mots) |
| Syntax error patcher | str_replace avait mangé un commentaire de section | Corrigé |

---

## 🧠 ARCHITECTURE (rappel)

```
Gameplay = TNA VM           (WL_AGENT, WL_ACT*, WL_STATE, WL_GAME, WL_PLAY...)
Rendering = host bridge     (AsmRefresh → renderWolfView en JS)
Input = host → MMIO 0xFE00  (keyState → IN_ReadControl TNA natif)
Audio = host (PlaySound → WebAudio)
MM/PM = host (allocateur flat, pas de far-ptr DOS)
Règle : jamais émuler VGA/x86/DOS, toujours intercepter à la frontière C↔ASM
```
