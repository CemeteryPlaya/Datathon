"""Сборка батча: диалоги (реплики + признаки) и вопросы с вариантами → тензоры для CQAModel."""
from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np
import torch

from .features import utterance_features
from .model import OKINDS, QTYPES
from .questions import is_negative, level_values, option_keys, option_text, question_text, question_type
from .text import MAX_Q_TOKENS, Vocab

MAX_UTT = 160


@dataclass
class PrepDialog:
    utt: list            # [np.ndarray токенов] по репликам
    feats: np.ndarray    # [n, N_FEATS]
    n: int


@dataclass
class PrepQuestion:
    q_ids: np.ndarray
    qtype: int
    qneg: int
    keys: list
    o_ids: list
    okind: list
    olevel: list


class Prep:
    """Кеш подготовки текстов: токены реплик и вопросов считаются один раз."""

    def __init__(self, vocab: Vocab | None = None):
        self.vocab = vocab or Vocab()
        self.qcache: dict[str, PrepQuestion] = {}

    def dialog(self, record, events, offsets) -> PrepDialog:
        tr = record["transcript"][:MAX_UTT]
        rec = {**record, "transcript": tr}
        feats = utterance_features(rec, events, offsets[:MAX_UTT] if offsets else None)
        return PrepDialog([self.vocab.ids(r.get("text") or "") for r in tr], feats, len(tr))

    def question(self, crit: dict) -> PrepQuestion:
        key = json.dumps(crit, ensure_ascii=False, sort_keys=True)
        q = self.qcache.get(key)
        if q is None:
            keys = option_keys(crit)
            levels = level_values(crit)
            mx = max(levels.values(), default=0) or 1
            q = PrepQuestion(
                q_ids=self.vocab.ids(question_text(crit), MAX_Q_TOKENS),
                qtype=QTYPES.index(question_type(crit)), qneg=int(is_negative(crit)), keys=keys,
                o_ids=[self.vocab.ids(option_text(crit, k), MAX_Q_TOKENS) for k in keys],
                okind=[OKINDS.index(k) if k in ("yes", "no", "na") else OKINDS.index("level") for k in keys],
                olevel=[levels.get(k, 0.0) / mx for k in keys],
            )
            self.qcache[key] = q
        return q


class TextBatch:
    def __init__(self, vocab: Vocab, texts: list, slots=12288):
        allt = np.concatenate(texts) if texts else np.zeros(0, dtype=np.int64)
        uniq, inv = np.unique(allt, return_inverse=True)
        flat, offs = vocab.bags(uniq)
        self.flat = torch.from_numpy(flat)
        self.offs = torch.from_numpy(offs)
        self.n_tok = len(uniq)
        self.n_texts = len(texts)
        lens = np.array([len(t) for t in texts])
        starts = np.zeros(len(texts), dtype=np.int64)
        if len(texts) > 1:
            starts[1:] = np.cumsum(lens)[:-1]
        self.inv, self.starts, self.lens = inv, starts, lens
        order = np.argsort(lens, kind="stable")
        self.chunks = []
        i = 0
        while i < len(order):
            j = i
            L = lens[order[i]]
            while j < len(order) and (j - i + 1) * lens[order[j]] <= slots:
                L = lens[order[j]]
                j += 1
            j = max(j, i + 1)
            L = lens[order[j - 1]]
            idx = order[i:j]
            gather = np.zeros((len(idx), L), dtype=np.int64)
            mask = np.zeros((len(idx), L), dtype=bool)
            for r, t in enumerate(idx):
                n = lens[t]
                gather[r, :n] = inv[starts[t]:starts[t] + n]
                mask[r, :n] = True
            self.chunks.append((torch.from_numpy(idx), torch.from_numpy(gather), torch.from_numpy(mask)))
            i = j


@dataclass
class DialogBatch:
    pad: torch.Tensor
    feats: torch.Tensor
    utt_pos: tuple
    utt_text: torch.Tensor
    roles: torch.Tensor          # [B, N] индекс роли (features.ROLES, 4 = прочее)
    dtok: torch.Tensor           # [B, N, Lu] уникальные токены реплик (бот пропущен) для лексического сопоставления
    dmask: torch.Tensor          # [B, N, Lu]


@dataclass
class QuestionBatch:
    q_text: torch.Tensor
    qtype: torch.Tensor
    qneg: torch.Tensor
    o_text: torch.Tensor
    okind: torch.Tensor
    olevel: torch.Tensor
    omask: torch.Tensor
    dial: torch.Tensor
    target: torch.Tensor | None = None
    ev: torch.Tensor | None = None       # [P, N] маска реплик-доказательств
    has_ev: torch.Tensor | None = None
    weight: torch.Tensor | None = None
    qtok: torch.Tensor | None = None     # [P, L] токены текста вопроса
    qmask: torch.Tensor | None = None


MATCH_UTT_TOKENS = 48


def text_tokens(tb, t):
    return tb.inv[tb.starts[t]:tb.starts[t] + tb.lens[t]]


