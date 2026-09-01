#!/usr/bin/env python3
"""
hermes-model-cost-report.test.py — regressão pro #6880 (decorre do #6708).

`collect()` fazia `LEFT JOIN sessions s ON s.id = u.session_id` só pra
produzir a coluna `pedido` (`s.model`) e o campo derivado `substituido`
(`pedido != modelo`). `sessions.model` é o modelo CORRENTE da sessão
(mutável) — não o modelo pedido NA CHAMADA que gerou aquela linha
agregada. Uma sessão que trocasse de modelo DEPOIS de fazer chamadas com
um modelo mais antigo fabricava uma "substituição" que nunca aconteceu.
Foi exatamente esse artefato de JOIN que abriu o #6708 como falso P1
(nenhuma cobrança fora da allowlist tinha de fato ocorrido).

Cobre:
  1. `collect()` nunca mais retorna as chaves `pedido`/`substituido`.
  2. `collect()` funciona SEM a tabela `sessions` existir no banco —
     prova que a dependência foi removida de verdade, não só escondida.
  3. `_is_leak`/`vazamento_pago` continuam corretos (dependem só de
     `model`/`provider`, nunca tocaram `pedido`) — não é uma regressão
     por associação com o fix.

#6912 (01/09/2026): também cobre `collect_tick_composition` — o detector de
degradação silenciosa POR TICK do job `continuo` (fallback local invisível
quando agregado por dia+modelo, ver docstring da função):
  4. tick 100% no modelo primário -> degraded=False.
  5. tick com qualquer chamada no fallback local (qwen) -> degraded=True,
     mesmo que a maioria das chamadas tenha sido no primário.
  6. session_id fora do padrão `hermes-cron-{JOB_ID}-*` não entra na
     composição (não é o job continuo).

Uso: python3 hermes/scripts/hermes-model-cost-report.test.py
"""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "hermes-model-cost-report.py"

FAILED = 0


