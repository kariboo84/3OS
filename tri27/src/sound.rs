//! TSG-3 — Ternary Sound Generator (SPEC.md §8).
//! 9 voix (sinus, TRI3 à 3 niveaux, carré équilibré, dent de scie, bruit LFSR GF(3)) + FIFO PCM en trytes.
//! Mixage ramené à un tryte (±9841, arrondi équilibré).

use crate::trit::H9;
use std::collections::VecDeque;

pub const SR: f64 = 44_100.0;
pub const PCM_RATE: f64 = 22_050.0;
pub const PCM_CAP: usize = 16_384;

pub const WAVE_OFF: i64 = 0;
pub const WAVE_SINE: i64 = 1;
pub const WAVE_TRI3: i64 = 2;
pub const WAVE_SQUARE: i64 = 3;
pub const WAVE_SAW: i64 = 4;
pub const WAVE_NOISE3: i64 = 5;

pub const ADDR_VOICES_HI: i64 = -100; // voix v, registre r : -100 - 9v - r
pub const ADDR_VOICES_LO: i64 = -100 - 9 * 9 + 1;
pub const ADDR_PCM_PUSH: i64 = -200;
pub const ADDR_PCM_FREE: i64 = -201;
pub const ADDR_MASTER: i64 = -202;

#[derive(Clone)]
struct Voice {
    freq_mhz: i64,
    wave: i64,
    vol: i64,
    attack_ms: i64,
    release_ms: i64,
    gate: bool,
    phase: f64,
    env: f64,
    lfsr: [u8; 9], // trits non signés 0,1,2 (2 ≡ −1)
    lfsr_pos: usize,
    noise: f64,
}

impl Voice {
    fn new() -> Voice {
        Voice {
            freq_mhz: 0,
            wave: WAVE_OFF,
            vol: 0,
            attack_ms: 5,
            release_ms: 80,
            gate: false,
            phase: 0.0,
            env: 0.0,
            lfsr: [1, 0, 0, 0, 0, 0, 0, 0, 0],
            lfsr_pos: 0,
            noise: 0.0,
        }
    }

    /// LFSR ternaire : s[n] = s[n-6] + s[n-7] + s[n-8] + 2·s[n-9] (mod 3), période 3^9 − 1.
    fn lfsr_step(&mut self) -> f64 {
        let at = |k: usize, s: &Self| s.lfsr[(s.lfsr_pos + 9 - k) % 9] as u32;
        // lfsr_pos pointe sur la case la plus ancienne (s[n-9]) ; s[n-k] = case (pos + 9 - k) % 9
        let next = (at(6, self) + at(7, self) + at(8, self) + 2 * self.lfsr[self.lfsr_pos] as u32) % 3;
        self.lfsr[self.lfsr_pos] = next as u8;
        self.lfsr_pos = (self.lfsr_pos + 1) % 9;
        match next {
            1 => 1.0,
            2 => -1.0,
            _ => 0.0,
        }
    }

