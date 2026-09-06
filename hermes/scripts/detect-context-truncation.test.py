#!/usr/bin/env python3
"""
detect-context-truncation.test.py — regressão pro #7528 (deteccao externa de
truncagem silenciosa do modelo local via session_model_usage).

Cobre:
  1. avg_per_call usa input_tokens / api_call_count (cumulativo dividido),
     nunca input_tokens cru.
  2. A tabela session_model_usage nao tem updated_at — a query usa first_seen
     (ordenacao + filtro temporal), nunca updated_at.
  3. Ceiling vem do config.yaml (model.context_length), nunca hardcode.
  4. TRUNCANDO: 2+ sessoes bate no valor suspeito (~32770) — alarme (exit 2).
  5. TRUNCANDO: colapso em sessao produtiva (avg << teto, calls >= 3) — alarme.
  6. NA BORDA: avg > 85% da janela sem truncar — aviso (exit 1).
  7. OK: nada suspeito — exit 0.
  8. INDETERMINADO: config nao expoe context_length e Ollama offline — exit 3
     (fail-closed, nunca "ok" por silencio).
  9. Sessao de 1 chamada com avg ~32770 nao dispara sozinha (precisa de 2+
     repeticoes pro sinal de valor suspeito; colapso exige calls >= 3).
  10. Modelos pagos (openrouter/openai-codex) nao entram na analise — truncagem
      so acontece no modelo local (custom/qwen).

Uso: python3 hermes/scripts/detect-context-truncation.test.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "detect-context-truncation.py"

FAILED = 0


def _load_module():
    spec = importlib.util.spec_from_file_location("detect_context_truncation", MODULE_PATH)
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


def _seed_usage(db_path: Path, rows: list[tuple]) -> None:
    """Cria session_model_usage com o schema REAL do state.db.

    Fixture usa sempre 7-tuples (session_id, model, billing_provider,
    api_call_count, input_tokens, first_seen, last_seen) — o subset que a
    logica de truncation analisa. Nao tem caminho de insercao generica
    (o schema real tem colunas NOT NULL sem default que exigiria todos os
    16 campos preenchidos; a fixture intencionalmente omite-as).
    """
    con = sqlite3.connect(db_path)
    con.execute("DROP TABLE IF EXISTS session_model_usage")
    con.execute(
        """
        CREATE TABLE session_model_usage (
            session_id TEXT NOT NULL,
            model TEXT NOT NULL,
            billing_provider TEXT NOT NULL DEFAULT '',
            billing_base_url TEXT NOT NULL DEFAULT '',
            billing_mode TEXT NOT NULL DEFAULT '',
            task TEXT NOT NULL DEFAULT '',
            api_call_count INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            reasoning_tokens INTEGER NOT NULL DEFAULT 0,
            estimated_cost_usd REAL NOT NULL DEFAULT 0,
            actual_cost_usd REAL NOT NULL DEFAULT 0,
            cost_status TEXT,
            cost_source TEXT,
            first_seen REAL,
            last_seen REAL,
            PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
        )
        """
    )
    con.executemany(
        """INSERT INTO session_model_usage
           (session_id, model, billing_provider, api_call_count,
            input_tokens, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [(r[0], r[1], r[2], r[3] if len(r) > 3 else 0, r[4] if len(r) > 4 else 0,
          r[5] if len(r) > 5 else time.time(), r[6] if len(r) > 6 else time.time())
         for r in rows]
    )
    con.commit()
    con.close()


def _write_config(path: Path, context_length: int | None = None) -> None:
    """Escreve um config.yaml minimo com (ou sem) context_length."""
    if context_length is not None:
        path.write_text(f"""
model:
  default: custom/qwen-64k:latest
  provider: custom
  context_length: {context_length}
""")
    else:
        path.write_text("""
model:
  default: custom/qwen-64k:latest
  provider: custom
""")


