#!/usr/bin/env python3
"""
detect-tick-claim-fabrication.test.py — regressão pro #7537 (deteccao
externa de fabricacao de conclusao pelo coordenador do continuo).

Cobre:
  1. Tick honesto: relatorio fresco (mtime dentro da janela) + sessao
     registrada -> status=ok, exit 0.
  2. Fabricacao reproduzida (#7537): sessao continuo registrada e recente,
     relatorio AUSENTE -> fabrication_suspected, exit 2.
  3. Relatorio ausente e NENHUMA sessao correlacionada -> indeterminado
     (1o tick legitimo), nunca "ok" nem "fabricacao" por default.
  4. Relatorio existe mas mtime ANTERIOR ao inicio da janela do tick
     (relatorio obsoleto de um tick anterior sendo reaproveitado) ->
     fabrication_suspected.
  4b. Relatorio existe mas mtime POSTERIOR ao fim da janela do tick ->
     indeterminado (cannot-verify), NUNCA fabrication_suspected — achado do
     #7641: mtime mais novo so pode vir de escrita real e posterior, nunca
     de arquivo obsoleto reaproveitado (que preservaria mtime antigo).
  5. Contagem de issues classificadas alegada no relatorio ("n=4 issues")
     diverge muito do real (41 abertas, via --open-issues-json) ->
     fabrication_suspected (mesmo padrao do #7537).
  6. Contagem alegada dentro da tolerancia do real -> ok (nao dispara por
     diferenca de 1-2 issues fechadas/abertas entre leitura e escrita).
  7. Relatorio sem nenhuma alegacao numerica reconhecivel -> not_applicable
     (nunca "ok" silencioso por ausencia de dado).
  8. Issue citada como "reivindicada" no relatorio mas AUSENTE de todo
     session-registry continuo -> fabrication_suspected.
  9. Issue citada como reivindicada e presente no session-registry -> ok.
  10. Relatorio sem nenhuma mencao de reivindicacao/claim -> not_applicable.
  11. main() exit codes agregados (0/2/3) via subprocesso real.

Uso: python3 hermes/scripts/detect-tick-claim-fabrication.test.py
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "detect-tick-claim-fabrication.py"

FAILED = 0


def _load_module():
    spec = importlib.util.spec_from_file_location("detect_tick_claim_fabrication", MODULE_PATH)
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


def _iso(d: datetime) -> str:
    return d.isoformat().replace("+00:00", "Z")


def _write_session(sessions_dir: Path, session_id: str, started: datetime,
                    heartbeat: datetime, claimed_issues: list[int] | None = None) -> None:
    sessions_dir.mkdir(parents=True, exist_ok=True)
    record = {
        "kind": "continuo",
        "machineTag": "300",
        "sessionId": session_id,
        "startedAt": _iso(started),
        "lastHeartbeat": _iso(heartbeat),
        "claimed_issues": claimed_issues or [],
    }
    (sessions_dir / f"continuo-300-{session_id}.json").write_text(
        json.dumps(record), encoding="utf-8"
    )


def _write_report(report_path: Path, text: str, mtime: datetime | None = None) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(text, encoding="utf-8")
    if mtime is not None:
        ts = mtime.timestamp()
        import os
        os.utime(report_path, (ts, ts))


def _open_issues_file(td: Path, count: int) -> Path:
    p = td / "open-issues.json"
    p.write_text(json.dumps([{"number": i} for i in range(1, count + 1)]), encoding="utf-8")
    return p


def main() -> int:
    mod = _load_module()
    now = datetime.now(timezone.utc)

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)

        # ------------------------------------------------------------------
        # 1. Tick honesto: relatorio fresco + sessao registrada -> ok
        # ------------------------------------------------------------------
        repo1 = td / "repo1"
        report1 = repo1 / "data" / "continuo" / "last-tick-report.md"
        sessions1 = repo1 / "data" / "sessions"
        session_start = now - timedelta(minutes=10)
        _write_session(sessions1, "tick-a", session_start, now)
        _write_report(report1, "## Tick 12:00\n### Trabalhado\nnada.\n", mtime=now)
        result1 = mod.run(repo1, report1, sessions1, 45, now, None)
        assert_true(
            "1. tick honesto (relatorio fresco + sessao registrada) -> status != fabrication_suspected",
            result1["status"] != "fabrication_suspected",
        )

        # ------------------------------------------------------------------
        # 2. Fabricacao reproduzida (#7537): sessao recente, relatorio ausente
        # ------------------------------------------------------------------
        repo2 = td / "repo2"
        report2 = repo2 / "data" / "continuo" / "last-tick-report.md"
        sessions2 = repo2 / "data" / "sessions"
        _write_session(sessions2, "tick-b", now - timedelta(minutes=5), now)
        # relatorio NUNCA escrito (dir nem existe)
        result2 = mod.run(repo2, report2, sessions2, 45, now, None)
        assert_true(
            "2. sessao continuo recente + relatorio AUSENTE -> fabrication_suspected (#7537)",
            result2["status"] == "fabrication_suspected",
        )
        assert_true(
            "2. checagem report_freshness aponta a fabricacao",
            any(c["check"] == "report_freshness" and c["status"] == "fabrication_suspected"
                for c in result2["checks"]),
        )

        # ------------------------------------------------------------------
        # 3. Relatorio ausente e NENHUMA sessao correlacionada -> indeterminado
        # ------------------------------------------------------------------
        repo3 = td / "repo3"
        report3 = repo3 / "data" / "continuo" / "last-tick-report.md"
        sessions3 = repo3 / "data" / "sessions"
        result3 = mod.run(repo3, report3, sessions3, 45, now, None)
        assert_true(
            "3. relatorio ausente SEM sessao correlacionada -> indeterminado (1o tick), nunca fabricacao",
            result3["status"] == "indeterminate",
        )

        # ------------------------------------------------------------------
        # 4. Relatorio com mtime FORA da janela do tick -> fabrication_suspected
        # ------------------------------------------------------------------
        repo4 = td / "repo4"
        report4 = repo4 / "data" / "continuo" / "last-tick-report.md"
        sessions4 = repo4 / "data" / "sessions"
        _write_session(sessions4, "tick-d", now - timedelta(minutes=10), now)
        old_mtime = now - timedelta(hours=5)  # bem fora da janela de 45min
        _write_report(report4, "## Tick antigo\n### Trabalhado\nnada.\n", mtime=old_mtime)
        result4 = mod.run(repo4, report4, sessions4, 45, now, None)
        assert_true(
            "4. relatorio com mtime fora da janela (obsoleto) -> fabrication_suspected",
            result4["status"] == "fabrication_suspected",
        )

        # ------------------------------------------------------------------
        # 4b. Relatorio com mtime POSTERIOR ao fim da janela -> indeterminado,
        # NUNCA fabricacao presumida (achado #7641: mtime mais novo que a
        # janela so pode vir de escrita real e posterior — nao de arquivo
        # obsoleto reaproveitado, que preservaria mtime antigo. E o padrao
        # exato da sessao 604fba55-476a-41a1-9432-1194484f4f31: um tick REAL
        # e mais recente escreveu o relatorio de verdade, so nao registrou
        # sessao propria em data/sessions/ pra ser correlacionado).
        # ------------------------------------------------------------------
        repo4b = td / "repo4b"
        report4b = repo4b / "data" / "continuo" / "last-tick-report.md"
        sessions4b = repo4b / "data" / "sessions"
        _write_session(sessions4b, "tick-d2", now - timedelta(hours=7), now - timedelta(hours=6))
        newer_mtime = now  # bem depois do fim da janela (heartbeat + buffer)
        _write_report(report4b, "## Tick mais novo que a sessao correlacionada\n### Trabalhado\nnada.\n",
                       mtime=newer_mtime)
        result4b = mod.run(repo4b, report4b, sessions4b, 45, now, None)
        assert_true(
            "4b. relatorio com mtime POSTERIOR a janela -> NUNCA fabrication_suspected (#7641)",
            result4b["status"] != "fabrication_suspected",
        )
        assert_true(
            "4b. status agregado fica indeterminado (cannot-verify), nao 'ok' silencioso",
            result4b["status"] == "indeterminate",
        )
        assert_true(
            "4b. checagem report_freshness fica indeterminada, distinguindo do caso 4 (mtime anterior)",
            any(c["check"] == "report_freshness" and c["status"] == "indeterminate"
                for c in result4b["checks"]),
        )

        # ------------------------------------------------------------------
        # 5. Contagem alegada diverge muito do real -> fabrication_suspected
        # ------------------------------------------------------------------
        repo5 = td / "repo5"
        report5 = repo5 / "data" / "continuo" / "last-tick-report.md"
        sessions5 = repo5 / "data" / "sessions"
        _write_session(sessions5, "tick-e", now - timedelta(minutes=5), now)
        _write_report(
            report5,
            "## Tick 12:00\n### Trabalhado\nclassificacao executada com n=4 issues\n",
            mtime=now,
        )
        open_issues_41 = _open_issues_file(td, 41)
        result5 = mod.run(repo5, report5, sessions5, 45, now, open_issues_41)
        assert_true(
            "5. alegado n=4 vs real=41 -> fabrication_suspected (mesmo padrao do #7537)",
            result5["status"] == "fabrication_suspected",
        )
        assert_true(
            "5. checagem classification_count aponta a divergencia",
            any(c["check"] == "classification_count" and c["status"] == "fabrication_suspected"
                for c in result5["checks"]),
        )

        # ------------------------------------------------------------------
        # 6. Contagem alegada dentro da tolerancia -> ok
        # ------------------------------------------------------------------
        repo6 = td / "repo6"
        report6 = repo6 / "data" / "continuo" / "last-tick-report.md"
        sessions6 = repo6 / "data" / "sessions"
        _write_session(sessions6, "tick-f", now - timedelta(minutes=5), now)
        _write_report(
            report6,
            "## Tick 12:00\n### Trabalhado\nclassificacao executada com n=40 issues\n",
            mtime=now,
        )
        result6 = mod.run(repo6, report6, sessions6, 45, now, open_issues_41)
        assert_true(
            "6. alegado n=40 vs real=41 (dentro da tolerancia) -> nao fabricacao",
            result6["status"] != "fabrication_suspected",
        )

        # ------------------------------------------------------------------
        # 7. Relatorio sem alegacao numerica reconhecivel -> not_applicable
        # ------------------------------------------------------------------
        cc = mod.check_classification_count("## Tick 12:00\n### Trabalhado\nnada de especial.\n", 41)
        assert_true(
            "7. relatorio sem alegacao numerica -> classification_count not_applicable",
            cc["status"] == "not_applicable",
        )

        # ------------------------------------------------------------------
        # 8. Issue citada como reivindicada mas ausente do session-registry
        # ------------------------------------------------------------------
        repo8 = td / "repo8"
        sessions8 = repo8 / "data" / "sessions"
        _write_session(sessions8, "tick-g", now - timedelta(minutes=5), now, claimed_issues=[100])
        report_text_8 = "## Tick 12:00\n### Trabalhado\nreivindicada #200, ainda em andamento.\n"
        claimed8 = mod.all_continuo_claimed_issues(sessions8)
        check8 = mod.check_claimed_issues(report_text_8, claimed8, sessions8.is_dir())
        assert_true(
            "8. issue #200 citada como reivindicada mas SO #100 esta no registro -> fabrication_suspected",
            check8["status"] == "fabrication_suspected",
        )

        # ------------------------------------------------------------------
        # 9. Issue citada como reivindicada E presente no registro -> ok
        # ------------------------------------------------------------------
        report_text_9 = "## Tick 12:00\n### Trabalhado\nreivindicada #100, ainda em andamento.\n"
        check9 = mod.check_claimed_issues(report_text_9, claimed8, sessions8.is_dir())
        assert_true(
            "9. issue #100 citada como reivindicada E presente no registro -> ok",
            check9["status"] == "ok",
        )

        # ------------------------------------------------------------------
        # 10. Relatorio sem mencao de reivindicacao/claim -> not_applicable
        # ------------------------------------------------------------------
        check10 = mod.check_claimed_issues(
            "## Tick 12:00\n### Trabalhado\nlinha qualquer sem #refs de claim.\n",
            claimed8, sessions8.is_dir(),
        )
        assert_true(
            "10. relatorio sem mencao de reivindicacao/claim -> not_applicable",
            check10["status"] == "not_applicable",
        )

        # ------------------------------------------------------------------
        # 10b. Relatorio ANTIGO mas SEM sessao continuo recente pra ancorar
        # -> indeterminado, NUNCA fabricacao (job pausado de proposito e
        # relatorio antigo legitimo sao indistinguiveis sem uma sessao pra
        # comparar contra).
        # ------------------------------------------------------------------
        repo10b = td / "repo10b"
        report10b = repo10b / "data" / "continuo" / "last-tick-report.md"
        sessions10b = repo10b / "data" / "sessions"  # sem sessao nenhuma
        _write_report(report10b, "## Tick de ha dias\n### Trabalhado\nnada.\n",
                       mtime=now - timedelta(days=3))
        result10b = mod.run(repo10b, report10b, sessions10b, 45, now, None)
        assert_true(
            "10b. relatorio antigo SEM sessao pra ancorar -> indeterminado, nunca fabricacao",
            result10b["status"] != "fabrication_suspected",
        )
        assert_true(
            "10b. checagem report_freshness fica indeterminada (nao 'ok' nem fabricacao)",
            any(c["check"] == "report_freshness" and c["status"] == "indeterminate"
                for c in result10b["checks"]),
        )

        # ------------------------------------------------------------------
        # 11. main() exit codes agregados via subprocesso real
        # ------------------------------------------------------------------
        def _run_main(args: list[str]) -> tuple[int, str]:
            r = subprocess.run(
                [sys.executable, str(MODULE_PATH)] + args,
                capture_output=True, text=True, timeout=30,
            )
            return r.returncode, r.stdout + r.stderr

        # exit 0: tick honesto
        code, _ = _run_main([
            "--repo", str(repo1), "--report-path", str(report1),
            "--sessions-dir", str(sessions1), "--tick-window-min", "45",
            "--now-iso", _iso(now),
        ])
        assert_true("11. main() exit 0 para tick honesto", code == 0)

        # exit 2: fabricacao (relatorio ausente + sessao recente)
        code, out = _run_main([
            "--repo", str(repo2), "--report-path", str(report2),
            "--sessions-dir", str(sessions2), "--tick-window-min", "45",
            "--now-iso", _iso(now), "--json",
        ])
        assert_true("11. main() exit 2 para fabricacao detectada", code == 2)
        parsed = json.loads(out)
        assert_true("11. main() --json emite status=fabrication_suspected",
                    parsed.get("status") == "fabrication_suspected")

        # exit 3: indeterminado (1o tick, sem sessao)
        code, out = _run_main([
            "--repo", str(repo3), "--report-path", str(report3),
            "--sessions-dir", str(sessions3), "--tick-window-min", "45",
            "--now-iso", _iso(now), "--json",
        ])
        assert_true("11. main() exit 3 para indeterminado (1o tick)", code == 3)
        parsed = json.loads(out)
        assert_true("11. main() --json emite status=indeterminate",
                    parsed.get("status") == "indeterminate")

        # ------------------------------------------------------------------
        # 12. #7996 — issue citada como reivindicada E liberada na MESMA
        # linha ("Claim liberada") mas ausente do session-registry ->
        # indeterminate (cannot-verify), NUNCA fabrication_suspected.
        # unclaimIssue apaga claimed_issues/claimed_issues_at por design
        # (#6453) — ausencia de uma claim liberada e o comportamento
        # esperado, nao evidencia de fabricacao. Reproduz o relatorio real
        # do tick 09/09/2026 20:00 (#7827 fechada, #7808/#5910 mergeados —
        # confirmados via `gh`, nao fabricados).
        # ------------------------------------------------------------------
        report_text_12 = (
            "## Tick 20:00\n### Trabalhado\n"
            "- #7807: a tentativa revelou que o trabalho ja estava coberto por #7808. "
            "A PR #7827 foi fechada com explicacao e a issue permanece aberta. Claim liberada.\n"
        )
        claimed_none = mod.all_continuo_claimed_issues(sessions8)  # reusa dir do teste 8 (so #100)
        check12 = mod.check_claimed_issues(report_text_12, claimed_none, sessions8.is_dir())
        assert_true(
            "12. claim liberado no mesmo tick, ausente do registro -> indeterminate (nao fabricacao)",
            check12["status"] == "indeterminate",
        )

        # ------------------------------------------------------------------
        # 12b. Issue citada como reivindicada SEM sinal de liberacao e
        # ausente do registro -> continua fabrication_suspected (o caso
        # real do #7537 nao pode regredir).
        # ------------------------------------------------------------------
        report_text_12b = "## Tick 12:00\n### Trabalhado\nreivindicada #300, ainda em andamento.\n"
        check12b = mod.check_claimed_issues(report_text_12b, claimed_none, sessions8.is_dir())
        assert_true(
            "12b. claim SEM liberacao e ausente do registro -> continua fabrication_suspected",
            check12b["status"] == "fabrication_suspected",
        )

        # ------------------------------------------------------------------
        # 12c. Mistura: uma issue liberada (ausente, esperado) e outra
        # SEM liberacao (ausente, suspeita) no mesmo relatorio -> o caso
        # SEM liberacao domina o veredito (fabrication_suspected).
        # ------------------------------------------------------------------
        report_text_12c = (
            "## Tick 20:00\n### Trabalhado\n"
            "- #7807: Claim liberada.\n"
            "- reivindicada #300, ainda em andamento.\n"
        )
        check12c = mod.check_claimed_issues(report_text_12c, claimed_none, sessions8.is_dir())
        assert_true(
            "12c. mistura liberada+retida ausentes -> fabrication_suspected domina",
            check12c["status"] == "fabrication_suspected",
        )

        if FAILED:
            print(f"\n{FAILED} assercao(es) falharam")
            return 1
        print("\nTODOS OS TESTES PASSARAM")
        return 0


if __name__ == "__main__":
    sys.exit(main())
