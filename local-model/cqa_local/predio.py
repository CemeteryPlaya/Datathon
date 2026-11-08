"""Файлы предсказаний: local-model/runs/preds/<модель>/<набор>.jsonl."""
from __future__ import annotations

import json

from . import RUNS

KEEP = ("src", "d", "qid", "w", "kind", "y", "amb", "lang", "channel", "gross", "cid", "pred", "probs", "conf", "evidence")


def preds_dir(model):
    return RUNS / "preds" / model


def write_preds(model, set_name, preds):
    d = preds_dir(model)
    d.mkdir(parents=True, exist_ok=True)
    with open(d / f"{set_name}.jsonl", "w", encoding="utf-8") as f:
        for p in preds:
            f.write(json.dumps({k: p[k] for k in KEEP if k in p}, ensure_ascii=False) + "\n")


def read_preds(model, set_name):
    f = preds_dir(model) / f"{set_name}.jsonl"
    if not f.exists():
        return None
    with open(f, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh]
