#!/usr/bin/env python3
"""
monitor-cron-model-rotation.test.py — regressão pro #6697.

Cobre os 3 findings do review consolidado do range `5bad85fc..3dd36e8d`
sobre `monitor-cron-model-rotation.py`:

  1. "falhou model=X" (marcador POR TENTATIVA, sempre presente antes de um
     fallback bem-sucedido) não pode disparar ALERTA sozinho — só a linha
     TERMINAL ("ERRO: todos os modelos da cadeia falharam") conta.
  2. A rotação não pode recomendar de volta um modelo que já falhou NESTA
     mesma sequência (chain de 2, ambos falhando, não pode alternar
     indefinidamente entre os dois quebrados).
  3. `last_status` diferente de "ok" (job novo → "unknown", ou logo após
     pausa do watchdog irmão) não pode, sozinho, produzir ALERTA quando
     streak e delegation_streak estão saudáveis.

Uso: python3 hermes/scripts/monitor-cron-model-rotation.test.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "monitor-cron-model-rotation.py"

FAILED = 0


def _load_module():
    spec = importlib.util.spec_from_file_location("monitor_cron_model_rotation", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _write_jobs(path: Path, *, streak: int, status: str, model: str, state: str = "idle") -> None:
    path.write_text(
        json.dumps(
            {
                "jobs": [
                    {
                        "id": "5d791ef6fc2c",
                        "failure_streak": streak,
                        "last_status": status,
                        "model": model,
                        "provider": "openrouter",
                        "state": state,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )


def _write_config(path: Path, chain: list[tuple[str, str]]) -> None:
    lines = ["smart_model_routing:", "  fallback_chains:", "    coding_fallback:"]
    for m, p in chain:
        lines.append(f'      - model: "{m}"')
        lines.append(f'        provider: "{p}"')
    path.write_text("\n".join(lines), encoding="utf-8")


def _write_tick(out_dir: Path, name: str, content: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / name).write_text(content, encoding="utf-8")


def _run(mod, capsys_target) -> str:
    import io
    import contextlib

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        mod.main()
    return buf.getvalue().strip()


def assert_true(desc: str, cond: bool, detail: str = "") -> None:
    global FAILED
    if cond:
        print(f"ok: {desc}")
    else:
        print(f"FAIL: {desc} {detail}")
        FAILED = 1


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        jobs_json = tmp_path / "jobs.json"
        config_yaml = tmp_path / "config.yaml"
        out_dir = tmp_path / "output" / "5d791ef6fc2c"

        mod = _load_module()
        mod.JOBS_JSON = str(jobs_json)
        mod.CONFIG_YAML = str(config_yaml)
        mod.CRON_OUTPUT_DIR = str(tmp_path / "output" / "{}")

        chain = [("dots-3", "openrouter"), ("laguna", "openrouter"), ("gpt-5.6-luna", "openai-codex")]
        _write_config(config_yaml, chain)

        # --- Finding 1: fallback bem-sucedido (só marcador por-tentativa) não alarma ---
        _write_jobs(jobs_json, streak=0, status="ok", model="dots-3")
        _write_tick(
            out_dir,
            "tick-01.md",
            "[claude-openrouter] tentando model=dots-3\n"
            "[claude-openrouter] falhou model=dots-3 rc=1: RATE-LIMIT/QUOTA — transitório, próximo da cadeia\n"
            "[claude-openrouter] tentando model=laguna\n"
            "[claude-openrouter] ok model=laguna\n",
        )
        out = _run(mod, None)
        assert_true(
            "finding 1: fallback bem-sucedido (1 'falhou model=' + sucesso) não produz ALERTA",
            out == "OK",
            f"(saída: {out!r})",
        )

        # --- Finding 1: streak real de falha TERMINAL ainda dispara alerta ---
        for f in out_dir.glob("*.md"):
            f.unlink()
        _write_tick(
            out_dir,
            "tick-01.md",
            "[claude-openrouter] falhou model=dots-3 rc=1: ...\n"
            "[claude-openrouter] falhou model=laguna rc=1: ...\n"
            "ERRO: todos os modelos da cadeia falharam\n",
        )
        _write_tick(
            out_dir,
            "tick-02.md",
            "[claude-openrouter] falhou model=dots-3 rc=1: ...\n"
            "[claude-openrouter] falhou model=laguna rc=1: ...\n"
            "ERRO: todos os modelos da cadeia falharam\n",
        )
        _write_jobs(jobs_json, streak=0, status="ok", model="dots-3")
        out = _run(mod, None)
        assert_true(
            "finding 1: 2 ticks com falha TERMINAL real produz ALERTA",
            out.startswith("ALERTA"),
            f"(saída: {out!r})",
        )

        # --- Finding 2: rotação pula modelo já falhado NESTA sequência ---
        # Usa slugs `:free` de propósito (regressão do bug achado no
        # self-review: um corte ingênuo em `:` truncava "laguna-s-2.1:free"
        # pra "laguna-s-2.1", perdendo o sufixo e quebrando o match contra a
        # chain — ver comentário de FAILED_MODEL_RE no módulo).
        for f in out_dir.glob("*.md"):
            f.unlink()
        free_chain = [
            ("dots-studio/dots-3-note-preview:free", "openrouter"),
            ("poolside/laguna-s-2.1:free", "openrouter"),
        ]
        _write_config(config_yaml, free_chain)
        # Mistura os 2 formatos reais do wrapper: "model=$MODEL rc=$RC: ..."
        # (espaço antes do rc=) e "model=$MODEL: ..." (':' direto após o modelo).
        _write_tick(
            out_dir,
            "tick-01.md",
            "falhou model=dots-studio/dots-3-note-preview:free rc=1: RATE-LIMIT/QUOTA\n"
            "falhou model=poolside/laguna-s-2.1:free: TIMEOUT (2400s)\n"
            "ERRO: todos os modelos da cadeia falharam\n",
        )
        _write_tick(
            out_dir,
            "tick-02.md",
            "falhou model=dots-studio/dots-3-note-preview:free rc=1: RATE-LIMIT/QUOTA\n"
            "falhou model=poolside/laguna-s-2.1:free: TIMEOUT (2400s)\n"
            "ERRO: todos os modelos da cadeia falharam\n",
        )
        _write_jobs(jobs_json, streak=2, status="error", model="dots-studio/dots-3-note-preview:free")
        out = _run(mod, None)
        assert_true(
            "finding 2: com os 2 únicos modelos :free da chain falhados nesta sequência, cai no fallback (candidates[0])",
            "dots-3-note-preview:free" in out or "laguna-s-2.1:free" in out,
            f"(saída: {out!r})",
        )

        # Chain de 3 (2 :free + 1 pago) com só os 2 :free falhados nesta
        # sequência: deve pular AMBOS (sufixo :free preservado) e recomendar
        # o pago.
        for f in out_dir.glob("*.md"):
            f.unlink()
        free_chain_3 = free_chain + [("z-ai/glm-5.3-flash", "openrouter")]
        _write_config(config_yaml, free_chain_3)
        _write_tick(
            out_dir,
            "tick-01.md",
            "falhou model=dots-studio/dots-3-note-preview:free rc=1: RATE-LIMIT/QUOTA\n"
            "falhou model=poolside/laguna-s-2.1:free: TIMEOUT (2400s)\n"
            "ERRO: todos os modelos da cadeia falharam\n",
        )
        _write_tick(
            out_dir,
            "tick-02.md",
            "falhou model=dots-studio/dots-3-note-preview:free rc=1: RATE-LIMIT/QUOTA\n"
            "falhou model=poolside/laguna-s-2.1:free: TIMEOUT (2400s)\n"
            "ERRO: todos os modelos da cadeia falharam\n",
        )
        _write_jobs(jobs_json, streak=2, status="error", model="dots-studio/dots-3-note-preview:free")
        out = _run(mod, None)
        assert_true(
            "finding 2: pula os 2 modelos :free (já falharam nesta sequência, sufixo preservado) e recomenda o pago glm-5.3-flash",
            "z-ai/glm-5.3-flash" in out,
            f"(saída: {out!r})",
        )

        # --- #6795: 2 ticks CONSECUTIVOS de fallback bem-sucedido (rc=1 em
        # cada, sem linha TERMINAL) não podem, juntos, disparar ALERTA. Este
        # é o cenário real que o finding 1 acima (1 único tick) não cobre:
        # "rc=1" sozinho na tupla contava delegation_streak=2 num par de
        # ticks NORMAIS (o :free #1 estoura cota, o #2 responde, exit 0),
        # que é justamente o caso comum, não a exceção.
        for f in out_dir.glob("*.md"):
            f.unlink()
        _write_tick(
            out_dir,
            "tick-01.md",
            "[claude-openrouter] tentando model=dots-3\n"
            "[claude-openrouter] falhou model=dots-3 rc=1: RATE-LIMIT/QUOTA — transitório, próximo da cadeia\n"
            "[claude-openrouter] tentando model=laguna\n"
            "[claude-openrouter] ok model=laguna\n",
        )
        _write_tick(
            out_dir,
            "tick-02.md",
            "[claude-openrouter] tentando model=dots-3\n"
            "[claude-openrouter] falhou model=dots-3 rc=1: RATE-LIMIT/QUOTA — transitório, próximo da cadeia\n"
            "[claude-openrouter] tentando model=laguna\n"
            "[claude-openrouter] ok model=laguna\n",
        )
        _write_jobs(jobs_json, streak=0, status="ok", model="dots-3")
        out = _run(mod, None)
        assert_true(
            "#6795: 2 ticks consecutivos de fallback bem-sucedido (rc=1 cada, sem linha TERMINAL) não produzem ALERTA",
            out == "OK",
            f"(saída: {out!r})",
        )

        # --- Finding 3: last_status != 'ok' com streaks saudáveis não alarma ---
        for f in out_dir.glob("*.md"):
            f.unlink()
        _write_jobs(jobs_json, streak=0, status="unknown", model="dots-3")
        out = _run(mod, None)
        assert_true(
            "finding 3: last_status='unknown' (job novo) com streak=0 e sem falha de delegação não produz ALERTA",
            out == "OK",
            f"(saída: {out!r})",
        )

    if FAILED:
        print("FALHOU")
        return 1
    print("OK — todos os asserts passaram")
    return 0


if __name__ == "__main__":
    sys.exit(main())
