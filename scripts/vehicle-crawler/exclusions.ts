/** Read the actual first 115 rows and derive source IDs; never mutate production. */
import { join } from 'node:path';
import { call } from './feishu';
import { BASE, load, save, source, sha } from './collect';
import type { Cells } from '../../lib/vehicle-catalog-source';

const PRODUCTION = { base: 'Is6Xb3btbazhFhsDXgFcqFG1nRc', models: 'tblxVNjP9dnJ7b3o', trims: 'tbl8YzkZkMxvHRoT' };
export function explicitSeries(text: string): number[] {
  return [...new Set([...text.matchAll(/(?:config\/series\/|seriesid=|Autohome series\s+)(\d+)/g)].map(m => Number(m[1])).filter(id => id > 0))];
}
function seriesIds(value: unknown): number[] {
  if (!value || typeof value !== 'object') return [];
  const obj = value as Record<string, unknown>;
  return [...(typeof obj.seriesid === 'number' && obj.seriesid > 0 ? [obj.seriesid] : []), ...Object.values(obj).flatMap(seriesIds)];
}
export async function exclusions(run: string): Promise<void> {
  const d = await load(join(run, 'discovery.json'));
  const views = (await call(['+view-list', '--base-token', PRODUCTION.base, '--table-id', PRODUCTION.models, '--json'])).data.views;
  const view = views.find((v: { name: string; type: string }) => v.name === '表格' && v.type === 'grid');
  if (!view) throw new Error('Source default grid not found');
  const file = join(run, 'production-first115.ndjson');
  const manifest = await call(['+record-list', '--base-token', PRODUCTION.base, '--table-id', PRODUCTION.models, '--view-id', view.id,
    '--limit', '115', '--offset', '0', '--format', 'ndjson', '--output', file, '--overwrite',
    ...['MODEL', 'model_id', 'brand', 'trim_source_summary_pruned', 'trim_configurations_pruned'].flatMap(f => ['--field-id', f])]);
  const rows: Cells[] = (await Bun.file(file).text()).trim().split('\n').map(line => JSON.parse(line));
  if (rows.length !== 115 || new Set(rows.map(r => r.record_id)).size !== 115) throw new Error('Source first115 incomplete');
  const childIds = [...new Set(rows.flatMap(r => (r.trim_configurations_pruned as { id: string }[] ?? []).map(x => x.id)))];
  const trims: Cells[] = []; let trimRevision;
  for (let i = 0; i < childIds.length; i += 200) {
    const path = join(run, `exclusion-trims-${i}.ndjson`);
    const m = await call(['+record-get', '--base-token', PRODUCTION.base, '--table-id', PRODUCTION.trims, '--format', 'ndjson', '--output', path, '--overwrite',
      ...childIds.slice(i, i + 200).flatMap(id => ['--record-id', id]), ...['model_id', 'notes', 'source_url'].flatMap(f => ['--field-id', f])]);
    if (m.has_more || m.records_count !== childIds.slice(i, i + 200).length || trimRevision !== undefined && trimRevision !== m.rev) throw new Error('Trim exclusion snapshot incomplete or changed');
    trimRevision = m.rev; trims.push(...(await Bun.file(path).text()).trim().split('\n').map(line => JSON.parse(line)));
  }
  const evidence = rows.map(r => ({ model_id: String(r.model_id), MODEL: String(r.MODEL), brand: typeof r.brand === 'string' ? r.brand : '',
    series_ids: explicitSeries([r.trim_source_summary_pruned, ...trims.filter(t => t.model_id === r.model_id).flatMap(t => [t.notes, t.source_url])].join('\n')),
    resolution: 'Explicit source URL or notes' }));
  const sources: unknown[] = [], unresolved: string[] = [], blocked = new Set(evidence.flatMap(e => e.series_ids));
  for (const e of evidence.filter(e => !e.series_ids.length)) {
    const urls = trims.filter(t => t.model_id === e.model_id).map(t => String(t.source_url ?? ''));
    for (const url of urls) {
      const spec = /https:\/\/(?:car|www)\.autohome\.com\.cn\/config\/spec\/(\d+)\.html/.exec(url);
      if (spec) {
        const s = await source(run, `exclusion-spec-${spec[1]}`, spec[0]); sources.push(s.info);
        const html = new TextDecoder().decode(s.raw), ids = [...html.matchAll(/\bseriesid\s*=\s*(\d+)/g)].map(m => Number(m[1])).filter(id => id > 0);
        if (new Set(ids).size === 1) { e.series_ids = [ids[0]]; e.resolution = 'Linked Autohome spec page metadata'; }
      } else if (/^https:\/\/newcar\.xcar\.com\.cn\/m\d+\/$/.test(url)) {
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok || r.url !== url) throw new Error('Linked source page redirected/failed');
        const raw = new Uint8Array(await r.arrayBuffer()), html = new TextDecoder('gb18030').decode(raw);
        const title = /<title>(.*?)<\/title>/s.exec(html)?.[1] ?? '';
        const matches = d.series.filter((s: { seriesname: string }) => title.includes(s.seriesname));
        const file = `exclusion-${e.model_id}.raw`; await Bun.write(join(run, file), raw);
        sources.push({ url, fetched_at: new Date().toISOString(), sha256: sha(raw), file, title });
        if (matches.length === 1) { e.series_ids = [matches[0].seriesid]; e.resolution = 'Exact Chinese name in linked source title'; }
      }
    }
    if (e.series_ids.length) { e.series_ids.forEach(id => blocked.add(id)); continue; }
    // A foreign-market source may have no China series ID. Avoid its entire verified brand in this pilot.
    const sameBrand = e.brand ? evidence.find(other => other.brand === e.brand && other.series_ids.length) : undefined;
    if (!sameBrand) { unresolved.push(e.model_id); continue; }
    const sid = sameBrand.series_ids[0];
    const param = await source(run, `exclusion-brand-identity-${sid}`, `${BASE}param/getParamConf?mode=1&site=1&seriesid=${sid}`); sources.push(param.info);
    const p = JSON.parse(new TextDecoder().decode(param.raw));
    if (p.returncode !== 0 || p.result?.bread?.seriesid !== sid || !p.result.bread.brandid) throw new Error('Brand exclusion identity unverified');
    const brand = await source(run, `exclusion-brand-${p.result.bread.brandid}`, `${BASE}series/getserieslistbybrandid?brandid=${p.result.bread.brandid}`); sources.push(brand.info);
    const b = JSON.parse(new TextDecoder().decode(brand.raw)); if (b.returncode !== 0) throw new Error('Brand source failed');
    const all = seriesIds(b.result); if (!all.length) throw new Error('Brand list missing series IDs');
    e.series_ids = [...new Set(all)].filter(id => d.series.some((s: { seriesid: number }) => s.seriesid === id));
    e.resolution = 'No direct series ID; conservatively exclude verified brand for the pilot'; e.series_ids.forEach(id => blocked.add(id));
  }
  const check = await call(['+record-list', '--base-token', PRODUCTION.base, '--table-id', PRODUCTION.models, '--limit', '1', '--field-id', 'model_id',
    '--format', 'ndjson', '--output', join(run, 'exclusion-revision.ndjson'), '--overwrite']);
  if (check.rev !== manifest.rev) throw new Error('Production changed while exclusions were resolved; retry');
  await save(join(run, 'exclusions.json'), { complete: !unresolved.length, first_rows: 115, view_id: view.id, source_revision: manifest.rev,
    series_ids: [...blocked].sort((a, b) => a - b), evidence, unresolved, sources });
  if (unresolved.length) throw new Error(`Unresolved exclusions: ${unresolved.join(', ')}`);
  console.log(`resolved 115 source rows; excluded ${blocked.size} series IDs`);
}
