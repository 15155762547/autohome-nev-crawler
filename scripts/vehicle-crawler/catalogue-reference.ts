import {join} from 'node:path';import {call} from './feishu';import {save,load} from './collect';import {catalogueSchema}from '../../lib/vehicle-catalogue-grouping';
/** Original company grid first115; only product identities and source links, never technical/business copying. */
export async function catalogueReference(run:string){
 const base='Is6Xb3btbazhFhsDXgFcqFG1nRc',mt='tblxVNjP9dnJ7b3o',tt='tbl8YzkZkMxvHRoT';
 const views=(await call(['+view-list','--base-token',base,'--table-id',mt,'--json'])).data.views,view=views.find((v:any)=>v.name==='表格'&&v.type==='grid');if(!view)throw Error('Company grid missing');
 const file=join(run,'company-first115.ndjson'),manifest=await call(['+record-list','--base-token',base,'--table-id',mt,'--view-id',view.id,'--limit','115','--format','ndjson','--output',file,'--overwrite',...['MODEL','model_id','brand','model','model_year','powertrain_type','trim_configurations_pruned'].flatMap(f=>['--field-id',f])]);
 const models=(await Bun.file(file).text()).trim().split('\n').map(s=>JSON.parse(s));if(models.length!==115)throw Error('Company first115 incomplete');
 const ids=[...new Set(models.flatMap(m=>m.trim_configurations_pruned.map((t:any)=>t.id)))],trims:any[]=[];let rev:number|undefined;
 for(let start=0;start<ids.length;start+=150){const r=(await call(['+record-get','--base-token',base,'--table-id',tt,...ids.slice(start,start+150).flatMap(id=>['--record-id',String(id)]),...['model_id','trim_config_id','trim','notes','source_url'].flatMap(f=>['--field-id',f]),'--format','json'])).data;
  if(r.has_more||rev!==undefined&&rev!==r.rev)throw Error('Company reference changed/incomplete');rev=r.rev;trims.push(...r.record_id_list.map((id:string,i:number)=>Object.fromEntries([['record_id',id],...r.fields.map((f:string,j:number)=>[f,r.data[i][j]])])));}
 const products=models.filter(m=>Array.isArray(m.powertrain_type)&&m.powertrain_type.length===1).map(m=>{const ts=trims.filter(t=>t.model_id===m.model_id);return {model_id:m.model_id,record_id:m.record_id,
  series_ids:[...new Set(ts.flatMap(t=>[...String(t.notes+' '+t.source_url).matchAll(/(?:config\/series\/|seriesid=|Autohome series\s+)(\d+)/g)].map(x=>Number(x[1]))))],
  fields:{MODEL:m.MODEL,brand:m.brand,model:m.model,model_year:m.model_year??null,powertrain_type:m.powertrain_type},
  specs:ts.map(t=>({spec_id:Number(/-(\d+)$/.exec(t.trim_config_id)?.[1]??0),trim_config_id:t.trim_config_id,trim:t.trim})).filter(t=>t.spec_id>0)}});
 const result=catalogueSchema.parse({version:1,source:{base_token:base,models_rev:manifest.rev,trims_rev:rev,fetched_at:new Date().toISOString()},products});
 await save(join(run,'company-catalogue.json'),result);console.log('Company catalogue products',products.length);
}
