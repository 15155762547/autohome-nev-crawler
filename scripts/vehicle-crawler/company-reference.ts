import { join } from 'node:path';
import { COMPANY, assertReference, referenceSchema, type CompanyReference } from '../../lib/vehicle-company-reference';
import { sourceIdentity, type Cells } from '../../lib/vehicle-catalog-source';
import { call } from './feishu';
import { load, save } from './collect';

/** Read-only company catalogue, restricted to products matched by selected source IDs. */
export async function reference(run: string): Promise<void> {
  const selection = await load(join(run, 'selection.json'));
  if (!selection.complete) throw new Error('Reference requires a complete selection');
  const base = ['--base-token', COMPANY.base_token];
  const scan = async (table: string, fields: string[]) => {
    let offset = 0, rev: number | undefined; const rows: Cells[] = [];
    do {
      const file = join(run, `company-${table}-${offset}.ndjson`);
      const r = await call(['+record-list', ...base, '--table-id', table, ...fields.flatMap(f => ['--field-id', f]), '--limit', '2000', '--offset', String(offset), '--format', 'ndjson', '--output', file, '--overwrite']);
      if (rev !== undefined && rev !== r.rev) throw new Error('Company changed during reference read');
      rev = r.rev; rows.push(...(await Bun.file(file).text()).trim().split('\n').filter(Boolean).map(s => JSON.parse(s)));
      if (!r.has_more) break;
      if (!(r.next_offset > offset)) throw new Error('Company pagination did not advance'); offset = r.next_offset;
    } while (true);
    return { rows, rev: rev! };
  };
  const trims = await scan(COMPANY.trims, ['model_id', 'trim_config_id', 'trim', 'vehicle_model_pruned']);
  const selected = trims.rows.filter(t => selection.series_ids.includes(Number(sourceIdentity(t)?.split('/')[0])));
  const models = await scan(COMPANY.models, ['model_id', 'MODEL', 'brand', 'model', 'model_year', 'powertrain_type', 'trim_configurations_pruned']);
  const products: CompanyReference['models'] = [];
  for (const key of new Set(selected.map(t => String(t.model_id)))) {
    const matches = models.rows.filter(m => m.model_id === key);
    if (matches.length !== 1) throw new Error('Company parent identity ambiguous');
    const m = matches[0], ts = selected.filter(t => t.model_id === key), series = [...new Set(ts.map(t => Number(sourceIdentity(t)!.split('/')[0])))];
    if (series.length !== 1) throw new Error('Company parent spans source series');
    for (const t of ts) if (!(t.vehicle_model_pruned as { id: string }[]).some(x => x.id === m.record_id) ||
      !(m.trim_configurations_pruned as { id: string }[]).some(x => x.id === t.record_id)) throw new Error('Company bidirectional identity mismatch');
    products.push({ record_id: String(m.record_id), model_id: key, series_id: series[0],
      fields: { MODEL: String(m.MODEL), brand: String(m.brand), model: String(m.model), model_year: m.model_year as number | null, powertrain_type: m.powertrain_type as string[] },
      specs: ts.map(t => ({ spec_id: Number(sourceIdentity(t)!.split('/')[1]), trim_config_id: String(t.trim_config_id), trim: String(t.trim) })) });
  }
  const result = referenceSchema.parse({ version: 1, source: { base_token: COMPANY.base_token, models_rev: models.rev, trims_rev: trims.rev, fetched_at: new Date().toISOString() },
    series_ids: selection.series_ids, models: products });
  assertReference(result); await save(join(run, 'company-reference.json'), result);
  console.log('只读公司目录参照', { products: products.length, configurations: selected.length });
}
