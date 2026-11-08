"""Обучение локальной модели CQA с нуля (случайная инициализация), ансамбль из 3 seed + калибровка температурой.

  py -3 local-model/train.py                  → local-model/weights/cqa-local-v1.pt (воспроизводимо: seed 1,2,3)
  py -3 local-model/train.py --epochs 2 --seeds 1 --out local-model/runs/quick.pt     (быстрая проверка)

Данные: pairs_train (синтетика) + реальный data/gt (повышенный вес в выборке) + аугментация DEV train.
Ранняя остановка: pairs_val + gt-fresh + аугментация DEV val. gt-holdout и его копии НЕ используются (assert_no_leak).
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cqa_local import data as D  # noqa: E402
from cqa_local.batch import Prep, build, to_device  # noqa: E402
from cqa_local.infer import WEIGHTS_FILE, Ensemble  # noqa: E402
from cqa_local.metrics import compute  # noqa: E402
from cqa_local.model import QTYPES, CQAModel, n_params  # noqa: E402
from cqa_local.probes import make_probe, phrase_pool  # noqa: E402
from cqa_local.questions import question_type  # noqa: E402

SAMPLE_WEIGHT = {"synth": 1.0, "aug": 3.0, "gt": 6.0}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def src_kind(src):
    return "synth" if src.startswith("synth") else "aug" if src.startswith("aug") else "gt"


def class_weights(train):
    cnt = defaultdict(Counter)
    for e in train:
        cnt[e["qid"]][e["y"]] += 1
    w = {}
    for q, c in cnt.items():
        n, k = sum(c.values()), len(c)
        for y, m in c.items():
            w[(q, y)] = float(np.clip(math.sqrt(n / (k * m)), 0.3, 4.0))
    return w, cnt


def group(examples):
    by = defaultdict(list)
    for e in examples:
        by[e["d"]].append(e)
    return by


def smooth_ce(logits, target, omask, eps):
    logp = torch.log_softmax(logits, -1)
    nll = -logp.gather(1, target.clamp(min=0).unsqueeze(1)).squeeze(1)
    valid = omask.float()
    uni = -(logp * valid).sum(1) / valid.sum(1)
    return (1 - eps) * nll + eps * uni


def predict_examples(ens: Ensemble, examples, batch_dialogs=32):
    """Предсказания ансамбля для списка примеров (без калибровки, если temps пусты)."""
    by = group(examples)
    ids = list(by)
    R, E = D.records(), D.events()
    dialogs = [(R[d], E[d]["events"], E[d]["offsets"]) for d in ids]
    questions = [[e["crit"] for e in by[d]] for d in ids]
    raw = ens.raw(dialogs, questions, batch_dialogs=batch_dialogs)
    preds = []
    for d, res in zip(ids, raw):
        roles = [r.get("speaker") for r in R[d]["transcript"]]
        for e, (p, keys, att, crit) in zip(by[d], res):
            a = ens.answer(p, keys, att, crit, roles)
            preds.append({**e, "pred": a["choice"], "probs": a["probabilities"], "conf": a["confidence"],
                          "evidence": a["evidence"], "raw": p.tolist(), "keys": keys})
    return preds


def val_score(preds):
    """Выбор эпохи: среднее macro-F1 по синтетическому val, реальному val (gt-fresh + аугментация) и zero-shot val."""
    parts = {
        "synth": compute([p for p in preds if p["src"].startswith("synth")]),
        "real": compute([p for p in preds if p["src"] in ("gt-fresh", "aug-val")]),
        "zero": compute([p for p in preds if p["src"].startswith("zero")]),
    }
    return sum(m["macro_f1"] for m in parts.values()) / len(parts), parts


def val_line(parts):
    return " · ".join(f"{k} F1 {m['macro_f1']:.3f} acc {m['acc']:.3f}" for k, m in parts.items())


def fit_temperatures(preds):
    """Температура на тип вопроса: p ← p^(1/T), подбор по NLL на калибровочном наборе."""
    temps = {}
    grid = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.4, 1.6, 1.8, 2.0, 2.5, 3.0]
    for qt in QTYPES:
        xs = [p for p in preds if question_type(p["crit"]) == qt]
        if not xs:
            continue
        best = None
        for t in grid:
            nll = 0.0
            for p in xs:
                r = np.clip(np.asarray(p["raw"]), 1e-6, 1) ** (1 / t)
                r = r / r.sum()
                nll -= math.log(max(1e-9, r[p["keys"].index(p["y"])])) if p["y"] in p["keys"] else 0
            nll /= len(xs)
            if best is None or nll < best[1]:
                best = (t, nll)
        temps[qt] = best[0]
    return temps


def train_seed(seed, args, prep, preps, train_by, weights, val, device):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    model = CQAModel().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    ids = list(train_by)
    draws_per_epoch = len(ids)
    steps_total = args.epochs * math.ceil(draws_per_epoch / args.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps_total, pct_start=0.06, anneal_strategy="cos")
    rng = np.random.default_rng(seed)
    prng = random.Random(seed)
    R = D.records()
    pool = phrase_pool([R[d] for d in ids], prng)
    best = (-1.0, None, 0)
    step = 0
    for ep in range(args.epochs):
        model.train()
        t0 = time.time()
        order = rng.choice(len(ids), size=draws_per_epoch, replace=True, p=weights)
        tot, nb = 0.0, 0
        for s in range(0, len(order), args.batch):
            bid = [ids[i] for i in order[s:s + args.batch]]
            dl = [preps[d] for d in bid]
            pairs = []
            for i, d in enumerate(bid):
                for e in train_by[d]:
                    pairs.append((i, e["crit"], e["y"], e["ev"], e["lw"]))
                for _ in range(args.probes if prng.random() < 0.5 else args.probes - 1 if args.probes else 0):
                    pr = make_probe(R[d], prng, pool)
                    if pr:
                        pairs.append((i, pr[0], pr[1], pr[2], args.probe_weight))
            tb, db, qb, _ = build(prep, dl, pairs)
            tb, db, qb = to_device(tb, db, qb, device)
            logits, att = model(tb, db, qb)
            ok = qb.target >= 0
            ce = smooth_ce(logits[ok], qb.target[ok], qb.omask[ok], args.smooth)
            w = qb.weight[ok]
            loss = (ce * w).sum() / w.sum()
            if qb.has_ev.any():
                m = qb.has_ev & ok
                mass = (att[m] * qb.ev[m].float()).sum(1)
                loss = loss + args.ev_weight * (-torch.log(mass + 1e-4)).mean()
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            step += 1
            tot += loss.item()
            nb += 1
        if ep + 1 < min(args.val_from, args.epochs):
            log(f"seed {seed} эпоха {ep + 1}/{args.epochs}: loss {tot / nb:.4f} · {time.time() - t0:.0f} с (валидация с эпохи {args.val_from})")
            continue
        ens = Ensemble([model], device=device)
        ens.prep = prep
        model.eval()
        preds = predict_examples(ens, val)
        score, parts = val_score(preds)
        log(f"seed {seed} эпоха {ep + 1}/{args.epochs}: loss {tot / nb:.4f} · val {val_line(parts)} · score {score:.4f} · {time.time() - t0:.0f} с")
        if score > best[0]:
            best = (score, {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}, ep + 1)
        elif ep + 1 - best[2] >= args.patience:
            log(f"seed {seed}: ранняя остановка, лучшая эпоха {best[2]}")
            break
    model.load_state_dict(best[1])
    return model.cpu().eval(), best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", default="1,2,3")
    ap.add_argument("--epochs", type=int, default=5)
    ap.add_argument("--val-from", type=int, default=3, help="валидировать (и выбирать лучшую эпоху) начиная с этой эпохи")
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--smooth", type=float, default=0.05)
    ap.add_argument("--ev-weight", type=float, default=0.2)
    ap.add_argument("--patience", type=int, default=3)
    ap.add_argument("--probes", type=int, default=3, help="пробных вопросов на диалог (самообучение сопоставлению)")
    ap.add_argument("--probe-weight", type=float, default=0.7)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--device", default="cpu", help="cpu | cuda | auto")
    ap.add_argument("--out", default=str(WEIGHTS_FILE))
    args = ap.parse_args()
    if args.threads:
        torch.set_num_threads(args.threads)
    device = ("cuda" if torch.cuda.is_available() else "cpu") if args.device == "auto" else args.device
    t_all = time.time()

    train = D.train_set()
    D.assert_no_leak(train)
    val = D.val_set() + D.synth_zero_shot("val")
    cw, cnt = class_weights(train)
    for e in train:
        e["lw"] = cw[(e["qid"], e["y"])] * (0.5 if e["amb"] else 1.0)
    train_by = group(train)
    rare = {(q, y) for q, c in cnt.items() for y, m in c.items() if m / sum(c.values()) < 0.15}
    ids = list(train_by)
    w = np.array([SAMPLE_WEIGHT[src_kind(train_by[d][0]["src"])] * (1.5 if any((e["qid"], e["y"]) in rare for e in train_by[d]) else 1.0) for d in ids])
    w = w / w.sum()
    log(f"обучение: {len(train)} пар, {len(ids)} диалогов ({Counter(src_kind(train_by[d][0]['src']) for d in ids)}); "
        f"val: {len(val)} пар; устройство {device}, потоков {torch.get_num_threads()}")

    prep = Prep()
    R, E = D.records(), D.events()
    preps = {d: prep.dialog(R[d], E[d]["events"], E[d]["offsets"]) for d in ids}
    log(f"токенизация готова: {len(prep.vocab.feats)} уникальных токенов")

    members, report = [], []
    for seed in [int(s) for s in args.seeds.split(",")]:
        t0 = time.time()
        m, best = train_seed(seed, args, prep, preps, train_by, w, val, device)
        members.append(m)
        report.append({"seed": seed, "best_epoch": best[2], "val_score": round(best[0], 4), "minutes": round((time.time() - t0) / 60, 1)})
        log(f"seed {seed}: лучшая эпоха {best[2]}, score {best[0]:.4f}, {report[-1]['minutes']} мин")

    ens = Ensemble(members, device="cpu")
    ens.prep = prep
    preds = predict_examples(ens, val)
    score0, parts = val_score(preds)
    temps = fit_temperatures(preds)
    ens.temps = temps
    preds_t = predict_examples(ens, val)
    _, parts_t = val_score(preds_t)
    log(f"ансамбль: val {val_line(parts)}; температуры {temps}; Brier "
        + ", ".join(f"{k} {parts[k]['brier']:.4f}→{parts_t[k]['brier']:.4f}" for k in parts))
    minutes = round((time.time() - t_all) / 60, 1)
    ens.meta = {"seeds": report, "train_minutes": minutes, "device": device, "threads": torch.get_num_threads(),
                "params": ens.n_params(), "args": vars(args), "val": {k: {"macro_f1": round(m["macro_f1"], 4), "acc": round(m["acc"], 4), "brier": round(m["brier"], 4)} for k, m in parts_t.items()},
                "trained_at": time.strftime("%Y-%m-%d %H:%M")}
    out = Path(args.out)
    ens.save(out)
    log(f"сохранено {out} ({out.stat().st_size / 1e6:.1f} МБ, {ens.n_params()} параметров), всего {minutes} мин")


if __name__ == "__main__":
    main()
