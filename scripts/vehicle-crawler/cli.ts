import { resolve } from 'node:path';
import { discover, collect, select } from './collect';
import { plan, apply, verify } from './feishu';
import { exclusions } from './exclusions';

const [command, directory, ...rest] = process.argv.slice(2);
if (!directory || !['discover', 'exclusions', 'select', 'collect', 'plan', 'apply', 'verify'].includes(command)) {
  console.error('bun scripts/vehicle-crawler/cli.ts discover|exclusions|select|collect|plan|apply|verify RUN_DIR [--count N | --series-ids IDS] --exclude FILE'); process.exit(1);
}
const run = resolve(directory);
if (command === 'discover') await discover(run);
if (command === 'exclusions') await exclusions(run);
if (command === 'select') {
  const value = (flag: string) => rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : undefined;
  const exclude = value('--exclude'), list = value('--series-ids');
  if (list !== undefined && (rest.includes('--series') || rest.includes('--count'))) throw new Error('Use --series-ids alone, not --series/--count');
  const seriesIds = list === undefined ? value('--series') === undefined ? undefined : Number(value('--series')) : list.split(',').map(x => x.trim() ? Number(x) : NaN);
  const count = Array.isArray(seriesIds) ? seriesIds.length : Number(value('--count'));
  if (!exclude || (!list && !rest.includes('--count'))) throw new Error('Select requires --exclude and --count or --series-ids');
  await select(run, count, resolve(exclude), seriesIds);
}
if (command === 'collect') {
  const limitIndex = rest.indexOf('--limit'); const limit = limitIndex < 0 ? undefined : Number(rest[limitIndex + 1]);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error('Invalid limit');
  await collect(run, limit);
}
if (command === 'plan') await plan(run, !rest.includes('--skip-images'), rest.includes('--allow-partial'));
if (command === 'apply') await apply(run);
if (command === 'verify') await verify(run);
