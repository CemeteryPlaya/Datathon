"""Токенизация без словаря: хеширование символьных n-грамм (3–5), слов и формы токена в 2^18 корзин.

Одинаково для RU/KZ/EN, устойчиво к опечаткам ASR, не требует обучения токенизатора. Хеш — CRC32 (стабилен
между запусками и платформами). Кеш токенов (Vocab) — только ускорение: новый текст в рантайме токенизируется так же.
"""
from __future__ import annotations

import re
import unicodedata
import zlib

import numpy as np

N_BUCKETS = 1 << 18
MAX_TOKENS = 64          # реплика
MAX_Q_TOKENS = 128       # текст вопроса / варианта
TOKEN_RE = re.compile(r"\w+|[^\w\s]", re.UNICODE)


def _h(s: str) -> int:
    return zlib.crc32(s.encode("utf-8")) % N_BUCKETS


def token_features(tok: str) -> list[int]:
    low = tok.lower()
    feats = ["w:" + low]
    if len(low) > 1 or low.isalnum():
        w = f"<{low}>"
        for n in (3, 4, 5):
            if len(w) < n:
                continue
            feats.extend(w[i:i + n] for i in range(len(w) - n + 1))
    if len(tok) >= 2 and tok.isupper():
        feats.append("s:CAPS")
    elif tok[:1].isupper():
        feats.append("s:Cap")
    if any(ch.isdigit() for ch in tok):
        feats.append("s:digit")
    cat = unicodedata.category(tok[0])
    if cat == "So":
        feats.append("s:symbol")
    elif cat.startswith("P"):
        feats.append("s:punct")
    return sorted({_h(f) for f in feats})


def tokenize(text: str, limit: int = MAX_TOKENS) -> list[str]:
    toks = TOKEN_RE.findall(unicodedata.normalize("NFKC", str(text or "")))
    return toks[:limit] if toks else ["∅"]


class Vocab:
    """Кеш: строка токена → индекс; для индекса — его корзины (CSR). Растёт по мере новых текстов."""

    def __init__(self):
        self.index: dict[str, int] = {}
        self.feats: list[np.ndarray] = []
        self._csr = None

    def ids(self, text: str, limit: int = MAX_TOKENS) -> np.ndarray:
        out = []
        for t in tokenize(text, limit):
            i = self.index.get(t)
            if i is None:
                i = len(self.feats)
                self.index[t] = i
                self.feats.append(np.asarray(token_features(t), dtype=np.int64))
                self._csr = None
            out.append(i)
        return np.asarray(out, dtype=np.int64)

    def csr(self):
        if self._csr is None or len(self._csr[1]) != len(self.feats):
            lens = np.fromiter((len(f) for f in self.feats), dtype=np.int64, count=len(self.feats))
            starts = np.zeros(len(lens), dtype=np.int64)
            if len(lens) > 1:
                starts[1:] = np.cumsum(lens)[:-1]
            flat = np.concatenate(self.feats) if self.feats else np.zeros(0, dtype=np.int64)
            self._csr = (flat, lens, starts)
        return self._csr

    def bags(self, tok_ids: np.ndarray):
        """Уникальные токены → (flat корзины, offsets) для EmbeddingBag."""
        flat, lens, starts = self.csr()
        l = lens[tok_ids]
        st = starts[tok_ids]
        offs = np.zeros(len(tok_ids), dtype=np.int64)
        if len(l) > 1:
            offs[1:] = np.cumsum(l)[:-1]
        idx = np.repeat(st - offs, l) + np.arange(l.sum())
        return flat[idx], offs