def main() -> int:
    mod = _load_module()
    now = time.time()

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        db_path = td / "state.db"
        config_path = td / "config.yaml"

        # ------------------------------------------------------------------
        # 1. avg_per_call divide input_tokens por api_call_count
        # ------------------------------------------------------------------
        _write_config(config_path, context_length=92700)
        _seed_usage(db_path, [
            ("sess-1", "qwen-64k:latest", "custom", 10, 600000, now, now),
        ])
        sessions = mod.collect_local_sessions(1, db_path)
        assert_true(
            "1. avg_per_call = input_tokens / api_call_count (cumulativo dividido, nao raw)",
            sessions[0]["avg_per_call"] == 60000,
        )

        # ------------------------------------------------------------------
        # 2. query usa first_seen, NUNCA updated_at
        # ------------------------------------------------------------------
        # Se a query fizesse ORDER BY updated_at, falharia (OperationalError).
        # Se aqui roda sem erro, first_seen esta certo.
        _seed_usage(db_path, [
            ("sess-2", "qwen-64k:latest", "custom", 5, 50000, now, now),
        ])
        sessions2 = mod.collect_local_sessions(999, db_path)
        assert_true(
            "2. collect_local_sessions roda sem updated_at (usa first_seen) — "
            "nao da OperationalError",
            len(sessions2) >= 1,
        )

        # ------------------------------------------------------------------
        # 3. ceiling vem do config.yaml, nunca hardcode
        # ------------------------------------------------------------------
        _write_config(config_path, context_length=100000)
        ceiling = mod._resolve_ceiling(config_path, "disabled", "qwen-64k:latest")
        assert_true(
            "3. ceiling lido do config.yaml (model.context_length), nao hardcode",
            ceiling == 100000,
        )

        # ------------------------------------------------------------------
        # 4. TRUNCANDO: 2+ sessoes no valor suspeito (32770)
        # ------------------------------------------------------------------
        _seed_usage(db_path, [])  # novo DB limpo
        db_path.unlink()
        _seed_usage(db_path, [
            ("sess-trunc-a", "qwen-64k:latest", "custom", 1, 32770, now, now),
            ("sess-trunc-b", "qwen-64k:latest", "custom", 3, 98310, now, now),
            ("sess-normal", "qwen-64k:latest", "custom", 5, 500000, now, now),
        ])
        sessions_t = mod.collect_local_sessions(1, db_path)
        _write_config(config_path, context_length=92700)
        ceiling_t = mod._resolve_ceiling(config_path, "disabled", "qwen-64k:latest")
        result_t = mod.detect_truncation(sessions_t, ceiling_t)
        assert_true(
            "4. 2+ sessoes no valor suspeito (~32770) -> status=truncating",
            result_t["status"] == "truncating",
        )
        assert_true(
            "4. ambas as sessoes truncantes aparecem em truncating_sessions",
            len(result_t["truncating_sessions"]) >= 2,
        )
        assert_true(
            "4. sessao normal (avg 100k) NAO aparece como truncante",
            "sess-normal" not in [s["session_id"] for s in result_t["truncating_sessions"]],
        )

        # ------------------------------------------------------------------
        # 5. TRUNCANDO: colapso em sessao produtiva (calls >= 3, avg << teto)
        # ------------------------------------------------------------------
        db_path.unlink()
        _seed_usage(db_path, [
            ("sess-collapse", "qwen-64k:latest", "custom", 10, 327700, now, now),
        ])
        sessions_c = mod.collect_local_sessions(1, db_path)
        result_c = mod.detect_truncation(sessions_c, 92700)
        avg_c = 327700 / 10  # 32770
        assert_true(
            "5. colapso em sessao produtiva (10 chamadas, avg=32770 < 50% de 92700) "
            "-> status=truncating (via collapse, mesmo que tambem bata no valor suspeito)",
            result_c["status"] == "truncating"
            and len(result_c["truncating_sessions"]) >= 1,
        )
        # Sessao produtiva (calls >= 3) com avg << teto mas FORA da faixa de
        # truncagem (32770) tambem dispara via colapso sozinho.
        db_path.unlink()
        _seed_usage(db_path, [
            ("sess-collapse-puro", "qwen-64k:latest", "custom", 5, 200000, now, now),
        ])  # avg = 40000 (43% de 92700) — fora da faixa 32770±6%, mas < 46350 e > 10k
        sessions_cp = mod.collect_local_sessions(1, db_path)
        result_cp = mod.detect_truncation(sessions_cp, 92700)
        assert_true(
            "5b. colapso sozinho (avg=40000, fora da faixa 32770±6%, calls=5>=3, "
            "10k < 40000 < 46350) -> status=truncating via sinal collapse exclusivo",
            result_cp["status"] == "truncating"
            and any(s["signal"] == "collapse" for s in result_cp["truncating_sessions"]),
        )

        # ------------------------------------------------------------------
        # 6. NA BORDA: avg > 85% da janela sem truncar
        # ------------------------------------------------------------------
        db_path.unlink()
        _seed_usage(db_path, [
            ("sess-edge", "qwen-64k:latest", "custom", 5, 500000, now, now),
        ])  # avg = 100000 > 85% de 92700 (78795)
        sessions_e = mod.collect_local_sessions(1, db_path)
        result_e = mod.detect_truncation(sessions_e, 92700)
        assert_true(
            "6. avg > 85% de ceiling sem truncar -> status=edge (aviso, nao alarme)",
            result_e["status"] == "edge",
        )
        assert_true(
            "6. sessao na borda aparece em edge_sessions",
            len(result_e["edge_sessions"]) == 1,
        )

        # ------------------------------------------------------------------
        # 7. OK: nada suspeito
        # ------------------------------------------------------------------
        db_path.unlink()
        _seed_usage(db_path, [
            ("sess-ok", "qwen-64k:latest", "custom", 5, 280000, now, now),
        ])  # avg = 56000 (60% de 92700) — normal
        sessions_ok = mod.collect_local_sessions(1, db_path)
        result_ok = mod.detect_truncation(sessions_ok, 92700)
        assert_true(
            "7. avg normal (56k, 60% de ceiling) -> status=ok",
            result_ok["status"] == "ok",
        )

        # ------------------------------------------------------------------
        # 8. INDETERMINADO: config sem context_length + Ollama offline
        # ------------------------------------------------------------------
        _write_config(config_path, context_length=None)  # sem context_length
        ceiling_ind = mod._resolve_ceiling(config_path, "disabled", "nope")
        assert_true(
            "8. config sem context_length + Ollama offline -> ceiling=None (INDETERMINADO)",
            ceiling_ind is None,
        )

        # ------------------------------------------------------------------
        # 9. Sessao de 1 chamada com avg ~32770 sozinha NAO dispara
        #    (precisa de 2+ para o sinal de valor suspeito; colapso exige calls >= 3).
        # ------------------------------------------------------------------
        db_path.unlink()
        _seed_usage(db_path, [
            ("sess-single", "qwen-64k:latest", "custom", 1, 32770, now, now),
        ])  # 1 chamada so, nao repete
        sessions_s = mod.collect_local_sessions(1, db_path)
        result_s = mod.detect_truncation(sessions_s, 92700)
        assert_true(
            "9. 1 chamada so com avg ~32770 nao dispara truncagem "
            "(precisa de 2+ repeticoes ou colapso com calls >= 3)",
            result_s["status"] == "ok",
        )

        # ------------------------------------------------------------------
        # 10. Modelos pagos nao entram na analise
        # ------------------------------------------------------------------
        db_path.unlink()
        _seed_usage(db_path, [
            ("sess-paid", "gpt-5.6-luna", "openai-codex", 5, 32770, now, now),
            ("sess-paid2", "gpt-5.6-luna", "openai-codex", 5, 32770, now, now),
        ])  # 2 sessoes pagas no valor 32770, mas NAO sao locais
        sessions_p = mod.collect_local_sessions(1, db_path)
        result_p = mod.detect_truncation(sessions_p, 92700)
        assert_true(
            "10. modelo pago (openai-codex) com avg 32770 nao dispara truncagem",
            result_p["status"] == "ok",
        )

        # ------------------------------------------------------------------
        # Bônus: 32770 + tolerancia (6%) — valores dentro da faixa contam.
        # ------------------------------------------------------------------
        db_path.unlink()
        _seed_usage(db_path, [
            ("sess-tol-a", "qwen-64k:latest", "custom", 1, 31000, now, now),
            ("sess-tol-b", "qwen-64k:latest", "custom", 1, 34500, now, now),
        ])  # 31000 = 32770 * 0.95 (dentro de 6%), 34500 = 32770 * 1.05 (dentro)
        sessions_tol = mod.collect_local_sessions(1, db_path)
        result_tol = mod.detect_truncation(sessions_tol, 92700)
        assert_true(
            "B. valores dentro da faixa de tolerancia (6%) de 32770 contam como suspeitos",
            result_tol["status"] == "truncating",
        )

        # ------------------------------------------------------------------
        # main() exit codes — o contrato consumido pelo watch-continuo-health.sh.
        # ------------------------------------------------------------------
        import subprocess

        def _run_main(args: list[str]) -> tuple[int, str]:
            """Invoca detect-context-truncation.py como subprocesso real."""
            r = subprocess.run(
                [sys.executable, str(MODULE_PATH)] + args,
                capture_output=True, text=True, timeout=30,
            )
            return r.returncode, r.stdout + r.stderr

        # main() exit 0: nada suspeito (config tem ceiling, sessao normal).
        _write_config(config_path, context_length=92700)
        db_path.unlink()
        _seed_usage(db_path, [
            ("sess-ok", "qwen-64k:latest", "custom", 5, 280000, now, now),
        ])  # avg=56000, 60% — normal
        code, _ = _run_main(["--days", "1", "--config", str(config_path),
                             "--state-db", str(db_path), "--no-ollama"])
        assert_true("main() exit 0 para status ok", code == 0)

        # main() exit 1: NA BORDA (avg > 85% sem truncar).
        db_path.unlink()
        _seed_usage(db_path, [
            ("sess-edge", "qwen-64k:latest", "custom", 5, 500000, now, now),
        ])  # avg=100000 > 85% de 92700
        code, _ = _run_main(["--days", "1", "--config", str(config_path),
                             "--state-db", str(db_path), "--no-ollama"])
        assert_true("main() exit 1 (edge) para NA BORDA", code == 1)

        # main() exit 2: TRUNCANDO (2+ sessoes em 32770).
        db_path.unlink()
        _seed_usage(db_path, [
            ("sess-tr-a", "qwen-64k:latest", "custom", 1, 32770, now, now),
            ("sess-tr-b", "qwen-64k:latest", "custom", 3, 98310, now, now),
        ])
        code, out = _run_main(["--days", "1", "--config", str(config_path),
                               "--state-db", str(db_path), "--no-ollama", "--json"])
        assert_true("main() exit 2 (truncating) para TRUNCANDO", code == 2)
        parsed = json.loads(out)
        assert_true("main() --json emite status=truncating", parsed.get("status") == "truncating")

        # main() exit 3: INDETERMINADO (config sem context_length + --no-ollama).
        _write_config(config_path, context_length=None)
        code, out = _run_main(["--days", "1", "--config", str(config_path),
                               "--state-db", str(db_path), "--no-ollama", "--json"])
        assert_true("main() exit 3 (indeterminado) quando ceiling nao resolve",
                    code == 3)
        parsed = json.loads(out)
        assert_true("main() --json emite status=indeterminado",
                    parsed.get("status") == "indeterminado")

        if FAILED:
            print(f"\n{FAILED} assercao(es) falharam")
            return 1
        print("\nTODOS OS TESTES PASSARAM")
        return 0


if __name__ == "__main__":
    sys.exit(main())
