import{expect,test}from'bun:test';import{catalogueCandidates,cataloguePatch,type Catalogue}from'../../../lib/vehicle-catalogue-grouping';import{interpret}from'../../../lib/vehicle-catalog-source';
const names=['能源类型','长度(mm)','座位数(个)','厂商指导价(元)'];
const input={bread:{seriesid:100,seriesname:'示例车',brandname:'示例'},titlelist:[{items:names.map((itemname,titleid)=>({itemname,titleid}))}],datalist:[
 {specid:10001,specname:'2025款 低配',specstatus:40,paramconflist:['纯电动','4000','4','10万'].map((itemname,titleid)=>({itemname,titleid}))},
 {specid:10002,specname:'2026款 高配',specstatus:20,paramconflist:['纯电动','4100','5','12万'].map((itemname,titleid)=>({itemname,titleid}))},
 {specid:10003,specname:'2027款 预售',specstatus:10,paramconflist:['插电式混合动力','4200','5','-'].map((itemname,titleid)=>({itemname,titleid}))}]};
const empty:Catalogue={version:1,source:{base_token:'Is6Xb3btbazhFhsDXgFcqFG1nRc',models_rev:1,trims_rev:1,fetched_at:'now'},products:[]};
const groups=()=>interpret(input,[10001,10002,10003],'now');
test('unmatched company records do not block new Chinese products; years merge and energy stays separate',()=>{
 const gs=catalogueCandidates(groups(),empty,[],[]);expect(gs.map(g=>g.key)).toEqual(['AUT-100-BEV','AUT-100-PHEV']);
 expect(gs[0].trims).toHaveLength(2);expect(gs[0].model.MODEL).toBe('示例车');expect(gs[0].model.length_mm).toBeNull();expect(gs[0].model.model_year).toBeNull();expect(gs[0].model.seats_min).toBe(4);expect(gs[0].model.seats_max).toBe(5);
 expect(gs[1].trims[0].fields.trim_price_rmb).toBeUndefined();
});
test('a unique company product identity is reused without copying technical values',()=>{
 const product={record_id:'recCompany',model_id:'MDL-001',series_ids:[100],fields:{MODEL:'Example EV',brand:'Example',model:'Example',model_year:2026,powertrain_type:['BEV']},specs:[]};
 const gs=catalogueCandidates(groups(),{...empty,products:[product]},[],[]);expect(gs[0].key).toBe('MDL-001');expect(gs[0].model.length_mm).toBeNull();expect(gs[0].model.MODEL).toBe('Example EV');expect(gs[0].trims[0].fields.trim).toBe('2025款 低配');
 expect(()=>catalogueCandidates(groups(),{...empty,products:[product,{...product,model_id:'MDL-002'}]},[],[])).toThrow('ambiguous');
});
test('existing stable parents are preserved and missing/deleted parents require review',()=>{
 const trims=[{trim_config_id:'MDL-155-100-10001',model_id:'MDL-155'}];
 const gs=catalogueCandidates(groups(),empty,[{model_id:'MDL-155',powertrain_type:['BEV']}],trims);expect(gs[0].key).toBe('MDL-155');
 expect(()=>catalogueCandidates(groups(),empty,[],trims)).toThrow('Deleted/missing parent');
});
test('catalogue refresh cannot change company business fields or unrelated technical fields',()=>{
 expect(cataloguePatch({length_mm:4000,Recommendation:['A'],airbags:6},{length_mm:null,Recommendation:['B'],airbags:7})).toEqual({length_mm:null});
});

test('catalogue clearing treats Feishu empty selections as already empty',()=>{expect(cataloguePatch({battery_technology:[],v2l_availability:[],length_mm:null},{battery_technology:null,v2l_availability:null,length_mm:null})).toEqual({});});

test('representative refresh preserves unverified historical values and business fields',()=>{expect(cataloguePatch({length_mm:4000,version:'Executive Flagship',seats_min:2},{length_mm:null,version:'Max',seats_min:2,seats_max:8},true)).toEqual({seats_max:8});});
