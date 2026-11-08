"""Локальная модель CQA: обучена с нуля, работает без внешних API."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # корень репозитория
LM = ROOT / "local-model"
DATA = LM / "data"
WEIGHTS = LM / "weights"
RUNS = LM / "runs"
MODEL_NAME = "cqa-local-v1"
