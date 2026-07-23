/**
 * Pack-based display helpers. Stock is always stored/computed in single
 * pieces; products with unitsPerPack > 1 just get a friendlier rendering
 * ("4 pkt + 3 pcs") and Packet<->Piece conversion in forms.
 */

/** "43" → "4 pkt + 3 pcs" when unitsPerPack is 10; plain number otherwise. */
export function formatStock(pieces: number, unitsPerPack?: number | null): string {
  if (!unitsPerPack || unitsPerPack <= 1) return String(pieces);
  const sign = pieces < 0 ? "-" : "";
  const abs = Math.abs(pieces);
  const packs = Math.floor(abs / unitsPerPack);
  const loose = abs % unitsPerPack;
  if (packs === 0) return `${sign}${loose} pcs`;
  if (loose === 0) return `${sign}${packs} pkt`;
  return `${sign}${packs} pkt + ${loose} pcs`;
}
