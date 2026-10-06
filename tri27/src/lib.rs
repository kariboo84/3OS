pub mod asm;
pub mod isa;
pub mod trit;
pub mod vm;

#[cfg(target_arch = "wasm32")]
pub mod wasm;
