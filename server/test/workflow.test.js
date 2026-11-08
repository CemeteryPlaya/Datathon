import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cqa-workflow-'));
process.env.STORAGE_DIR=dir;
process.env.DATA_DIR=dir;
process.env.NODE_ENV='test';
const {default:app}=await import('../index.js');
const store=await import('../store.js');
let server, base;
before(async()=>{server=app.listen(0);await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/api`;});
after(()=>{server.close();fs.rmSync(dir,{recursive:true,force:true});});
async function req(url,body){const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
test('версии и накопительный пересчёт апелляций с проверкой допустимых ответов',async()=>{
 const original=store.getChecklist('default');
 const ev=store.saveEvaluation({conversation_id:'workflow',checklist_id:original.id,checklist_version:original.version,results:original.criteria.map(c=>({criterion_id:c.id,answer:c.type==='scale'?0:'no'}))});
 const draft=structuredClone(original);draft.criteria=draft.criteria.filter(c=>c.id!=='c01');draft.criteria.push({...original.criteria[0],id:'replacement',name:'Замена'});
 const saved=await req('/checklists',draft);assert.equal(saved.status,200);assert.equal(saved.data.version,2);assert.ok(store.getChecklist('default',1).criteria.some(c=>c.id==='c01'));assert.ok(saved.data.criteria.some(c=>c.id==='replacement'));
 const invalid=structuredClone(draft);invalid.criteria[0].weight=-1;assert.equal((await req('/checklists',invalid)).status,400);
 const a=(await req('/appeals',{evaluation_id:ev.id,criterion_id:'c01',comment:'Проверьте приветствие'})).data;
 assert.equal((await req('/appeals',{evaluation_id:ev.id,criterion_id:'unknown',comment:'x'})).status,400);
 assert.equal((await req(`/appeals/${a.id}/decision`,{action:'change',new_answer:'na',reason:'x'})).status,400);
 assert.equal((await req(`/appeals/${a.id}/decision`,{action:'change',new_answer:'yes',reason:'Есть приветствие'})).status,200);
 assert.equal((await req(`/appeals/${a.id}/decision`,{action:'confirm',reason:'Ещё раз'})).status,409);
 const b=(await req('/appeals',{evaluation_id:ev.id,criterion_id:'c05',comment:'Есть эмпатия'})).data;
 const result=await req(`/appeals/${b.id}/decision`,{action:'change',new_answer:'yes',reason:'В реплике оператора'});
 assert.equal(result.data.final_score.total,25);
 const detail=(await req(`/evaluations/${ev.id}`)).data;assert.equal(detail.final_score.total,25);assert.equal(detail.results.find(r=>r.criterion_id==='c01').answer,'no');
});

test('повторная оценка через API использует выбранную новую версию и сохраняет старую',async()=>{
 const record={conversation_id:'reapply',language:'RU',channel:'agent chat',transcript:[{timestamp:'00:01',speaker:'operator',text:'Здравствуйте!'}]};
 fs.writeFileSync(path.join(dir,'TEST.json'),JSON.stringify({records:[record]}));
 // поддельная модель: на каждый вопрос — первый вариант ответа
 app.locals.localModel={kind:'local',model:'test-only',async decide({questions}) {
   const answers=Object.fromEntries(Object.entries(questions).map(([id,q])=>[id,{choice:q.options[0].key,probabilities:{[q.options[0].key]:1},confidence:1,evidence:[0],checked_range:[]}]));
   return {model:'test-only',operator_name:null,answers};
 }};
 const first=await req('/evaluate',{group_id:'TEST',conversation_ids:['reapply'],checklist_id:'default',checklist_version:1,wait:true});
 const second=await req('/evaluate',{group_id:'TEST',conversation_ids:['reapply'],checklist_id:'default',checklist_version:2,wait:true});
 assert.equal(first.data.errors.length,0);assert.equal(second.data.errors.length,0);
 assert.ok(first.data.evaluations[0].results.some(r=>r.criterion_id==='c01'));
 assert.ok(second.data.evaluations[0].results.some(r=>r.criterion_id==='replacement'));
 assert.ok(!second.data.evaluations[0].results.some(r=>r.criterion_id==='c01'));
 assert.equal(second.data.evaluations[0].checklist_version,2);
 assert.equal((await req('/evaluations?conversation_id=reapply')).data.length,2);
});

test('фоновая задача оценки: job_id сразу, затем прогресс до done',async()=>{
 const start=await req('/evaluate',{group_id:'TEST',conversation_ids:'all',checklist_id:'default'});
 assert.ok(start.data.job_id);
 let j; for(let i=0;i<50;i++){j=(await req(`/jobs/${start.data.job_id}`)).data;if(j.status!=='running')break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(j.status,'done');assert.equal(j.done,1);assert.equal(j.total,1);assert.equal(j.evaluation_ids.length,1);
});

test('набор: без CQA_API_URL понятная ошибка, локальный файл читается',async()=>{
 const saved=process.env.CQA_API_URL;delete process.env.CQA_API_URL;
 const r=await req('/datasets/NOPE');assert.equal(r.status,400);assert.match(r.data.error,/CQA_API_URL/);
 const ok=await req('/datasets/TEST');assert.equal(ok.data.total,1);
 if(saved!==undefined)process.env.CQA_API_URL=saved;
});
