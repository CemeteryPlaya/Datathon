"""Модель «Jev с нуля»: диалог кодируется один раз, все вопросы решаются параллельно поверх этого кодирования.

диалог → реплики → [текстовый энкодер] + признаки реплик → [энкодер диалога] → U (N × d)
вопрос, варианты → [тот же текстовый энкодер] → q, o_1..o_M
q → cross-attention по U (2 шага) → контекст c → оценка совпадения (c, q, o_m) → softmax по вариантам
Веса внимания по репликам → доказательства (evidence, checked_range).
Только случайная инициализация: никаких предобученных весов, эмбеддингов и токенизаторов.
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

from .features import N_FEATS
from .text import N_BUCKETS

QTYPES = ["noul", "choice", "score"]
OKINDS = ["yes", "no", "na", "level"]


class HashEmbed(nn.Module):
    """Hash embeddings (Svenstrup et al., 2017): корзина 2^18 → два вектора из общей таблицы + веса важности корзины.
    Почти без коллизий при малой таблице: 2^14 × dim + 2^18 × 2 параметров."""

    def __init__(self, rows=1 << 14, dim=64):
        super().__init__()
        self.rows = rows
        self.table = nn.EmbeddingBag(rows, dim, mode="sum")
        self.imp = nn.Embedding(N_BUCKETS, 2)
        nn.init.normal_(self.table.weight, std=0.1)
        nn.init.constant_(self.imp.weight, 0.5)

    def forward(self, flat, offs, n_tok):
        h1 = flat & (self.rows - 1)
        h2 = ((flat * 2654435761) & 0xFFFFFFFF) >> (32 - self.rows.bit_length() + 1)
        w = self.imp(flat)
        e = self.table(h1, offs, per_sample_weights=w[:, 0]) + self.table(h2, offs, per_sample_weights=w[:, 1])
        lens = torch.diff(torch.cat([offs, offs.new_tensor([flat.numel()])])).clamp(min=1).float()
        return e / lens.sqrt().unsqueeze(1)


class TextEncoder(nn.Module):
    """Токены → свёртки (2 слоя, остаточные) → max+mean пулинг → вектор текста."""

    def __init__(self, d=192, emb=64, rows=1 << 14, dropout=0.1):
        super().__init__()
        self.embed = HashEmbed(rows, emb)
        self.proj = nn.Linear(emb, d)
        self.convs = nn.ModuleList([nn.Conv1d(d, d, 3, padding=1) for _ in range(2)])
        self.norms = nn.ModuleList([nn.LayerNorm(d) for _ in range(2)])
        self.pool = nn.Linear(2 * d, d)
        self.drop = nn.Dropout(dropout)

    def token_vectors(self, flat, offs, n_tok):
        return self.proj(self.embed(flat, offs, n_tok))

    def forward(self, x, mask):
        """x: [T, L, d] векторы токенов, mask: [T, L] True = токен есть."""
        m = mask.unsqueeze(-1).float()
        h = x * m          # паддинг = 0: результат не зависит от состава батча
        for conv, norm in zip(self.convs, self.norms):
            y = conv(h.transpose(1, 2)).transpose(1, 2)
            h = norm(h + F.gelu(y)) * m
        mx = h.masked_fill(~mask.unsqueeze(-1), -1e4).max(1).values
        mean = h.sum(1) / m.sum(1).clamp(min=1)
        return self.drop(self.pool(torch.cat([mx, mean], -1)))


class Hop(nn.Module):
    def __init__(self, d, heads, dropout):
        super().__init__()
        self.att = nn.MultiheadAttention(d, heads, dropout=dropout, batch_first=True)
        self.n1 = nn.LayerNorm(d)
        self.ff = nn.Sequential(nn.Linear(d, 2 * d), nn.GELU(), nn.Dropout(dropout), nn.Linear(2 * d, d))
        self.n2 = nn.LayerNorm(d)

    def forward(self, q, U, pad, bias=None):
        c, w = self.att(q.unsqueeze(1), U, U, attn_mask=bias, need_weights=True, average_attn_weights=True)
        h = self.n1(q + c.squeeze(1))
        return self.n2(h + self.ff(h)), c.squeeze(1), w.squeeze(1)


class Decision(nn.Module):
    """Решающий слой: вопрос → cross-attention по репликам → контекст → оценка каждого варианта. Его же дообучаем."""

    def __init__(self, d=192, heads=4, dropout=0.1, hidden=96):
        super().__init__()
        self.qtype = nn.Embedding(len(QTYPES), d)
        self.qpol = nn.Embedding(2, d)
        self.okind = nn.Embedding(len(OKINDS), d)
        self.olevel = nn.Linear(1, d)
        self.hops = nn.ModuleList([Hop(d, heads, dropout) for _ in range(2)])
        self.heads = heads
        self.alpha = nn.Parameter(torch.tensor([3.0, 3.0]))   # вес двух каналов лексического сопоставления во внимании
        self.mfeat = nn.Sequential(nn.Linear(10, d), nn.GELU(), nn.Linear(d, d))
        self.mlogit = nn.Linear(10, 1)          # прямой путь: «нашлось в репликах оператора» → в пользу «да»
        self.score = nn.Sequential(nn.Linear(7 * d, hidden), nn.GELU(), nn.Linear(hidden, 1))

    def forward(self, U, pad, g, qv, qtype, qneg, ov, okind, olevel, omask, dial, S, roles):
        """U [B,N,d], pad [B,N], g [B,d]; qv [P,d] с индексом диалога dial [P]; ov [P,M,d], omask [P,M];
        S [P,N] — лексическое совпадение вопроса с репликой; roles [B,N]."""
        q = qv + self.qtype(qtype) + self.qpol(qneg)
        Ub, pb, rb = U[dial], pad[dial], roles[dial]
        bias = (S * self.alpha).sum(-1).masked_fill(pb, float("-inf")).unsqueeze(1).repeat_interleave(self.heads, 0)
        h = q
        attn = []
        for hop in self.hops:
            h, c, w = hop(h, Ub, pb, bias)
            attn.append(w)
        def smax(m):
            return S.masked_fill((~m | pb).unsqueeze(-1), 0.0).max(1).values
        op = rb == 1
        mean_op = S.masked_fill((~op | pb).unsqueeze(-1), 0.0).sum(1) / (op & ~pb).sum(1, keepdim=True).clamp(min=1)
        mf = torch.cat([smax(op), smax(rb == 0), smax(rb == 3), mean_op, smax(rb >= 0)], -1)
        h = h + self.mfeat(mf)
        o = ov + self.okind(okind) + self.olevel(olevel.unsqueeze(-1))
        M = o.shape[1]
        hq = h.unsqueeze(1).expand(-1, M, -1)
        qq = q.unsqueeze(1).expand(-1, M, -1)
        gg = g[dial].unsqueeze(1).expand(-1, M, -1)
        feats = torch.cat([hq, qq, o, hq * o, qq * o, gg * o, hq * qq], -1)
        direct = self.mlogit(mf) * (okind == 0).float() * (qtype < 2).float().unsqueeze(-1)   # только вариант «да» в да/нет
        logits = (self.score(feats).squeeze(-1) + direct).masked_fill(~omask, -1e4)
        return logits, (attn[0] + attn[1]) / 2


class CQAModel(nn.Module):
    def __init__(self, d=192, emb=64, rows=1 << 14, heads=4, layers=2, dropout=0.1):
        super().__init__()
        self.cfg = dict(d=d, emb=emb, rows=rows, heads=heads, layers=layers, dropout=dropout)
        self.text = TextEncoder(d, emb, rows, dropout)
        self.feat = nn.Sequential(nn.Linear(N_FEATS, d), nn.GELU(), nn.Linear(d, d))
        layer = nn.TransformerEncoderLayer(d, heads, 2 * d, dropout, batch_first=True, norm_first=True, activation="gelu")
        self.dialog = nn.TransformerEncoder(layer, layers, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(d)
        self.mproj = nn.Linear(d, 64)       # пространство лексического сопоставления токенов
        self.msal = nn.Linear(d, 1)         # важность токена вопроса (учится занижать служебные слова)
        self.decision = Decision(d, heads, dropout)

    def encode_texts(self, tb):
        """tb — TextBatch: уникальные токены + группы текстов одинаковой длины → ([T, d] в исходном порядке, векторы токенов)."""
        tok = self.text.token_vectors(tb.flat, tb.offs, tb.n_tok)
        out = tok.new_zeros(tb.n_texts, tok.shape[1])
        for idx, gather, mask in tb.chunks:
            out[idx] = self.text(tok[gather], mask)
        return out, tok

    def match(self, tok, db, qb):
        """S[p, i]: насколько реплика i лексически совпадает с текстом вопроса p (late interaction, max по токенам реплики,
        взвешенное среднее по токенам вопроса). Даёт новому критерию из редактора опору на конкретные слова."""
        z = F.normalize(self.mproj(tok), dim=-1)
        sal = self.msal(tok).squeeze(-1)
        P, L = qb.qtok.shape
        N = db.pad.shape[1]
        qs = sal[qb.qtok].masked_fill(~qb.qmask, -1e4)
        k = min(16, L)                                   # самые важные токены вопроса
        top, ti = qs.topk(k, dim=1)
        qa = top.softmax(-1)
        gate = torch.sigmoid(top)
        Qz = z[qb.qtok.gather(1, ti)]
        S = Qz.new_zeros(P, N, 2)
        for b in range(db.pad.shape[0]):
            rows = (qb.dial == b).nonzero().squeeze(1)
            if rows.numel() == 0:
                continue
            n = int((~db.pad[b]).sum())
            Dz = z[db.dtok[b, :n]]                                   # [n, Lu, k]
            sim = torch.einsum("plk,nuk->plnu", Qz[rows], Dz)
            sim = sim.masked_fill(~db.dmask[b, :n].view(1, 1, n, -1), -1.0).max(-1).values.clamp(min=0)   # [p, L, n]
            # насколько реплика выделяется на фоне диалога: общие слова совпадают со всеми репликами одинаково
            has = db.dmask[b, :n].any(-1).float()
            mean = (sim * has).sum(-1, keepdim=True) / has.sum().clamp(min=1)
            cen = (sim - mean).clamp(min=0) * has
            S[rows, :n, 0] = (qa[rows].unsqueeze(-1) * cen).sum(1)
            S[rows, :n, 1] = (gate[rows].unsqueeze(-1) * cen).max(1).values
        return S

    def encode_dialogs(self, tvec, db):
        """Векторы реплик + признаки → энкодер диалога. db — DialogBatch."""
        B, N = db.pad.shape
        x = tvec.new_zeros(B, N, tvec.shape[1])
        x[db.utt_pos] = tvec[db.utt_text]
        x = x + self.feat(db.feats)
        U = self.norm(self.dialog(x, src_key_padding_mask=db.pad))
        keep = (~db.pad).unsqueeze(-1).float()
        g = (U * keep).sum(1) / keep.sum(1).clamp(min=1)
        return U, g

    def decide(self, U, g, tvec, S, db, qb, decision=None, zd=None):
        dec = decision or self.decision
        if isinstance(dec, AdaptedDecision):
            kwS = dec.keyword_match(zd, db.dmask, qb.dial) if zd is not None else None
            return dec(U, db.pad, g, tvec[qb.q_text], qb.qtype, qb.qneg, tvec[qb.o_text], qb.okind, qb.olevel, qb.omask, qb.dial, S, db.roles, kwS)
        return dec(U, db.pad, g, tvec[qb.q_text], qb.qtype, qb.qneg, tvec[qb.o_text], qb.okind, qb.olevel, qb.omask, qb.dial, S, db.roles)

    def encode(self, tb, db, qb, tokens=False):
        """Всё, кроме решающего слоя (для дообучения адаптера кодирование считается один раз).
        tokens=True — ещё и токены реплик в пространстве сопоставления (для адаптеров с ключевыми словами)."""
        tvec, tok = self.encode_texts(tb)
        U, g = self.encode_dialogs(tvec, db)
        zd = F.normalize(self.mproj(tok), dim=-1)[db.dtok] if tokens else None
        return U, g, tvec, self.match(tok, db, qb), zd

    def question_tokens(self, tb, qb, k=4):
        """Самые важные токены вопроса в пространстве сопоставления: начальные «ключевые слова» адаптера."""
        _, tok = self.encode_texts(tb)
        sal = self.msal(tok).squeeze(-1)[qb.qtok[0]].masked_fill(~qb.qmask[0], -1e4)
        idx = qb.qtok[0][sal.topk(min(k, sal.numel())).indices]
        return F.normalize(self.mproj(tok[idx]), dim=-1)

    def forward(self, tb, db, qb):
        U, g, tvec, S, _ = self.encode(tb, db, qb)
        return self.decide(U, g, tvec, S, db, qb)


def n_params(model):
    return sum(p.numel() for p in model.parameters())


class AdaptedDecision(Decision):
    """Решающий слой, дообученный под один вопрос по решениям проверяющих:
    + выученные «ключевые слова» (векторы в пространстве лексического сопоставления: что искать в репликах),
    + сдвиг вектора вопроса и смещения вариантов. Остальные веса — как у базового решающего слоя."""

    def __init__(self, d=192, heads=4, dropout=0.1, hidden=96, keywords=4, kdim=64):
        super().__init__(d, heads, dropout, hidden)
        self.qdelta = nn.Parameter(torch.zeros(d))
        self.obias = nn.Parameter(torch.zeros(len(OKINDS)))
        self.kw = nn.Parameter(torch.randn(keywords, kdim) * 0.1)
        self.kw_gain = nn.Parameter(torch.tensor(1.0))
        self.mix = nn.Parameter(torch.tensor(0.0))      # насколько ключевые слова влияют на внимание базового слоя
        self.kw_w = nn.Parameter(torch.tensor(4.0))     # детектор: max совпадения в репликах оператора → логит «да»
        self.kw_b = nn.Parameter(torch.tensor(0.0))

    def keyword_match(self, zd, dmask, dial):
        """Совпадение реплик с ключевыми словами адаптера (выделяется ли реплика на фоне диалога) → добавка к S [P, N, 1]."""
        kw = F.normalize(self.kw, dim=-1)
        sim = torch.einsum("bnuk,jk->bnuj", zd, kw).masked_fill(~dmask.unsqueeze(-1), -1.0).max(2).values.clamp(min=0)
        has = dmask.any(-1).float().unsqueeze(-1)
        mean = (sim * has).sum(1, keepdim=True) / has.sum(1, keepdim=True).clamp(min=1)
        cen = ((sim - mean).clamp(min=0) * has).max(-1).values
        return (self.kw_gain * cen)[dial].unsqueeze(-1)

    def forward(self, U, pad, g, qv, qtype, qneg, ov, okind, olevel, omask, dial, S, roles, kwS=None):
        S2 = S if kwS is None else S + self.mix * kwS
        logits, att = super().forward(U, pad, g, qv + self.qdelta, qtype, qneg, ov, okind, olevel, omask, dial, S2, roles)
        logits = logits + self.obias[okind]
        if kwS is not None:
            op = (roles[dial] == 1) & ~pad[dial]
            feat = kwS.squeeze(-1).masked_fill(~op, 0.0).max(1).values
            logits = logits + ((self.kw_w * feat + self.kw_b).unsqueeze(-1) * (okind == 0).float())
        return logits.masked_fill(~omask, -1e4), att
