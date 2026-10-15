export class PublicAccessPaused extends Error {}
type Download = { raw: Uint8Array; final: string; mime: string };
type Runtime = { request: typeof fetch; now: () => number; sleep: (ms: number) => Promise<unknown>; shouldStop?: () => Promise<boolean> };
/** One request at a time, including discovery, retries and galleries. Never retry an access challenge. */
export function createPublicFetcher(intervalMs: number, runtime: Runtime) {
  let queue = Promise.resolve(), finished = -Infinity, paused: PublicAccessPaused | undefined;
  const perform = async (url: string): Promise<Download> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (paused) throw paused;
      const delay = Math.max(0, intervalMs - (runtime.now() - finished));
      if (delay) await runtime.sleep(delay);
      if (await runtime.shouldStop?.()) { paused = new PublicAccessPaused('Operator requested STOP'); throw paused; }
      try {
        const r = await runtime.request(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/html,image/*' }, signal: AbortSignal.timeout(30000) });
        const raw = new Uint8Array(await r.arrayBuffer()), mime = r.headers.get('content-type') ?? '';
        const title = mime.includes('html') ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(new TextDecoder().decode(raw))?.[1] ?? '' : '';
        let message = '';
        if (mime.includes('json')) {
          try { const body = JSON.parse(new TextDecoder().decode(raw)); message = String(body.message ?? body.msg ?? body.returnmsg ?? ''); } catch { /* Source parser reports malformed JSON. */ }
        }
        if ([401, 403, 429].includes(r.status) || /验证码|安全验证|安全校验|访问受限|访问异常|访问频繁|Access Denied|Just a moment/i.test(title) || /验证码|安全验证|访问受限|访问频繁|请求频繁|rate limit|too many requests/i.test(message) ||
            /(?:captcha|verify|challenge)/i.test(new URL(r.url || url).pathname)) {
          paused = new PublicAccessPaused(`Public access paused: HTTP ${r.status}; ${url}; ${title || message || 'access denied/challenge'}. Stop and inspect; no automatic retry.`);
          throw paused;
        }
        if (!r.ok) {
          if ([502, 503, 504].includes(r.status) && attempt < 2) continue;
          throw new Error(`HTTP ${r.status}: ${url}`);
        }
        return { raw, final: r.url, mime };
      } catch (error) {
        if (error instanceof PublicAccessPaused || !(error instanceof TypeError || error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name)) || attempt === 2) throw error;
      } finally { finished = runtime.now(); }
    }
    throw new Error('Public request exhausted');
  };
  return (url: string): Promise<Download> => {
    const result = queue.then(() => perform(url));
    queue = result.then(() => {}, () => {});
    return result;
  };
}
