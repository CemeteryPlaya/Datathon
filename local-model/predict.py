"""Предсказания обученной модели на тестовых наборах → local-model/runs/preds/<name>/<набор>.jsonl.

  py -3 local-model/predict.py                        (веса local-model/weights/cqa-local-v1.pt)
  py -3 local-model/predict.py --weights local-model/runs/quick.pt --name quick
Затем: py -3 local-model/evaluate.py --models majority,rules,cqa-local-v1 --detail gt-holdout
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cqa_local import MODEL_NAME  # noqa: E402
from cqa_local import data as D  # noqa: E402
from cqa_local.infer import WEIGHTS_FILE, Ensemble  # noqa: E402
from cqa_local.predio import write_preds  # noqa: E402
from train import predict_examples  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default=str(WEIGHTS_FILE))
    ap.add_argument("--name", default=MODEL_NAME)
    ap.add_argument("--sets", default="")
    ap.add_argument("--no-adapters", action="store_true", help="не применять адаптеры дообучения (для честных замеров)")
    a = ap.parse_args()
    torch.set_grad_enabled(False)
    ens = Ensemble.load(Path(a.weights))
    if a.no_adapters:
        ens.adapters = {}
    sets = D.test_sets()
    for name, exs in sets.items():
        if a.sets and name not in a.sets.split(","):
            continue
        t = time.time()
        preds = predict_examples(ens, exs)
        n_d = len({e["d"] for e in exs})
        write_preds(a.name, name, preds)
        print(f"{name}: {len(preds)} ответов, {n_d} диалогов, {time.time() - t:.1f} с ({1000 * (time.time() - t) / max(1, n_d):.0f} мс/диалог)")


if __name__ == "__main__":
    main()
