import{join,resolve}from'node:path';import{mkdir,open,unlink,rename,copyFile,statfs}from'node:fs/promises';
import{discoverAll}from'./discover-all';import{catalogueReference}from'./catalogue-reference';import{collect,select,load,save,sha}from'./collect';import{plan,apply,verify}from'./feishu';import{archiveBatch}from'./archive-batch';
const root=resolve(process.argv[2]??'');if(!process.argv[2])throw Error('Explicit run directory required');const resume=process.argv.includes('--resume'),batchSize=10,restMs=60000;
await mkdir(root,{recursive:true});const lock=join(root,'runner.lock');
if(await Bun.file(lock).exists()){const pid=Number(await Bun.file(lock).text());let alive=false;try{process.kill(pid,0);alive=true;}catch{}if(alive||!resume)throw Error('Runner lock exists; inspect status or explicitly resume stale runner');await unlink(lock);}
const fd=await open(lock,'wx');await fd.writeFile(String(process.pid));await fd.close();
process.env.CRAWLER_STOP_FILE=join(root,'STOP');process.env.CRAWLER_PROGRESS_FILE=join(root,'source-progress.json');
let state:any={phase:'starting',cursor:0,started_at:new Date().toISOString(),batch_size:batchSize};
const checkpoint=async(extra:any)=>{state={...state,...extra,updated_at:new Date().toISOString(),pid:process.pid};const file=join(root,'status.json');await save(file+'.tmp',state);await rename(file+'.tmp',file);};
const stopped=async()=>await Bun.file(join(root,'STOP')).exists();
try{
 if(await Bun.file(join(root,'status.json')).exists()){if(!resume)throw Error('Existing run requires --resume');state=await load(join(root,'status.json'));}
 if(await stopped())throw Error('STOP file present; operator must review before resuming');
 await checkpoint({phase:'discovery',error:null});if(!await Bun.file(join(root,'discovery.json')).exists())await discoverAll(root);
 const discovery=await load(join(root,'discovery.json'));if(!discovery.complete||!discovery.all_sales_states)throw Error('All-state directory incomplete');
 if(!await Bun.file(join(root,'company-catalogue.json')).exists()){await checkpoint({phase:'company_reference'});await catalogueReference(root);}
 const queueFile=join(root,'queue.json');let queue:any;
 if(await Bun.file(queueFile).exists())queue=await load(queueFile);else{
  const byState=[2,3,1,4].map(value=>discovery.series.filter((s:any)=>s.discovery_states.includes(value)).map((s:any)=>s.seriesid));const ids:number[]=[],seen=new Set<number>();let i=0;
  while(byState.some(a=>a.length>i)){for(const list of byState){const id=list[i];if(id&&!seen.has(id)){seen.add(id);ids.push(id);}}i++;}
  queue={series_ids:ids,discovery_sha:sha(await Bun.file(join(root,'discovery.json')).text())};await save(queueFile,queue);
 }
 if(queue.discovery_sha!==sha(await Bun.file(join(root,'discovery.json')).text()))throw Error('Directory changed after queue creation');
 await checkpoint({total_series:queue.series_ids.length,total_batches:Math.ceil(queue.series_ids.length/batchSize),code_commit:(await Bun.file(join(root,'git-commit.txt')).exists())?(await Bun.file(join(root,'git-commit.txt')).text()).trim():'not-recorded'});
 for(let start=state.cursor??0;start<queue.series_ids.length;start+=batchSize){
  if(await stopped())throw Error('Operator requested STOP');const disk=await statfs(root);if(disk.bavail*disk.bsize<2*1024**3)throw Error('Less than 2GiB disk free; pause to preserve artifacts');const ids=queue.series_ids.slice(start,start+batchSize),dir=join(root,`batch-${String(start/batchSize+1).padStart(4,'0')}`);await mkdir(dir,{recursive:true});
  await save(join(dir,'code-commit.json'),{commit:process.env.CRAWLER_CODE_COMMIT??'not-recorded',started_at:new Date().toISOString()});
  await checkpoint({phase:'collecting',cursor:start,current_batch:dir,current_series:ids});
  if(!await Bun.file(join(dir,'selection.json')).exists()){
   await copyFile(join(root,'discovery.json'),join(dir,'discovery.json'));await save(join(dir,'exclusions.json'),{complete:true,series_ids:[],reason:'Explicit all-state full scope; no original115 exclusion'});await select(dir,ids.length,join(dir,'exclusions.json'),ids);
  }
  await collect(dir,undefined,false);const collection=await load(join(dir,'collection.json'));if(collection.source_paused)throw Error('Source access paused');
  await checkpoint({phase:'planning'});await plan(dir,false,true,undefined,false,false,join(root,'company-catalogue.json'));
  if(await stopped())throw Error('Operator requested STOP before write');await checkpoint({phase:'applying'});await apply(dir);
  await checkpoint({phase:'verifying'});await verify(dir);const result=await load(join(dir,'verification.json'));if(!result.ok)throw Error('Batch verification failed');
  await save(join(root,`batch-result-${String(start/batchSize+1).padStart(4,'0')}.json`),result);
  await checkpoint({phase:'archiving'});await archiveBatch(dir);
  await checkpoint({phase:'resting',cursor:start+ids.length,completed_batches:start/batchSize+1,mapped_configurations:(state.mapped_configurations??0)+result.mapped_specs,grouping_review_count:(state.grouping_review_count??0)+result.grouping_reviews.length,failed_series_count:(state.failed_series_count??0)+result.failed_series.length,failed_spec_count:(state.failed_spec_count??0)+result.failed_specs.length,lab_models:result.lab_models,lab_trims:result.lab_trims,last_result:{mapped_specs:result.mapped_specs,groups:result.groups,failed_series:result.failed_series,failed_specs:result.failed_specs,grouping_reviews:result.grouping_reviews}});
  if(start+ids.length<queue.series_ids.length)for(let slept=0;slept<restMs;slept+=1000){if(await stopped())throw Error('Operator requested STOP');await Bun.sleep(1000);}
 }
 await checkpoint({phase:(state.grouping_review_count||state.failed_series_count||state.failed_spec_count)?'complete_with_issues':'complete',finished_at:new Date().toISOString()});
}catch(error){await checkpoint({phase:await stopped()?'stopped':'paused',error:String(error)});console.error('Runner stopped:',error);process.exitCode=1;}
finally{await unlink(lock).catch(()=>{});}
