"""Сервис локальной модели CQA (только 127.0.0.1).

  local-model/.venv/Scripts/python.exe local-model/serve.py   (порт из LOCAL_MODEL_PORT, по умолчанию 8000)

GET  /health       → { model, params, adapters, temps, trained_at }
POST /v1/decide    → вероятности по вариантам для всех вопросов чек-листа за один проход по диалогу
POST /v1/finetune  → дообучение решающего слоя под вопрос (≥ 5 примеров), адаптер сохраняется и применяется сразу
Формат запросов и ответов — local-model/README.md, раздел «API сервиса».
"""
from __future__ import annotations

import os
import re
import sys
import threading
import time
from pathlib import Path

# Windows: вывод в файл/канал идёт в cp1251 — русский текст и «→» не должны ронять сервис
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))

import torch  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import Body, FastAPI, HTTPException  # noqa: E402

from cqa_local import MODEL_NAME  # noqa: E402
from cqa_local.finetune import FinetuneError, finetune  # noqa: E402
from cqa_local.infer import WEIGHTS_FILE, Ensemble  # noqa: E402
from cqa_local.questions import option_keys  # noqa: E402

def load_env():
    """Из .env в корне репо берём только LOCAL_MODEL_* (порт, потоки); переменные окружения важнее."""
    f = Path(__file__).resolve().parents[1] / ".env"
    if not f.exists():
        return
    for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
        m = re.match(r"^\s*(LOCAL_MODEL_[A-Z_]+)\s*=\s*(.*?)\s*$", line)
        if m and m.group(2) and m.group(1) not in os.environ:
            os.environ[m.group(1)] = m.group(2).strip("'\"")


load_env()
torch.set_num_threads(int(os.environ.get("LOCAL_MODEL_THREADS", "4")))
if not WEIGHTS_FILE.exists():
    sys.exit(f"Нет весов {WEIGHTS_FILE}. Обучите модель: py -3 local-model/train.py")
ENS = Ensemble.load(WEIGHTS_FILE)
LOCK = threading.Lock()
app = FastAPI(title="cqa-local", version="1")

UP = "А-ЯЁӘӨҮҰҚҒҢІҺA-Z"
# триггер — без учёта регистра, имя — с заглавной буквы
NAME_RE = [rf"(?i:{t})\s+([{UP}][\w-]+)" for t in (
    "меня зовут", "на связи", "с вами", "менің атым", "атым", "байланыста", "my name is", "this is", "оператор")]
NAME_RE += [
    r"\b(?i:I'?m)\s+([A-Z][a-z][\w-]+)",
    r"(?:^|[\s,.!])(?i:я)\s+([А-ЯЁ][а-яё]+)\b",
    r"(?:^|[\s,.!])(?i:мен)\s+([А-ЯЁӘӨҮҰҚҒҢІҺ][а-яёәөүұқғңіһ]+?)(?:пын|бын|мын|пін|бін|мін)?\b",
]
NOT_NAMES = {"Freedom", "Фридом", "Сізге", "Вам", "Here", "Happy", "Glad", "Sorry", "Имя", "Поддержка", "Support"}


def operator_name(record):
    """Имя из первой реплики оператора («меня зовут Алина», «я Руслан», «мен Саматпын», «I'm Alex»); маска [Имя скрыто] → null."""
    first = next((r.get("text") or "" for r in record.get("transcript", []) if r.get("speaker") == "operator"), "")
    for rx in NAME_RE:
        m = re.search(rx, first)
        if m and m.group(1) not in NOT_NAMES:
            return m.group(1)
    return None


def criterion_of(q: dict) -> dict:
    crit = q.get("criterion")
    if not isinstance(crit, dict) or not (crit.get("name") or crit.get("description")):
        raise HTTPException(400, "у вопроса нет criterion { name, description, type, ... }")
    crit = dict(crit)
    if q.get("type") == "score":
        crit["type"] = "scale"
    return crit


def check_record(record):
    if not isinstance(record, dict) or not isinstance(record.get("transcript"), list) or not record["transcript"]:
        raise HTTPException(400, "record.transcript должен быть непустым массивом реплик")


@app.get("/health")
def health():
    return {"model": MODEL_NAME, "params": ENS.n_params(), "members": len(ENS.members), "adapters": ENS.adapter_info(),
            "temps": ENS.temps, "trained_at": ENS.meta.get("trained_at")}


@app.post("/v1/decide")
def decide(body: dict = Body(...)):
    t0 = time.time()
    record = body.get("record")
    check_record(record)
    questions = body.get("questions") or {}
    if not isinstance(questions, dict) or not questions:
        raise HTTPException(400, "questions: { <ключ>: { type, criterion, options } }")
    keys = list(questions)
    crits = [criterion_of(questions[k]) for k in keys]
    with LOCK:
        res = ENS.predict([(record, body.get("events") or [], body.get("offsets"))], [crits])[0]
    answers = {}
    for k, crit, r in zip(keys, crits, res):
        allowed = [o.get("key") for o in questions[k].get("options") or [] if isinstance(o, dict)]
        if allowed and set(allowed) != set(option_keys(crit)):
            r["warning"] = f"варианты запроса {allowed} не совпадают с критерием {option_keys(crit)}; использованы варианты критерия"
        answers[k] = r
    return {"model": MODEL_NAME, "duration_ms": round((time.time() - t0) * 1000), "operator_name": operator_name(record), "answers": answers}


@app.post("/v1/finetune")
def finetune_route(body: dict = Body(...)):
    q = body.get("question") or {}
    crit = criterion_of(q if "criterion" in q else {"criterion": q})
    examples = body.get("examples") or []
    for e in examples:
        check_record(e.get("record"))
    try:
        with LOCK:
            info = finetune(ENS, crit, examples)
    except FinetuneError as e:
        raise HTTPException(400, str(e)) from e
    return {"model": MODEL_NAME, "adapter": info}


if __name__ == "__main__":
    port = int(os.environ.get("LOCAL_MODEL_PORT", "8000"))
    print(f"cqa-local: {ENS.n_params()} параметров, {len(ENS.members)} модели, адаптеров {len(ENS.adapters)} → http://127.0.0.1:{port}")
    # keep-alive дольше, чем у клиента Node (undici): иначе сервер закрывает соединение, пока клиент его переиспользует
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", timeout_keep_alive=75)
