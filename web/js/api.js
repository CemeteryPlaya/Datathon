// Единственное место с fetch к бэкенду (адаптер; для D365 заменим реализацию).
const BASE = '/api';

async function req(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

const qs = (params = {}) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? '?' + new URLSearchParams(p).toString() : '';
};

export const api = {
  // чек-листы
  checklists: (all = false) => req('GET', `/checklists${all ? '?all=1' : ''}`),
  checklistsAll: () => req('GET', '/checklists?all=1'),
  checklist: (id, version) => req('GET', `/checklists/${encodeURIComponent(id)}${qs({ version })}`),
  saveChecklist: (c) => req('POST', '/checklists', c),
  // данные организаторов и оценка
  dataset: (groupId, refresh) => req('GET', `/datasets/${encodeURIComponent(groupId)}${qs({ refresh: refresh ? 1 : undefined })}`),
  conversation: (id, group_id) => req('GET', `/conversations/${encodeURIComponent(id)}${qs({ group_id })}`),
  audio: (id, group_id) => req('GET', `/conversations/${encodeURIComponent(id)}/audio${qs({ group_id })}`),
  evaluate: (body) => req('POST', '/evaluate', body),
  job: (id) => req('GET', `/jobs/${encodeURIComponent(id)}`),
  // оценки и апелляции
  evaluations: (conversation_id) => req('GET', `/evaluations${qs({ conversation_id })}`),
  evaluation: (id) => req('GET', `/evaluations/${encodeURIComponent(id)}`),
  appeals: (params) => req('GET', `/appeals${qs(params)}`),
  createAppeal: (a) => req('POST', '/appeals', a),
  decideAppeal: (id, d) => req('POST', `/appeals/${encodeURIComponent(id)}/decision`, d),
  // бизнес-аналитика
  summary: (f) => req('GET', `/analytics/summary${qs(f)}`),
  operators: (f) => req('GET', `/analytics/operators${qs(f)}`),
  operator: (name, f) => req('GET', `/analytics/operators/${encodeURIComponent(name)}${qs(f)}`),
  setOperator: (conversationId, name) => req('PUT', `/conversations/${encodeURIComponent(conversationId)}/operator`, { name }),
  alerts: (f) => req('GET', `/alerts${qs(f)}`),
  ackAlert: (evaluationId, note) => req('POST', `/alerts/${encodeURIComponent(evaluationId)}/ack`, { note }),
  // режим оценки и локальная модель
  config: () => req('GET', '/config'),
  localFinetune: (body) => req('POST', '/local/finetune', body),
};
