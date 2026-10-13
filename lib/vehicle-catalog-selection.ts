export function selectSeries(ordered: number[], excluded: number[], count: number): number[] {
  if (!Number.isInteger(count) || count <= 0 || new Set(ordered).size !== ordered.length) throw new Error('Invalid count or duplicate discovery IDs');
  const blocked = new Set(excluded), chosen = ordered.filter(id => !blocked.has(id)).slice(0, count);
  if (chosen.length !== count) throw new Error('Insufficient eligible series for the requested cohort');
  return chosen;
}