def _load_module():
    spec = importlib.util.spec_from_file_location("hermes_model_cost_report", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def assert_true(desc: str, cond: bool) -> None:
    global FAILED
    if cond:
        print(f"ok: {desc}")
    else:
        print(f"FAIL: {desc}")
        FAILED += 1


def _seed_usage_only(db_path: Path) -> None:
    """Banco com session_model_usage mas SEM a tabela sessions — prova que
    collect() não depende mais dela."""
    con = sqlite3.connect(db_path)
    con.execute(
        """
        CREATE TABLE session_model_usage (
            session_id TEXT,
            model TEXT,
            billing_provider TEXT,
            api_call_count INTEGER,
            input_tokens INTEGER,
            output_tokens INTEGER,
            actual_cost_usd REAL,
            estimated_cost_usd REAL,
            first_seen REAL
        )
        """
    )
    now = time.time()
    # Cenário do #6708: uma sessão fez chamadas com um modelo :free (nunca
    # cobrou), sem nenhuma linha de vazamento real.
    con.execute(
        "INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?)",
        ("s1", "z-ai/glm-5.3-flash:free", "openrouter", 3, 1000, 500, 0.0, 0.0, now),
    )
    # Linha de vazamento real: pago, fora da allowlist.
    con.execute(
        "INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?)",
        ("s2", "z-ai/glm-5.2", "openrouter", 17, 100000, 100000, 0.459, 0.459, now),
    )
    con.commit()
    con.close()


def _seed_tick_composition(db_path: Path, job_id: str) -> None:
    """Banco com 3 ticks do continuo — 1 saudavel (100% primario), 1
    degradado (chamou o fallback local), 1 fora do padrao de session_id (nao
    e do job continuo, nao deve entrar na composicao)."""
    con = sqlite3.connect(db_path)
    con.execute(
        """
        CREATE TABLE session_model_usage (
            session_id TEXT,
            model TEXT,
            billing_provider TEXT,
            api_call_count INTEGER,
            input_tokens INTEGER,
            output_tokens INTEGER,
            actual_cost_usd REAL,
            estimated_cost_usd REAL,
            first_seen REAL
        )
        """
    )
    now = time.time()
    rows = [
        # tick saudavel: só primário.
        (f"hermes-cron-{job_id}-aaa111", "gpt-5.6-luna", "openai-codex", 5, 1000, 500, 0.0, 0.0, now),
        # tick degradado: maioria no primário, mas ALGUMA chamada caiu no
        # fallback local (qwen) — degraded=True mesmo sendo minoria.
        (f"hermes-cron-{job_id}-bbb222", "gpt-5.6-luna", "openai-codex", 8, 2000, 1000, 0.0, 0.0, now),
        (f"hermes-cron-{job_id}-bbb222", "qwen3.5:latest", "custom", 2, 200, 100, 0.0, 0.0, now),
        # sessão fora do padrão (não é job continuo) — não deve aparecer.
        ("outra-sessao-qualquer", "gpt-5.6-luna", "openai-codex", 9, 900, 900, 0.0, 0.0, now),
    ]
    con.executemany(
        "INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?)", rows
    )
    con.commit()
    con.close()


def main() -> int:
    mod = _load_module()

    with tempfile.TemporaryDirectory() as td:
        db_path = Path(td) / "state.db"
        _seed_usage_only(db_path)
        mod.STATE_DB = db_path

        rows = mod.collect(days=1)

        assert_true("collect() retorna as 2 linhas seedadas", len(rows) == 2)

        for r in rows:
            assert_true(
                f"linha {r['modelo']!r}: NÃO tem a chave 'pedido' (artefato de JOIN removido, #6880)",
                "pedido" not in r,
            )
            assert_true(
                f"linha {r['modelo']!r}: NÃO tem a chave 'substituido' (derivada de 'pedido', removida junto)",
                "substituido" not in r,
            )

        free_row = next(r for r in rows if r["modelo"] == "z-ai/glm-5.3-flash:free")
        assert_true(
            "linha :free (sem sessions.model divergente possível de existir) -> vazamento_pago=False",
            free_row["vazamento_pago"] is False,
        )

        leak_row = next(r for r in rows if r["modelo"] == "z-ai/glm-5.2")
        assert_true(
            "linha paga fora da allowlist (sem :free, sem match na allowlist) -> vazamento_pago=True",
            leak_row["vazamento_pago"] is True,
        )

    with tempfile.TemporaryDirectory() as td:
        db_path = Path(td) / "state.db"
        _seed_tick_composition(db_path, mod.CONTINUO_JOB_ID)
        mod.STATE_DB = db_path

        ticks = mod.collect_tick_composition(days=1)
        session_ids = {t["session_id"] for t in ticks}

        assert_true(
            "collect_tick_composition() só retorna sessões do padrão hermes-cron-{JOB_ID}-* (2, não 3)",
            len(ticks) == 2,
        )
        assert_true(
            "sessão fora do padrão (outra-sessao-qualquer) NÃO entra na composição",
            "outra-sessao-qualquer" not in session_ids,
        )

        saudavel = next(t for t in ticks if t["session_id"].endswith("aaa111"))
        assert_true(
            "tick 100% no modelo primário -> degraded=False",
            saudavel["degraded"] is False and saudavel["primary_pct"] == 100.0,
        )

        degradado = next(t for t in ticks if t["session_id"].endswith("bbb222"))
        assert_true(
            "tick com QUALQUER chamada no fallback local -> degraded=True, mesmo sendo minoria das chamadas",
            degradado["degraded"] is True and degradado["local_fallback_pct"] > 0
            and degradado["primary_pct"] > degradado["local_fallback_pct"],
        )

    if FAILED:
        print(f"\n{FAILED} asserção(ões) falharam")
        return 1
    print("\nTODOS OS TESTES PASSARAM")
    return 0


if __name__ == "__main__":
    sys.exit(main())
