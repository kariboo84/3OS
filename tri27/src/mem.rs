//! Mémoire creuse de la VM : la RAM invitée peut être immense (jusqu'à la moitié positive de l'espace
//! d'adressage, ~3,8 × 10¹² trytes) ; l'hôte n'alloue que les pages réellement écrites.
//! Une page jamais écrite se lit comme des zéros. Le découpage en pages hôte (2^15 trytes) est
//! invisible pour le programme invité.

use crate::isa::Inst;

const PB: usize = 15;
const PS: usize = 1 << PB;
const PM: usize = PS - 1;

pub struct Ram {
    pages: Vec<Option<Box<[i16]>>>,
    size: usize,
    /// Pages hôte allouées (mesure de la mémoire réellement consommée).
    pub allocated: usize,
}

impl Ram {
    pub fn new(size: usize) -> Ram {
        Ram { pages: (0..size.div_ceil(PS)).map(|_| None).collect(), size, allocated: 0 }
    }

    #[inline(always)]
    pub fn len(&self) -> usize {
        self.size
    }

    /// Octets hôte occupés par les données (hors table des pages).
    pub fn host_bytes(&self) -> usize {
        self.allocated * PS * 2
    }

    /// Lecture d'une tryte ; `u < len()` est garanti par l'appelant.
    #[inline(always)]
    pub fn get(&self, u: usize) -> i16 {
        match &self.pages[u >> PB] {
            Some(p) => p[u & PM],
            None => 0,
        }
    }

    #[inline(always)]
    pub fn set(&mut self, u: usize, v: i16) {
        let i = u >> PB;
        if let Some(p) = &mut self.pages[i] {
            p[u & PM] = v;
        } else if v != 0 {
            self.alloc(i)[u & PM] = v;
        }
    }

    #[cold]
    #[inline(never)]
    fn alloc(&mut self, i: usize) -> &mut [i16] {
        self.allocated += 1;
        self.pages[i].insert(vec![0i16; PS].into_boxed_slice())
    }

    /// Mot de 3 trytes (petit-boutiste) ; chemin rapide si les 3 trytes sont dans la même page.
    #[inline(always)]
    pub fn get3(&self, u: usize) -> (i16, i16, i16) {
        if (u & PM) + 2 < PS {
            match &self.pages[u >> PB] {
                Some(p) => {
                    let o = u & PM;
                    (p[o], p[o + 1], p[o + 2])
                }
                None => (0, 0, 0),
            }
        } else {
            (self.get(u), self.get(u + 1), self.get(u + 2))
        }
    }

    pub fn write_slice(&mut self, a: usize, src: &[i16]) {
        for (k, &v) in src.iter().enumerate() {
            self.set(a + k, v);
        }
    }

    pub fn read_slice(&self, a: usize, dst: &mut [i16]) {
        for (k, d) in dst.iter_mut().enumerate() {
            *d = self.get(a + k);
        }
    }
}

const CB: usize = 12;
const CS: usize = 1 << CB;
const CM: usize = CS - 1;

/// Cache des instructions décodées, par page : seules les pages exécutées sont allouées.
/// Chemin rapide : la dernière page utilisée est mémorisée (une comparaison par instruction).
pub struct ICache {
    pages: Vec<Option<Box<[Inst]>>>,
    last: usize,
    ptr: *mut Inst,
}

impl ICache {
    pub fn new(words: usize) -> ICache {
        ICache { pages: (0..words.div_ceil(CS)).map(|_| None).collect(), last: usize::MAX, ptr: std::ptr::null_mut() }
    }

    #[inline(always)]
    pub fn get(&mut self, ci: usize) -> &mut Inst {
        let i = ci >> CB;
        if i != self.last {
            self.switch(i);
        }
        // SAFETY : `ptr` pointe sur la page `last` (Box sur le tas, jamais déplacée tant qu'elle
        // n'est pas libérée ; `clear` remet `last` à usize::MAX), et `ci & CM < CS`.
        unsafe { &mut *self.ptr.add(ci & CM) }
    }

    #[cold]
    #[inline(never)]
    fn switch(&mut self, i: usize) {
        let p = self.pages[i].get_or_insert_with(|| vec![Inst::UNDECODED; CS].into_boxed_slice());
        self.ptr = p.as_mut_ptr();
        self.last = i;
    }

    #[inline(always)]
    pub fn invalidate(&mut self, ci: usize) {
        if let Some(Some(p)) = self.pages.get_mut(ci >> CB) {
            p[ci & CM] = Inst::UNDECODED;
        }
    }

    pub fn invalidate_range(&mut self, ci0: usize, ci1: usize) {
        for ci in ci0..ci1 {
            self.invalidate(ci);
        }
    }

    pub fn clear(&mut self) {
        for p in self.pages.iter_mut() {
            *p = None;
        }
        self.last = usize::MAX;
        self.ptr = std::ptr::null_mut();
    }
}
