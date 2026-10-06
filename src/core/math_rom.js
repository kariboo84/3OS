// Table Sinus/Cosus en entiers (x100) pour eviter les floats
// Index 0..359
const SIN_TABLE = [];
const COS_TABLE = [];

for(let i=0; i<360; i++) {
    const rad = i * (Math.PI / 180);
    SIN_TABLE.push(Math.round(Math.sin(rad) * 100));
    COS_TABLE.push(Math.round(Math.cos(rad) * 100));
}

module.exports = { SIN_TABLE, COS_TABLE };