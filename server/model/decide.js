// Клиент сервиса модели (local-model/serve.py): /v1/decide, /v1/finetune, /health.
// Встроенный fetch, без зависимостей. Адрес — LOCAL_MODEL_URL (по умолчанию http://127.0.0.1:8000).

export const LOCAL_MODEL = 'cqa-local-v1';
const HINT = 'запустите сервис модели: local-model\\.venv\\Scripts\\python.exe local-model\\serve.py';

export function createLocalModel({ url = process.env.LOCAL_MODEL_URL || 'http://127.0.0.1:8000', timeoutMs = Number(process.env.LOCAL_MODEL_TIMEOUT_MS) || 30000, fetchImpl = globalThis.fetch } = {}) {
  const base = String(url).replace(/\/+$/, '');

  // retries: повтор при сетевой ошибке (не при таймауте) — гонка keep-alive между fetch и uvicorn под нагрузкой.
  async function call(path, body, timeout = timeoutMs, retries = 0) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetchImpl(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e?.name !== 'AbortError' && retries > 0) {
        await new Promise((r) => setTimeout(r, 200));
        return call(path, body, timeout, retries - 1);
      }
      const why = e?.name === 'AbortError' ? `нет ответа за ${Math.round(timeout / 1000)} с` : 'нет соединения';
      throw new Error(`Модель не запущена (${base}, ${why}): ${HINT}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
    if (!res.ok) {
      const detail = json?.detail || json?.error || text || res.statusText;
      const err = new Error(`Модель: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  return {
    kind: 'local',
    model: LOCAL_MODEL,
    url: base,
    decide: (body) => call('/v1/decide', body, timeoutMs, 2),
    // дообучение занимает до минуты на CPU
    finetune: (body) => call('/v1/finetune', body, Math.max(timeoutMs, 120000)),
    health: () => call('/health'),
  };
}
