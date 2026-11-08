import { api } from '../api.js';
import { esc, scorePill } from '../ui.js';
import { role } from '../role.js';
import { mountLocalTraining } from '../localtrain.js';
export const answerLabel = a => ({yes:'Да',no:'Нет',na:'N/A',manual:'Ручная проверка'}[a] ?? a ?? '—');
export function appealForm(evaluation, checklist, appeals, done) {
  const box=document.createElement('section'); box.className='cqa-card';
  const available=checklist.criteria.filter(c=>!appeals.some(a=>a.criterion_id===c.id && a.status==='open'));
  box.innerHTML=`<h2>Подать апелляцию</h2>${available.length ? `<form class="cqa-form-grid"><label>Критерий <select class="cqa-input" name="criterion_id">${available.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label><label>Комментарий <textarea class="cqa-input" name="comment" required></textarea></label><button class="cqa-btn">Подать апелляцию</button><p role="alert" class="cqa-error"></p></form>`:'<p>По всем критериям есть открытые апелляции.</p>'}`;
  const form=box.querySelector('form');
  if(form) form.onsubmit=async e=>{ e.preventDefault(); const b=form.querySelector('button'); b.disabled=true; try {await api.createAppeal({evaluation_id:evaluation.id,...Object.fromEntries(new FormData(form))}); await done();} catch(e){form.querySelector('[role=alert]').textContent=e.message;b.disabled=false;} };
  return box;
}
export async function render(root, params={}) {
  const status=params.status || 'open';
  root.innerHTML=`<h1>${role()==='reviewer'?'Очередь проверяющего':'Апелляции'}</h1><label>Статус <select id="status" class="cqa-input"><option value="open">Открытые</option><option value="resolved">С решением</option><option value="all">Все</option></select></label><div id="local-train"></div><div id="queue"></div>`;
  mountLocalTraining(root.querySelector('#local-train'));
  root.querySelector('#status').value=status;
  root.querySelector('#status').onchange=e=>{location.hash=`#/appeals?status=${e.target.value}`;};
  const appeals=await api.appeals(status==='all'?{}:{status});
  const queue=root.querySelector('#queue');
  if(!appeals.length) queue.textContent='Апелляций нет.';
  for(const a of appeals) {
    const ev=await api.evaluation(a.evaluation_id), cl=await api.checklist(ev.checklist_id,ev.checklist_version);
    const c=cl.criteria.find(c=>c.id===a.criterion_id), original=ev.results.find(r=>r.criterion_id===a.criterion_id);
    const card=document.createElement('section');card.className='cqa-card';
    card.innerHTML=`<h2>${esc(c?.name || a.criterion_id)}</h2><a href="#/conv/${encodeURIComponent(a.conversation_id)}?ev=${encodeURIComponent(ev.id)}">Диалог ${esc(a.conversation_id)}</a><p>Исходный ответ: ${esc(answerLabel(original?.answer))}</p><p>${esc(original?.explanation)}</p><p>Комментарий оператора: ${esc(a.comment)}</p>${a.decision?`<p>Решение: ${a.decision.action==='change'?`изменить на ${esc(answerLabel(a.decision.new_answer))}`:'подтвердить'}. Причина: ${esc(a.decision.reason)}</p><p>Итог на момент решения: ${scorePill(a.final_score?.total)}</p>`:''}`;
    if(role()==='reviewer' && a.status==='open' && c) {
      const form=document.createElement('form');form.className='cqa-form-grid';
      const answers=c.type==='scale'?c.levels.map(l=>l.value):['yes','no']; if(c.na_allowed) answers.push('na');
      form.innerHTML=`<label>Решение <select name="action" class="cqa-input"><option value="confirm">Подтвердить</option><option value="change">Изменить</option></select></label><label>Новый ответ <select name="new_answer" class="cqa-input" disabled>${answers.map(v=>`<option value="${esc(v)}">${esc(answerLabel(v))}</option>`).join('')}</select></label><label>Причина <textarea class="cqa-input" name="reason" required></textarea></label><button class="cqa-btn">Сохранить решение</button><p class="cqa-error" role="alert"></p>`;
      form.elements.action.onchange=()=>{form.elements.new_answer.disabled=form.elements.action.value!=='change';};
      form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('button');b.disabled=true;try{const d=Object.fromEntries(new FormData(form));if(c.type==='scale' && d.new_answer!=='na' && d.action==='change') d.new_answer=Number(d.new_answer);await api.decideAppeal(a.id,d);await render(root,params);}catch(e){form.querySelector('[role=alert]').textContent=e.message;b.disabled=false;}};
      card.append(form);
    }
    queue.append(card);
  }
}

export function mountCardAppeals({root, evaluation, checklist, appeals, rerender}) {
  if (role() === 'operator') root.querySelector('.cqa-conv-eval').append(appealForm(evaluation, checklist, appeals, rerender));
}
