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
  4. #8378/#7641 REGRESSÃO — sessao continuo recente de OUTRO tick (janela
     NAO se sobrepoe a do relatorio) + relatorio antigo -> indeterminate,
     NUNCA fabrication_suspected. O detector antigo (`latest_continuo_session`)
     pegava essa sessao de outro tick em silencio e correlacionava errado.
  4b. Contraponto do 4: sessao que SE sobrepoe a janela do relatorio +
     relatorio fresco -> ok (a correlacao por sobreposição acerta o caso
     honesto).
  4c. `correlate_continuo_session` em isolation: devolve a sessao cuja
     janela se sobrepoe; ignora sessao de outro tick (None). E a primitiva
     que substitui `latest_continuo_session` no `run()`.
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
  14. #8521 — issue reivindicada ausente do session-registry (endSession
      apagou o registro inteiro) MAS com evento "ended" REAL
      (data/session-lifecycle.jsonl) sobrepondo a janela -> indeterminate,
      nunca fabrication_suspected (reproduz #8515). 14b: mesmo relatorio
      SEM esse evento -> continua fabrication_suspected (#7537 nao
      regride). 14c: evento de OUTRO tick nao correlaciona.
  15. Regressão end-to-end (`run()`) do relatório real do tick de 15:36
      UTC de 20/09/2026 que motivou o #8521 — 3 issues citadas em
      contexto de negação ("não foram reivindicadas") + 1 claim real com
      PR aberta cuja sessão já terminou -> overall nunca
      fabrication_suspected.
  16. `test_regressao_8521_negacao_nao_e_claim` — "não"/"nunca foi(ram)
      reivindicada(s)" não é lido como claim; claim real na linha seguinte
      não é afetado.

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


def _write_lifecycle_event(
    lifecycle_log_path: Path, session_id: str, started: datetime, heartbeat: datetime,
    kind: str = "continuo", event: str = "ended",
) -> None:
    """#8521: simula uma linha de `data/session-lifecycle.jsonl` como
    `endSession` (`scripts/lib/session-registry.ts`) escreve — append-only,
    sobrevive à remoção do registro `data/sessions/continuo-*.json`."""
    lifecycle_log_path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "event": event,
        "kind": kind,
        "machineTag": "300",
        "sessionId": session_id,
        "ts": _iso(heartbeat),
        "startedAt": _iso(started),
        "lastHeartbeat": _iso(heartbeat),
    }
    with lifecycle_log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def _open_issues_file(td: Path, count: int) -> Path:
    p = td / "open-issues.json"
    p.write_text(json.dumps([{"number": i} for i in range(1, count + 1)]), encoding="utf-8")
    return p


# ------------------------------------------------------------------
# 13. Regressão #8377 (2026-09-18) — falso positivo de fabricação
# pelo detector quando a linha de relatório mescla: (a) claim de outro
# ator ("reivindicada pelo Overnight"), (b) PR #NNNN (não issue),
# (c) cobertura (#7807 coberto por #7808) e (d) claim próprio
# ("reivindicada #8356 pelo mesmo tick" — deve ser reconhecido como
# próprio, NÃO excluído pelo filtro de "outro ator"). Nenhum desses
# casos pode ser marcado como fabrication_suspected por falso
# reconhecimento de claim — a correção é o filtro de cláusula + PR +
# outros + cobertura + proximidade no extract_claimed_issue_refs.
# ------------------------------------------------------------------

