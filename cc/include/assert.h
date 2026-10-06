#ifndef TRI_ASSERT_H
#define TRI_ASSERT_H
void __tri_assert_fail(const char*,const char*,int);
#ifdef NDEBUG
#define assert(e) ((void)0)
#else
#define assert(e) ((e)?(void)0:__tri_assert_fail(#e,__FILE__,__LINE__))
#endif
#endif
