import { resolve } from 'node:path';
import { discover, collect, select } from './collect';
import { plan, apply, verify } from './feishu';
import { exclusions } from './exclusions';

const [command, directory, ...rest] = process.argv.slice(2);
if (!directory || !['discover', 'exclusions', 'select', 'collect', 'plan', 'apply', 'verify'].includes(command)) {
  console.error('bun scripts/vehicle-crawler/cli.ts discover|exclusions|select|collect|plan|apply|verify RUN_DIR [--count N --exclude FILE]'); process.exit(1);
}
const run = resolve(directory);
if (command === 'discover') await discover(run);
if (command === 'exclusions') await exclusions(run);
if (command === 'select') {
  const count = Number(rest[rest.indexOf('--count') + 1]), exclude = rest[rest.indexOf('--exclude') + 1];
  if (!rest.includes('--count') || !rest.includes('--exclude') || !exclude) throw new Error('Select requires --count and --exclude');
  await select(run, count, resolve(exclude));
}
if (command === 'collect') {
  const limitIndex = rest.indexOf('--limit'); const limit = limitIndex < 0 ? undefined : Number(rest[limitIndex + 1]);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error('Invalid limit');
  await collect(run, limit);
}
if (command === 'plan') await plan(run, !rest.includes('--skip-images'), rest.includes('--allow-partial'));
if (command === 'apply') await apply(run);
if (command === 'verify') await verify(run);
