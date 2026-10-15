import { expect, test, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, save, load, sha } from '../../../scripts/vehicle-crawler/collect';

test('gallery identity errors are reported separately from successful in-sale parameters', async () => {
  const run = await mkdtemp(join(tmpdir(), 'vehicle-collection-'));
  const discovery = { complete: true, total: 1, series: [{ seriesid: 6939, seriesname: 'MEGA', specids: [78129] }] };
  await save(join(run, 'discovery.json'), discovery);
  await save(join(run, 'selection.json'), { complete: true, series_ids: [6939], excluded_series_ids: [], discovery_sha: sha(await Bun.file(join(run, 'discovery.json')).text()) });
  const mocked = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (request: RequestInfo | URL) => {
    const url = String(request);
    const result = url.includes('getSpecList') ? { seriesid: 6939, items: [{ id: 78129, specname: '2026款 Home', specstate: 20 }] } : {
      bread: { seriesid: 6939, seriesname: 'MEGA', brandname: '理想' },
      titlelist: [{ items: [{ itemname: '能源类型', titleid: 1 }] }],
      datalist: [{ specid: 78129, specname: '2026款 Home', specstatus: 20, paramconflist: [{ titleid: 1, itemname: '纯电动' }] }],
    };
    const response = new Response(url.includes('imglist') ? '<script id="__NEXT_DATA__">{"props":{"pageProps":{"breadInfo":{"seriesid":999}}}}</script>' :
      JSON.stringify({ returncode: 0, result }), { headers: { 'content-type': url.includes('imglist') ? 'text/html' : 'application/json' } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  }, { preconnect: globalThis.fetch.preconnect }));
  try {
    await collect(run);
    expect((await load(join(run, 'collection.json'))).complete).toBeTrue();
    const packet = await load(join(run, 'series-6939.json'));
    expect(packet.candidates[0].trims[0].spec_id).toBe(78129);
    expect(packet.photos).toHaveLength(0);
    expect(packet.image_errors).toHaveLength(3);
    expect(packet.image_errors.every((e: any) => e.error.includes('gallery identity'))).toBeTrue();
    const skipRun = join(run, 'without-images');
    await save(join(skipRun, 'discovery.json'), discovery);
    await save(join(skipRun, 'selection.json'), await load(join(run, 'selection.json')));
    const previousCalls = mocked.mock.calls.length;
    await collect(skipRun, undefined, false);
    const skipped = await load(join(skipRun, 'series-6939.json'));
    expect(skipped.images_skipped).toBeTrue(); expect(skipped.photos).toHaveLength(0); expect(skipped.image_errors).toHaveLength(0);
    expect(mocked.mock.calls.slice(previousCalls).every(args => !String(args[0]).includes('imglist'))).toBeTrue();
  } finally { mocked.mockRestore(); await rm(run, { recursive: true, force: true }); }
}, 60000);
