import { mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { createPublicFetcher, PublicAccessPaused } from '../../lib/vehicle-public-request';
import { assertDiscovery, interpret, listingSchema, parametersSchema, type Candidate } from '../../lib/vehicle-catalog-source';
import { selectSeries } from '../../lib/vehicle-catalog-selection';

export const BASE = 'https://www.autohome.com.cn/web-main/car/';
export const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
export const save = async (file: string, value: unknown) => { await mkdir(join(file, '..'), { recursive: true }); await Bun.write(file, JSON.stringify(value, null, 2)); };
export const load = async (file: string): Promise<any> => {
  if (await Bun.file(file).exists()) return Bun.file(file).json();
  const manifest = Bun.file(join(dirname(file), 'compressed-backups.json'));
  if (await manifest.exists()) {
    const item = (await manifest.json()).filter((x: any) => x.file === basename(file)).at(-1);
    if (item) { const raw = gunzipSync(new Uint8Array(await Bun.file(join(dirname(file), item.compressed)).arrayBuffer()));
      if (sha(raw) !== item.sha256) throw new Error('Compressed backup hash mismatch'); return JSON.parse(new TextDecoder().decode(raw)); }
  }
  return Bun.file(file).json();
};
export type Source = { url: string; final_url: string; fetched_at: string; sha256: string; file: string; mime: string };
export type Photo = { spec_id: number; picture_id: number; src: string; category_id: number; source_url?: string };
export const requestIntervalMs = Number(process.env.CRAWLER_REQUEST_INTERVAL_MS ?? 5000);
if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 5000 || requestIntervalMs > 60000) throw new Error('CRAWLER_REQUEST_INTERVAL_MS must be 5000..60000');
const scheduledFetch = createPublicFetcher(requestIntervalMs, { request: Object.assign((...args: Parameters<typeof fetch>) => fetch(...args), { preconnect: fetch.preconnect }), now: Date.now, sleep: ms => Bun.sleep(ms), shouldStop: async () => Boolean(process.env.CRAWLER_STOP_FILE && await Bun.file(process.env.CRAWLER_STOP_FILE).exists()) });
export async function fetchPublic(url: string): Promise<{ raw: Uint8Array; final: string; mime: string }> {
  const host = new URL(url).hostname;
  if (!url.startsWith('https://') || !/(?:^|\.)(autohome\.com\.cn|autoimg\.cn)$/.test(host)) throw new Error('Unapproved source host');
  return scheduledFetch(url);
}
export async function source(run: string, key: string, url: string): Promise<{ info: Source; raw: Uint8Array }> {
  if (process.env.CRAWLER_STOP_FILE && await Bun.file(process.env.CRAWLER_STOP_FILE).exists()) throw new PublicAccessPaused('Operator STOP file present');
  const x = await fetchPublic(url), file = `${key}.raw`;
  const info = { url, final_url: x.final, fetched_at: new Date().toISOString(), sha256: sha(x.raw), file, mime: x.mime };
  await Bun.write(join(run, file), x.raw); await save(join(run, `${key}.source.json`), info);
  if (process.env.CRAWLER_PROGRESS_FILE) await save(process.env.CRAWLER_PROGRESS_FILE, { pid: process.pid, last_response_at: info.fetched_at, url, series_run: run });
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
  let total = 0;
  for (let p = 1; p === 1 || p <= Math.ceil(total / 20); p++) {
    const x = await source(run, `discovery-${p}`, `${BASE}search/searchcar?searchtype=6&pageindex=${p}&pagesize=20&orderid=0&state=2`);
    const data = listingSchema.parse(response(x.raw));
    if (p === 1) total = data.seriescount;
    if (data.seriescount !== total) throw new Error('Discovery count changed during API pagination');
    pages.push({ ...x.info, page: p, count: data.seriesgrouplist.length }); rows.push(...data.seriesgrouplist);
    if (p % 10 === 0 || p === Math.ceil(total / 20)) console.log(`目录分页 ${p}/${Math.ceil(total / 20)}`);
  }
  assertDiscovery(rows, total);
  const pageOnlyIds = advertised.seriesgrouplist.filter(s => !rows.some(x => x.seriesid === s.seriesid)).map(s => s.seriesid);
  if (advertised.seriescount === total && pageOnlyIds.length) throw new Error('Page/API identity disagreement without a total-count change');
  await save(join(run, 'discovery.json'), { complete: true, filters: { page: '/price/ev', searchtype: 6, state: 2, orderid: 0, pagesize: 20 },
    fetched_at: page.info.fetched_at, screenshot_baseline: 863, total: rows.length, pages, series: rows,
    page_api_comparison: { page_total: advertised.seriescount, api_total: total, page_only_ids: pageOnlyIds, totals_match: advertised.seriescount === total } });
  console.log(`discovered ${rows.length} series, ${pages.length} pages; page advertised ${advertised.seriescount}`);
}

