//! Molette : accumulation bornée, lecture consommante et réveil, sans injection guest.
use super::*;

#[test]
fn wheel_accumule_et_consomme() {
    let mut v=Vm::new(1000);
    v.set_wheel(3);v.set_wheel(2);v.set_wheel(-1);
    assert_eq!(v.mmio_read(mmio::MOUSE_WHEEL),4);
    assert_eq!(v.mmio_read(mmio::MOUSE_WHEEL),0);
    v.set_wheel(-3);
    assert_eq!(v.mmio_read(mmio::MOUSE_WHEEL),-3);
}

#[test]
fn wheel_borne_reveille_et_remise_a_zero() {
    let mut v=Vm::new(1000);
    v.waiting=true;v.set_wheel(0);assert!(v.waiting);
    v.set_wheel(i64::MAX);assert!(!v.waiting);
    v.set_wheel(i64::MAX);
    assert_eq!(v.mmio_read(mmio::MOUSE_WHEEL),27);
    v.set_wheel(i64::MIN);
    assert_eq!(v.mmio_read(mmio::MOUSE_WHEEL),-27);
    v.set_wheel(2);
    v.mmio_write(mmio::MOUSE_WHEEL,9); // Non-zéro : pas d'injection d'événement.
    assert_eq!(v.mmio_read(mmio::MOUSE_WHEEL),2);
    v.set_wheel(3);v.mmio_write(mmio::MOUSE_WHEEL,0);
    assert_eq!(v.mmio_read(mmio::MOUSE_WHEEL),0);
}
