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
import datetime
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


KEY_LIMIT_ERROR = (
    "RuntimeError: HTTP 403: Key limit exceeded (daily limit). Manage it using "
    "https://openrouter.ai/workspaces/default/keys/xxx"
)


def key_limit_cases() -> None:
    """#10064: o watchdog pausa no 403 Key limit exceeded lido de `last_error`
    do job (sem pool exausto em auth.json), retoma depois da virada UTC e não
    re-pausa lendo o erro velho logo após retomar."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        auth_path = tmp_path / "auth.json"
        jobs_path = tmp_path / "jobs.json"
        marker_path = tmp_path / ".paused-by-watchdog"
        state_path = tmp_path / ".key-limit-resumed-run"
        # Pool saudável — o ramo antigo nunca dispararia (cenário real de 10/10).
        auth_path.write_text(
            json.dumps({"credential_pool": {"openrouter": [{"last_status": "ok"}]}}),
            encoding="utf-8",
        )

        def write_job(**kw):
            job = {
                "id": "5d791ef6fc2c",
                "enabled": True,
                "model": "gpt-6-luna",
                "provider": "openai-codex",
                "failure_streak": 45,
                "last_error": KEY_LIMIT_ERROR,
                "last_run_at": "2026-10-10T07:40:30-03:00",
            }
            job.update(kw)
            jobs_path.write_text(json.dumps({"jobs": [job]}), encoding="utf-8")

        mod = _load_module()
        mod.AUTH_PATH = str(auth_path)
        mod.JOBS_PATH = str(jobs_path)
        mod.MARKER_PATH = str(marker_path)
        mod.KEY_LIMIT_STATE_PATH = str(state_path)
        ok_result = subprocess.CompletedProcess(args=["hermes"], returncode=0, stdout="", stderr="")

        # 1. 403 key limit com streak alto -> pausa + marcador JSON com resume_after
        write_job()
        with mock.patch.object(mod.subprocess, "run", return_value=ok_result) as run:
            out = _run_main(mod)
        calls = [c.args[0] for c in run.call_args_list]
        assert_true(
            "key limit: 403 Key limit exceeded com failure_streak alto pausa o job",
            ["hermes", "cron", "pause", "5d791ef6fc2c"] in calls and "pausado" in out.lower(),
            f"(calls={calls!r} saída={out!r})",
        )
        marker = json.loads(marker_path.read_text()) if marker_path.exists() else {}
        assert_true(
            "key limit: marcador JSON com reason=key_limit e resume_after futuro",
            marker.get("reason") == "key_limit" and marker.get("resume_after", 0) > time.time(),
            f"(marcador={marker!r})",
        )

        # 2. Job pausado, antes do reset -> silêncio, nada roda
        write_job(enabled=False)
        with mock.patch.object(mod.subprocess, "run", return_value=ok_result) as run:
            out = _run_main(mod)
        assert_true(
            "key limit: antes da virada UTC o watchdog fica em silêncio",
            out == "" and run.call_count == 0,
            f"(saída={out!r} calls={run.call_count})",
        )

        # 3. Depois do reset -> retoma e grava o last_run_at da retomada
        marker["resume_after"] = time.time() - 1
        marker_path.write_text(json.dumps(marker))
        with mock.patch.object(mod.subprocess, "run", return_value=ok_result) as run:
            out = _run_main(mod)
        calls = [c.args[0] for c in run.call_args_list]
        assert_true(
            "key limit: depois da virada UTC retoma o job e remove o marcador",
            ["hermes", "cron", "resume", "5d791ef6fc2c"] in calls and not marker_path.exists(),
            f"(calls={calls!r} saída={out!r})",
        )
        assert_true(
            "key limit: guarda o last_run_at da retomada",
            state_path.exists() and state_path.read_text() == "2026-10-10T07:40:30-03:00",
        )

        # 4. Logo após retomar, last_error ainda é o 403 velho -> NÃO re-pausa
        write_job(enabled=True)
        with mock.patch.object(mod.subprocess, "run", return_value=ok_result) as run:
            out = _run_main(mod)
        assert_true(
            "key limit: erro velho (mesmo last_run_at da retomada) não re-pausa",
            run.call_count == 0 and not marker_path.exists(),
            f"(saída={out!r} calls={run.call_count})",
        )

        # 5. Novo run falhou de novo com 403 -> re-pausa
        write_job(last_run_at="2026-10-11T00:10:00-03:00", failure_streak=46)
        with mock.patch.object(mod.subprocess, "run", return_value=ok_result) as run:
            out = _run_main(mod)
        assert_true(
            "key limit: run novo falhando de novo com 403 pausa outra vez",
            run.call_count == 1 and marker_path.exists(),
            f"(saída={out!r} calls={run.call_count})",
        )
        marker_path.unlink()

        # 6. Streak 1 (falha isolada) ou 403 genérico -> não pausa
        for desc, kw in (
            ("failure_streak=1", {"failure_streak": 1, "last_run_at": "x1"}),
            ("403 genérico sem 'key limit'", {"last_error": "HTTP 403: Forbidden", "last_run_at": "x2"}),
        ):
            write_job(**kw)
            with mock.patch.object(mod.subprocess, "run", return_value=ok_result) as run:
                _run_main(mod)
            assert_true(
                f"key limit: {desc} não pausa",
                run.call_count == 0 and not marker_path.exists(),
            )

        # 7. Editor retomou à mão enquanto o marcador existia -> só limpa.
        # Estado REAL pós-`hermes cron resume` (#10111): o resume do Hermes mexe
        # só em enabled/state/paused_*/next_run_at — `failure_streak` e
        # `last_error` seguem os do run que falhou (antes o fixture usava
        # streak=0/last_error=None, estado que o Hermes nunca produz).
        state_path.unlink(missing_ok=True)
        marker_path.write_text(json.dumps({
            "reason": "key_limit", "resume_after": time.time() + 3600,
            "paused_last_run_at": "2026-10-12T07:00:00-03:00",
        }))
        write_job(last_run_at="2026-10-12T07:00:00-03:00")
        with mock.patch.object(mod.subprocess, "run", return_value=ok_result) as run:
            _run_main(mod)
        assert_true(
            "key limit: job já ativo com marcador -> limpa o marcador sem comando",
            run.call_count == 0 and not marker_path.exists(),
        )
        assert_true(
            "#10111: retomada manual grava o paused_last_run_at no estado",
            state_path.exists() and state_path.read_text() == "2026-10-12T07:00:00-03:00",
            f"(estado={state_path.read_text() if state_path.exists() else None!r})",
        )

        # 8. #10111 cenário da issue, passo 4: tick seguinte, sem marcador, job
        # ativo com o 403 velho e streak alto -> NÃO re-pausa (desfaria a
        # retomada manual do editor até a próxima 00:05 UTC).
        with mock.patch.object(mod.subprocess, "run", return_value=ok_result) as run:
            out = _run_main(mod)
        assert_true(
            "#10111: tick após a retomada manual não re-pausa lendo o 403 velho",
            run.call_count == 0 and not marker_path.exists() and out == "",
            f"(saída={out!r} calls={[c.args[0] for c in run.call_args_list]!r})",
        )

        # 9. Depois da retomada manual, um run NOVO falha de novo com 403 ->
        # re-pausa (a cota não voltou; a guarda só segura o erro velho).
        write_job(last_run_at="2026-10-12T09:00:00-03:00", failure_streak=46)
        with mock.patch.object(mod.subprocess, "run", return_value=ok_result) as run:
            _run_main(mod)
        assert_true(
            "#10111: run novo pós-retomada manual falhando com 403 pausa outra vez",
            run.call_count == 1 and marker_path.exists(),
        )
        marker_path.unlink(missing_ok=True)

        # 10. Marcador sem `paused_last_run_at` (gravado antes desse campo) ->
        # cai no last_run_at atual do job e também não re-pausa.
        state_path.unlink(missing_ok=True)
        marker_path.write_text(json.dumps({"reason": "key_limit", "resume_after": time.time() + 3600}))
        write_job(last_run_at="2026-10-12T11:00:00-03:00")
        with mock.patch.object(mod.subprocess, "run", return_value=ok_result) as run:
            _run_main(mod)
            _run_main(mod)
        assert_true(
            "#10111: marcador sem paused_last_run_at usa o last_run_at do job e não re-pausa",
            run.call_count == 0 and not marker_path.exists()
            and state_path.read_text() == "2026-10-12T11:00:00-03:00",
        )

    assert_true(
        "next_key_limit_reset: próxima 00:00 UTC + margem",
        _load_module().next_key_limit_reset(
            datetime.datetime(2026, 10, 10, 18, 57, tzinfo=datetime.timezone.utc).timestamp()
        ) == datetime.datetime(2026, 10, 11, 0, 5, tzinfo=datetime.timezone.utc).timestamp(),
    )


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

    key_limit_cases()

    if FAILED:
        print("FALHOU")
        return 1
    print("OK — todos os asserts passaram")
    return 0


if __name__ == "__main__":
    sys.exit(main())