export function photosFromHtml(html: string, sid: number, ids: number[]): Photo[] {
  const m = /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/.exec(html);
  if (!m) throw new Error('Gallery structure changed');
  const p = JSON.parse(m[1]).props.pageProps;
  if (p.breadInfo.seriesid !== sid) throw new Error('Wrong gallery identity');
  if (p.breadInfo.specid && !ids.includes(p.breadInfo.specid)) throw new Error('Wrong gallery spec identity');
  const root = p.SpecPicList ?? p.SeriesPicList ?? {}, info = root.picinfo ?? {}, groups = Array.isArray(info) ? info : info.callist ?? [];
  const out: Photo[] = [];
  for (const g of groups) {
    if (![1, 10].includes(g.claid)) continue;
    for (const im of g.list ?? []) if (ids.includes(im.specid) && (im.mediatype ?? 0) === 0 && im.picpath) {
      out.push({ spec_id: im.specid, picture_id: im.picid, category_id: g.claid, src: im.picpath.replace(/^http:/, 'https:').replace(/^\/\//, 'https://') });
    }
  }
  for (const spec of root.speclist ?? []) for (const im of spec.piclist ?? []) {
    if (ids.includes(spec.specid) && im.specid === spec.specid && [1, 10].includes(im.claid) && (im.mediatype ?? 0) === 0 && im.picpath) {
      out.push({ spec_id: im.specid, picture_id: im.picid, category_id: im.claid, src: im.picpath.replace(/^http:/, 'https:').replace(/^\/\//, 'https://') });
    }
  }
  return [...new Map(out.map(x => [x.src, x])).values()];
}
/** State 10 alone is insufficient: verify the requested spec page identity and visible launch label. */
export function verifyUpcoming(html: string, sid: number, id: number): string {
  const m = /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/.exec(html);
  if (!m) throw new Error('Upcoming page structure changed');
  const p = JSON.parse(m[1]).props.pageProps, b = p.specDetails?.bread, info = p.specDetails?.specinfo;
  if (p.seriesId !== sid || p.specId !== id || b?.seriesid !== sid || b?.specid !== id || info?.id !== id || info?.specstate !== 10 ||
      !/(预售|即将上市)/.test(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ''))) throw new Error('Requested spec is not a verified upcoming configuration');
  return b.specname;
}
export async function collect(run: string, limit?: number, images = true): Promise<void> {
  if ((await load(join(run, 'selection.json'))).all_sales_states) return (await import('./collect-all')).collectAll(run, limit);
  const discovery = await load(join(run, 'discovery.json'));
  if (!discovery.complete) throw new Error('Incomplete discovery');
  const selection = await load(join(run, 'selection.json'));
  if (!selection.complete || selection.discovery_sha !== sha(await Bun.file(join(run, 'discovery.json')).text())) throw new Error('Select a bounded cohort before collection');
  const chosen = selection.series_ids.map((id: number) => {
    const row = discovery.series.find((s: { seriesid: number }) => s.seriesid === id);
    if (!row || selection.excluded_series_ids.includes(id)) throw new Error('Selected series absent or excluded');
    return row;
  });
  const series = limit ? chosen.slice(0, limit) : chosen;
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < series.length) {
      const s = series[next++], sid = s.seriesid, file = join(run, `series-${sid}.json`);
      try {
        if (await Bun.file(file).exists()) {
          const prior = await load(file);
          for (const x of prior.sources as Source[]) if (sha(new Uint8Array(await Bun.file(join(run, x.file)).arrayBuffer())) !== x.sha256) throw new Error('Cached raw source hash mismatch');
          if (JSON.stringify(prior.upcoming_spec_ids ?? []) !== JSON.stringify(selection.upcoming_spec_ids ?? [])) throw new Error('Cached sales scope differs from selection');
          if (images && prior.images_skipped) throw new Error('Use a new run to collect previously skipped galleries');
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
          const onSaleIds = [...ids], upcomingIds: number[] = selection.upcoming_spec_ids ?? [];
          for (const id of upcomingIds) {
            if (ids.includes(id) || !params.datalist.some(p => p.specid === id && p.specstatus === 10)) throw new Error('Requested upcoming spec absent or already in sale');
            const proof = await source(run, `upcoming-${sid}-${id}`, `https://www.autohome.com.cn/spec/${id}/`); sources.push(proof.info);
            verifyUpcoming(new TextDecoder().decode(proof.raw), sid, id);
            ids.push(id);
          }
          const candidates = interpret(params, ids, b.info.fetched_at);
          const excluded = ids.filter(id => !candidates.some(g => g.trims.some(t => t.spec_id === id)));
          const photos: Photo[] = [], imageErrors: { url: string; error: string }[] = [];
          const gallery = async (key: string, url: string, specs: number[]) => {
            try {
              const c = await source(run, key, url); sources.push(c.info);
              photos.push(...photosFromHtml(new TextDecoder().decode(c.raw), sid, specs).map(p => ({ ...p, source_url: url })));
              const unique = [...new Map(photos.map(p => [p.src, p])).values()]; photos.splice(0, photos.length, ...unique);
            } catch (e) { if (e instanceof PublicAccessPaused) throw e; imageErrors.push({ url, error: String(e) }); }
          };
          if (images) {
          await gallery(`gallery-${sid}`, `https://www.autohome.com.cn/cars/imglist-x-x-${sid}-x-x-x-x-x-x-1.html`, ids);
          for (const group of candidates) for (const cat of [1, 10]) {
            const needed = cat === 1 ? 2 : 1;
            const count = () => photos.filter(p => p.category_id === cat && group.trims.some(t => t.spec_id === p.spec_id)).length;
            for (const trim of group.trims) {
              if (count() >= needed) break;
              await gallery(`gallery-${sid}-${trim.spec_id}-${cat}`, `https://www.autohome.com.cn/cars/imglist-x-x-${sid}-${trim.spec_id}-${cat}-x-x-x-x-1.html`, [trim.spec_id]);
            }
          }
          }
          await save(file, { complete: true, images_skipped: !images, series_id: sid, name: s.seriesname, spec_ids: ids, on_sale_spec_ids: onSaleIds, upcoming_spec_ids: upcomingIds, excluded_non_nev_specs: excluded, candidates, photos, image_errors: imageErrors, sources });
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
  await save(join(run, 'collection.json'), { request_interval_ms: requestIntervalMs, source_concurrency: 1, complete: outcomes.every(x => x.ok), scope: series.map((s: { seriesid: number }) => s.seriesid),
    full_discovery: series.length === discovery.total, success: outcomes.filter(x => x.ok).length, failed: outcomes.filter(x => !x.ok), outcomes });
  console.log(`collection success ${outcomes.filter(x => x.ok).length}; failed ${outcomes.filter(x => !x.ok).length}`);
  for (const outcome of outcomes.filter(x => x.ok)) {
    const packet = await load(join(run, `series-${outcome.series_id}.json`));
    console.log('参数/图库', { name: packet.name, specs: packet.spec_ids.length, image_candidates: packet.photos.length, gallery_errors: packet.image_errors?.length ?? 0 });
  }
}
export async function select(run: string, count: number, exclusionFile: string, seriesId?: number | number[], upcomingSpecIds: number[] = []): Promise<void> {
  if (await Bun.file(join(run, 'collection.json')).exists()) throw new Error('Use a new run directory to select a different cohort');
  const d = await load(join(run, 'discovery.json')), exclusions = await load(exclusionFile);
  if (!d.complete || exclusions.complete !== true || !Array.isArray(exclusions.series_ids)) throw new Error('Discovery/exclusion contract incomplete');
  const ids = selectSeries(d.series.map((s: { seriesid: number }) => s.seriesid), exclusions.series_ids, count, seriesId);
  if (upcomingSpecIds.length && (ids.length !== 1 || upcomingSpecIds.some(id => !Number.isInteger(id) || id <= 0) || new Set(upcomingSpecIds).size !== upcomingSpecIds.length)) throw new Error('Upcoming selection requires one series and unique positive spec IDs');
  await save(join(run, 'selection.json'), { complete: true, all_sales_states: Boolean(d.all_sales_states), upcoming_spec_ids: upcomingSpecIds, requested_series: count, series_ids: ids, excluded_series_ids: exclusions.series_ids,
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

export function parameterSource(packet: any): Source {
 return packet.parameter_source ?? (packet.sources as Source[]).filter(s => s.url.includes('getParamConf')).at(-1)!;
}
export async function readParameters(run: string, packet: any) {
 const p=parameterSource(packet);if(sha(new Uint8Array(await Bun.file(join(run,p.file)).arrayBuffer()))!==p.sha256)throw new Error('Parameter/derived snapshot hash changed');return load(join(run,p.file));
}
