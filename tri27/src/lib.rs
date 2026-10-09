pub mod asm;
pub mod isa;
pub mod mem;
pub mod sound;
pub mod trit;
pub mod vector;
pub mod vm;

#[cfg(target_arch = "wasm32")]
pub mod wasm;
