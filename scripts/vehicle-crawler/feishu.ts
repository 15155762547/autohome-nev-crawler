import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { empty, interpret, matchesFormulaNumber, mergeParentGroups, protectedFields, same, sourceIdentity, type Candidate, type Cells } from '../../lib/vehicle-catalog-source';
import { load, save, sha, downloadPhotos, type Source } from './collect';
import { auditField, auditNotes, csvAudit, maintainedFields, reconcileMaintained, type AuditEntry } from '../../lib/vehicle-catalog-audit';
import { referenceSchema, assertReference, companyCandidates, alignmentPatch, alignmentFields, type CompanyReference, type Retirement } from '../../lib/vehicle-company-reference';

export const LAB = { base_token: 'EB60b9omTaMyZzsJ273cKdL8nkb', profile: 'shengxu',
  tables: { models: 'tblzyug797w8obPF', trims: 'tbljGsW6q0bvSxri' } } as const;
type Kind = keyof typeof LAB.tables;
const fieldSchema = z.object({ id: z.string(), name: z.string(), type: z.string(), options: z.array(z.object({ name: z.string() })).optional() }).passthrough();
type Field = z.infer<typeof fieldSchema>;
export type Snapshot = { schema: Field[]; rows: Cells[]; rev: number };
type Planned = { key: string; prior_id?: string; fields: Cells; model_key?: string };
export type Plan = { target: typeof LAB; source_sha: string; selection_sha: string; before: Record<Kind, Snapshot>; creates: Record<Kind, Planned[]>;
  updates: Record<Kind, Planned[]>; model_ids: Record<string, string>; conflicts: unknown[]; pending: unknown[];
    groups: { key: string; model_key: string; series_id: number; spec_ids: number[]; images: Awaited<ReturnType<typeof downloadPhotos>> }[];
  alignment?: { reference: CompanyReference; reference_sha: string; align_existing: boolean; retired: Retirement[] } };

