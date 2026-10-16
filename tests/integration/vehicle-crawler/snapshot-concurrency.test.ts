import { expect, test, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot, LAB } from '../../../scripts/vehicle-crawler/feishu';
async function check(error?: 'revision' | 'ids' | 'cells') {
  const run=await mkdtemp(join(tmpdir(),'snapshot-reads-'));let active=0,max=0,calls=0;
  const rows=Array.from({length:401},(_,i)=>({record_id:`rec${i}`,model_id:`AUT-${i}`}));
  const mock=spyOn(Bun,'spawn').mockImplementation(((argv:string[])=>{
    expect(argv[argv.indexOf('--base-token')+1]).toBe(LAB.base_token);
    expect(argv[argv.indexOf('--profile')+1]).toBe('shengxu');
    let result:any,exited=Promise.resolve(0);
    if(argv[2]==='+field-list')result={ok:true,data:{fields:[{id:'fldPrimary',name:'record_id',type:'text'},{id:'fldModel',name:'model_id',type:'text'}]}};
    else if(argv[2]==='+record-list'){writeFileSync(argv[argv.indexOf('--output')+1],rows.map(r=>JSON.stringify(r)).join('\n'));result={manifest_version:'v1',format:'ndjson',rev:4,has_more:false};}
    else if(argv[2]==='+record-get'){
      calls++;active++;max=Math.max(max,active);
      const ids=argv.flatMap((v,i)=>v==='--record-id'?[argv[i+1]]:[]).reverse();
      if(error==='ids')ids[0]=ids[1];
      result={ok:true,data:{field_id_list:['fldPrimary'],record_id_list:ids,data:ids.map(id=>error==='cells'?[]:[`trim-${id}`]),rev:error==='revision'?5:4,has_more:false}};
      exited=Bun.sleep(15).then(()=>{active--;return 0;});
    }else throw Error('Unexpected operation '+argv[2]);
    return{stdout:new Response(JSON.stringify(result)).body,stderr:new Response('').body,exited};
  })as any);
  try{
    if(error)await expect(snapshot('trims',run,'test')).rejects.toThrow(error==='revision'?'Concurrent edit':'Incomplete primary matrix');
    else{const s=await snapshot('trims',run,'test');expect(s.rows).toHaveLength(401);expect(calls).toBe(3);for(const row of s.rows)expect(row._primary_text).toBe(`trim-${row.record_id}`);}
    expect(max).toBe(2);expect(active).toBe(0);
  }finally{mock.mockRestore();await rm(run,{recursive:true,force:true});}
}
test('two concurrent primary reads retain all values, including reversed response ordering',()=>check());
test('concurrent primary reads still reject revision drift',()=>check('revision'));
test('concurrent primary reads reject duplicate or substituted record IDs',()=>check('ids'));
test('concurrent primary reads reject missing cells',()=>check('cells'));
