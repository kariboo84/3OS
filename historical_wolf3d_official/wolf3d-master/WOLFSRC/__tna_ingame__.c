#include "ID_HEADS.H"
#include "WL_DEF.H"
void CheckForEpisodes(void);
void Patch386(void);
void InitGame(void);
void NewGame(int difficulty,int episode);
void GameLoop(void);
int tna_harness_main(void) {
  CheckForEpisodes();
  Patch386();
  InitGame();
  NewGame(1,0);
  GameLoop();
  return 778;
}
