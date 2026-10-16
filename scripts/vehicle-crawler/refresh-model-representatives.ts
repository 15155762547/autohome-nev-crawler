/** Replay saved full-crawl sources into existing lab models only; never creates records or fields. */
import { join, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { LAB, call, snapshot, validateFields } from './feishu';
import { load, save, readParameters, parameterSource, sha } from './collect';
import { catalogueCandidates, catalogueSchema } from '../../lib/vehicle-catalogue-grouping';
import { interpret, empty, same, type Cells } from '../../lib/vehicle-catalog-source';
import { representativeModel, representativeFields, representativeNote } from '../../lib/vehicle-model-representative';
import { auditNotes } from '../../lib/vehicle-catalog-audit';
const [mode, rootArg, runArg] = process.argv.slice(2);
if (!['plan','apply','verify'].includes(mode) || !rootArg || !runArg) throw Error('Usage: refresh-model-representatives.ts plan|apply|verify FULL_RUN MIGRATION_RUN');
const root=resolve(rootArg), run=resolve(runArg), target=['--base-token',LAB.base_token,'--table-id',LAB.tables.models];
const allowed=new Set([...representativeFields,'seats_min','seats_max','review_notes','trim_source_summary_pruned']);
const schemaEqual=(a:any[],b:any[])=>same([...a].sort((x,y)=>x.id.localeCompare(y.id)),[...b].sort((x,y)=>x.id.localeCompare(y.id)));
async function revision(){return (await call(['+record-list',...target,'--limit','1','--field-id','model_id','--format','ndjson','--output',join(run,'models-write-revision.ndjson'),'--overwrite'])).rev;}
async function assertPaused(){const s=await load(join(root,'status.json'));if(!['paused','stopped','complete','complete_with_issues'].includes(s.phase))throw Error(`Full worker must be paused: ${s.phase}`);}
async function trimsProjection(){const rows:Cells[]=[];let rev:number|undefined,offset=0;do{
 const file=join(run,`trims-identities-${offset}.ndjson`);
 const r=await call(['+record-list','--base-token',LAB.base_token,'--table-id',LAB.tables.trims,'--limit','2000','--offset',String(offset),'--format','ndjson','--output',file,'--overwrite',...['model_id','trim_config_id','notes','vehicle_model_pruned'].flatMap(f=>['--field-id',f])]);
 if(rev!==undefined&&rev!==r.rev)throw Error('Concurrent trims edit');rev=r.rev;
 rows.push(...(await Bun.file(file).text()).split('\n').filter(Boolean).map(s=>JSON.parse(s)));
 if(!r.has_more)break;if(!(r.next_offset>offset))throw Error('Invalid offset');offset=r.next_offset;
 }while(true);return{rows,rev};}
function patch(old:Cells,desired:Cells){return Object.fromEntries(Object.entries(desired).filter(([f,v])=>allowed.has(f)&&!empty(v)&&!same(old[f],v)));}
if(mode==='plan'){
 await assertPaused();
 const before=await snapshot('models',run,'before'),trims=await trimsProjection();
 const catalogue=catalogueSchema.parse(await load(join(root,'company-catalogue.json')));
 const updates:any[]=[],reviews:any[]=[];const seen=new Set<string>();
 for(const name of (await readdir(root)).filter(n=>/^batch-\d+$/.test(n)).sort()){
  const batch=join(root,name);if(!await Bun.file(join(batch,'coverage.json')).exists())continue;
  const coverage=await load(join(batch,'coverage.json'));
  for(const scope of coverage.filter((s:any)=>s.status==='mapped')){
   try{
    const packet=await load(join(batch,`series-${scope.series_id}.json`));
    for(const s of packet.sources)if(sha(new Uint8Array(await Bun.file(join(batch,s.file)).arrayBuffer()))!==s.sha256)throw Error('Raw source hash mismatch');
    const raw=await readParameters(batch,packet),source=parameterSource(packet);
    const groups=catalogueCandidates(interpret(raw.result,packet.spec_ids,source.fetched_at),catalogue,before.rows,trims.rows);
    for(const original of groups){
     if(!scope.models.includes(original.key))continue;
     const old=before.rows.find(r=>r.model_id===original.key);if(!old)throw Error('Missing existing model');
     const ids=trims.rows.filter(r=>r.model_id===original.key).map(r=>/series\s+(\d+).*?spec\s+(\d+)/.exec(String(r.notes))?.[2]??/(\d+)$/.exec(String(r.trim_config_id))?.[1]).map(Number).sort((a,b)=>a-b);
     if(!same(ids,original.trims.map(t=>t.spec_id).sort((a,b)=>a-b)))throw Error(`Configuration scope differs: ${original.key}`);
     if(seen.has(original.key))throw Error('Duplicate model source');seen.add(original.key);
     const g=representativeModel(original,raw.result,packet.sales_states,source.fetched_at,packet.spec_provenance);
     const note=representativeNote(g);
     const desired:Cells=Object.fromEntries([...representativeFields,'seats_min','seats_max'].map(f=>[f,g.model[f]]));
     desired.review_notes=auditNotes(old.review_notes,`来源：${source.url}\n保存快照重放，未重新联网采集。\n${note}`);
     desired.trim_source_summary_pruned=`Autohome series ${scope.series_id}; current group specs ${original.trims.map(t=>t.spec_id).join(',')}; source fetched ${source.fetched_at}; ${note}`;
     const fields=patch(old,desired);validateFields(fields,before.schema);
     updates.push({record_id:old.record_id,model_id:old.model_id,fields,representative:g.evidence.representative,source_run:batch});
    }
   }catch(e){reviews.push({series_id:scope.series_id,error:String(e)});}
  }
 }
 const plan={target:LAB,root,before,trims_rev:trims.rev,updates,reviews};await save(join(run,'plan.json'),plan);
 console.log({models:updates.length,changed:updates.filter(u=>Object.keys(u.fields).length).length,technical_changes:updates.flatMap(u=>Object.keys(u.fields).filter(f=>!['review_notes','trim_source_summary_pruned'].includes(f))).length,reviews});
}else{
 await assertPaused();const p=await load(join(run,'plan.json'));if(!same(p.target,LAB)||p.root!==root)throw Error('Wrong target/root');
 if(mode==='apply'){
  const receipts:any[]=await Bun.file(join(run,'receipts.json')).exists()?await load(join(run,'receipts.json')):[];
  const now=await snapshot('models',run,'prewrite');
  if(!schemaEqual(now.schema,p.before.schema)||now.rows.length!==p.before.rows.length)throw Error('Model schema/count changed');
  if(!receipts.length&&now.rev!==p.before.rev)throw Error('Models changed since plan');
  // After partial success, accept only exact old or planned values. Never overwrite a third value.
  for(const old of p.before.rows){const current=now.rows.find(r=>r.record_id===old.record_id);if(!current)throw Error('Missing model');
   const fields=p.updates.find((u:any)=>u.record_id===old.record_id)?.fields??{};
   for(const f of Object.keys(old))if(!(f==='last_synced_at'&&receipts.length&&Object.keys(fields).length)&&!same(current[f],old[f])&&!(f in fields&&same(current[f],fields[f])))throw Error(`Concurrent edit ${old.model_id}/${f}`);
  }
  const trims=await trimsProjection();if(trims.rev!==p.trims_rev)throw Error('Trims changed since plan');
  const updates=p.updates.map((u:any)=>({...u,fields:patch(now.rows.find(r=>r.record_id===u.record_id)!,u.fields)})).filter((u:any)=>Object.keys(u.fields).length);let expected=now.rev;
  for(let i=0;i<updates.length;i+=200){
   for(const u of updates.slice(i,i+200)){if(Object.keys(u.fields).some(f=>!allowed.has(f)))throw Error('Unauthorized field');validateFields(u.fields,p.before.schema);}
   if(await revision()!==expected)throw Error('Concurrent model edit');
   const result=await call(['+record-batch-update',...target],true,{update_records:Object.fromEntries(updates.slice(i,i+200).map((u:any)=>[u.record_id,{...u.fields,last_synced_at:new Date().toISOString()}]))});
   receipts.push(result);await save(join(run,'receipts.json'),receipts);
   if(!same([...result.data.record_id_list].sort(),updates.slice(i,i+200).map((u:any)=>u.record_id).sort()))throw Error('Incomplete receipt');console.log(`models ${Math.min(i+200,updates.length)}/${updates.length}`);
   await Bun.sleep(8000);expected=await revision();
   let settled=false;for(let attempt=0;attempt<6;attempt++){await Bun.sleep(1500);const current=await revision();if(current===expected){settled=true;break;}expected=current;}if(!settled)throw Error('Model revision did not settle');
  }
 }
 const after=await snapshot('models',run,'after'),trims=await trimsProjection(),errors:any[]=[];
 if(!schemaEqual(after.schema,p.before.schema)||after.rows.length!==p.before.rows.length||trims.rev!==p.trims_rev)errors.push('Schema, count or trims revision changed');
 const fieldsById=new Map(p.updates.map((u:any)=>[u.record_id,u.fields]));let replayChanges=0;
 for(const old of p.before.rows){const row=after.rows.find(r=>r.record_id===old.record_id);if(!row){errors.push({missing:old.record_id});continue;}
  const fields=fieldsById.get(old.record_id) as Cells|undefined;
  for(const f of Object.keys(old)){if(f==='last_synced_at'&&fields&&Object.keys(fields).length)continue;if(!same(row[f],fields&&f in fields?fields[f]:old[f]))errors.push({model:old.model_id,field:f});}
  if(fields)replayChanges+=Object.keys(patch(row,fields)).length;
 }
 await save(join(run,'verification.json'),{ok:errors.length===0&&replayChanges===0,models:p.updates.length,updated:p.updates.filter((u:any)=>Object.keys(u.fields).length).length,replay_changes:replayChanges,trims_unchanged:trims.rev===p.trims_rev,errors});
 console.log({ok:errors.length===0&&replayChanges===0,replayChanges,errors:errors.slice(0,20)});if(errors.length||replayChanges)throw Error('Verification failed');
}