def test_regressao_8377_falsos_positivos_claim():
    mod = _load_module()
    # Linha que provocava 12 falsos positivos no #8377
    linha = (
        "Após #8356, não havia outra unidade primária livre: #8355 está "
        "reivindicada pelo Overnight; #8354 tem colisão documentada com a PR #8358; "
        "#8353/#8352/#8351/#8350/#8349/#8344/#8336 foram barradas pelo gate de coerência; "
        "#8341 foi fechada"
    )
    refs = mod.extract_claimed_issue_refs(linha)
    # Nenhum claim PRÓPRIO nesta linha (todos são referência narrativa);
    # #8356 aparece em contexto de "Após #8356" (não claim) — não deve entrar.
    assert 8356 not in refs, f"8356 indevidamente capturado: {refs}"
    assert 8355 not in refs, f"8355 (outro ator) indevido: {refs}"
    assert 8358 not in refs, f"8358 (PR) indevido: {refs}"
    # Cobertura não é claim — não deve gerar entrada
    # Se fosse claim próprio, seria reconhecido; aqui não é.
    # Regra: claim próprio preservado — "reivindicada pelo mesmo tick" é próprio
    linha_proprio = "#8356 está reivindicada pelo mesmo tick; Claim liberada"
    refs_proprio = mod.extract_claimed_issue_refs(linha_proprio)
    assert 8356 in refs_proprio, f"claim próprio #8356 deve ser preservado: {refs_proprio}"
    print("regressão #8377: falsos positivos eliminados + claim próprio preservado — OK")


# Regressão real #7807 coberto por #7808 (#7996): cobertura não é claim
def test_regressao_7807_coberto_por_7808():
    mod = _load_module()
    linha = "- #7807: o trabalho já estava coberto por #7808. A PR #7827 foi fechada."
    refs = mod.extract_claimed_issue_refs(linha)
    assert 7807 not in refs, f"#7807 (coberto) indevidamente como claim: {refs}"
    assert 7808 not in refs, f"#7808 (cobertura) indevidamente como claim: {refs}"
    print("regressão #7807 coberto por #7808: cobertura excluída — OK")


# Regressão da correção de #8377 (achado na revisão da PR #8381, 1ª
# objeção): cada regex de exclusão captura SÓ o #NNNN que a justificou, e
# é aplicada a esse número. Antes, o conjunto de todos os #NNNN
# capturados era aplicado a cada ref do segmento, então um claim PRÓPRIO
# no mesmo segmento que uma cobertura de outro issue era derrubado junto
# ("#7807 reivindicada, trabalho coberto por #7808" -> #7807 sumia).
def test_regressao_exclusao_por_ref_nao_bloqueia_claim_proprio():
    mod = _load_module()
    linha = "#7807 foi reivindicada ontem, mas o trabalho estava coberto por #7808."
    refs = mod.extract_claimed_issue_refs(linha)
    assert 7807 in refs, f"claim próprio #7807 derrubado pela cobertura de #7808: {refs}"
    assert 7808 not in refs, f"#7808 (cobertura) indevidamente como claim: {refs}"
    print("regressão: exclusão por ref preserva claim próprio no mesmo segmento — OK")


# Revisão da PR #8381 — FALSOS NEGATIVOS dos filtros: fabricação real não
# pode virar not_applicable por lista longa, `;`, título longo ou
# "Reivindiquei".
def test_adversarial_falsos_negativos_extraem_todos():
    mod = _load_module()
    casos = [
        ("Issues reivindicadas neste tick: #8301, #8302, #8303, #8304, #8305, #8306.",
         {8301, 8302, 8303, 8304, 8305, 8306}),
        ("Claim de #8301, #8302, #8303, #8304, #8305 e #8306 registrada.",
         {8301, 8302, 8303, 8304, 8305, 8306}),
        ("- #8400 corrigir o parser de datas do scorer quando o feed vem sem timezone (reivindicada).",
         {8400}),
        ("Claims: #100; #101; #102", {100, 101, 102}),
        ("- #500: descrição da unidade. Claim registrada.", {500}),
        ("Reivindiquei #8301", {8301}),
        ("Reivindiquei #8301 e #8302", {8301, 8302}),
    ]
    for texto, esperado in casos:
        got = set(mod.extract_claimed_issue_refs(texto))
        assert got == esperado, f"{texto!r}: esperado {esperado}, veio {got}"
    print("adversarial: lista longa / ; / titulo longo / reivindiquei — OK")