export function guardWrite(args: string[]): void {
  if (args[args.indexOf('--base-token') + 1] !== LAB.base_token || !args.includes('--base-token') ||
      !Object.values(LAB.tables).includes(args[args.indexOf('--table-id') + 1] as typeof LAB.tables.models)) throw new Error('Only the authorized lab tables can be mutated');
  if (!['+record-batch-create', '+record-batch-update', '+record-upload-attachment'].includes(args[0])) throw new Error('Unapproved mutation');
}
export async function call(args: string[], write = false, body?: unknown): Promise<any> {
  if (write || !['+field-list', '+view-list', '+record-list', '+record-get'].includes(args[0])) guardWrite(args);
  if (body !== undefined) {
    const file = resolve(import.meta.dir, '../../.vehicle-crawler-runs', `payload-${randomUUID()}.json`);
    await save(file, body); args = [...args, '--json', `@${file}`];
  }
  const p = Bun.spawn(['lark-cli', 'base', ...args, '--profile', LAB.profile, '--as', 'user'], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code) throw new Error(`lark-cli failed: ${err}`);
  const result = JSON.parse(out);
  if (result.ok !== true && !(result.manifest_version === 'v1' && result.format === 'ndjson')) throw new Error('Feishu did not confirm success');
  return result;
}
const args = (kind: Kind) => ['--base-token', LAB.base_token, '--table-id', LAB.tables[kind]];
export async function snapshot(kind: Kind, directory: string, label: string): Promise<Snapshot> {
  const schema = z.array(fieldSchema).parse((await call(['+field-list', ...args(kind), '--json'])).data.fields);
  const names = schema.filter(f => f.name !== 'record_id').map(f => f.name), rows = new Map<string, Cells>();
  let rev: number | undefined;
  for (let projection = 0; projection < names.length; projection += 50) {
    let offset = 0;
    do {
      const file = join(directory, `${kind}-${label}-${projection}-${offset}.ndjson`);
      const m = await call(['+record-list', ...args(kind), '--limit', '2000', '--offset', String(offset), '--format', 'ndjson', '--output', file, '--overwrite',
        ...names.slice(projection, projection + 50).flatMap(n => ['--field-id', n])]);
      if (rev !== undefined && rev !== m.rev) throw new Error('Concurrent table edit during snapshot');
      rev = m.rev;
      for (const line of (await Bun.file(file).text()).split('\n').filter(Boolean)) {
        const r = JSON.parse(line);
        if (projection === 0 && rows.has(r.record_id)) throw new Error('Duplicate pagination row');
        rows.set(r.record_id, { ...rows.get(r.record_id), ...r });
      }
      if (!m.has_more) break;
      if (!(m.next_offset > offset)) throw new Error('Invalid Feishu pagination'); offset = m.next_offset;
    } while (true);
  }
  if (kind === 'trims') {
    const fid = schema.find(f => f.name === 'record_id')!.id, ids = [...rows.keys()];
    for (let start = 0; start < ids.length; start += 200) {
      const r = await call(['+record-get', ...args(kind), '--field-id', fid, '--format', 'json', ...ids.slice(start, start + 200).flatMap(id => ['--record-id', id])]);
      const matrix = r.data;
      if (matrix.has_more || matrix.field_id_list[0] !== fid || matrix.record_id_list.length !== ids.slice(start, start + 200).length) throw new Error('Incomplete primary matrix');
      if (matrix.rev !== rev) throw new Error('Concurrent edit during primary matrix read');
      matrix.record_id_list.forEach((id: string, i: number) => { rows.get(id)!._primary_text = matrix.data[i][0]; });
    }
  }
  const result = { schema, rows: [...rows.values()], rev: rev! }; await save(join(directory, `${kind}-${label}.json`), result); return result;
}
export function validateFields(fields: Cells, schema: Field[]): void {
  for (const [key, value] of Object.entries(fields)) {
    const f = schema.find(f => f.name === key || f.id === key);
    if (!f || ['formula', 'lookup', 'attachment', 'created_at', 'updated_at'].includes(f.type) || protectedFields.has(f.name)) throw new Error(`Forbidden field ${key}`);
    if (value === null) continue;
    if (f.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`Invalid numeric ${key}`);
    if (f.type === 'select' && (!Array.isArray(value) || value.some(v => !f.options?.some(o => o.name === v)))) throw new Error(`Unmapped option ${key}`);
    if (f.type === 'checkbox' && typeof value !== 'boolean') throw new Error(`Invalid checkbox ${key}`);
    if (f.type === 'link' && (!Array.isArray(value) || value.some(x => typeof x.id !== 'string' || !x.id.startsWith('rec')))) throw new Error('Invalid link identity');
  }
}
function unique(rows: Cells[], key: (r: Cells) => string | null): Map<string, Cells> {
  const m = new Map<string, Cells>();
  for (const row of rows) { const k = key(row); if (!k) throw new Error('Unresolved existing source identity'); if (m.has(k)) throw new Error(`Duplicate existing key ${k}`); m.set(k, row); }
  return m;
}
export async function plan(run: string, images = true, allowPartial = false, companyFile?: string, alignExisting = false): Promise<void> {
  const collection = await load(join(run, 'collection.json'));
  const selection = await load(join(run, 'selection.json'));
  if (!same(collection.scope, selection.series_ids) || !selection.complete || collection.scope.some((sid: number) => selection.excluded_series_ids.includes(sid))) throw new Error('Collection differs from the approved bounded selection');
  if (!collection.complete && !allowPartial) throw new Error('Incomplete collection: retry failed series or explicitly use --allow-partial');
  if (await Bun.file(join(run, 'plan.json')).exists()) {
    const history = join(run, 'history', String(Date.now()));
    for (const file of ['plan.json', 'apply.json', 'verification.json']) if (await Bun.file(join(run, file)).exists()) await save(join(history, file), await load(join(run, file)));
  }
  const before = { models: await snapshot('models', run, 'before'), trims: await snapshot('trims', run, 'before') };
  const models = unique(before.models.rows, r => typeof r.model_id === 'string' && r.model_id ? r.model_id : null), trims = unique(before.trims.rows, sourceIdentity);
  const p: Plan = { target: LAB, source_sha: sha(await Bun.file(join(run, 'collection.json')).text()), selection_sha: sha(await Bun.file(join(run, 'selection.json')).text()), before,
    creates: { models: [], trims: [] }, updates: { models: [], trims: [] }, model_ids: {}, conflicts: [], pending: [], groups: [] };
  if (alignExisting && !companyFile) throw new Error('Alignment requires explicit company reference');
  if (companyFile) {
    const ref = referenceSchema.parse(await load(companyFile)); assertReference(ref);
    if (!same([...ref.series_ids].sort(), [...selection.series_ids].sort())) throw new Error('Company reference selection mismatch');
    if (alignExisting && !same(selection.series_ids, [8171])) throw new Error('Existing-record migration is authorized only for Ti7');
    p.alignment = { reference: ref, reference_sha: sha(JSON.stringify(ref)), align_existing: alignExisting, retired: [] };
  }
  const add = (kind: Kind, key: string, desired: Cells, prior?: Cells, modelKey?: string) => {
    const { patch, conflicts } = reconcileMaintained(prior, desired);
    const overrides = p.alignment?.align_existing ? alignmentPatch(kind, prior, desired) : {};
    Object.assign(patch, overrides);
    p.conflicts.push(...conflicts.filter(c => !(c.field in overrides)).map(c => ({ table: kind, key, ...c })));
    validateFields(patch, before[kind].schema);
    const record = { key, prior_id: prior?.record_id as string | undefined, fields: patch, model_key: modelKey };
    if (!prior) p.creates[kind].push(record); else if (Object.keys(patch).length) p.updates[kind].push(record);
    if (kind === 'models' && prior) p.model_ids[key] = prior.record_id as string;
  };
  const scope = collection.scope as number[]; let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < scope.length) {
    const sid = scope[next++];
    if (collection.failed.some((x: { series_id: number }) => x.series_id === sid)) continue;
    const packet = await load(join(run, `series-${sid}.json`));
    for (const s of packet.sources as Source[]) if (sha(new Uint8Array(await Bun.file(join(run, s.file)).arrayBuffer())) !== s.sha256) throw new Error('Source hash changed before planning');
    // Mapping is rerunnable from preserved raw responses when rules evolve; collection stays immutable.
    const parameter = (packet.sources as Source[]).filter(s => s.url.includes('getParamConf')).at(-1)!;
    const raw = await load(join(run, parameter.file));
    if (raw.returncode !== 0 || raw.result?.bread?.seriesid !== sid) throw new Error('Source parameter identity mismatch');
    let candidates = interpret(raw.result, packet.spec_ids, parameter.fetched_at);
    if (p.alignment) candidates = companyCandidates(candidates, p.alignment.reference);
    const assigned = new Map<string, Candidate[]>();
    for (const sourceGroup of candidates) {
      if (p.alignment) { assigned.set(sourceGroup.key, [sourceGroup]); continue; }
      const parents = [...new Set(sourceGroup.trims.map(t => trims.get(`${sid}/${t.spec_id}`)?.model_id).filter(Boolean))] as string[];
      for (const parent of new Set([...parents, ...(sourceGroup.trims.some(t => !trims.has(`${sid}/${t.spec_id}`)) ? [parents.length === 1 ? parents[0] : sourceGroup.key] : [])])) {
        const subset = sourceGroup.trims.filter(t => (trims.get(`${sid}/${t.spec_id}`)?.model_id ?? (parents.length === 1 ? parents[0] : sourceGroup.key)) === parent);
        if (subset.length) assigned.set(parent, [...(assigned.get(parent) ?? []), { ...sourceGroup, trims: subset }]);
      }
    }
    for (const [modelKey, related] of assigned) {
      const g = related.length === 1 ? related[0] : mergeParentGroups(related);
      let prior = models.get(modelKey);
      if (p.alignment) {
        const parents = [...new Set(g.trims.map(t => trims.get(`${sid}/${t.spec_id}`)?.model_id).filter(Boolean))] as string[];
        if (!prior && parents.length && !p.alignment.align_existing) throw new Error('Existing product needs explicit --align-existing migration');
        if (!prior && parents.length) prior = parents.map(key => models.get(key)!).sort((a, b) => Number(a.model_year) - Number(b.model_year) || String(a.model_id).localeCompare(String(b.model_id)))[0];
        for (const parent of parents.filter(k => k !== prior?.model_id)) {
          const old = models.get(parent)!;
          const outside = before.trims.rows.filter(t => t.model_id === parent && !g.trims.some(s => sourceIdentity(t) === `${sid}/${s.spec_id}`));
          if (outside.length || [...protectedFields].some(f => !empty(old[f]) && old[f] !== false)) throw new Error('Cannot retire product with outside trims or business content');
          p.alignment.retired.push({ record_id: String(old.record_id), model_id: parent, into_key: modelKey });
        }
        if (prior && !p.alignment.align_existing && prior.model_id !== modelKey) throw new Error('Company identity mismatch');
      }
      if (!p.alignment && modelKey.startsWith('MDL-') && !prior) throw new Error('Orphan existing trim');
      const desired: Cells = { ...g.model, model_id: modelKey };
      let photoList: Awaited<ReturnType<typeof downloadPhotos>> = [];
      if (images && empty(prior?.brochure_cover)) {
        try { photoList = await downloadPhotos(run, g, packet.photos); }
        catch (e) { p.pending.push({ group: g.key, image_error: String(e) }); }
      }
      if (photoList.length) {
        Object.assign(desired, { image_url: photoList[0].src, gallery_images_json: JSON.stringify(photoList.map(p => ({ src: p.src, cat: p.category_id === 1 ? 'Exterior' : 'Interior', label: `${packet.name}; spec ${p.spec_id}`, spec_id: p.spec_id }))) });
      }
      const currentIds = g.trims.map(t => t.spec_id);
      const linkedIds = (prior?.trim_configurations_pruned as { id: string }[] ?? []).map(x => x.id);
      const oldChildren = g.trims.map(t => trims.get(`${sid}/${t.spec_id}`)?.record_id);
      Object.assign(desired, { trim_last_verified_at: parameter.fetched_at,
        trim_section_status_pruned: [linkedIds.some(id => !oldChildren.includes(id)) ? 'Partial' : 'Verified'],
        trim_source_summary_pruned: `Autohome series ${sid}; current group specs ${currentIds.join(',')}; source fetched ${parameter.fetched_at}; ${p.alignment ? 'English product/configuration names and representative model year from company catalogue; source years remain per configuration.' : 'Chinese source names retained.'}` });
      const missing = before.models.schema.filter(f => !['formula', 'link'].includes(f.type)).map(f => auditField('models', modelKey, f,
        f.name in desired ? desired[f.name] : prior?.[f.name], desired[f.name], g, parameter.url)).filter(e =>
        !(p.alignment && e.field === 'model_year') && ['来源未披露', '条件不明确', '枚举不适配', '代码未覆盖'].includes(e.category));
      desired.review_notes = auditNotes(prior?.review_notes, `来源：${parameter.url}\n来源采集时间：${parameter.fetched_at}\n本组配置：${currentIds.join(',')}\n` +
        missing.sort((a, b) => a.field.localeCompare(b.field)).map(e => `${e.field}：${e.reason}`).join('\n'));
      add('models', modelKey, desired, prior);
      for (const t of g.trims) {
        const key = `${sid}/${t.spec_id}`, old = trims.get(key);
        if (old && !p.alignment?.align_existing && !empty(old.vehicle_model_pruned) && !same(old.vehicle_model_pruned, [{ id: prior?.record_id }])) throw new Error(`Existing parent link disagrees with model_id: ${key}`);
        const record: Cells = { ...t.fields, model_id: modelKey, trim_config_id: p.alignment ? t.fields.trim_config_id : old?.trim_config_id ?? t.fields.trim_config_id };
        const fid = before.trims.schema.find(f => f.name === 'record_id')!.id;
        if (!old || empty(old._primary_text) || p.alignment?.align_existing && old._primary_text !== record.trim_config_id) record[fid] = record.trim_config_id;
        if (p.alignment?.align_existing && old && !same(old.vehicle_model_pruned, [{ id: prior?.record_id }])) record.vehicle_model_pruned = [{ id: prior!.record_id }];
        add('trims', key, record, old, modelKey);
      }
      p.groups.push({ key: g.key, model_key: modelKey, series_id: sid, spec_ids: g.trims.map(t => t.spec_id), images: photoList });
      // Use the same field classifications for planning and final read-back audit.
      for (const kind of ['models', 'trims'] as const) for (const f of before[kind].schema) {
        if (kind === 'models') {
          const entry = auditField(kind, modelKey, f, prior?.[f.name], desired[f.name], g, parameter.url);
          p.pending.push({ group: g.key, table: kind, field: f.name, disposition: entry.category, reason: entry.reason });
        } else for (const t of g.trims) {
          const entry = auditField(kind, `${sid}/${t.spec_id}`, f, trims.get(`${sid}/${t.spec_id}`)?.[f.name], t.fields[f.name], g, parameter.url, t.spec_id);
          p.pending.push({ group: g.key, spec_id: t.spec_id, table: kind, field: f.name, disposition: entry.category, reason: entry.reason });
        }
      }
    }
    if (p.groups.length % 50 < assigned.size) console.log(`planned ${p.groups.length} model groups`);
  } }));
  for (const kind of ['models', 'trims'] as const) for (const mode of ['creates', 'updates'] as const) p[mode][kind].sort((a, b) => a.key.localeCompare(b.key));
  p.groups.sort((a, b) => a.model_key.localeCompare(b.model_key));
  await save(join(run, 'plan.json'), p);
  console.log('plan', { groups: p.groups.length, creates: Object.fromEntries(Object.entries(p.creates).map(([k, v]) => [k, v.length])),
    updates: Object.fromEntries(Object.entries(p.updates).map(([k, v]) => [k, v.length])), conflicts: p.conflicts.length, retire_models: p.alignment?.retired.length ?? 0 });
}
export async function apply(run: string): Promise<void> {
  const p: Plan = await load(join(run, 'plan.json'));
  if (p.alignment) {
    assertReference(p.alignment.reference);
    if (p.alignment.reference_sha !== sha(JSON.stringify(p.alignment.reference))) throw new Error('Company reference changed');
    for (const sid of new Set(p.groups.map(g => g.series_id))) {
      const packet = await load(join(run, `series-${sid}.json`));
      for (const source of packet.sources as Source[]) if (sha(new Uint8Array(await Bun.file(join(run, source.file)).arrayBuffer())) !== source.sha256) throw new Error('Cached source changed before alignment apply');
    }
  }
  if (p.alignment?.align_existing && !p.creates.models.length && !p.creates.trims.length) {
    await (await import('./company-migration')).applyMigration(run, p); return;
  }
  if (p.selection_sha !== sha(await Bun.file(join(run, 'selection.json')).text())) throw new Error('Selection changed or absent; full-catalog plans cannot be applied');
  if (!same(p.target, LAB) || p.source_sha !== sha(await Bun.file(join(run, 'collection.json')).text())) throw new Error('Plan scope changed');
  const fresh = { models: await snapshot('models', run, 'prewrite'), trims: await snapshot('trims', run, 'prewrite') };
  const byFieldId = (a: Field, b: Field) => a.id.localeCompare(b.id);
  for (const k of ['models', 'trims'] as const) if (fresh[k].rev !== p.before[k].rev || !same([...fresh[k].schema].sort(byFieldId), [...p.before[k].schema].sort(byFieldId))) throw new Error('Concurrent edit or schema drift; replan');
  const ids = { models: { ...p.model_ids }, trims: Object.fromEntries(fresh.trims.rows.map(r => [sourceIdentity(r)!, r.record_id as string])) };
  const receipt = { created: { models: 0, trims: 0 }, updated: { models: 0, trims: 0 }, uploads: 0, ids };
  const revisions = { models: fresh.models.rev, trims: fresh.trims.rev };
  const revision = async (kind: Kind) => (await call(['+record-list', ...args(kind), '--limit', '1', '--field-id', 'model_id', '--format', 'ndjson',
    '--output', join(run, `${kind}-write-revision.ndjson`), '--overwrite'])).rev;
  const settledRevision = async (kind: Kind) => {
    let previous = await revision(kind);
    for (let attempt = 0; attempt < 6; attempt++) {
      await Bun.sleep(1500); const current = await revision(kind);
      if (current === previous) return current; previous = current;
    }
    throw new Error('Table revision has not settled; stop and read back');
  };
  await save(join(run, 'apply.json'), receipt);
  for (const kind of ['models', 'trims'] as const) {
    for (const mode of ['creates', 'updates'] as const) for (let start = 0; start < p[mode][kind].length; start += 200) {
      const batch = p[mode][kind].slice(start, start + 200), fields = batch.map(r => {
        const result = { ...r.fields };
        if (kind === 'trims') result.vehicle_model_pruned = [{ id: ids.models[r.model_key!] }];
        validateFields(result, fresh[kind].schema); return result;
      });
      if (await revision(kind) !== revisions[kind]) throw new Error('Concurrent edit between batches; replan remaining writes');
      const r = mode === 'creates' ? await call(['+record-batch-create', ...args(kind)], true, { create_records: fields }) :
        await call(['+record-batch-update', ...args(kind)], true, { update_records: Object.fromEntries(batch.map((b, i) => [b.prior_id!, fields[i]])) });
      await save(join(run, `${kind}-${mode}-${start}-receipt.json`), r);
      const returned = r.data.record_id_list;
      if (returned.length !== batch.length || mode === 'updates' && !same([...returned].sort(), batch.map(b => b.prior_id!).sort())) throw new Error('Incomplete write receipt; inspect before retry');
      batch.forEach((b, i) => { ids[kind][b.key] = mode === 'creates' ? returned[i] : b.prior_id!; });
      receipt[mode === 'creates' ? 'created' : 'updated'][kind] += batch.length; await save(join(run, 'apply.json'), receipt);
      console.log(`${kind} ${mode}: ${start + batch.length}/${p[mode][kind].length}`);
      revisions[kind] = await settledRevision(kind);
      // Bidirectional trim writes also change the parent table revision.
      if (kind === 'trims') revisions.models = await settledRevision('models');
    }
  }
  const ledgerDir = join(run, '..', 'attachment-ledger');
  const readAttachments = async (rid: string) => {
    const file = join(run, 'attachment-readback.ndjson');
    const m = await call(['+record-get', ...args('models'), '--record-id', rid, '--field-id', 'brochure_cover', '--format', 'ndjson', '--output', file, '--overwrite']);
    if (m.records_count !== 1 || m.has_more) throw new Error('Attachment target missing/incomplete');
    const row = JSON.parse((await Bun.file(file).text()).trim()); return row.brochure_cover ?? [];
  };
  for (const group of p.groups) {
    if (!group.images.length) continue;
    const rid = ids.models[group.model_key], ledger = join(ledgerDir, `${rid}.json`);
    if (await Bun.file(ledger).exists()) throw new Error('Prior upload receipt exists; read back and replan without reupload');
    for (const image of group.images) if (sha(new Uint8Array(await Bun.file(join(run, image.file)).arrayBuffer())) !== image.sha256) throw new Error('Image hash changed');
    // Formula/attachment jobs change table rev asynchronously. Inspect the exact cell we append to.
    if ((await readAttachments(rid)).length) throw new Error('Attachment cell changed after planning; preserve it and replan');
    const r = await call(['+record-upload-attachment', ...args('models'), '--record-id', rid, '--field-id', 'brochure_cover',
      ...group.images.flatMap(x => ['--file', resolve(run, x.file)]), '--json'], true);
    await save(ledger, { result: r, images: group.images }); receipt.uploads++; await save(join(run, 'apply.json'), receipt);
    if (receipt.uploads % 20 === 0) console.log(`uploaded ${receipt.uploads} image records`);
    let visible = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const cell = await readAttachments(rid);
      if (same(cell.map((x: { name: string; size: number }) => [x.name, x.size]).sort(), group.images.map(x => [x.file, x.size]).sort())) { visible = true; break; }
      await Bun.sleep(1000);
    }
    if (!visible) throw new Error('Attachment write not yet visible; inspect receipt and replan without reupload');
  }
  const changed = p.groups.filter(g => g.images.length || p.creates.models.some(r => r.key === g.model_key) || p.updates.models.some(r => r.key === g.model_key) ||
    [...p.creates.trims, ...p.updates.trims].some(r => r.model_key === g.model_key));
  const syncedAt = new Date().toISOString(), syncedIds = [...new Set(changed.map(g => ids.models[g.model_key]))];
  if (syncedIds.length) {
    const current = (await call(['+record-get', ...args('models'), '--field-id', 'last_synced_at', '--format', 'json',
      ...syncedIds.flatMap(id => ['--record-id', id])])).data;
    if (current.has_more || current.record_id_list.length !== syncedIds.length) throw new Error('Missing sync-time target');
    current.record_id_list.forEach((id: string, i: number) => {
      const old = fresh.models.rows.find(r => r.record_id === id)?.last_synced_at;
      if (!empty(current.data[i][0]) && !same(current.data[i][0], old)) throw new Error('Concurrent synchronization timestamp edit');
    });
    const r = await call(['+record-batch-update', ...args('models')], true, { update_records: Object.fromEntries(syncedIds.map(id => [id, { last_synced_at: syncedAt }])) });
    if (!same([...r.data.record_id_list].sort(), [...syncedIds].sort())) throw new Error('Incomplete synchronization timestamp receipt');
    await save(join(run, 'sync-time-receipt.json'), r);
  }
  Object.assign(receipt, { sync_time: syncedAt, synced_model_ids: syncedIds }); await save(join(run, 'apply.json'), receipt);
  console.log('applied', { created: receipt.created, updated: receipt.updated, uploads: receipt.uploads });
}
export async function verify(run: string): Promise<void> {
  const p: Plan = await load(join(run, 'plan.json')), receipt = await load(join(run, 'apply.json'));
  const after = { models: await snapshot('models', run, 'after'), trims: await snapshot('trims', run, 'after') };
  const mismatches: unknown[] = [], byId = { models: new Map(after.models.rows.map(r => [r.record_id, r])), trims: new Map(after.trims.rows.map(r => [r.record_id, r])) };
  unique(after.models.rows, r => typeof r.model_id === 'string' && r.model_id ? r.model_id : null); unique(after.trims.rows, sourceIdentity);
  for (const kind of ['models', 'trims'] as const) {
    for (const r of [...p.creates[kind], ...p.updates[kind]]) {
      const rid = receipt.ids[kind][r.key], actual = byId[kind].get(rid);
      for (const [field, value] of Object.entries(r.fields)) {
        const f = after[kind].schema.find(f => f.id === field);
        const got = f?.name === 'record_id' ? actual?._primary_text : actual?.[field];
        if (!same(got, value)) mismatches.push({ table: kind, key: r.key, field, expected: value, actual: got });
      }
    }
    for (const old of p.before[kind].rows) {
      const actual = byId[kind].get(old.record_id);
      if (!actual) { if (kind === 'models' && p.alignment?.retired.some(r => r.record_id === old.record_id)) continue;
        mismatches.push({ missing_existing_record: old.record_id }); continue; }
      for (const f of p.before[kind].schema) {
        if (['formula', 'link', 'updated_at', 'updated_by'].includes(f.type) || empty(old[f.name]) || old[f.name] === false) continue;
        if (maintainedFields.has(f.name) && [...p.creates[kind], ...p.updates[kind]].some(r => r.prior_id === old.record_id && f.name in r.fields)) continue;
        if (p.alignment?.align_existing && alignmentFields[kind].has(f.name) && p.updates[kind].some(r => r.prior_id === old.record_id && (f.name in r.fields || f.id in r.fields))) continue;
        if (kind === 'models' && f.name === 'last_synced_at' && receipt.synced_model_ids?.includes(old.record_id)) continue;
        if (!same(old[f.name], actual[f.name])) mismatches.push({ existing_value_changed: old.record_id, field: f.name });
      }
    }
  }
  let formulaChecks = 0, formulaMissing = 0;
  for (const rid of receipt.synced_model_ids ?? []) if (!same(byId.models.get(rid)?.last_synced_at, receipt.sync_time)) mismatches.push({ synchronization_time: rid });
  for (const g of p.groups) {
    const model = byId.models.get(receipt.ids.models[g.model_key])!;
    const children = g.spec_ids.map(spec => byId.trims.get(receipt.ids.trims[`${g.series_id}/${spec}`]));
    for (const trim of children) if (!trim || !same(trim.vehicle_model_pruned, [{ id: model.record_id }]) || !(model.trim_configurations_pruned as { id: string }[] ?? []).some(x => x.id === trim.record_id)) mismatches.push({ link: g.key, spec: trim?.trim_config_id });
    if (g.images.length && !same((model.brochure_cover as { name: string; size: number }[] ?? []).map(x => [x.name, x.size]).sort(), g.images.map(x => [x.file, x.size]).sort())) mismatches.push({ images: g.key });
    const allChildren = (model.trim_configurations_pruned as { id: string }[] ?? []).map(x => byId.trims.get(x.id)!);
    for (const [stem, field, unit] of [['battery_capacity', 'battery_capacity_kwh', 'kwh'], ['motor_power', 'motor_power_kw', 'kw'], ['motor_torque', 'motor_torque_n_m', 'n_m'], ['cltc_range', 'range_display', 'km'], ['guide_price', 'trim_price_display', 'usd']]) {
      const nums = allChildren.map(t => t?.[field]).filter((x): x is number => typeof x === 'number');
      for (const [side, fn] of [['min', Math.min], ['max', Math.max]] as const) {
        const key = `${stem}_${side}_${unit}_auto`, actual = model[key];
        if (!nums.length) { formulaMissing++; continue; }
        if (empty(actual)) { formulaMissing++; mismatches.push({ formula: key, model: g.model_key, missing_value_with_inputs: true }); continue; }
        formulaChecks++; if (!matchesFormulaNumber(actual, fn(...nums))) mismatches.push({ formula: key, model: g.model_key, actual, expected: fn(...nums) });
      }
    }
    for (const [field, formula, separator] of [['battery_chemistry', 'battery_chemistry_auto', '/'], ['drivetrain_display', 'drivetrain_display_auto', ' / ']]) {
      const values = [...new Set(allChildren.flatMap(t => Array.isArray(t?.[field]) ? t[field] as string[] : []))];
      const actual = model[formula];
      if (!values.length) { formulaMissing++; continue; }
      if (empty(actual)) { formulaMissing++; mismatches.push({ formula, model: g.model_key, missing_value_with_inputs: true }); continue; }
      formulaChecks++;
      if (typeof actual !== 'string' || !same(actual.split(separator).sort(), values.sort())) mismatches.push({ formula, model: g.model_key, actual, expected: values });
    }
  }
  const collection = await load(join(run, 'collection.json'));
  const coverage = [];
  for (const sid of collection.scope as number[]) {
    const failed = collection.failed.find((x: { series_id: number }) => x.series_id === sid);
    if (failed) { coverage.push({ ...failed, status: 'source_failed' }); continue; }
    const packet = await load(join(run, `series-${sid}.json`));
    const groups = p.groups.filter(g => g.series_id === sid), mapped = groups.flatMap(g => g.spec_ids);
    if (!same([...mapped, ...packet.excluded_non_nev_specs].sort(), [...packet.spec_ids].sort())) mismatches.push({ series_coverage_mismatch: sid });
    coverage.push({ series_id: sid, name: packet.name, status: mapped.length ? 'mapped' : 'excluded_energy', models: groups.map(g => g.model_key), mapped_specs: mapped,
      excluded_specs: packet.excluded_non_nev_specs, image_records: groups.filter(g => g.images.length).length });
  }
  const covered = new Set(p.groups.flatMap(g => g.spec_ids.map(id => `${g.series_id}/${id}`)));
  const imageCoverage = p.groups.map(g => ({ model: g.model_key, attachments: (byId.models.get(receipt.ids.models[g.model_key])!.brochure_cover as unknown[] ?? []).length }));
  const result = { ok: !mismatches.length, discovered_series: (await load(join(run, 'discovery.json'))).total, collected_series: collection.success,
    selected_series: (await load(join(run, 'selection.json'))).requested_series, scoped_models: new Set(p.groups.map(g => g.model_key)).size,
    full_discovery: collection.full_discovery, source_complete: collection.complete, failed_series: collection.failed, groups: p.groups.length, mapped_specs: p.groups.reduce((n, g) => n + g.spec_ids.length, 0),
    lab_models: after.models.rows.length, lab_trims: after.trims.rows.length, created: receipt.created, updated: receipt.updated, uploads: receipt.uploads, deleted_models: receipt.deleted_models ?? [],
    formula_checks: formulaChecks, formula_missing_inputs_or_values: formulaMissing, conflicts_preserved: p.conflicts.length,
    image_errors: p.pending.filter((x: any) => x.image_error), image_coverage: imageCoverage,
    retained_trims_outside_current_scope: after.trims.rows.filter(r => !covered.has(sourceIdentity(r)!)).map(r => r.trim_config_id), mismatches };
  await save(join(run, 'coverage.json'), coverage);
  await save(join(run, 'verification.json'), result);
  await writeAudit(run, p, after, receipt.ids);
  console.log('verification', { ok: result.ok, selected_series: result.selected_series, scoped_models: result.scoped_models, mapped_specs: result.mapped_specs,
    formula_checks: result.formula_checks, formula_missing: result.formula_missing_inputs_or_values, mismatches: result.mismatches.length });
  console.log('图片覆盖', { models_with_attachments: imageCoverage.filter(x => x.attachments).length, models: imageCoverage.length,
    attachments: imageCoverage.reduce((n, x) => n + x.attachments, 0), download_errors: result.image_errors.length });
  if (!result.ok) throw new Error('Read-back mismatch; do not blindly repeat writes');
}

