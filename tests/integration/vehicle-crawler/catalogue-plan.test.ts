import {expect,test,spyOn} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {plan,LAB} from '../../../scripts/vehicle-crawler/feishu';
import {save,load,sha} from '../../../scripts/vehicle-crawler/collect';
import {interpret} from '../../../lib/vehicle-catalog-source';
import {catalogueCandidates,type Catalogue} from '../../../lib/vehicle-catalogue-grouping';
import {maintainedFields} from '../../../lib/vehicle-catalog-audit';

test('planning can create a uniquely matched company product absent from the lab without allowing real orphan trims',async()=>{
 const run=await mkdtemp(join(tmpdir(),'catalogue-plan-'));
 const raw={returncode:0,result:{bread:{seriesid:100,seriesname:'测试车',brandname:'测试'},titlelist:[{items:[{titleid:1,itemname:'能源类型'}]}],datalist:[{specid:10001,specname:'2026款 测试',specstatus:20,paramconflist:[{titleid:1,itemname:'纯电动'}]}]}};
 const catalogue:Catalogue={version:1,source:{base_token:'Is6Xb3btbazhFhsDXgFcqFG1nRc',models_rev:1,trims_rev:1,fetched_at:'2026-10-15T13:00:00Z'},products:[{model_id:'MDL-001',record_id:'recCompany',series_ids:[100],fields:{MODEL:'Example EV',model:'Example',brand:'Example',model_year:2026,powertrain_type:['BEV']},specs:[]}]};
 const time=catalogue.source.fetched_at;
 const group=catalogueCandidates(interpret(raw.result,[10001],time),catalogue,[],[])[0];
 const names=new Set([...Object.keys(group.model),...Object.keys(group.trims[0].fields),...maintainedFields,'model_id','record_id','trim_config_id','trim_order','review_notes','trim_source_summary_pruned','trim_section_status_pruned','trim_last_verified_at']);
 const schema=[...names].map(name=>({id:name==='record_id'?'fldPrimary':name,name,type:'text'}));
 await save(join(run,'discovery.json'),{complete:true,total:1});
 await save(join(run,'selection.json'),{complete:true,all_sales_states:true,series_ids:[100],excluded_series_ids:[]});
 await save(join(run,'collection.json'),{complete:true,scope:[100],failed:[]});
 await save(join(run,'catalogue.json'),catalogue);
 await save(join(run,'parameters.raw'),raw);
 const source={file:'parameters.raw',url:'https://www.autohome.com.cn/web-main/car/param/getParamConf?seriesid=100',fetched_at:time,sha256:sha(await Bun.file(join(run,'parameters.raw')).text()),mime:'application/json',final_url:''};
 await save(join(run,'series-100.json'),{all_sales_states:true,spec_ids:[10001],sources:[source],parameter_source:source,sales_states:{10001:{state:2,label:'在售'}},failed_specs:[],photos:[]});
 const calls:string[]=[];
 const mock=spyOn(Bun,'spawn').mockImplementation(((argv:string[])=>{
  expect(argv[0]).toBe('lark-cli');expect(argv[argv.indexOf('--base-token')+1]).toBe(LAB.base_token);const command=argv[2];calls.push(command);let response:any;
  if(command==='+field-list')response={ok:true,data:{fields:schema}};
  else if(command==='+record-list'){writeFileSync(argv[argv.indexOf('--output')+1],'');response={manifest_version:'v1',format:'ndjson',rev:1,has_more:false};}
  else throw Error('Unexpected external operation '+command);
  return{stdout:new Response(JSON.stringify(response)).body,stderr:new Response('').body,exited:Promise.resolve(0)};
 })as any);
 try{
  await plan(run,false,false,undefined,false,false,join(run,'catalogue.json'));
  const result=await load(join(run,'plan.json'));expect(result.creates.models).toHaveLength(1);expect(result.creates.models[0].key).toBe('MDL-001');expect(result.creates.trims).toHaveLength(1);expect(result.creates.trims[0].model_key).toBe('MDL-001');
  expect(calls.every(c=>['+field-list','+record-list'].includes(c))).toBeTrue();
  expect(()=>catalogueCandidates(interpret(raw.result,[10001],time),catalogue,[],[{model_id:'MDL-001',notes:'Autohome series 100; spec 10001'}])).toThrow('Deleted/missing parent');
 }finally{mock.mockRestore();await rm(run,{recursive:true,force:true});}
});