def test_controle_claim_proprio_ausente_do_registro_e_fabricacao():
    mod = _load_module()
    texto = "Issues reivindicadas neste tick: #8301, #8302, #8303, #8304, #8305, #8306."
    check = mod.check_claimed_issues(texto, {8301, 8302, 8303}, True)
    assert check["status"] == "fabrication_suspected", check
    print("controle: claim proprio ausente do registro -> fabrication_suspected — OK")


def test_regressao_8463_falsos_positivos_lista_atribuida_outro_ator():
    """#8463: lista de refs antes de 'reivindicada pelo Overnight' só capturava
    último #N; agora captura todos (ex: #8355/#8354). Não deve incluir item
    que abre a linha se não há claim próprio com liberação no mesmo tick."""
    mod = _load_module()
    # (P3) #8355 ficou bloqueada porque #8354 foi reivindicada pelo Overnight
    linha = "#8355 ficou bloqueada porque #8354 foi reivindicada pelo Overnight"
    refs = mod.extract_claimed_issue_refs(linha)
    assert 8354 not in refs, f"#8354 (outro ator) indevido como claim: {refs}"
    # #8355 abre a linha e está bloqueada por outro; sem claim próprio -> não entra
    assert 8355 not in refs, f"#8355 (item que abre linha) indevido: {refs}"
    # Caso com lista completa de outro: "#8355/#8354 reivindicadas pelo Overnight"
    linha2 = "#8355/#8354 reivindicadas pelo Overnight"
    refs2 = mod.extract_claimed_issue_refs(linha2)
    # Ambos são excluídos pelo _OTHERS_CLAIM (outro ator) — nenhum claim próprio
    for n in (8355, 8354):
        assert n not in refs2, f"#{{n}} (lista outro ator) indevido: {{refs2}}"
    # Caso #7807 / #7808 / #7809 (lista abre + item reivindicado)
    linha3 = "#7807 coberto por #7808, #7809 reivindicada pelo Overnight"
    refs3 = mod.extract_claimed_issue_refs(linha3)
    # #7808/#7809 são outros (reivindicados pelo Overnight); #7807 é cobertura, não claim
    assert 7808 not in refs3, f"#7808 indevido: {refs3}"
    assert 7809 not in refs3, f"#7809 indevido: {refs3}"
    assert 7807 not in refs3, f"#7807 (cobertura) indevido: {refs3}"
    print("regressão #8463: lista atribuída a outro ator + item que abre linha -> OK")


