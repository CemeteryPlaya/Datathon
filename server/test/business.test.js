import { test } from 'node:test';
import assert from 'node:assert/strict';
import { economy, coaching } from '../business.js';
import { summary, operatorProfile } from '../analytics.js';
const checklist = {id:'custom', version:1, sections:[{id:'s',name:'Секция'}], criteria:[
  {id:'custom',name:'Новое правило',description:'Проверьте следующий шаг',section:'s',type:'yesno',weight:100,kind:'normal'},
  {id:'risk',name:'Конфиденциальность',description:'Не раскрывать данные',section:'s',type:'yesno',weight:0,kind:'gross'},
]};
const evaluation=(id,answer='no',cost=0.1)=>({id,conversation_id:id,group_id:'DEV',checklist_id:'custom',checklist_version:1,operator_name:'Тест',created_at:'2026-11-07T10:00:00Z',cost_usd:cost,results:[{criterion_id:'custom',answer,explanation:'Исходный вывод',evidence:[0]},{criterion_id:'risk',answer:'no'}]});
const data=(evaluations,appeals=[])=>({evaluations,appeals,getChecklist:()=>checklist});

test('экономия: часы, все попытки и однократный учёт разбора',()=>{
 const a=evaluation('a'),b=evaluation('b');
 const d=data([a,b]);const s=summary(d,{}, {human_minutes:12,review_minutes:3,hourly_usd:20});
 assert.equal(s.economy.human_hours,0.4);assert.equal(s.economy.saved_hours,0.4);assert.equal(s.economy.saved_usd,7.8);
 a.results[1].answer='yes'; a.results[0].answer='manual';
 d.appeals.push({evaluation_id:'a',criterion_id:'risk',status:'open'});
 d.evaluations.unshift({...a,id:'old',created_at:'2026-11-06',cost_usd:0.3});
 const e=summary(d,{}, {human_minutes:12,review_minutes:3,hourly_usd:20}).economy;
 assert.equal(e.review_conversations,1);assert.equal(e.saved_hours,0.35);assert.equal(e.attempts,3);assert.equal(e.ai_cost_usd,0.5);assert.equal(e.assisted_cost_usd,1.5);assert.equal(e.risk_findings,1);
});
test('неизвестная цена не превращается в бесплатный ИИ; ноль является известной ценой',()=>{
 const e=evaluation('a');e.cost_usd=null;
 const s=summary(data([e]));assert.equal(s.economy.saved_usd,null);assert.equal(s.economy.ai_cost_usd,null);assert.equal(s.cost.total_usd,null);
 e.cost_usd=0;assert.equal(summary(data([e])).economy.ai_cost_usd,0);
});
test('пустая выборка, нулевые ставки, отрицательная экономия и фильтры',()=>{
 assert.equal(economy([],[]).saved_hours,0);
 const a=evaluation('a');a.results[1].answer='yes';
 const e=summary(data([a]),{},{human_minutes:1,review_minutes:10,hourly_usd:0}).economy;
 assert.equal(e.saved_hours,-0.15);assert.equal(e.saved_usd,-0.1);
 assert.equal(summary(data([a]),{group_id:'OTHER'}).economy.attempts,0);
 assert.equal(economy([],[],{human_minutes:-1}).assumptions.human_minutes,10);
});
test('коучинг: риск первым, произвольный критерий, версия и доказательство',()=>{
 const a=evaluation('a');a.results[1].answer='yes';
 const p=operatorProfile(data([a]),'Тест');
 assert.equal(p.coaching[0].criterion_id,'risk');assert.equal(p.coaching[1].criterion_id,'custom');
 const ex=p.coaching[1].examples[0];assert.equal(ex.checklist_version,1);assert.deepEqual(ex.evidence,[0]);assert.equal(ex.rule,'Проверьте следующий шаг');
});
test('решения убирают исправленные проблемы; N/A и manual не создают коучинг',()=>{
 const a=evaluation('a');
 const appeals=[{evaluation_id:'a',criterion_id:'custom',status:'resolved',decision:{action:'change',new_answer:'yes',reason:'Исправлено'}}];
 assert.deepEqual(operatorProfile(data([a],appeals),'Тест').coaching,[]);
 a.results[0].answer='na';assert.deepEqual(operatorProfile(data([a]),'Тест').coaching,[]);
 a.results[0].answer='manual';assert.deepEqual(operatorProfile(data([a]),'Тест').coaching,[]);
 appeals[0].decision.new_answer='no';appeals[0].decision.reason='Подтверждено проверяющим';
 const ex=operatorProfile(data([a],appeals),'Тест').coaching[0].examples[0];
 assert.equal(ex.explanation,'Подтверждено проверяющим');assert.deepEqual(ex.evidence,[]);
});
