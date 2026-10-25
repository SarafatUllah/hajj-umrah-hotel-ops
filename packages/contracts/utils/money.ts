/** Money (v7 §16): whole halalas in the API and the database (1 SAR = 100), riyals with two decimals where people read or type it. */
export const HALALAS_PER_RIYAL = 100

/** Riyals as whole halalas: two decimals matter, a third rounds to the nearest halala. */
export const toHalalas = (riyals: number): number => Math.round(riyals * HALALAS_PER_RIYAL)

/** Halalas as riyals. */
export const toRiyals = (halalas: number): number => halalas / HALALAS_PER_RIYAL