def test_regressao_8521_negacao_nao_e_claim():
    """#8521: relatório real do tick 15:36 UTC de 20/09/2026 — "#8518, #8517
    e #8516 foram lidas frescas via REST (...) e barradas pelo
    check-continuo-coherence (...); não foram reivindicadas." O detector
    antigo linkava a lista de refs do segmento anterior ao keyword
    "reivindicadas" em "não foram reivindicadas" (mesmo mecanismo que
    reconhece "- #500: descrição. Claim registrada.") e produzia 3 falsos
    fabrication_suspected para issues explicitamente NÃO reivindicadas."""
    mod = _load_module()
    linha = (
        "#8518, #8517 e #8516 foram lidas frescas via REST (o caminho gh "
        "issue view --comments falhou pelo mesmo motivo) e barradas pelo "
        "check-continuo-coherence por sobreposição com paths/módulos "
        "tocados em PRs ou merges recentes; não foram reivindicadas."
    )
    refs = mod.extract_claimed_issue_refs(linha)
    for n in (8516, 8517, 8518):
        assert n not in refs, f"#{n} (negado 'não foram reivindicadas') indevido: {refs}"
    # Variante "nunca foi reivindicada" (singular) — mesmo marcador de negação.
    linha_nunca = "- #9001: investigada, mas nunca foi reivindicada."
    refs_nunca = mod.extract_claimed_issue_refs(linha_nunca)
    assert 9001 not in refs_nunca, f"#9001 ('nunca foi reivindicada') indevido: {refs_nunca}"
    # Controle: claim genuíno na MESMA janela textual do relatório real
    # (linha seguinte, #8515) continua reconhecido — a negação não pode
    # apagar claims legítimos em outras linhas/segmentos.
    linha_claim_real = (
        "#8515 foi lida fresca via REST, admitida pelo coherence gate e "
        "reivindicada com o session-id deste tick."
    )
    refs_real = mod.extract_claimed_issue_refs(linha_claim_real)
    assert 8515 in refs_real, f"claim real #8515 nao deveria ser afetado pela negacao: {refs_real}"
    print("regressão #8521: 'não/nunca foi(ram) reivindicada(s)' não vira claim — OK")


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
        # 4. #7641 REGRESSÃO — o defeito que esta correção encerra: tick com
        #    relatório ANTIGO e uma sessão `continuo` RECENTE que é de OUTRO
        #    tick (não sobreõe a janela do relatório). O detector ANTIGO
        #    (`latest_continuo_session`) pegava essa sessão de outro tick e
        #    trataria o relatório obsoleto como se fosse deste tick ->
        #    fabrication_suspected. Com a correlação por SOPOSIÇÃO DE
        #    JANELA (`correlate_continuo_session`), a sessão de outro tick
        #    não conta, e o relatório antigo sozinho é indistinguível de
        #    "job pausado de propósito" -> indeterminate, NUNCA fabricacao.
        #    É o caso real do #7641 (tick sem registro proprio, sessao
        #    correlacionada errada em silencio).
        # ------------------------------------------------------------------
        repo4 = td / "repo4"
        report4 = repo4 / "data" / "continuo" / "last-tick-report.md"
        sessions4 = repo4 / "data" / "sessions"
        old_mtime = now - timedelta(hours=5)  # relatorio de um tick anterior
        _write_report(report4, "## Tick de ha 5h\n### Trabalhado\nnada.\n", mtime=old_mtime)
        # sessao continuo recente, mas de OUTRO tick: janela [now-10, now]
        # NAO se sobrepoe a [old_mtime-45, old_mtime+45]
        _write_session(sessions4, "tick-outro", now - timedelta(minutes=10), now)
        result4 = mod.run(repo4, report4, sessions4, 45, now, None)
        assert_true(
            "4. sessao de OUTRO tick (nao sobreõe a janela) + relatorio antigo "
            "-> NUNCA fabrication_suspected (#7641)",
            result4["status"] != "fabrication_suspected",
        )
        assert_true(
            "4. status agregado fica indeterminate (cannot-verify), nao 'ok' silencioso",
            result4["status"] == "indeterminate",
        )
        assert_true(
            "4. correlacao NAO escolheu a sessao de outro tick (session_correlated e None)",
            result4["session_correlated"] is None,
        )
        assert_true(
            "4. checagem report_freshness fica indeterminada (relatorio antigo sem sessao correlacionada)",
            any(c["check"] == "report_freshness" and c["status"] == "indeterminate"
                for c in result4["checks"]),
        )

        # ------------------------------------------------------------------
        # 4b. Contraponto do 4: quando a sessao É de fato do tick (janela
        #     se sobrepõe à do relatório) e o relatório existe, o frescor
        #     é ok — a correlação por sobreposição acerta o caso honesto.
        #     Sem isto, o 4 sozinho daria a impressão de que qualquer
        #     relatorio fresco vira indeterminate.
        # ------------------------------------------------------------------
        repo4b = td / "repo4b"
        report4b = repo4b / "data" / "continuo" / "last-tick-report.md"
        sessions4b = repo4b / "data" / "sessions"
        rep_mtime = now - timedelta(minutes=20)
        _write_report(report4b, "## Tick 12:00\n### Trabalhado\nnada.\n", mtime=rep_mtime)
        # sessao cuja janela se sobrepõe a [rep_mtime-45, rep_mtime+45]
        _write_session(sessions4b, "tick-mesmo", rep_mtime - timedelta(minutes=10),
                        rep_mtime + timedelta(minutes=5))
        result4b = mod.run(repo4b, report4b, sessions4b, 45, now, None)
        assert_true(
            "4b. sessao sobrepondo a janela do relatorio + relatorio fresco -> ok",
            result4b["status"] == "ok",
        )
        assert_true(
            "4b. sessao correlacionada e a do proprio tick (session_correlated)",
            result4b["session_correlated"] == "tick-mesmo",
        )

        # ------------------------------------------------------------------
        # 4c. `correlate_continuo_session` em isolation: puro, por
        #     sobreposição de janela. Sobreõe -> devolve a sessao; nao
        #     sobreõe (sessao de outro tick) -> None. É a primitiva que
        #     substitui `latest_continuo_session` no `run()` e o nucleo
        #     desta correção (#8378).
        # ------------------------------------------------------------------
        cs_ok = mod.correlate_continuo_session(
            sessions4b, rep_mtime - timedelta(minutes=45), rep_mtime + timedelta(minutes=45)
        )
        assert_true(
            "4c. correlate_continuo_session devolve a sessao que se sobrepoe",
            cs_ok is not None and cs_ok.get("sessionId") == "tick-mesmo",
        )
        cs_none = mod.correlate_continuo_session(
            sessions4, old_mtime - timedelta(minutes=45), old_mtime + timedelta(minutes=45)
        )
        assert_true(
            "4c. correlate_continuo_session ignora sessao de outro tick -> None",
            cs_none is None,
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
        # Texto REVISADO pós-#8377: a linha original do tick real
        # (#7807 coberto por #7808, PR #7827 fechada, "Claim liberada.")
        # não declara claim PRÓPRIO — todos os #NNNN são cobertura/PR, e
        # com os filtros de #8377 (cobertura + PR) nenhum sobrevive, o que
        # tornava o teste em `not_applicable` em vez de `indeterminate`.
        # A hipótese do #7996 (claim próprio declarado e liberado no mesmo
        # tick, ausente do registro por design do `unclaimIssue`) é
        # reproduzida com uma linha em que o #NNNN e o keyword de claim
        # estão no MESMO segmento e a liberação aparece no mesmos linha
        # (em outro segmento, separado por `;` — o caso que o avaliar por
        # segmento orfanearia).
        report_text_12 = (
            "## Tick 20:00\n### Trabalhado\n"
            "- #7807: a issue foi reivindicada e o trabalho ja estava coberto por #7808; "
            "a PR #7827 foi fechada com explicacao; a claim foi liberada.\n"
        )
        claimed_from_test8 = mod.all_continuo_claimed_issues(sessions8)  # {100} -- reusa dir do teste 8; NAO vazio (review PR #8014, achado 4)
        check12 = mod.check_claimed_issues(report_text_12, claimed_from_test8, sessions8.is_dir())
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
        check12b = mod.check_claimed_issues(report_text_12b, claimed_from_test8, sessions8.is_dir())
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
        check12c = mod.check_claimed_issues(report_text_12c, claimed_from_test8, sessions8.is_dir())
        assert_true(
            "12c. mistura liberada+retida ausentes -> fabrication_suspected domina",
            check12c["status"] == "fabrication_suspected",
        )

        # ------------------------------------------------------------------
        # 12d. Review da PR #8014, achado 1 — "_RELEASE_SIGNAL" nao pode
        # casar como SUBSTRING dentro de "deliberou"/"deliberado". Uma
        # linha que usa esse verbo (bem comum em PT-BR) MAS nao libera
        # claim nenhum precisa continuar fabrication_suspected quando a
        # issue citada esta ausente do registro — sem o \b na regex, o
        # "deliberou" mascararia a fabricacao real como indeterminate,
        # exatamente na direcao errada pro proposito deste detector.
        # ------------------------------------------------------------------
        report_text_12d = (
            "## Tick 20:00\n### Trabalhado\n"
            "- o coordenador deliberou reivindicar #400 e seguiu em frente.\n"
        )
        check12d = mod.check_claimed_issues(report_text_12d, claimed_from_test8, sessions8.is_dir())
        assert_true(
            "12d. 'deliberou' (verbo comum) NAO e falso sinal de liberacao -> continua fabrication_suspected",
            check12d["status"] == "fabrication_suspected",
        )

        # ------------------------------------------------------------------
        # 14. #8521 — issue citada como reivindicada, ausente do
        # session-registry (endSession já apagou o registro inteiro), MAS
        # um evento "ended" REAL (data/session-lifecycle.jsonl) sobrepõe a
        # janela do tick -> indeterminate (cannot-verify), NUNCA
        # fabrication_suspected. Reproduz #8515: reivindicada, PR #8520
        # aberta de verdade, claim nunca liberada (trabalho em andamento),
        # sessão terminou o protocolo e seu registro sumiu.
        # ------------------------------------------------------------------
        repo14 = td / "repo14"
        lifecycle14 = repo14 / "data" / "session-lifecycle.jsonl"
        tick_start14 = now - timedelta(minutes=20)
        tick_end14 = now - timedelta(minutes=1)
        _write_lifecycle_event(lifecycle14, "hermes-cron-20260920T151606Z", tick_start14, tick_end14)
        report_text_14 = (
            "## Tick 15:36\n### Trabalhado\n"
            "#8515 foi lida fresca via REST, admitida pelo coherence gate e "
            "reivindicada com o session-id deste tick. Delegação implementou "
            "o fix e abriu a PR #8520; verificação independente confirmou "
            "OPEN, MERGEABLE. Não mergeei.\n"
        )
        claimed_empty: set[int] = set()
        ended14 = mod.ended_continuo_session_in_window(lifecycle14, tick_start14 - timedelta(minutes=45), tick_end14 + timedelta(minutes=45))
        assert_true("14. ended_continuo_session_in_window acha o evento na janela", ended14 is not None)
        check14 = mod.check_claimed_issues(
            report_text_14, claimed_empty, True, ended_session_in_window=True,
        )
        assert_true(
            "14. #8515 ausente do registro MAS com sessao 'ended' real na janela -> indeterminate",
            check14["status"] == "indeterminate",
        )

        # ------------------------------------------------------------------
        # 14b. Controle: MESMO relatório do teste 14, mas SEM evento
        # "ended" correlacionado (default `ended_session_in_window=False`,
        # retrocompatível) -> continua fabrication_suspected. O #7537
        # original não pode regredir por esta mudança.
        # ------------------------------------------------------------------
        check14b = mod.check_claimed_issues(report_text_14, claimed_empty, True)
        assert_true(
            "14b. mesmo relatorio SEM sessao 'ended' correlacionada -> continua fabrication_suspected",
            check14b["status"] == "fabrication_suspected",
        )

        # ------------------------------------------------------------------
        # 14c. `ended_continuo_session_in_window` não correlaciona um
        # evento de OUTRO tick (janela não se sobrepõe) — mesma disciplina
        # de `correlate_continuo_session` (#7641/#8378).
        # ------------------------------------------------------------------
        outro_tick_start = now - timedelta(hours=5)
        outro_tick_end = now - timedelta(hours=4, minutes=40)
        ended14c = mod.ended_continuo_session_in_window(lifecycle14, outro_tick_start, outro_tick_end)
        assert_true("14c. evento de OUTRO tick nao correlaciona -> None", ended14c is None)

        # ------------------------------------------------------------------
        # 15. Regressão end-to-end via `run()` — relatório real (trimmed)
        # do tick de 15:36 UTC de 20/09/2026 que motivou o #8521: 3 issues
        # citadas em contexto de negação ("não foram reivindicadas") + 1
        # claim real (#8515, com PR aberta) cuja sessão já terminou o
        # protocolo. Overall NÃO pode ser fabrication_suspected.
        # ------------------------------------------------------------------
        repo15 = td / "repo15"
        report15 = repo15 / "data" / "continuo" / "last-tick-report.md"
        sessions15 = repo15 / "data" / "sessions"  # existe mas vazio -> endSession já rodou
        sessions15.mkdir(parents=True, exist_ok=True)
        lifecycle15 = repo15 / "data" / "session-lifecycle.jsonl"
        report_mtime15 = now
        tick_start15 = report_mtime15 - timedelta(minutes=20)
        tick_end15 = report_mtime15 - timedelta(minutes=1)
        _write_lifecycle_event(lifecycle15, "hermes-cron-20260920T151606Z", tick_start15, tick_end15)
        report_text_full15 = (
            "## Tick 15:36 UTC\n### Trabalhado\n"
            "- Classificação determinística final: 62 issues abertas — 5 overnight, "
            "22 fora-de-rodada, 17 bloqueada, 15 agendada, 2 epica e 1 develop.\n"
            "- #8518, #8517 e #8516 foram lidas frescas via REST (o caminho gh issue "
            "view --comments falhou pelo mesmo motivo) e barradas pelo "
            "check-continuo-coherence por sobreposição com paths/módulos tocados em "
            "PRs ou merges recentes; não foram reivindicadas.\n"
            "- #8515 foi lida fresca via REST, admitida pelo coherence gate e "
            "reivindicada com o session-id deste tick. Delegação implementou o fix e "
            "abriu a PR #8520; verificação independente confirmou OPEN, MERGEABLE. "
            "Não mergeei.\n"
            "- O registro do tick foi encerrado com session-registry.ts end --kind "
            "continuo --session-id hermes-cron-20260920T151606Z.\n"
        )
        _write_report(report15, report_text_full15, mtime=report_mtime15)
        open_issues_62 = _open_issues_file(td, 62)
        result15 = mod.run(repo15, report15, sessions15, 45, now, open_issues_62, lifecycle_log_path=lifecycle15)
        assert_true(
            "15. regressão #8521 end-to-end: overall NUNCA fabrication_suspected",
            result15["status"] != "fabrication_suspected",
        )
        claimed_check15 = next(c for c in result15["checks"] if c["check"] == "claimed_issues")
        assert_true(
            "15. checagem claimed_issues fica indeterminate (nao ok nem fabricacao)",
            claimed_check15["status"] == "indeterminate",
        )

        # ------------------------------------------------------------------
        # 13. Regressão #8377 (falsos positivos de claim) + #7996
        # (cobertura não é claim) — funções autônomas que não eram
        # chamadas pelo runner (review da PR #8381, 3ª objeção: o teste
        # de regressão prometia verificar claim-próprio/cobertura e não
        # rodava). Agora executadas aqui, como parte da suíte.
        # ------------------------------------------------------------------
        test_regressao_8377_falsos_positivos_claim()
        test_regressao_7807_coberto_por_7808()
        test_regressao_exclusao_por_ref_nao_bloqueia_claim_proprio()
        test_adversarial_falsos_negativos_extraem_todos()
        test_controle_claim_proprio_ausente_do_registro_e_fabricacao()
        test_regressao_8463_falsos_positivos_lista_atribuida_outro_ator()
        test_regressao_8521_negacao_nao_e_claim()

        if FAILED:
            print(f"\n{FAILED} assercao(es) falharam")
            return 1
        print("\nTODOS OS TESTES PASSARAM")
        return 0


if __name__ == "__main__":
    sys.exit(main())
