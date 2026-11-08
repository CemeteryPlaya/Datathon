"""Вопрос модели = ТЕКСТ критерия. Никаких id критериев: всё строится из полей конфига.

Один и тот же код используется в обучении и в сервисе, поэтому модель видит в работе ровно те тексты, что на обучении.
"""
from __future__ import annotations


def is_negative(criterion: dict) -> bool:
    return criterion.get("polarity") == "negative" or criterion.get("kind") == "gross"


def question_type(criterion: dict) -> str:
    """noul — да/нет без N/A, choice — да/нет/N/A, score — шкала."""
    if criterion.get("type") == "scale":
        return "score"
    return "choice" if criterion.get("na_allowed") else "noul"


def question_text(criterion: dict) -> str:
    name = str(criterion.get("name") or "").strip()
    desc = str(criterion.get("description") or "").strip()
    parts = [p for p in (name, desc) if p]
    text = ". ".join(parts)
    if is_negative(criterion):
        text += " (Да = нарушение.)"
    return text


def option_keys(criterion: dict) -> list[str]:
    if criterion.get("type") == "scale":
        keys = [fmt_value(l.get("value")) for l in criterion.get("levels") or []]
    else:
        keys = ["yes", "no"]
    if criterion.get("na_allowed"):
        keys.append("na")
    return keys


def fmt_value(v) -> str:
    """Ступень шкалы как ключ варианта: 20 → "20", 7.5 → "7.5"."""
    f = float(v)
    return str(int(f)) if f.is_integer() else str(f)


def option_text(criterion: dict, key: str) -> str:
    if key == "na":
        cond = str(criterion.get("na_condition") or "").strip()
        return f"N/A: {cond}" if cond else "N/A: неприменимо"
    if criterion.get("type") == "scale":
        levels = criterion.get("levels") or []
        mx = max((float(l.get("value")) for l in levels), default=0) or 1
        for l in levels:
            if fmt_value(l.get("value")) == key:
                return f"{key} из {fmt_value(mx)}: {str(l.get('description') or '').strip()}"
        return key
    return {"yes": "Да", "no": "Нет"}.get(key, key)


def options(criterion: dict) -> list[tuple[str, str]]:
    return [(k, option_text(criterion, k)) for k in option_keys(criterion)]


def level_values(criterion: dict) -> dict[str, float]:
    return {fmt_value(l.get("value")): float(l.get("value")) for l in criterion.get("levels") or []}


def normalize_answer(y) -> str:
    if isinstance(y, (int, float)) and not isinstance(y, bool):
        return fmt_value(y)
    s = str(y)
    try:
        return fmt_value(float(s))
    except ValueError:
        return s


def norm_text(s: str) -> str:
    return " ".join(str(s).lower().split())


def question_key(criterion: dict) -> str:
    """Нормализованный текст вопроса + варианты: ключ адаптера дообучения."""
    return norm_text(question_text(criterion)) + " || " + " | ".join(norm_text(t) for _, t in options(criterion))
