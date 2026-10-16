import { expect, test } from 'bun:test';
import { interpret, mergeParentGroups } from '../../../lib/vehicle-catalog-source';
import { representativeModel } from '../../../lib/vehicle-model-representative';
const names=['能源类型','长度(mm)','宽度(mm)','座位数(个)','厂商指导价(元)'];
const raw={bread:{seriesid:1,seriesname:'测试',brandname:'测试'},titlelist:[{items:names.map((itemname,titleid)=>({itemname,titleid}))}],datalist:[
 ['2025款 标准','纯电动','4000','1800','2-8','10万'],['2026款 Max','纯电动','4100','1900','5','20万'],['2027款 预售','纯电动','4200','2000','5','30万'],['2026款 混动','插电式混合动力','5000','2100','5','40万']
].map(([specname,...values],i)=>({specid:i+1,specname,specstatus:20,paramconflist:values.map((itemname,titleid)=>({itemname,titleid}))}))};
const states={'1':{state:2,label:'在售'},'2':{state:2,label:'在售'},'3':{state:3,label:'预售'},'4':{state:2,label:'在售'}};
function run(r=raw){const gs=interpret(r,[1,2,3],'now');return representativeModel(mergeParentGroups(gs),r,states,'now');}
test('highest priced on-sale in product; preserve seat range and identity',()=>{const g=run();expect(g.model.length_mm).toBe(4100);expect(g.model.width_mm).toBe(1900);expect(g.model.seats_min).toBe(2);expect(g.model.seats_max).toBe(8);expect((g.evidence.representative as any).spec_id).toBe(2);expect(g.model.version).toBeUndefined();});
test('never fill dimensions from incompatible other configurations',()=>{const r=structuredClone(raw);r.datalist[1].paramconflist[1].itemname='-';r.datalist[2].paramconflist[1].itemname='4000';expect(run(r).model.length_mm).toBeNull();});
test('consistent others may supply missing value with explicit spec provenance',()=>{const r=structuredClone(raw);r.datalist[1].paramconflist[1].itemname='-';r.datalist[2].paramconflist[1].itemname='4000';r.datalist.forEach(s=>s.paramconflist[2].itemname='1800');const g=run(r);expect(g.model.length_mm).toBe(4000);expect((g.evidence.representative as any).fields.length_mm).toEqual([1,3]);});
test('historical only and no price are labelled and deterministic',()=>{const r=structuredClone(raw);r.datalist.forEach(s=>s.paramconflist[4].itemname='-');const g=representativeModel(mergeParentGroups(interpret(r,[1,2,3],'old')),r,{},'old');expect((g.evidence.representative as any).spec_id).toBe(3);expect((g.evidence.representative as any).selection).toContain('不宣称最高配');expect((g.evidence.representative as any).fetched_at).toBe('old');});
test('rejects energy contamination',()=>{const g=mergeParentGroups(interpret(raw,[1,2,3],'now'));g.trims.push(interpret(raw,[4],'now')[0].trims[0]);expect(()=>representativeModel(g,raw,states,'now')).toThrow('energy mismatch');});

test('same price chooses newer year then larger spec ID; future price never overrides on-sale',()=>{const r=structuredClone(raw);r.datalist[0].paramconflist[4].itemname='20万';expect((run(r).evidence.representative as any).spec_id).toBe(2);});

test('representative audit names exact configuration and audit notes replace without accumulating',async()=>{const {auditField,auditNotes}=await import('../../../lib/vehicle-catalog-audit');const g=run();const e=auditField('models',g.key,{name:'length_mm',type:'number'},4100,4100,g,'snapshot');expect(e.reason).toContain('spec 2');expect(e.source_url).toBe('https://www.autohome.com.cn/config/spec/2.html');const note=auditNotes('人工备注','代表配置2');expect(auditNotes(note,'代表配置2')).toBe(note);expect(note).toContain('人工备注');});

test('load and approximate source AC conditions survive representative selection and notes',async()=>{
 const r=structuredClone(raw);for(const [i,name] of ['满载最小离地间隙(mm)','电池慢充时间(小时)','NEDC纯电续航里程(km)','CLTC纯电续航里程(km)'].entries()){r.titlelist[0].items.push({itemname:name,titleid:20+i});for(const row of r.datalist)row.paramconflist.push({titleid:20+i,itemname:['125','6','200','450'][i]});}
 const g=run(r);expect(g.model.ground_clearance_mm).toBe(125);expect(g.model.ac_slow_charge_full_time_hours).toBe(6);expect(g.model.ac_slow_charge_supported).toBeTrue();
 const {representativeNote}=await import('../../../lib/vehicle-model-representative');const note=representativeNote(g);expect(note).toContain('满载');expect(note).toContain('SOC窗口未披露');expect(note).toContain('NEDC 200 km');expect(note).toContain('CLTC 450 km');
 const {auditField}=await import('../../../lib/vehicle-catalog-audit');expect(auditField('models',g.key,{name:'ground_clearance_mm',type:'number'},125,125,g,'snapshot').reason).toContain('满载');
});
test('same numeric clearance under different load conditions is not a shared fallback',()=>{
 const r=structuredClone(raw);r.titlelist[0].items.push({itemname:'满载最小离地间隙(mm)',titleid:20},{itemname:'空载最小离地间隙(mm)',titleid:21});r.datalist[0].paramconflist.push({titleid:20,itemname:'110'});r.datalist[2].paramconflist.push({titleid:21,itemname:'110'});expect(run(r).model.ground_clearance_mm).toBeNull();
});
test('declared partial slow-charge window cannot inherit another config full-charge time',()=>{
 const r=structuredClone(raw);r.titlelist[0].items.push({itemname:'电池慢充时间(小时)',titleid:20},{itemname:'电池慢充电量范围(%)',titleid:21});for(const row of r.datalist){row.paramconflist.push({titleid:20,itemname:'6'},{titleid:21,itemname:row.specid===2?'20-80':'0-100'});}expect(run(r).model.ac_slow_charge_full_time_hours).toBeNull();
});
