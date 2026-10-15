export function selectSeries(ordered: number[], excluded: number[], count: number, seriesId?: number | number[]): number[] {
  if (!Number.isInteger(count) || count <= 0 || new Set(ordered).size !== ordered.length) throw new Error('Invalid count or duplicate discovery IDs');
  if (Array.isArray(seriesId)) {
    if (!seriesId.length || new Set(seriesId).size !== seriesId.length || count !== seriesId.length || seriesId.some(id => !Number.isInteger(id) || !ordered.includes(id) || excluded.includes(id))) throw new Error('Explicit series IDs must be unique, discovered and eligible');
    return seriesId;
  }
  if (seriesId !== undefined && (count !== 1 || !Number.isInteger(seriesId) || !ordered.includes(seriesId) || excluded.includes(seriesId))) throw new Error('Requested series must be discovered, eligible, and selected alone');
  if (seriesId !== undefined) return [seriesId];
  const blocked = new Set(excluded), chosen = ordered.filter(id => !blocked.has(id)).slice(0, count);
  if (chosen.length !== count) throw new Error('Insufficient eligible series for the requested cohort');
  return chosen;
}
