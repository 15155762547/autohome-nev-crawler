import { z } from 'zod';
import { empty, mergeParentGroups, same, sourceIdentity, type Candidate, type Cells } from './vehicle-catalog-source';

export const COMPANY = { base_token: 'Is6Xb3btbazhFhsDXgFcqFG1nRc', models: 'tblxVNjP9dnJ7b3o', trims: 'tbl8YzkZkMxvHRoT' } as const;
export const referenceSchema = z.object({
  version: z.literal(1), source: z.object({ base_token: z.literal(COMPANY.base_token), models_rev: z.number(), trims_rev: z.number(), fetched_at: z.string() }),
  series_ids: z.array(z.number().int().positive()),
  models: z.array(z.object({ record_id: z.string(), model_id: z.string().regex(/^MDL-\d+$/), series_id: z.number(),
    fields: z.object({ MODEL: z.string().min(1), brand: z.string().min(1), model: z.string().min(1), model_year: z.number().nullable(), powertrain_type: z.array(z.string()).length(1) }),
    specs: z.array(z.object({ spec_id: z.number(), trim_config_id: z.string(), trim: z.string().min(1) })).min(1) })) });
export type CompanyReference = z.infer<typeof referenceSchema>;
export const alignmentFields = {
  models: new Set(['MODEL', 'brand', 'model', 'model_id', 'model_year', 'charging', 'common_features_json_pruned']),
  trims: new Set(['trim', 'model_id', 'trim_config_id', 'record_id', 'trim_order', 'trim_price_display', 'drivetrain_display', 'vehicle_model_pruned']),
};
export function assertReference(ref: CompanyReference): void {
  const ids = new Set<string>(), parents = new Set<string>();
  if (!ref.series_ids.length || new Set(ref.series_ids).size !== ref.series_ids.length) throw new Error('Invalid company series scope');
  for (const m of ref.models) {
    if (!ref.series_ids.includes(m.series_id) || parents.has(m.model_id)) throw new Error('Ambiguous company product');
    parents.add(m.model_id);
    for (const t of m.specs) {
      const key = `${m.series_id}/${t.spec_id}`;
      if (ids.has(key) || sourceIdentity(t) !== key) throw new Error('Ambiguous company configuration identity');
      ids.add(key);
    }
  }
}
/** Group using company product identity; source-year groups are only intermediate evidence. */
export function companyCandidates(groups: Candidate[], ref: CompanyReference): Candidate[] {
  assertReference(ref);
  const assigned = new Map<string, Candidate[]>();
  for (const g of groups) for (const t of g.trims) {
    const matches = ref.models.filter(m => m.series_id === g.series_id && m.specs.some(s => s.spec_id === t.spec_id));
    if (matches.length !== 1 || matches[0].fields.powertrain_type[0] !== g.energy) throw new Error(`Company mapping absent/ambiguous: ${g.series_id}/${t.spec_id}`);
    const m = matches[0], subset = { ...g, trims: [t] };
    assigned.set(m.model_id, [...(assigned.get(m.model_id) ?? []), subset]);
  }
  return [...assigned].map(([key, parts]) => {
    const m = ref.models.find(m => m.model_id === key)!;
    // Merge each distinct source group once; trim-level evidence remains intact.
    const sourceGroups = [...new Set(parts.map(p => p.key))].map(k => {
      const ps = parts.filter(p => p.key === k); return { ...ps[0], trims: ps.flatMap(p => p.trims) };
    });
    const g = sourceGroups.length === 1 ? { ...sourceGroups[0], model: { ...sourceGroups[0].model } } : mergeParentGroups(sourceGroups);
    g.key = key; g.model = { ...g.model, ...m.fields };
    g.trims = [...g.trims].sort((a, b) => (typeof a.fields.trim_price_rmb === 'number' ? a.fields.trim_price_rmb : Infinity) - (typeof b.fields.trim_price_rmb === 'number' ? b.fields.trim_price_rmb : Infinity) || a.spec_id - b.spec_id).map((t, i) => {
      const r = m.specs.find(s => s.spec_id === t.spec_id)!;
      const sourceYear = /source name: (\d{4})款/.exec(String(t.fields.notes ?? ''))?.[1];
      const name = sourceYear ? r.trim.replace(/^\d{4}(?= MY\b)/, sourceYear) : r.trim;
      return { ...t, fields: { ...t.fields, trim: name, trim_config_id: r.trim_config_id, trim_order: i + 1, ...(typeof t.fields.trim_price_rmb === 'number' ? { trim_price_display: Math.round(t.fields.trim_price_rmb / 6.74) } : {}) } };
    });
    return g;
  });
}
export function alignmentPatch(kind: 'models' | 'trims', old: Cells | undefined, desired: Cells): Cells {
  return Object.fromEntries(Object.entries(desired).filter(([f, v]) => alignmentFields[kind].has(f) && !same(old?.[f], v) && (!empty(v) || f === 'model_year' && v === null)));
}
export type Retirement = { record_id: string; model_id: string; into_key: string };
export function assertRetirement(retired: Retirement, approved: Retirement[], children: unknown[], backupValid: boolean): void {
  if (!backupValid || children.length || !approved.some(r => same(r, retired)) || !/^AUT-8171-2026-PHEV$/.test(retired.model_id)) {
    throw new Error('Retirement requires verified backup, exact approved Ti7 duplicate and zero remaining links');
  }
}

/** Explicit one-product scope refresh; ordinary sync still protects nonempty values. */
export const seagullScopeFields = new Set(['length_mm', 'width_mm', 'height_mm', 'wheelbase_mm', 'seats_min', 'seats_max', 'top_speed_min_kmh', 'top_speed_max_kmh', 'common_features_json_pruned', 'charging']);
export function seagullScopePatch(old: Cells | undefined, desired: Cells): Cells {
  if (desired.model_id !== 'MDL-002') throw new Error('Scope refresh is limited to BYD Seagull MDL-002');
  return Object.fromEntries([...seagullScopeFields].filter(f => f in desired && !same(old?.[f], desired[f])).map(f => [f, desired[f]]));
}
