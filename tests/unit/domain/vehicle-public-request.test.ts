import { expect, test } from 'bun:test';
import { createPublicFetcher, PublicAccessPaused } from '../../../lib/vehicle-public-request';
function fake(statuses = [200], title = '') {
  let time = 0, calls = 0; const starts: number[] = [];
  const request = Object.assign(async (url: RequestInfo | URL) => {
    starts.push(time); const status = statuses[Math.min(calls++, statuses.length - 1)]; time += 2;
    const r = new Response(title ? `<title>${title}</title>` : '{}', { status, headers: { 'content-type': title ? 'text/html' : 'application/json' } });
    Object.defineProperty(r, 'url', { value: String(url) }); return r;
  }, { preconnect: fetch.preconnect });
  return { runtime: { request, now: () => time, sleep: async (ms: number) => { time += ms; } }, starts };
}
test('public requests are serialized and spaced after completion, even when callers run concurrently', async () => {
  const f = fake(), request = createPublicFetcher(5, f.runtime);
  await Promise.all([request('https://www.autohome.com.cn/a'), request('https://www.autohome.com.cn/b'), request('https://www.autohome.com.cn/c')]);
  expect(f.starts).toEqual([0, 7, 14]);
});
test('403/429 and challenge pages stop queued requests without retrying', async () => {
  for (const [status, title] of [[403, ''], [429, ''], [200, '安全验证']] as const) {
    const f = fake([status], title), request = createPublicFetcher(5, f.runtime);
    const results = await Promise.allSettled([request('https://www.autohome.com.cn/a'), request('https://www.autohome.com.cn/b')]);
    expect(results.every(r => r.status === 'rejected' && r.reason instanceof PublicAccessPaused)).toBeTrue();
    expect(f.starts).toHaveLength(1);
  }
});
test('transient server failures retry at the same bounded pace; non-retryable errors stop immediately', async () => {
  const f = fake([503, 200]), request = createPublicFetcher(5, f.runtime);
  await request('https://www.autohome.com.cn/a'); expect(f.starts).toEqual([0, 7]);
  const missing = fake([404]); await expect(createPublicFetcher(5, missing.runtime)('https://www.autohome.com.cn/missing')).rejects.toThrow('404');
  expect(missing.starts).toHaveLength(1);
});
test('JSON access-limit messages also pause the process', async () => {
  let calls = 0;
  const request = Object.assign(async () => { calls++; return new Response(JSON.stringify({ returncode: 1, message: '请求频繁，请稍后重试' }), { headers: { 'content-type': 'application/json' } }); }, { preconnect: fetch.preconnect });
  const get = createPublicFetcher(5, { request, now: Date.now, sleep: async () => {} });
  await expect(get('https://www.autohome.com.cn/a')).rejects.toBeInstanceOf(PublicAccessPaused);
  await expect(get('https://www.autohome.com.cn/b')).rejects.toBeInstanceOf(PublicAccessPaused);
  expect(calls).toBe(1);
});
test('operator stop is checked after pacing delay, before issuing the next request', async()=>{
 const f=fake();const get=createPublicFetcher(5,{...f.runtime,shouldStop:async()=>true});
 await expect(get('https://www.autohome.com.cn/a')).rejects.toBeInstanceOf(PublicAccessPaused);expect(f.starts).toHaveLength(0);
});