export async function writeAudit(run: string, p: Plan, after: Record<Kind, Snapshot>, ids: { models: Record<string, string>; trims: Record<string, string> }) {
  const entries: AuditEntry[] = [], summary: string[] = ['# 选定车系字段质量报告', '', '同步回读通过与字段完整程度分别报告；false默认值不是“不支持”的证据。', ''];
  for (const group of p.groups) {
    const packet = await load(join(run, `series-${group.series_id}.json`));
    const parameter = (packet.sources as Source[]).filter(s => s.url.includes('getParamConf')).at(-1)!;
    const raw = await load(join(run, parameter.file));
    const candidates = interpret(raw.result, group.spec_ids, parameter.fetched_at);
    const candidate = p.alignment ? companyCandidates(candidates, p.alignment.reference)[0] : candidates.length === 1 ? candidates[0] : mergeParentGroups(candidates);
    const model = after.models.rows.find(r => r.record_id === ids.models[group.model_key])!;
    const attachment = (model.brochure_cover as { name: string; size: number }[] ?? []).map(p => ({ name: p.name, size: p.size }));
    const imageReason = group.images.length ? '本次下载校验并上传匹配配置照片，附件回读已核对。' : attachment.length ? '已有附件保留，本轮没有替换或重传。' :
      p.pending.some((x: any) => x.group === group.key && x.image_error) ? '下载/图片校验失败，详见plan image_error。' :
        packet.image_errors?.length ? '图库请求或解析失败，详见series image_errors；不当作网站没有照片。' : '已查询匹配配置图库，仍未取得照片；不是全网无照片的证明。';
    for (const f of [...after.models.schema].sort((a, b) => a.name.localeCompare(b.name))) {
      const image = ['brochure_cover', 'image_url', 'gallery_images_json'].includes(f.name);
      const galleryUrl = packet.sources.find((s: Source) => s.url.includes('/cars/imglist'))?.url ?? parameter.url;
      const entry = auditField('models', group.model_key, f, f.name === 'brochure_cover' ? attachment : model[f.name],
        candidate.model[f.name], candidate, image ? galleryUrl : parameter.url, undefined, imageReason);
      if (p.alignment && ['MODEL', 'brand', 'model', 'model_year'].includes(f.name)) {
        const product = p.alignment.reference.models.find(m => m.model_id === group.model_key)!;
        entry.category = '程序转换'; entry.reason = '产品英文名称及展示年款复用公司目录，不是汽车之家原名；展示年款不代表所有配置年款。公司留空则保留空。';
        entry.raw = { autohome: entry.raw, company: { value: product.fields[f.name as keyof typeof product.fields], record_id: product.record_id,
          revision: p.alignment.reference.source.models_rev, fetched_at: p.alignment.reference.source.fetched_at } };
        entry.source_url = `https://ecn4k98ibq2i.feishu.cn/base/${p.alignment.reference.source.base_token}`;
        entry.source_fields = [`公司产品.${f.name}`];
      }
      if (image) {
        entry.source_fields = ['图库series/spec/picture身份'];
        entry.raw = packet.photos.filter((p: { spec_id: number }) => group.spec_ids.includes(p.spec_id)).map((p: { spec_id: number; category_id: number; source_url?: string }) => ({ ...p,
          source_url: p.source_url ?? packet.sources.find((s: Source) => s.url.includes(`-${group.series_id}-${p.spec_id}-${p.category_id}-`))?.url ?? galleryUrl }));
        entry.source_url = [...new Set((entry.raw as { source_url: string }[]).map(p => p.source_url))].join(' ; ') || galleryUrl;
      }
      entries.push(entry);
    }
    for (const t of candidate.trims) {
      const key = `${group.series_id}/${t.spec_id}`, row = after.trims.rows.find(r => r.record_id === ids.trims[key])!;
      for (const f of [...after.trims.schema].sort((a, b) => a.name.localeCompare(b.name))) {
        const entry = auditField('trims', key, f, f.name === 'record_id' ? row._primary_text : row[f.name], t.fields[f.name], candidate, parameter.url, t.spec_id);
        if (p.alignment && f.name === 'trim_price_display') entry.reason = '人民币指导价÷6.74，四舍五入到整数美元；不是公开美元报价。';
        if (p.alignment && ['trim', 'trim_config_id', 'record_id'].includes(f.name)) {
          entry.category = '程序转换'; entry.reason = '对应配置ID匹配公司目录的英文名/业务编号；汽车之家中文原名保留在来源快照和notes。';
        }
        entries.push(entry);
      }
    }
    const needs = entries.filter(e => e.table === 'models' && e.key === group.model_key && (empty(e.actual) || e.field === 'household_charging' && e.actual === false));
    summary.push(`## ${packet.name} / ${group.model_key}`, '', `本组${group.spec_ids.length}个在售配置；附件${attachment.length}张；待解释字段${needs.length}个。`, '', imageReason, '',
      ...needs.map(e => `- ${e.field}（${e.label}）：${e.category}；${e.reason}`), '');
  }
  await save(join(run, 'field-audit.json'), entries); await Bun.write(join(run, 'field-audit.csv'), csvAudit(entries));
  await Bun.write(join(run, '字段质量报告.md'), summary.join('\n'));
  console.log('字段审计', { rows: entries.length, report: join(run, '字段质量报告.md'), csv: join(run, 'field-audit.csv') });
}
