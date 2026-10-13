import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { assertDiscovery, interpret, listingSchema, parametersSchema, type Candidate } from '../../lib/vehicle-catalog-source';
import { selectSeries } from '../../lib/vehicle-catalog-selection';

export const BASE = 'https://www.autohome.com.cn/web-main/car/';
export const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
export const save = async (file: string, value: unknown) => { await mkdir(join(file, '..'), { recursive: true }); await Bun.write(file, JSON.stringify(value, null, 2)); };
export const load = (file: string) => Bun.file(file).json();
export type Source = { url: string; final_url: string; fetched_at: string; sha256: string; file: string; mime: string };
export type Photo = { spec_id: number; picture_id: number; src: string; category_id: number };
export async function fetchPublic(url: string): Promise<{ raw: Uint8Array; final: string; mime: string }> {
  const host = new URL(url).hostname;
  if (!url.startsWith('https://') || !/(?:^|\.)(autohome\.com\.cn|autoimg\.cn)$/.test(host)) throw new Error('Unapproved source host');
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/html,image/*' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { raw: new Uint8Array(await r.arrayBuffer()), final: r.url, mime: r.headers.get('content-type') ?? '' };
    } catch (e) { if (attempt === 2) throw e; await Bun.sleep(1000 * (attempt + 1)); }
  }
}
export async function source(run: string, key: string, url: string): Promise<{ info: Source; raw: Uint8Array }> {
  const x = await fetchPublic(url), file = `${key}.raw`;
  const info = { url, final_url: x.final, fetched_at: new Date().toISOString(), sha256: sha(x.raw), file, mime: x.mime };
  await Bun.write(join(run, file), x.raw); await save(join(run, `${key}.source.json`), info);
  if (x.final !== url) throw new Error(`Unexpected redirect: ${url} -> ${x.final}`);
  return { info, raw: x.raw };
}
const response = (raw: Uint8Array) => {
  const v = z.object({ returncode: z.literal(0), result: z.unknown() }).parse(JSON.parse(new TextDecoder().decode(raw)));
  return v.result;
};
export async function discover(run: string): Promise<void> {
  await mkdir(run, { recursive: true });
  const page = await source(run, 'discovery-page', 'https://www.autohome.com.cn/price/ev');
  const html = new TextDecoder().decode(page.raw), m = /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/.exec(html);
  if (!m) throw new Error('Discovery page structure changed');
  const props = JSON.parse(m[1]).props.pageProps;
  if (props.type !== 'ev' || props.searchtype !== 6 || props.filter) throw new Error('Wrong page scope');
  const advertised = listingSchema.parse(props.seriesList), pages: (Source & { page: number; count: number })[] = [], rows: typeof advertised.seriesgrouplist = [];
  for (let p = 1; p <= Math.ceil(advertised.seriescount / 20); p++) {
    const x = await source(run, `discovery-${p}`, `${BASE}search/searchcar?searchtype=6&pageindex=${p}&pagesize=20&orderid=0&state=2`);
    const data = listingSchema.parse(response(x.raw));
    if (data.seriescount !== advertised.seriescount) throw new Error('Discovery count changed during pagination');
    pages.push({ ...x.info, page: p, count: data.seriesgrouplist.length }); rows.push(...data.seriesgrouplist);
  }
  assertDiscovery(rows, advertised.seriescount);
  if (advertised.seriesgrouplist.some(s => !rows.some(x => x.seriesid === s.seriesid))) throw new Error('Page/API disagreement');
  await save(join(run, 'discovery.json'), { complete: true, filters: { page: '/price/ev', searchtype: 6, state: 2, orderid: 0, pagesize: 20 },
    fetched_at: page.info.fetched_at, screenshot_baseline: 863, total: rows.length, pages, series: rows });
  console.log(`discovered ${rows.length} series, ${pages.length} pages`);
}
export function photosFromHtml(html: string, sid: number, ids: number[]): Photo[] {
  const m = /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/.exec(html);
  if (!m) throw new Error('Gallery structure changed');
  const p = JSON.parse(m[1]).props.pageProps;
  if (p.breadInfo.seriesid !== sid) throw new Error('Wrong gallery identity');
  const root = p.SeriesPicList ?? p.SpecPicList ?? {}, info = root.picinfo ?? {}, groups = Array.isArray(info) ? info : info.callist ?? [];
  const out: Photo[] = [];
  for (const g of groups) {
    if (![1, 10].includes(g.claid)) continue;
    for (const im of g.list ?? []) if (ids.includes(im.specid) && (im.mediatype ?? 0) === 0 && im.picpath) {
      out.push({ spec_id: im.specid, picture_id: im.picid, category_id: g.claid, src: im.picpath.replace(/^http:/, 'https:').replace(/^\/\//, 'https://') });
    }
  }
  return [...new Map(out.map(x => [x.src, x])).values()];
}
export async function collect(run: string, limit?: number): Promise<void> {
  const discovery = await load(join(run, 'discovery.json'));
  if (!discovery.complete) throw new Error('Incomplete discovery');
  const selection = await load(join(run, 'selection.json'));
  if (!selection.complete || selection.discovery_sha !== sha(await Bun.file(join(run, 'discovery.json')).text())) throw new Error('Select a bounded cohort before collection');
  const chosen = discovery.series.filter((s: { seriesid: number }) => selection.series_ids.includes(s.seriesid));
  const series = limit ? chosen.slice(0, limit) : chosen;
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < series.length) {
      const s = series[next++], sid = s.seriesid, file = join(run, `series-${sid}.json`);
      try {
        if (await Bun.file(file).exists()) {
          const prior = await load(file);
          for (const x of prior.sources as Source[]) if (sha(new Uint8Array(await Bun.file(join(run, x.file)).arrayBuffer())) !== x.sha256) throw new Error('Cached raw source hash mismatch');
          if (!prior.complete) throw new Error('Incomplete cached series');
        } else {
          const sources: Source[] = [];
          const a = await source(run, `specs-${sid}`, `${BASE}spec/getSpecList?searchtype=6&seriesid=${sid}&state=2&orderid=0`); sources.push(a.info);
          const specList = z.object({ seriesid: z.literal(sid), items: z.array(z.object({ id: z.number(), specname: z.string(), specstate: z.number() })) }).parse(response(a.raw));
          const ids = specList.items.map(x => x.id);
          if (!ids.length || new Set(ids).size !== ids.length || JSON.stringify([...ids].sort()) !== JSON.stringify([...s.specids].sort())) throw new Error('Discovery/in-sale spec list changed');
          let b = await source(run, `params-${sid}`, `${BASE}param/getParamConf?mode=1&site=1&seriesid=${sid}`); sources.push(b.info);
          let params = parametersSchema.parse(response(b.raw));
          if (ids.some(x => !params.datalist.some(p => p.specid === x))) {
            b = await source(run, `params-selected-${sid}`, `${BASE}param/getParamConf?mode=1&site=1&seriesid=${sid}&specids=${ids.join(',')}`); sources.push(b.info);
            params = parametersSchema.parse(response(b.raw));
          }
          if (params.bread.seriesid !== sid) throw new Error('Wrong parameter series identity');
          const candidates = interpret(params, ids, b.info.fetched_at);
          const excluded = ids.filter(id => !candidates.some(g => g.trims.some(t => t.spec_id === id)));
          const c = await source(run, `gallery-${sid}`, `https://www.autohome.com.cn/cars/imglist-x-x-${sid}-x-x-x-x-x-x-1.html`); sources.push(c.info);
          const photos = photosFromHtml(new TextDecoder().decode(c.raw), sid, candidates.flatMap(g => g.trims.map(t => t.spec_id)));
          await save(file, { complete: true, series_id: sid, name: s.seriesname, spec_ids: ids, excluded_non_nev_specs: excluded, candidates, photos, sources });
        }
        await save(join(run, `error-${sid}.json`), null);
      } catch (e) { await save(join(run, `error-${sid}.json`), { series_id: sid, error: String(e), failed_at: new Date().toISOString() }); }
      done++; if (done % 20 === 0 || done === series.length) console.log(`collected ${done}/${series.length}`);
    }
  }));
  const outcomes = await Promise.all(series.map(async (s: { seriesid: number }) => {
    const error = await load(join(run, `error-${s.seriesid}.json`));
    return error ?? { series_id: s.seriesid, ok: true };
  }));
  await save(join(run, 'collection.json'), { complete: outcomes.every(x => x.ok), scope: series.map((s: { seriesid: number }) => s.seriesid),
    full_discovery: series.length === discovery.total, success: outcomes.filter(x => x.ok).length, failed: outcomes.filter(x => !x.ok), outcomes });
  console.log(`collection success ${outcomes.filter(x => x.ok).length}; failed ${outcomes.filter(x => !x.ok).length}`);
}
export async function select(run: string, count: number, exclusionFile: string): Promise<void> {
  if (await Bun.file(join(run, 'collection.json')).exists()) throw new Error('Use a new run directory to select a different cohort');
  const d = await load(join(run, 'discovery.json')), exclusions = await load(exclusionFile);
  if (!d.complete || exclusions.complete !== true || !Array.isArray(exclusions.series_ids)) throw new Error('Discovery/exclusion contract incomplete');
  const ids = selectSeries(d.series.map((s: { seriesid: number }) => s.seriesid), exclusions.series_ids, count);
  await save(join(run, 'selection.json'), { complete: true, requested_series: count, series_ids: ids, excluded_series_ids: exclusions.series_ids,
    exclusion_sha: sha(await Bun.file(exclusionFile).text()), discovery_sha: sha(await Bun.file(join(run, 'discovery.json')).text()), selected_at: new Date().toISOString() });
  console.log(`selected ${ids.length} series after exclusions`);
}
export async function downloadPhotos(run: string, group: Candidate, candidates: Photo[]) {
  const selected: Photo[] = [];
  for (const cat of [1, 10]) for (const p of candidates.filter(p => p.category_id === cat && group.trims.some(t => t.spec_id === p.spec_id)).slice(0, cat === 1 ? 2 : 1)) selected.push(p);
  return await Promise.all(selected.map(async p => {
    const key = `image-${group.key}-${p.picture_id}`, metadataFile = join(run, `${key}.source.json`);
    const info: Source | undefined = await Bun.file(metadataFile).exists() ? await load(metadataFile) : undefined;
    const x = info && info.url === p.src ? { info, raw: new Uint8Array(await Bun.file(join(run, info.file)).arrayBuffer()) } : await source(run, key, p.src);
    if (sha(x.raw) !== x.info.sha256) throw new Error('Cached image hash changed');
    if (!x.info.mime.startsWith('image/')) throw new Error('Non-image response');
    const meta = await sharp(x.raw).metadata();
    if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < 200 || !['jpeg', 'png', 'webp'].includes(meta.format ?? '')) throw new Error('Invalid image content/dimensions');
    // Validate decoding, but retain original bytes and hash for attachments.
    await sharp(x.raw).stats();
    const file = `image-${group.key}-${p.picture_id}.${meta.format === 'jpeg' ? 'jpg' : meta.format}`;
    await Bun.write(join(run, file), x.raw);
    return { ...p, file, size: x.raw.length, sha256: x.info.sha256, width: meta.width, height: meta.height };
  }));
}
