import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertRetirement, alignmentFields, assertReference } from '../../lib/vehicle-company-reference';
import { empty, same, sourceIdentity, type Cells } from '../../lib/vehicle-catalog-source';
import { maintainedFields } from '../../lib/vehicle-catalog-audit';
import { LAB, call, snapshot, validateFields, type Plan, type Snapshot } from './feishu';
import { load, save, sha } from './collect';

type Kind = 'models' | 'trims';
/** A resumed write may see only the exact old value or the exact planned value. */
export function remainingPatch(current: Cells, old: Cells, desired: Cells, primaryFieldId?: string): Cells {
  const result: Cells = {};
  for (const [field, value] of Object.entries(desired)) {
    const key = field === primaryFieldId ? '_primary_text' : field;
    if (same(current[key], value)) continue;
    if (!same(current[key], old[key])) throw new Error(`Concurrent edit of ${field}`);
    result[field] = value;
  }
  return result;
}
export async function verifyBackup(directory: string, planSha: string): Promise<boolean> {
  try {
    const manifest = await load(join(directory, 'manifest.json'));
    if (manifest.plan_sha !== planSha || manifest.complete !== true || !manifest.files?.length) return false;
    for (const file of manifest.files) {
      const path = resolve(directory, file.path);
      if (!path.startsWith(resolve(directory) + '/') || sha(new Uint8Array(await Bun.file(path).arrayBuffer())) !== file.sha256) return false;
    }
    return true;
  } catch { return false; }
}
const settle = async (kind: Kind, run: string) => {
  let prior = -1;
  for (let attempt = 0; attempt < 8; attempt++) {
    await Bun.sleep(1500);
    const r = await call(['+record-list', '--base-token', LAB.base_token, '--table-id', LAB.tables[kind], '--field-id', 'model_id', '--limit', '1',
      '--format', 'ndjson', '--output', join(run, `${kind}-alignment-revision.ndjson`), '--overwrite']);
    if (prior === r.rev) return r.rev; prior = r.rev;
  }
  throw new Error('Alignment revision did not settle; inspect before resuming');
};
async function backup(run: string, p: Plan, planSha: string): Promise<void> {
  const directory = join(run, 'alignment-backup');
  if (await Bun.file(join(directory, 'manifest.json')).exists()) {
    if (!await verifyBackup(directory, planSha)) throw new Error('Existing backup is incomplete or corrupted');
    return;
  }
  await mkdir(directory, { recursive: true });
  const files: { path: string; sha256: string }[] = [];
  await save(join(directory, 'before.json'), p.before);
  files.push({ path: 'before.json', sha256: sha(await Bun.file(join(directory, 'before.json')).text()) });
  const ids = new Set([...p.updates.models.map(r => r.prior_id!), ...p.alignment!.retired.map(r => r.record_id)]);
  for (const id of ids) {
    const row = p.before.models.rows.find(r => r.record_id === id)!;
    const attachments = row.brochure_cover as { name: string; size: number; file_token: string }[] ?? [];
    if (!attachments.length) continue;
    const target = resolve(directory, id); await mkdir(target, { recursive: true });
    const proc = Bun.spawn(['lark-cli', 'base', '+record-download-attachment', '--base-token', LAB.base_token, '--table-id', LAB.tables.models,
      '--record-id', id, '--output', target, '--overwrite', '--profile', LAB.profile, '--as', 'user'], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code || !JSON.parse(out).ok) throw new Error(`Attachment backup failed: ${err}`);
    const downloaded = JSON.parse(out).data.downloaded;
    if (downloaded.length !== attachments.length) throw new Error('Incomplete attachment backup');
    for (const attachment of attachments) {
      const saved = downloaded.find((x: any) => x.file_token === attachment.file_token);
      if (!saved || !resolve(saved.saved_path).startsWith(target + '/')) throw new Error('Attachment backup path/identity mismatch');
      const data = new Uint8Array(await Bun.file(saved.saved_path).arrayBuffer());
      if (data.length !== attachment.size) throw new Error('Attachment backup size mismatch');
      files.push({ path: `${id}/${saved.saved_path.slice(target.length + 1)}`, sha256: sha(data) });
    }
  }
  await save(join(directory, 'manifest.json'), { complete: true, plan_sha: planSha, files, restore: 'before.json contains schemas, original fields and both link directions. Attachment files are stored per original record ID. Restore retired parent first, then restore trim links and original technical fields; new system IDs must be remapped if the deleted record cannot be recovered.' });
  if (!await verifyBackup(directory, planSha)) throw new Error('Backup verification failed');
}
export async function applyMigration(run: string, p: Plan): Promise<void> {
  const a = p.alignment!;
  assertReference(a.reference);
  if (!a.align_existing || !same(a.reference.series_ids, [8171]) || !same(p.target, LAB) || p.creates.models.length || p.creates.trims.length ||
    a.reference_sha !== sha(JSON.stringify(a.reference)) || p.selection_sha !== sha(await Bun.file(join(run, 'selection.json')).text()) ||
    p.source_sha !== sha(await Bun.file(join(run, 'collection.json')).text())) throw new Error('Alignment scope/reference/source changed');
  const planSha = sha(await Bun.file(join(run, 'plan.json')).text());
  const read = async (label: string) => ({ models: await snapshot('models', run, label), trims: await snapshot('trims', run, label) });
  let current = await read('alignment-prewrite');
  let receipt: any = await Bun.file(join(run, 'apply.json')).exists() ? await load(join(run, 'apply.json')) : null;
  const resuming = receipt?.plan_sha === planSha;
  if (!resuming) {
    for (const kind of ['models', 'trims'] as const) if (current[kind].rev !== p.before[kind].rev) throw new Error('Table changed; replan before migration');
    receipt = { plan_sha: planSha, created: { models: 0, trims: 0 }, updated: { models: 0, trims: 0 }, uploads: 0, deleted_models: [],
      updated_ids: { models: [], trims: [] }, ids: { models: p.model_ids, trims: Object.fromEntries(p.before.trims.rows.map(r => [sourceIdentity(r), r.record_id])) }, synced_model_ids: [] };
  }
  const assertCurrent = (now: Record<Kind, Snapshot>) => {
    for (const kind of ['models', 'trims'] as const) {
      const sorted = (s: Snapshot) => [...s.schema].sort((a, b) => a.id.localeCompare(b.id));
      if (!same(sorted(now[kind]), sorted(p.before[kind]))) throw new Error('Schema changed during migration');
      const beforeIds = new Set(p.before[kind].rows.map(r => r.record_id));
      if (now[kind].rows.some(r => !beforeIds.has(r.record_id))) throw new Error('Concurrent record creation');
      for (const old of p.before[kind].rows) {
        const actual = now[kind].rows.find(r => r.record_id === old.record_id);
        if (!actual) {
          if (kind === 'models' && (receipt.deleted_models.includes(old.record_id) || receipt.delete_intent === old.record_id) && a.retired.some(r => r.record_id === old.record_id)) continue;
          throw new Error('Unexpected deleted record');
        }
        const planned = p.updates[kind].find(r => r.prior_id === old.record_id);
        for (const f of p.before[kind].schema) {
          const key = f.name === 'record_id' ? '_primary_text' : f.name;
          if (['formula', 'updated_at', 'updated_by'].includes(f.type)) continue;
          if (kind === 'models' && f.type === 'link' && f.name === 'trim_configurations_pruned' &&
            (p.groups.some(g => p.model_ids[g.model_key] === old.record_id) || a.retired.some(r => r.record_id === old.record_id))) continue;
          const desired = planned && (f.name in planned.fields ? planned.fields[f.name] : planned.fields[f.id]);
          const hasDesired = planned && (f.name in planned.fields || f.id in planned.fields);
          if (hasDesired && (same(actual[key], desired) || same(actual[key], old[key]))) continue;
          if (kind === 'models' && f.name === 'last_synced_at' && receipt.sync_time && same(actual[key], receipt.sync_time)) continue;
          if (!same(actual[key], old[key])) throw new Error(`Concurrent edit outside planned changes: ${old.record_id}/${f.name}`);
        }
      }
    }
  };
  assertCurrent(current);
  if (!p.updates.models.length && !p.updates.trims.length && !a.retired.length) {
    await save(join(run, 'apply.json'), receipt);
    console.log('公司目录对齐', { updated: receipt.updated, retired: 0, created: receipt.created, uploads: 0 }); return;
  }
  // A missing backup cannot be recreated from an already partially migrated state.
  if (resuming && !await verifyBackup(join(run, 'alignment-backup'), planSha)) throw new Error('Cannot resume without original verified backup');
  await backup(run, p, planSha);
  await save(join(run, 'apply.json'), receipt);
  for (const kind of ['models', 'trims'] as const) {
    const changes: Record<string, Cells> = {};
    for (const record of p.updates[kind]) {
      const old = p.before[kind].rows.find(r => r.record_id === record.prior_id)!;
      const now = current[kind].rows.find(r => r.record_id === record.prior_id)!;
      for (const f of Object.keys(record.fields)) {
        const name = current[kind].schema.find(x => x.id === f)?.name ?? f;
        if (!alignmentFields[kind].has(name) && !maintainedFields.has(name) && !empty(old[name]) && !same(old[name], record.fields[f])) throw new Error(`Unapproved overwrite ${name}`);
      }
      const patch = remainingPatch(now, old, record.fields, current[kind].schema.find(f => f.name === 'record_id')?.id);
      if (Object.keys(patch).length) { validateFields(patch, current[kind].schema); changes[record.prior_id!] = patch; }
    }
    if (Object.keys(changes).length) {
      if (await settle(kind, run) !== current[kind].rev) throw new Error('Concurrent revision before alignment batch');
      receipt.intent = { kind, ids: Object.keys(changes) }; await save(join(run, 'apply.json'), receipt);
      const r = await call(['+record-batch-update', '--base-token', LAB.base_token, '--table-id', LAB.tables[kind]], true, { update_records: changes });
      await save(join(run, `${kind}-alignment-receipt.json`), r);
      if (!same([...r.data.record_id_list].sort(), Object.keys(changes).sort())) throw new Error('Incomplete alignment receipt');
      await settle(kind, run); if (kind === 'trims') await settle('models', run);
    }
    if (receipt.intent?.kind === kind) {
      receipt.updated_ids[kind] = [...new Set([...receipt.updated_ids[kind], ...receipt.intent.ids])]; delete receipt.intent;
    }
    receipt.updated[kind] = receipt.updated_ids[kind].length; await save(join(run, 'apply.json'), receipt);
    current = await read(`alignment-after-${kind}`); assertCurrent(current);
    for (const record of p.updates[kind]) {
      const now = current[kind].rows.find(r => r.record_id === record.prior_id)!;
      if (Object.keys(remainingPatch(now, p.before[kind].rows.find(r => r.record_id === record.prior_id)!, record.fields,
        current[kind].schema.find(f => f.name === 'record_id')?.id)).length) throw new Error('Planned alignment value not visible');
    }
  }
  // Read both link directions before considering the single approved duplicate deletion.
  for (const group of p.groups) {
    const parent = current.models.rows.find(r => r.record_id === p.model_ids[group.model_key])!;
    const children = group.spec_ids.map(id => current.trims.rows.find(r => sourceIdentity(r) === `${group.series_id}/${id}`)!);
    if (!same(parent.trim_configurations_pruned, children.map(r => ({ id: r.record_id }))) || children.some(r => !same(r.vehicle_model_pruned, [{ id: parent.record_id }]))) throw new Error('Alignment links not complete');
  }
  for (const retired of a.retired) {
    const row = current.models.rows.find(r => r.record_id === retired.record_id);
    if (row) {
      assertRetirement(retired, a.retired, row.trim_configurations_pruned as unknown[] ?? [], await verifyBackup(join(run, 'alignment-backup'), planSha));
      if (row.model_id !== retired.model_id || await settle('models', run) !== current.models.rev) throw new Error('Retirement record/version changed');
      receipt.delete_intent = retired.record_id; await save(join(run, 'apply.json'), receipt);
      // Deliberately not added to call()/guardWrite(): only this verified migration may retire a record.
      const proc = Bun.spawn(['lark-cli', 'base', '+record-delete', '--base-token', LAB.base_token, '--table-id', LAB.tables.models,
        '--record-id', retired.record_id, '--yes', '--profile', LAB.profile, '--as', 'user'], { stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code || !JSON.parse(out).ok) throw new Error(`Retirement failed: ${err}`);
      await save(join(run, 'retirement-receipt.json'), JSON.parse(out)); await settle('models', run);
    } else if (receipt.delete_intent !== retired.record_id && !receipt.deleted_models.includes(retired.record_id)) throw new Error('Unrecorded retirement');
    receipt.deleted_models = [...new Set([...receipt.deleted_models, retired.record_id])]; delete receipt.delete_intent;
    await save(join(run, 'apply.json'), receipt);
    current = await read('alignment-after-retirement'); assertCurrent(current);
  }
  const changed = p.groups.filter(g => receipt.updated_ids.models.includes(p.model_ids[g.model_key]) || g.spec_ids.some(id => receipt.updated_ids.trims.includes(receipt.ids.trims[`${g.series_id}/${id}`])));
  if (changed.length) {
    receipt.sync_time ??= new Date().toISOString(); receipt.synced_model_ids = changed.map(g => p.model_ids[g.model_key]); await save(join(run, 'apply.json'), receipt);
    const updates = Object.fromEntries(receipt.synced_model_ids.filter((id: string) => !same(current.models.rows.find(r => r.record_id === id)?.last_synced_at, receipt.sync_time)).map((id: string) => [id, { last_synced_at: receipt.sync_time }]));
    if (Object.keys(updates).length) {
      if (await settle('models', run) !== current.models.rev) throw new Error('Concurrent edit before sync time');
      await call(['+record-batch-update', '--base-token', LAB.base_token, '--table-id', LAB.tables.models], true, { update_records: updates }); await settle('models', run);
    }
  }
  await save(join(run, 'apply.json'), receipt);
  console.log('公司目录对齐', { updated: receipt.updated, retired: receipt.deleted_models.length, created: receipt.created, uploads: receipt.uploads });
}
