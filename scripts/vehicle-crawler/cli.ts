import { resolve, join } from 'node:path';
import { discover, collect, select } from './collect';
import { plan, apply, verify } from './feishu';
import { exclusions } from './exclusions';
import { reference } from './company-reference';

const [command, directory, ...rest] = process.argv.slice(2);
if (!directory || !['discover', 'exclusions', 'select', 'collect', 'reference', 'catalogue-reference', 'plan', 'apply', 'verify'].includes(command)) {
  console.error('bun scripts/vehicle-crawler/cli.ts discover|exclusions|select|collect|plan|apply|verify RUN_DIR [--count N | --series-ids IDS] --exclude FILE'); process.exit(1);
}
const run = resolve(directory);
if (command === 'discover') { if (rest.includes('--all-states')) await (await import('./discover-all')).discoverAll(run); else await discover(run); }
if (command === 'exclusions') await exclusions(run);
if (command === 'select') {
  const value = (flag: string) => rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : undefined;
  const exclude = value('--exclude'), list = value('--series-ids');
  if (list !== undefined && (rest.includes('--series') || rest.includes('--count'))) throw new Error('Use --series-ids alone, not --series/--count');
  const seriesIds = list === undefined ? value('--series') === undefined ? undefined : Number(value('--series')) : list.split(',').map(x => x.trim() ? Number(x) : NaN);
  const count = Array.isArray(seriesIds) ? seriesIds.length : Number(value('--count'));
  if (!exclude || (!list && !rest.includes('--count'))) throw new Error('Select requires --exclude and --count or --series-ids');
  await select(run, count, resolve(exclude), seriesIds, value('--upcoming-spec-ids')?.split(',').map(Number) ?? []);
}
if (command === 'collect') {
  const limitIndex = rest.indexOf('--limit'); const limit = limitIndex < 0 ? undefined : Number(rest[limitIndex + 1]);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error('Invalid limit');
  await collect(run, limit, !rest.includes('--skip-images'));
  if (!(await Bun.file(join(run, 'collection.json')).json()).complete) process.exitCode = 1;
}
if (command === 'reference') await reference(run);
if (command === 'catalogue-reference') await (await import('./catalogue-reference')).catalogueReference(run);
if (command === 'plan') {
  const i = rest.indexOf('--company-reference');
  if (i >= 0 && !rest[i + 1]) throw new Error('Missing company reference file');
  const file = i >= 0 ? resolve(rest[i + 1]) : await Bun.file(join(run, 'company-reference.json')).exists() ? join(run, 'company-reference.json') : undefined;
  if (!file && !rest.includes('--catalogue') && (await Bun.file(join(run, 'selection.json')).json()).series_ids.includes(8171)) throw new Error('Ti7 requires reference RUN before planning');
  await plan(run, !rest.includes('--skip-images'), rest.includes('--allow-partial'), file, rest.includes('--align-existing'), rest.includes('--refresh-seagull-scope'), rest.includes('--catalogue') ? resolve(rest[rest.indexOf('--catalogue')+1]) : undefined);
}
if (command === 'apply') await apply(run);
if (command === 'verify') await verify(run);