    fn sample(&mut self) -> f64 {
        // enveloppe
        if self.gate {
            let step = if self.attack_ms <= 0 { 1.0 } else { 1000.0 / (self.attack_ms as f64 * SR) };
            self.env = (self.env + step).min(1.0);
        } else if self.env > 0.0 {
            let step = if self.release_ms <= 0 { 1.0 } else { 1000.0 / (self.release_ms as f64 * SR) };
            self.env = (self.env - step).max(0.0);
        }
        if self.env <= 0.0 || self.wave == WAVE_OFF || self.vol <= 0 {
            return 0.0;
        }
        let f = self.freq_mhz.max(0) as f64 / 1000.0;
        let inc = f / SR;
        let p = self.phase;
        let x = match self.wave {
            WAVE_SINE => (p * std::f64::consts::TAU).sin(),
            WAVE_TRI3 => {
                // +1 sur [0,1/3), 0 sur [1/3,1/2), −1 sur [1/2,5/6), 0 sur [5/6,1)
                if p < 1.0 / 3.0 {
                    1.0
                } else if p < 0.5 {
                    0.0
                } else if p < 5.0 / 6.0 {
                    -1.0
                } else {
                    0.0
                }
            }
            WAVE_SQUARE => {
                if p < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
            WAVE_SAW => 2.0 * p - 1.0,
            WAVE_NOISE3 => self.noise,
            _ => 0.0,
        };
        let mut np = p + inc;
        while np >= 1.0 {
            np -= 1.0;
            if self.wave == WAVE_NOISE3 {
                self.noise = self.lfsr_step();
            }
        }
        self.phase = np;
        x * self.env * (self.vol.min(H9) as f64)
    }
}

pub struct Tsg {
    voices: Vec<Voice>,
    pub master: i64,
    pcm: VecDeque<i16>,
    pcm_acc: f64,
    pcm_cur: f64,
}

impl Default for Tsg {
    fn default() -> Self {
        Self::new()
    }
}

impl Tsg {
    pub fn new() -> Tsg {
        Tsg { voices: vec![Voice::new(); 9], master: H9, pcm: VecDeque::new(), pcm_acc: 0.0, pcm_cur: 0.0 }
    }

    #[inline]
    pub fn owns(addr: i64) -> bool {
        (ADDR_VOICES_LO..=ADDR_VOICES_HI).contains(&addr) || (ADDR_MASTER..=ADDR_PCM_PUSH).contains(&addr)
    }

    pub fn write(&mut self, addr: i64, v: i64) {
        if (ADDR_VOICES_LO..=ADDR_VOICES_HI).contains(&addr) {
            let k = (ADDR_VOICES_HI - addr) as usize;
            let vo = &mut self.voices[k / 9];
            match k % 9 {
                0 => vo.freq_mhz = v,
                1 => vo.wave = v,
                2 => vo.vol = v.clamp(0, H9),
                3 => vo.attack_ms = v.max(0),
                4 => vo.release_ms = v.max(0),
                5 => vo.gate = v > 0,
                _ => {}
            }
            return;
        }
        match addr {
            ADDR_PCM_PUSH => {
                if self.pcm.len() < PCM_CAP {
                    self.pcm.push_back(v.clamp(-H9, H9) as i16)
                }
            }
            ADDR_MASTER => self.master = v.clamp(0, H9),
            _ => {}
        }
    }

    pub fn read(&self, addr: i64) -> i64 {
        if (ADDR_VOICES_LO..=ADDR_VOICES_HI).contains(&addr) {
            let k = (ADDR_VOICES_HI - addr) as usize;
            let vo = &self.voices[k / 9];
            return match k % 9 {
                0 => vo.freq_mhz,
                1 => vo.wave,
                2 => vo.vol,
                3 => vo.attack_ms,
                4 => vo.release_ms,
                5 => vo.gate as i64,
                _ => 0,
            };
        }
        match addr {
            ADDR_PCM_FREE => (PCM_CAP - self.pcm.len()) as i64,
            ADDR_MASTER => self.master,
            _ => 0,
        }
    }

    /// Rend `out.len()` échantillons mono en f32 (−1..1). Chaque échantillon passe par un tryte.
    pub fn render(&mut self, out: &mut [f32]) {
        for o in out.iter_mut() {
            let mut s = 0.0;
            for v in self.voices.iter_mut() {
                s += v.sample();
            }
            // PCM 22 050 Hz → 44 100 Hz (échantillon tenu)
            self.pcm_acc += PCM_RATE / SR;
            while self.pcm_acc >= 1.0 {
                self.pcm_acc -= 1.0;
                self.pcm_cur = self.pcm.pop_front().map(|x| x as f64).unwrap_or(0.0);
            }
            s += self.pcm_cur;
            s *= self.master as f64 / H9 as f64;
            let tryte = s.round().clamp(-(H9 as f64), H9 as f64); // arrondi équilibré au tryte
            *o = (tryte / H9 as f64 * 0.8) as f32;
        }
    }
}
