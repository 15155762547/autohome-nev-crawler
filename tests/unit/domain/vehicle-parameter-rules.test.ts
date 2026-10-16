import { expect, test } from 'bun:test';
import { groundClearance, slowChargeTime } from '../../../lib/vehicle-parameter-rules';
const get=(values:Record<string,string>)=>(name:string)=>values[name]??'';
test('clearance aliases preserve load condition and explicit unqualified value takes priority',()=>{
 expect(groundClearance(get({'满载最小离地间隙(mm)':'110'}))).toMatchObject({value:110,condition:'满载'});
 expect(groundClearance(get({'空载最小离地间隙(mm)':'140'}))).toMatchObject({value:140,condition:'空载'});
 expect(groundClearance(get({'最小离地间隙(mm)':'150','满载最小离地间隙(mm)':'110'}))?.value).toBe(150);
 for(const invalid of ['-','0','110-150','暂无数据'])expect(groundClearance(get({'满载最小离地间隙(mm)':invalid}))).toBeNull();
});
test('source slow time is usable without SOC while declared partial window cannot become full charge',()=>{
 expect(slowChargeTime(get({'电池慢充时间(小时)':'9'}))).toMatchObject({value:9});
 expect(slowChargeTime(get({'电池慢充时间(小时)':'9'}))?.condition).toContain('未独立证实');
 expect(slowChargeTime(get({'电池慢充时间(小时)':'6','电池慢充电量范围(%)':'0%～100%'}))?.condition).toBe('SOC 0–100%');
 for(const window of ['20-80','30-100','50','0-80'])expect(slowChargeTime(get({'电池慢充时间(小时)':'6','电池慢充电量范围(%)':window}))).toBeNull();
 for(const value of ['-','0','6-8','约6'])expect(slowChargeTime(get({'电池慢充时间(小时)':value}))).toBeNull();
});
