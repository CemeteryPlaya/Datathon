"""Метрики по сохранённым предсказаниям.

  py -3 local-model/evaluate.py --models majority,rules,cqa-local-v1
  py -3 local-model/evaluate.py --models cqa-local-v1 --detail gt-holdout     (по критериям и языкам)

Наборы: synth-test (синтетический test), aug-test (аугментированные копии gt-holdout), gt-holdout (реальный эталон),
zero-shot (вопросы, которых модель не видела). Предсказания пишут baselines.py и predict.py.
Результат также сохраняется в local-model/runs/metrics.json.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cqa_local import RUNS  # noqa: E402
from cqa_local.metrics import compute, fmt, summary_header, summary_row  # noqa: E402
from cqa_local.predio import read_preds  # noqa: E402

SETS = ["gt-holdout", "aug-test", "synth-test", "zero-shot"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="majority,rules,cqa-local-v1")
    ap.add_argument("--sets", default=",".join(SETS))
    ap.add_argument("--detail", default="", help="набор, по которому показать разбивку по вопросам/языкам/каналам")
    a = ap.parse_args()
    models = [m for m in a.models.split(",") if m]
    out = {}
    for s in a.sets.split(","):
        print(f"\n### {s}\n")
        print(summary_header())
        for m in models:
            preds = read_preds(m, s)
            if preds is None:
                continue
            res = compute(preds)
            out.setdefault(m, {})[s] = res
            print(summary_row(m, res))
    if a.detail:
        for m in models:
            res = out.get(m, {}).get(a.detail)
            if not res:
                continue
            print(f"\n#### {m} · {a.detail}: по вопросам\n")
            print("| вопрос | n | точн. | macro-F1 | bal.acc |\n|---|---|---|---|---|")
            for q, r in res["per_question"].items():
                print(f"| {q} | {r['n']} | {fmt(r['acc'])} | {fmt(r['macro_f1'])} | {fmt(r['bal_acc'])} |")
            for field in ("by_lang", "by_channel"):
                print(f"\n{field}: " + "; ".join(f"{k}: n={v['n']} точн. {fmt(v['acc'])} macro-F1 {fmt(v['macro_f1'])}" for k, v in res[field].items()))
    RUNS.mkdir(parents=True, exist_ok=True)
    f = RUNS / "metrics.json"
    prev = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    prev.update(out)
    f.write_text(json.dumps(prev, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
