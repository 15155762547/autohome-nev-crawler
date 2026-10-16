import { realpath, stat, mkdir, readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import sharp from 'sharp';
import { createPublicFetcher } from '../lib/vehicle-public-request';

// Review-only downloader: no Feishu client and no writes outside the external library.
const volume = '/Volumes/奥睿科1TB';
const library = join(volume, '代码程序/汽车之家爬虫图片库');
const output = resolve(process.argv[2] ?? '');
async function guard() {
  const device = (await stat(volume)).dev;
  if (device === (await stat('/')).dev) throw new Error('External disk is not mounted');
  const root = await realpath(library), target = await realpath(output), rel = relative(root, target);
  if ((await stat(root)).dev !== device || (await stat(target)).dev !== device) throw new Error('Library/output must reside on the external disk');
  if (!rel || rel.startsWith('..') || rel.startsWith('/')) throw new Error('Output must be a sample folder inside the external image library');
}
await guard();
type Candidate = { id: string; category: string; title: string; url: string; source_page: string; identity: string; classification_basis: string };
const candidates: Candidate[] = JSON.parse(await readFile(join(output, 'candidates.json'), 'utf8'));
if (new Set(candidates.map(x => x.id)).size !== candidates.length) throw new Error('Duplicate candidate IDs');
const allowed = (url: string) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !(u.hostname === 'prod2.byd.com' || u.hostname === 'www.byd.com' || /^(car\d+|car)\.autoimg\.cn$/.test(u.hostname))) throw new Error(`Unapproved image host: ${u.hostname}`);
};
for (const c of candidates) { allowed(c.url); if (!/^[a-z0-9-]+$/.test(c.id)) throw new Error('Invalid candidate ID'); }
const request: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  allowed(String(input));
  // A redirect must be reviewed before following it to a different endpoint.
  return fetch(input, { ...init, redirect: 'error' });
}, { preconnect: fetch.preconnect });
const get = createPublicFetcher(5000, { request, now: Date.now, sleep: Bun.sleep });
const hash = (raw: Uint8Array) => new Bun.CryptoHasher('sha256').update(raw).digest('hex');
const results: object[] = [], seen = new Set<string>();
for (const c of candidates) {
  await guard();
  const directory = join(output, c.id);
  await mkdir(directory, { recursive: true });
  if (await realpath(directory) !== directory) throw new Error('Image directory must not be a symbolic link');
  const receipt = Bun.file(join(directory, 'metadata.json'));
  let meta;
  if (await receipt.exists()) {
    meta = await receipt.json();
    if (meta.url !== c.url || meta.sha256 !== hash(new Uint8Array(await Bun.file(join(directory, meta.filename)).arrayBuffer()))) throw new Error('Cached image identity/hash mismatch');
  } else {
    const r = await get(c.url);
    allowed(r.final);
    if (!r.mime.startsWith('image/')) throw new Error('Response is not an image');
    const info = await sharp(r.raw).metadata();
    await sharp(r.raw).stats();
    if (!info.width || !info.height || Math.min(info.width, info.height) < 250) throw new Error('Image is too small');
    const filename = `original.${info.format === 'jpeg' ? 'jpg' : info.format}`;
    meta = { ...c, filename, final_url: r.final, fetched_at: new Date().toISOString(), sha256: hash(r.raw), bytes: r.raw.length, width: info.width, height: info.height, status: '待用户确认；未上传飞书' };
    await guard();
    await Bun.write(join(directory, filename), r.raw);
    await Bun.write(receipt, JSON.stringify(meta, null, 2));
  }
  if (seen.has(meta.sha256)) throw new Error('Duplicate image content');
  seen.add(meta.sha256);
  await guard();
  await sharp(join(directory, meta.filename)).resize(440, 270, { fit: 'inside' }).jpeg({ quality: 85 }).toFile(join(directory, 'preview.jpg'));
  results.push(meta);
  await Bun.write(join(output, 'download-manifest.json'), JSON.stringify(results, null, 2));
  console.log(`${results.length}/${candidates.length} ${c.title} ${meta.width}×${meta.height}`);
}
console.log('Downloaded for local review only:', output);
