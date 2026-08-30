#!/usr/bin/env python3
"""
pause-cron-on-ratelimit.test.py — regressão pro #6697 finding 4.

Cobre o cenário: `hermes cron pause` sucede, mas gravar o marcador
`.paused-by-watchdog` falha (permissão, disco cheio) — antes desta correção,
a exceção subia crua e o job ficava pausado indefinidamente EM SILÊNCIO
(sem o marcador, o watchdog nunca mais o retoma). Também cobre o guard de
`subprocess.run` contra `FileNotFoundError`/`TimeoutExpired` (hermes fora do
PATH), que antes produzia traceback cru a cada tick.

Uso: python3 hermes/scripts/pause-cron-on-ratelimit.test.py
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "pause-cron-on-ratelimit.py"

FAILED = 0


def _load_module():
    spec = importlib.util.spec_from_file_location("pause_cron_on_ratelimit", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def assert_true(desc: str, cond: bool, detail: str = "") -> None:
    global FAILED
    if cond:
        print(f"ok: {desc}")
    else:
        print(f"FAIL: {desc} {detail}")
        FAILED = 1


def _run_main(mod) -> str:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        mod.main()
    return buf.getvalue().strip()


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        auth_path = tmp_path / "auth.json"
        jobs_path = tmp_path / "jobs.json"
        marker_path = tmp_path / ".paused-by-watchdog"

        future = time.time() + 3600
        auth_path.write_text(
            json.dumps(
                {
                    "credential_pool": {
                        "openrouter": [
                            {"last_status": "exhausted", "last_error_reset_at": future},
                            {"last_status": "exhausted", "last_error_reset_at": future},
                        ]
                    }
                }
            ),
            encoding="utf-8",
        )
        jobs_path.write_text(
            json.dumps(
                {
                    "jobs": [
                        {
                            "id": "5d791ef6fc2c",
                            "enabled": True,
                            "model": "poolside/laguna-s-2.1:free",
                            "provider": "openrouter",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        mod = _load_module()
        mod.AUTH_PATH = str(auth_path)
        mod.JOBS_PATH = str(jobs_path)
        mod.MARKER_PATH = str(marker_path)

        # --- finding 4a: pause sucede, gravar marcador falha -> grita, não estoura ---
        ok_result = subprocess.CompletedProcess(args=["hermes"], returncode=0, stdout="", stderr="")
        # Só o open() do MARKER_PATH falha — os demais (leitura de auth/jobs)
        # seguem reais, sem precisar mockar o parse JSON inteiro.
        real_open = open

        def _open_patch(path, mode="r", *a, **kw):
            if str(path) == str(marker_path) and "w" in mode:
                raise OSError("disk full (simulado)")
            return real_open(path, mode, *a, **kw)

        with mock.patch.object(mod.subprocess, "run", return_value=ok_result):
            with mock.patch("builtins.open", side_effect=_open_patch):
                out = _run_main(mod)
        assert_true(
            "finding 4a: pause sucede mas grava do marcador falha -> mensagem explícita, sem traceback",
            "FALHOU AO GRAVAR" in out and "PAUSOU" in out,
            f"(saída: {out!r})",
        )
        assert_true(
            "finding 4a: marcador realmente NÃO foi criado (grito é sobre um estado real, não hipotético)",
            not marker_path.exists(),
        )

        # --- finding 4b: subprocess.run explode com FileNotFoundError -> guard, não traceback ---
        with mock.patch.object(mod.subprocess, "run", side_effect=FileNotFoundError("hermes: not found")):
            out = _run_main(mod)
        assert_true(
            "finding 4b: hermes fora do PATH (FileNotFoundError) produz mensagem de watchdog, não traceback",
            "não conseguiu rodar" in out,
            f"(saída: {out!r})",
        )

        # --- finding 4c: subprocess.run explode com TimeoutExpired -> guard, não traceback ---
        with mock.patch.object(
            mod.subprocess, "run", side_effect=subprocess.TimeoutExpired(cmd="hermes", timeout=90)
        ):
            out = _run_main(mod)
        assert_true(
            "finding 4c: hermes trava (TimeoutExpired) produz mensagem de watchdog, não traceback",
            "não conseguiu rodar" in out,
            f"(saída: {out!r})",
        )

        # --- caminho feliz: pause sucede e marcador grava normalmente ---
        with mock.patch.object(mod.subprocess, "run", return_value=ok_result):
            out = _run_main(mod)
        assert_true(
            "caminho feliz: pause sucede e marcador é gravado sem erro",
            "pausado" in out.lower() and marker_path.exists(),
            f"(saída: {out!r})",
        )

    if FAILED:
        print("FALHOU")
        return 1
    print("OK — todos os asserts passaram")
    return 0


if __name__ == "__main__":
    sys.exit(main())
