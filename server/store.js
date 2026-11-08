// Хранилище на JSON-файлах в STORAGE_DIR (по умолчанию ./storage).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.resolve(ROOT, process.env.STORAGE_DIR || 'storage');
fs.mkdirSync(DIR, { recursive: true });

function file(name) {
  return path.join(DIR, `${name}.json`);
}

export function readAll(name, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeAll(name, data) {
  const tmp = `${file(name)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  // Windows: rename поверх файла, который в этот момент читают, даёт EPERM/EBUSY — короткий повтор
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file(name));
      return;
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

// ---------- checklists (версии хранятся все) ----------
const SEED = path.join(ROOT, 'server/seed/checklist.default.json');

export function listChecklists() {
  let all = readAll('checklists');
  if (!all.length) {
    const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
    all = [{ ...seed, created_at: new Date().toISOString() }];
    writeAll('checklists', all);
  }
  return all;
}

export function getChecklist(id, version) {
  const versions = listChecklists().filter((c) => c.id === id);
  if (!versions.length) return null;
  if (version != null) return versions.find((c) => c.version === Number(version)) || null;
  return versions.reduce((a, b) => (b.version > a.version ? b : a));
}

export function saveChecklistVersion(checklist) {
  const all = listChecklists();
  const id = checklist.id || newId('cl');
  const prev = all.filter((c) => c.id === id).reduce((m, c) => Math.max(m, c.version), 0);
  const rec = { ...checklist, id, version: prev + 1, created_at: new Date().toISOString() };
  all.push(rec);
  writeAll('checklists', all);
  return rec;
}

// ---------- evaluations ----------
export const listEvaluations = () => readAll('evaluations');
export const getEvaluation = (id) => listEvaluations().find((e) => e.id === id) || null;
export function saveEvaluation(ev) {
  const all = listEvaluations();
  const rec = { ...ev, id: ev.id || newId('ev'), created_at: ev.created_at || new Date().toISOString() };
  all.push(rec);
  writeAll('evaluations', all);
  return rec;
}

// ---------- appeals ----------
export const listAppeals = () => readAll('appeals');
export function saveAppeal(ap) {
  const all = listAppeals();
  const i = all.findIndex((a) => a.id === ap.id);
  if (i >= 0) all[i] = ap;
  else all.push(ap);
  writeAll('appeals', all);
  return ap;
}

// ---------- имена операторов, исправленные вручную: { conversation_id: name } ----------
export const getOperatorOverrides = () => readAll('operators', {});
export function setOperatorOverride(conversationId, name) {
  const all = getOperatorOverrides();
  if (name) all[conversationId] = name;
  else delete all[conversationId];
  writeAll('operators', all);
  return all;
}

// ---------- просмотренные тревоги: { evaluation_id: { acked_at, note } } ----------
export const getAlertAcks = () => readAll('alerts', {});
export function ackAlert(evaluationId, note = '') {
  const all = getAlertAcks();
  all[evaluationId] = { acked_at: new Date().toISOString(), note };
  writeAll('alerts', all);
  return all[evaluationId];
}