def build(prep: Prep, dialogs: list, pairs: list):
    """dialogs: [PrepDialog]; pairs: [(dialog_idx, crit, y|None, ev|None, weight)] → (TextBatch, DialogBatch, QuestionBatch, qs)."""
    texts = []
    text_idx = {}

    def add_text(arr, key):
        if key not in text_idx:
            text_idx[key] = len(texts)
            texts.append(arr)
        return text_idx[key]

    B = len(dialogs)
    N = max(d.n for d in dialogs)
    pad = np.ones((B, N), dtype=bool)
    feats = np.zeros((B, N, dialogs[0].feats.shape[1]), dtype=np.float32)
    rows, cols, utt_text = [], [], []
    for b, d in enumerate(dialogs):
        pad[b, :d.n] = False
        feats[b, :d.n] = d.feats
        for i, u in enumerate(d.utt):
            rows.append(b)
            cols.append(i)
            utt_text.append(add_text(u, ("t", u.tobytes())))
    qs = [prep.question(c) for _, c, *_ in pairs]
    M = max(len(q.keys) for q in qs)
    P = len(pairs)
    q_text = np.zeros(P, dtype=np.int64)
    o_text = np.zeros((P, M), dtype=np.int64)
    okind = np.zeros((P, M), dtype=np.int64)
    olevel = np.zeros((P, M), dtype=np.float32)
    omask = np.zeros((P, M), dtype=bool)
    target = np.full(P, -100, dtype=np.int64)
    ev = np.zeros((P, N), dtype=bool)
    weight = np.ones(P, dtype=np.float32)

    for p, ((di, crit, y, evs, w), q) in enumerate(zip(pairs, qs)):
        q_text[p] = add_text(q.q_ids, ("t", q.q_ids.tobytes()))
        for m, k in enumerate(q.keys):
            o_text[p, m] = add_text(q.o_ids[m], ("t", q.o_ids[m].tobytes()))
            okind[p, m] = q.okind[m]
            olevel[p, m] = q.olevel[m]
            omask[p, m] = True
        if y is not None and y in q.keys:
            target[p] = q.keys.index(y)
        for i in evs or []:
            if 0 <= i < dialogs[di].n:
                ev[p, i] = True
        weight[p] = w
    tb = TextBatch(prep.vocab, texts)
    roles = np.full((B, N), 4, dtype=np.int64)
    Lu = max(1, min(MATCH_UTT_TOKENS, max(len(u) for d in dialogs for u in d.utt)))
    dtok = np.zeros((B, N, Lu), dtype=np.int64)
    dmask = np.zeros((B, N, Lu), dtype=bool)
    for b, i, t in zip(rows, cols, utt_text):
        r = int(np.argmax(dialogs[b].feats[i, :5]))
        roles[b, i] = r
        if r == 2:   # бот: длинные шаблоны, к работе оператора не относятся
            continue
        tk = text_tokens(tb, t)[:Lu]
        dtok[b, i, :len(tk)], dmask[b, i, :len(tk)] = tk, True
    L = max(len(text_tokens(tb, t)) for t in q_text)
    qtok = np.zeros((P, L), dtype=np.int64)
    qmask = np.zeros((P, L), dtype=bool)
    for p, t in enumerate(q_text):
        tk = text_tokens(tb, t)
        qtok[p, :len(tk)], qmask[p, :len(tk)] = tk, True
    db = DialogBatch(torch.from_numpy(pad), torch.from_numpy(feats), (torch.tensor(rows), torch.tensor(cols)), torch.tensor(utt_text),
                     torch.from_numpy(roles), torch.from_numpy(dtok), torch.from_numpy(dmask))
    qb = QuestionBatch(
        torch.from_numpy(q_text), torch.tensor([q.qtype for q in qs]), torch.tensor([q.qneg for q in qs]),
        torch.from_numpy(o_text), torch.from_numpy(okind), torch.from_numpy(olevel), torch.from_numpy(omask),
        torch.tensor([p[0] for p in pairs]), torch.from_numpy(target), torch.from_numpy(ev),
        torch.from_numpy(ev.any(1)), torch.from_numpy(weight), torch.from_numpy(qtok), torch.from_numpy(qmask),
    )
    return tb, db, qb, qs


def to_device(tb: TextBatch, db: DialogBatch, qb: QuestionBatch, device):
    if str(device) == "cpu":
        return tb, db, qb
    tb.flat, tb.offs = tb.flat.to(device), tb.offs.to(device)
    tb.chunks = [(a.to(device), b.to(device), c.to(device)) for a, b, c in tb.chunks]
    for k in ("pad", "feats", "utt_text", "roles", "dtok", "dmask"):
        setattr(db, k, getattr(db, k).to(device))
    db.utt_pos = tuple(x.to(device) for x in db.utt_pos)
    for k in ("q_text", "qtype", "qneg", "o_text", "okind", "olevel", "omask", "dial", "target", "ev", "has_ev", "weight", "qtok", "qmask"):
        v = getattr(qb, k)
        if v is not None:
            setattr(qb, k, v.to(device))
    return tb, db, qb
