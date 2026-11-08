import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dataDir = path.resolve(process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../data'));

function checkGroup(group) {
  if (typeof group !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(group)) throw new Error('Недопустимый group_id');
}
const fileFor = (group) => path.join(dataDir, `${group}.json`);
const extract = (raw) => raw?.data?.records || raw?.records || raw;

export function hasLocal(group) {
  checkGroup(group);
  return fs.existsSync(fileFor(group));
}

export function recordsFor(group) {
  checkGroup(group);
  const filename = fileFor(group);
  if (!fs.existsSync(filename)) throw new Error(`Нет локального набора data/${group}.json. Нажмите «Обновить из API» или положите снапшот организаторов.`);
  const records = extract(JSON.parse(fs.readFileSync(filename, 'utf8')));
  if (!Array.isArray(records)) throw new Error('Неверный формат набора');
  return records;
}

/** URL организаторов из .env + group_id. Сам URL (с подписью) никогда не логируем и не возвращаем клиенту. */
function apiUrl(group, env = process.env) {
  const base = env.CQA_API_URL;
  if (!base) throw new Error('CQA_API_URL не задан в .env — загрузка из API недоступна, используйте локальный снапшот.');
  const u = new URL(base);
  u.searchParams.set('group_id', group);
  return u.toString();
}

/** Скачивает набор из API организаторов и сохраняет ответ как есть в data/<group>.json. */
export async function fetchDataset(group, { fetchImpl = fetch, env = process.env } = {}) {
  checkGroup(group);
  const res = await fetchImpl(apiUrl(group, env), { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`API организаторов ответил HTTP ${res.status}`);
  const raw = await res.json();
  if (raw && raw.isSuccess === false) throw new Error(`API организаторов: ${raw.error || 'ошибка'}`);
  const records = extract(raw);
  if (!Array.isArray(records)) throw new Error('API организаторов вернул неожиданный формат');
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${fileFor(group)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw));
  fs.renameSync(tmp, fileFor(group));
  return records;
}

/** Достаёт src из HTML-страницы плеера (<audio><source src="...">). */
export function extractAudioSrc(html) {
  const m = String(html).match(/<source[^>]*\bsrc\s*=\s*["']([^"']+)["']/i) || String(html).match(/<audio[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

/** Свежая ссылка на mp3 (SAS-подпись живёт ~1 час, поэтому не кешируем). */
export async function resolveAudio(record, { fetchImpl = fetch } = {}) {
  if (!record?.audio_url) return null;
  const res = await fetchImpl(record.audio_url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Страница аудио ответила HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('audio/')) return record.audio_url;
  return extractAudioSrc(await res.text());
}
