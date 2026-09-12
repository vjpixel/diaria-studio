#!/usr/bin/env python3
"""Detecção EXTERNA de fabricação de conclusão pelo coordenador do contínuo
(qwen/modelo local, issue #7537).

Reproduzido ao vivo em 06/09/2026: rodando `hermes-diaria-continuo` com o
modelo local como coordenador (repo, `gh` e guards REAIS; só delegação e
escritas foram stubbadas), o modelo **relatou ter concluído passos que não
executou**. Saída literal dele:

    RELATÓRIO DE TICK SOBRESCRITO em `data/continuo/last-tick-report.md`
    conforme §5 do SKILL.md
    $ cat data/continuo/last-tick-report.md -> (conteúdo do relatório)

O arquivo nunca existiu — o modelo fabricou a conclusão e até simulou a
saída de um `cat` que nunca rodou. No mesmo tick, alegou "classificação
executada com n=4 issues" quando havia 41 issues abertas.

Este detector NÃO lê a saída conversacional do modelo (ela não é persistida
em lugar nenhum) — compara o ESTADO REAL ao fim do tick contra o que o
protocolo do SKILL.md (`hermes/skills/hermes-diaria-continuo/SKILL.md`)
exige que TODO tick produza, mesmo em parada antecipada (ver seção
"Relatório de tick" do SKILL.md: "Vale para TODO desfecho de tick, inclusive
parada antecipada"). Mesma família do #7528 (`detect-context-truncation.py`)
— detecção externa, sem depender do modelo cooperar.

Três checagens, cada uma opera sobre uma ponta de estado real e é
FAIL-SOFT/graduada — uma checagem indeterminada não derruba as outras:

  (a) RELATÓRIO — `data/continuo/last-tick-report.md` existe e tem mtime
      dentro da janela do tick mais recente. A janela é derivada do registro
      de sessão mais recente com `kind=continuo` em `data/sessions/` (campo
      `startedAt`/`lastHeartbeat`) quando disponível; sem sessão registrada,
      cai no argumento `--tick-window-min` (default 45min — mesmo valor que
      `watch-continuo-health.sh` checagem #3 já usa como "tick é de 30min +
      folga"). Sessão ATIVA e recente sem relatório fresco = suspeita forte
      (é exatamente o cenário reproduzido no #7537: sessão rodou, relatório
      nunca foi escrito).

      **mtime fora da janela se divide em DOIS casos com peso de evidência
      diferente (achado da investigação do #7641, 09/09/2026)** — mtime é o
      horário real da ÚLTIMA ESCRITA no disco, então ele nunca "recua"
      sozinho:
        - mtime ANTERIOR ao início da janela → relatório genuinamente
          obsoleto (reaproveitamento de arquivo de um tick anterior, sem
          nada de novo ter sido escrito nesta sessão) → `fabrication_suspected`,
          o mesmo sinal de sempre.
        - mtime POSTERIOR ao fim da janela → só pode vir de uma escrita
          REAL e mais recente (não de arquivo velho reaproveitado, que
          preservaria mtime antigo). A sessão #604fba55-476a-41a1-9432-
          1194484f4f31 citada no #7641 é exatamente este caso: o log do
          Hermes (`~/.hermes/logs/agent.log.1`, sessão
          `cron_5d791ef6fc2c_20260908_064744`) confirma um `write_file`
          real de 611 bytes às 09:51:26 UTC — no mesmo segundo do mtime do
          alarme — mas aquele tick nunca registrou
          `data/sessions/continuo-*.json` para si mesmo (provavelmente por
          ter terminado cedo após falhas de credencial no início). O
          relatório não era obsoleto — a sessão "mais recente" escolhida
          por `latest_continuo_session` simplesmente não era a que o
          escreveu. Sem outro registro de sessão pra correlacionar, não dá
          pra confirmar NEM descartar fabricação só pelo mtime →
          `indeterminate` (cannot-verify), nunca fabricação presumida por
          default nem "ok" silencioso.

  (b) CONTAGEM DE ISSUES — o relatório persistido pode conter uma alegação
      numérica em prosa (ex: "n=4 issues", "4 issues classificadas"); quando
      existe, compara contra a contagem REAL de `gh issue list --state open`
      (ou `--open-issues-json` para testes/offline). Divergência grande
      (fora de tolerância) = suspeita de fabricação. **Limitação documentada
      (a mesma issue já antecipa isto): o protocolo do contínuo hoje NÃO
      grava um contador estruturado em lugar nenhum — só existe como texto
      solto que pode ou não aparecer no relatório persistido.** Quando o
      relatório não contém nenhuma contagem explícita, esta checagem é
      `not_applicable`, nunca um "ok" silencioso — não inventamos um campo
      estruturado que a issue não pediu.

  (c) CLAIMS DECLARADOS — números de issue citados no relatório em contexto
      de "reivindicad_"/"claim" (`#NNNN`) são cruzados contra
      `claimed_issues` de QUALQUER registro `data/sessions/continuo-*.json`
      (session-registry, `scripts/lib/session-registry.ts`). Issue citada
      como reivindicada no relatório mas ausente de todo registro de sessão
      contínuo = suspeita de fabricação (o mecanismo de claim real nunca
      rodou para aquele número).

      **Exceção — claim liberado no mesmo tick (achado #7996, 12/09/2026):**
      `unclaimIssue` (`scripts/lib/session-registry.ts`) REMOVE a issue de
      `claimed_issues` (e sua entrada de `claimed_issues_at`) no momento da
      liberação — por design (#6453), pra uma re-reivindicação futura não
      herdar timestamp da claim anterior. Consequência não antecipada: um
      tick que reivindica uma issue, investiga, decide que não há trabalho
      (ou que já foi feito em outra PR) e libera a claim ANTES do relatório
      ser escrito produz `claimed_issues: []` no snapshot final — a mesma
      assinatura de uma claim que nunca aconteceu. Reproduzido ao vivo: tick
      de 09/09/2026 20:00 (session-registry correlacionado pelo detector,
      8e5413d2, era de OUTRO tick — mesma classe de "sessão errada" do
      #7641, ver checagem (a)) citou "#7807 ... Claim liberada" e "#5734 ...
      Claim liberada"; ambos os PRs/issues mencionados no relatório
      (#7827 fechada, #7808/#5910 mergeados) se confirmaram reais e
      corretos via `gh`, mas as 5 issues (#5734/#5910/#7807/#7808/#7827)
      saíram como `fabrication_suspected` porque nenhuma aparecia em
      `claimed_issues` de sessão viva. Por isso, uma linha de claim que
      também sinaliza liberação no MESMO tick ("liberad_") não conta como
      fabricação por ausência — ausência é o comportamento ESPERADO de
      `unclaimIssue`, não evidência. Vira `indeterminate` (cannot-verify),
      igual à checagem (a). Só falta de sinal de liberação + ausência do
      registro continua `fabrication_suspected` — é o caso real do #7537
      (nenhuma liberação foi mencionada, e a claim nunca rodou).

Uso:
    python3 detect-tick-claim-fabrication.py [--repo PATH]
        [--report-path PATH] [--sessions-dir PATH]
        [--tick-window-min N] [--now-iso ISO]
        [--open-issues-json PATH] [--json]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

# hermes/scripts/detect-tick-claim-fabrication.py -> parents[1] = repo root
# (scripts -> hermes -> repo). Diferente de detect-context-truncation.py
# (que lê estado do HOME do Hermes), este script lê estado DESTE repo
# (data/continuo, data/sessions) — repo root é o default correto.
DEFAULT_REPO = Path(__file__).resolve().parents[2]

REPORT_REL_PATH = Path("data") / "continuo" / "last-tick-report.md"
SESSIONS_REL_DIR = Path("data") / "sessions"

# Mesmo valor usado por watch-continuo-health.sh checagem #3 ("claims
# vazando de novo"): tick é de 30min, folga de 15min pra latência de
# escrita/sync do OneDrive.
DEFAULT_TICK_WINDOW_MIN = 45

# Tolerância relativa pra divergência de contagem de issues: uma alegação
# "perto" do real (ex: issue fechada/aberta entre a leitura e a escrita do
# relatório) não deveria disparar por 1-2 de diferença. Divergência grande
# (a demonstrada no #7537: alegou 4, real era 41) sempre dispara.
COUNT_TOLERANCE_ABS = 3
COUNT_TOLERANCE_FRAC = 0.15

# Regexes para extrair alegação de contagem em prosa. Best-effort — o
# protocolo não tem campo estruturado (ver limitação no docstring acima).
_COUNT_PATTERNS = [
    re.compile(r"\bn\s*=\s*(\d+)\s*issues?\b", re.IGNORECASE),
    re.compile(r"classifica\w*[^\d]{0,25}(\d+)\s*issues?\b", re.IGNORECASE),
    re.compile(r"(\d+)\s*issues?\s*(?:classificad\w*|analisad\w*)\b", re.IGNORECASE),
]

# Regex para issue refs (#NNNN) no relatório.
_ISSUE_REF = re.compile(r"#(\d+)\b")

# Palavras que sinalizam "isto é um claim declarado", usadas pra restringir
# a busca de #NNNN a linhas plausivelmente sobre reivindicação (evita casar
# qualquer menção solta de "#123" em qualquer contexto).
_CLAIM_KEYWORDS = re.compile(r"reivindic|claim", re.IGNORECASE)

# Sinaliza que a MESMA linha também documenta a liberação do claim
# ("Claim liberada", "liberou a claim") — ver docstring do módulo, seção
# (c), "Exceção — claim liberado no mesmo tick" (#7996). `unclaimIssue`
# apaga a entrada de `claimed_issues`/`claimed_issues_at` por design
# (#6453), então ausência no registro é o resultado ESPERADO de uma
# liberação real, não evidência de fabricação.
#
# `\b` (word boundary) na frente de cada alternativa é obrigatório — sem
# ele, "liberad"/"liberou" casam como SUBSTRING dentro de "deliberou"/
# "deliberado" (review da PR #8014, achado 1: confirmado ao vivo, os dois
# davam match sem o \b). Isso mordia na direção ERRADA pro propósito deste
# detector: uma linha legítima como "o coordenador deliberou não
# reivindicar #123" seria lida como liberação e mascararia uma fabricação
# real como `indeterminate`. `\b` antes de "liberad"/"liberou" não casa
# dentro de "deliberad_"/"deliberou" (sem fronteira de palavra entre "de"
# e "liberad_"/"liberou"), mas continua casando "Claim liberada"/"liberou
# a claim" normalmente (fronteira real antes de "liberad_"/"liberou").
_RELEASE_SIGNAL = re.compile(r"\bliberad|\bliberou", re.IGNORECASE)


def _run_gh_open_issue_count() -> int | None:
    """Conta issues abertas via `gh issue list`. None se `gh` falhar/ausente
    (fail-soft — o caller trata como indeterminado, nunca como zero)."""
    try:
        out = subprocess.run(
            ["gh", "issue", "list", "--state", "open", "--json", "number",
             "--limit", "500"],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode != 0:
            return None
        data = json.loads(out.stdout)
        return len(data)
    except Exception:
        return None


def resolve_open_issue_count(open_issues_json: Path | None) -> int | None:
    """Resolve a contagem REAL de issues abertas.

    `--open-issues-json` (testes/offline): arquivo com array de números OU
    de objetos `{"number": N}` (mesmo shape de `gh issue list --json number`).
    Sem o arquivo: chama `gh` de verdade.
    """
    if open_issues_json is not None:
        try:
            data = json.loads(open_issues_json.read_text(encoding="utf-8"))
            return len(data)
        except (OSError, json.JSONDecodeError):
            return None
    return _run_gh_open_issue_count()


def _parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def latest_continuo_session(sessions_dir: Path) -> dict | None:
    """Lê `data/sessions/continuo-*.json` e devolve o registro com
    `lastHeartbeat` (ou `startedAt`) mais recente. None se o diretório não
    existir ou nenhum registro `kind=continuo` for encontrado — fail-soft,
    o caller trata como "sem sessão pra correlacionar", não como erro."""
    if not sessions_dir.is_dir():
        return None
    best: dict | None = None
    best_ts: dt.datetime | None = None
    for f in sessions_dir.glob("continuo-*.json"):
        try:
            record = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if record.get("kind") != "continuo":
            continue
        ts = _parse_iso(record.get("lastHeartbeat")) or _parse_iso(record.get("startedAt"))
        if ts is None:
            continue
        if best_ts is None or ts > best_ts:
            best_ts = ts
            best = record
    return best


def all_continuo_claimed_issues(sessions_dir: Path) -> set[int]:
    """União de `claimed_issues` de TODOS os registros `continuo-*.json`
    (vivos ou não — um claim de um tick anterior ainda conta como "o
    mecanismo de claim rodou pra esse número" pro propósito desta
    checagem). Vazio (não None) quando o diretório não existe ou está
    vazio — distinto de "não consegui checar", tratado pelo caller via
    `sessions_dir.is_dir()` separadamente."""
    claimed: set[int] = set()
    if not sessions_dir.is_dir():
        return claimed
    for f in sessions_dir.glob("continuo-*.json"):
        try:
            record = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if record.get("kind") != "continuo":
            continue
        for n in record.get("claimed_issues") or []:
            try:
                claimed.add(int(n))
            except (TypeError, ValueError):
                pass
    return claimed


def extract_alleged_count(report_text: str) -> int | None:
    """Extrai a 1ª alegação numérica de contagem de issues do relatório.
    Best-effort (ver limitação no docstring do módulo) — None quando o
    relatório não contém nenhuma alegação reconhecível."""
    for pattern in _COUNT_PATTERNS:
        m = pattern.search(report_text)
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                continue
    return None


def extract_claimed_issue_refs(report_text: str) -> dict[int, bool]:
    """Extrai números de issue (#NNNN) citados em linhas que mencionam
    "reivindicad"/"claim" — restringe a busca a contexto plausível de claim
    declarado, em vez de casar QUALQUER #NNNN solto no relatório (uma
    referência em '### Trabalhado' sem palavra de claim não entra aqui).

    Devolve `{issue: released}` — `released=True` quando a MESMA linha
    também sinaliza liberação do claim (`_RELEASE_SIGNAL`, ex: "Claim
    liberada"). Ver `check_claimed_issues` e a seção (c) do docstring do
    módulo para o porquê disso importar (#7996): `unclaimIssue` apaga a
    entrada do session-registry ao liberar, então ausência de um claim
    liberado não é evidência de fabricação. Se o mesmo número aparecer em
    mais de uma linha, `released` vira `True` assim que QUALQUER uma delas
    sinalizar liberação (OR, nunca perde o sinal)."""
    refs: dict[int, bool] = {}
    for line in report_text.splitlines():
        if _CLAIM_KEYWORDS.search(line):
            released = bool(_RELEASE_SIGNAL.search(line))
            for m in _ISSUE_REF.finditer(line):
                n = int(m.group(1))
                refs[n] = refs.get(n, False) or released
    return refs


def check_report_freshness(
    report_path: Path,
    session: dict | None,
    tick_window_min: int,
    now: dt.datetime,
) -> dict:
    """Checagem (a): relatório existe e tem mtime dentro da janela do tick.

    Janela: se há sessão `continuo` registrada, usa
    [startedAt - buffer, lastHeartbeat + buffer] (buffer = tick_window_min);
    senão, usa [now - tick_window_min, now].
    """
    buffer = dt.timedelta(minutes=tick_window_min)
    if session is not None:
        started = _parse_iso(session.get("startedAt"))
        heartbeat = _parse_iso(session.get("lastHeartbeat")) or started
        if started is None:
            window_start = now - buffer
        else:
            window_start = started - buffer
        window_end = (heartbeat or now) + buffer
        session_ref = session.get("sessionId")
    else:
        window_start = now - buffer
        window_end = now
        session_ref = None

    if not report_path.exists():
        # Sem sessão correlacionada: pode ser 1º tick / arquivo nunca
        # existiu por motivo benigno -> indeterminado, não fabricação.
        # COM sessão recente registrada e SEM relatório: é o cenário exato
        # reproduzido no #7537 (sessão rodou, relatório nunca foi escrito).
        if session is not None:
            return {
                "check": "report_freshness",
                "status": "fabrication_suspected",
                "details": (
                    f"relatorio ausente ({report_path}) mas ha sessao continuo "
                    f"registrada ({session_ref}) na janela — cenario reproduzido "
                    "no #7537: modelo alegou ter escrito o relatorio sem faze-lo."
                ),
            }
        return {
            "check": "report_freshness",
            "status": "indeterminate",
            "details": (
                f"relatorio ausente ({report_path}) e nenhuma sessao continuo "
                "registrada para correlacionar — pode ser 1o tick, sem sinal de "
                "fabricacao."
            ),
        }

    mtime = dt.datetime.fromtimestamp(report_path.stat().st_mtime, tz=dt.timezone.utc)
    if window_start <= mtime <= window_end:
        return {
            "check": "report_freshness",
            "status": "ok",
            "details": f"relatorio com mtime {mtime.isoformat()} dentro da janela do tick.",
        }
    if session is None:
        # Sem sessão pra ancorar "quando o tick devia ter rodado", um
        # relatório antigo é indistinguível de "o job está pausado de
        # propósito, ninguém escreveu nada recente" — mesma disciplina do
        # #6963 (zero ticks nunca é lido como "ok", mas também nunca vira
        # alarme sem uma âncora real pra comparar). Flaggear fabricação aqui
        # seria falso positivo garantido em todo dia sem tick.
        return {
            "check": "report_freshness",
            "status": "indeterminate",
            "details": (
                f"relatorio com mtime {mtime.isoformat()} fora da janela default de "
                f"{tick_window_min}min, mas SEM sessao continuo recente pra ancorar "
                "a comparacao — pode ser job pausado (relatorio antigo legitimo), "
                "sem sinal de fabricacao."
            ),
        }
    if mtime < window_start:
        # Relatorio é MAIS ANTIGO que a janela da sessao correlacionada —
        # exatamente o padrao do #7537 (sessao rodou, nao escreveu nada, o
        # arquivo obsoleto de um tick anterior ficou por ali sendo tratado
        # como se fosse deste tick). mtime nunca "recua" sozinho — um
        # arquivo reaproveitado carrega o horario da ULTIMA escrita real,
        # que aqui é anterior ao inicio da sessao. Sinal forte.
        return {
            "check": "report_freshness",
            "status": "fabrication_suspected",
            "details": (
                f"relatorio com mtime {mtime.isoformat()} ANTERIOR a janela esperada "
                f"[{window_start.isoformat()}, {window_end.isoformat()}] da sessao "
                f"continuo registrada ({session_ref}) — relatorio obsoleto (de um tick "
                "anterior) sendo tratado como o deste tick, apesar de uma sessao "
                "recente ter rodado."
            ),
        }
    # mtime > window_end: relatorio é MAIS NOVO que a janela da sessao
    # correlacionada. Achado ao vivo do #7641 (investigacao da sessao
    # 604fba55-476a-41a1-9432-1194484f4f31): um mtime "fora da janela pra
    # frente" nao é o mesmo sinal que "pra tras" — mtime é o horario real
    # da ULTIMA ESCRITA, entao um relatorio mais novo que a sessao
    # correlacionada só pode ter sido escrito por uma atividade REAL e
    # POSTERIOR (write_file de verdade, confirmado no log do Hermes daquela
    # ocorrencia) — nunca por reaproveitamento de arquivo velho, que
    # preservaria um mtime antigo, nao um mais novo. O que isso demonstra é
    # que a sessao "mais recente" escolhida por `latest_continuo_session`
    # nao é necessariamente a que escreveu o relatorio: um tick pode
    # concluir (inclusive escrever o relatorio) sem nunca registrar
    # `data/sessions/continuo-*.json` para si mesmo (ex: tick curto que
    # falha cedo em credencial e só faz o minimo). Sem outra sessao
    # registrada pra correlacionar a esse mtime mais novo, nao dá pra
    # provar NEM refutar fabricacao — cannot-verify, nunca "ok" silencioso
    # nem fabricacao presumida por default.
    return {
        "check": "report_freshness",
        "status": "indeterminate",
        "details": (
            f"relatorio com mtime {mtime.isoformat()} POSTERIOR a janela esperada "
            f"[{window_start.isoformat()}, {window_end.isoformat()}] da sessao "
            f"continuo registrada ({session_ref}) — mtime mais novo so pode vir de "
            "escrita real e posterior (nao de reaproveitamento de arquivo antigo, "
            "que preservaria mtime antigo), mas nenhuma sessao registrada cobre esse "
            "horario — provavel tick que concluiu sem registrar "
            "`data/sessions/continuo-*.json` para si (achado #7641). Nao é possivel "
            "confirmar nem descartar fabricacao so pelo mtime; cannot-verify."
        ),
    }


def check_classification_count(
    report_text: str | None,
    open_issue_count: int | None,
) -> dict:
    """Checagem (b): contagem de issues classificadas alegada vs real."""
    if report_text is None:
        return {
            "check": "classification_count",
            "status": "not_applicable",
            "details": "relatorio indisponivel — checagem nao pode rodar.",
        }
    alleged = extract_alleged_count(report_text)
    if alleged is None:
        return {
            "check": "classification_count",
            "status": "not_applicable",
            "details": (
                "relatorio nao contem nenhuma alegacao numerica reconhecivel "
                "(protocolo nao grava contador estruturado — ver limitacao "
                "documentada no docstring do modulo)."
            ),
        }
    if open_issue_count is None:
        return {
            "check": "classification_count",
            "status": "indeterminate",
            "details": (
                f"relatorio alega n={alleged} issues, mas a contagem REAL "
                "(gh issue list) nao pode ser resolvida."
            ),
        }
    tolerance = max(COUNT_TOLERANCE_ABS, round(open_issue_count * COUNT_TOLERANCE_FRAC))
    if abs(alleged - open_issue_count) <= tolerance:
        return {
            "check": "classification_count",
            "status": "ok",
            "details": f"alegado n={alleged} bate com real={open_issue_count} (tolerancia {tolerance}).",
        }
    return {
        "check": "classification_count",
        "status": "fabrication_suspected",
        "details": (
            f"relatorio alega n={alleged} issues classificadas, mas existem "
            f"{open_issue_count} issues abertas (gh issue list) — divergencia "
            f"acima da tolerancia ({tolerance}). Mesmo padrao do #7537 (alegou "
            "n=4, existiam 41)."
        ),
    }


def check_claimed_issues(
    report_text: str | None,
    claimed_in_registry: set[int],
    sessions_dir_exists: bool,
) -> dict:
    """Checagem (c): issues citadas como reivindicadas no relatório
    aparecem de fato em algum `claimed_issues` do session-registry."""
    if report_text is None:
        return {
            "check": "claimed_issues",
            "status": "not_applicable",
            "details": "relatorio indisponivel — checagem nao pode rodar.",
        }
    alleged_claims = extract_claimed_issue_refs(report_text)
    if not alleged_claims:
        return {
            "check": "claimed_issues",
            "status": "not_applicable",
            "details": "relatorio nao cita nenhuma issue em contexto de reivindicacao/claim.",
        }
    if not sessions_dir_exists:
        return {
            "check": "claimed_issues",
            "status": "indeterminate",
            "details": (
                f"relatorio cita {sorted(alleged_claims)} como reivindicadas, mas "
                "data/sessions/ nao existe para correlacionar."
            ),
        }
    missing = sorted(n for n in alleged_claims if n not in claimed_in_registry)
    if not missing:
        return {
            "check": "claimed_issues",
            "status": "ok",
            "details": f"todas as issues citadas como reivindicadas ({sorted(alleged_claims)}) aparecem no session-registry.",
        }
    # #7996: `unclaimIssue` apaga `claimed_issues`/`claimed_issues_at` da
    # issue liberada por design (#6453) — ausencia no registro de uma issue
    # cuja MESMA linha do relatorio ja documenta a liberacao ("Claim
    # liberada") e o resultado ESPERADO, nao evidencia de fabricacao. Ver
    # docstring do modulo, secao (c), "Excecao — claim liberado no mesmo
    # tick". So a ausencia de uma issue SEM sinal de liberacao continua
    # fabrication_suspected — e o caso real do #7537.
    missing_released = sorted(n for n in missing if alleged_claims[n])
    missing_held = sorted(n for n in missing if not alleged_claims[n])
    if missing_held:
        return {
            "check": "claimed_issues",
            "status": "fabrication_suspected",
            "details": (
                f"issue(s) {missing_held} citada(s) como reivindicada(s) no relatorio mas "
                "ausente(s) de todo registro `data/sessions/continuo-*.json` — o "
                "mecanismo de claim real nunca rodou para esse(s) numero(s)."
                + (f" issue(s) {missing_released} tambem ausentes mas com liberacao "
                   "documentada na mesma linha — tratadas a parte, ver indeterminate."
                   if missing_released else "")
            ),
        }
    return {
        "check": "claimed_issues",
        "status": "indeterminate",
        "details": (
            f"issue(s) {missing_released} citada(s) como reivindicada(s) E liberada(s) no "
            "mesmo tick ('Claim liberada' na mesma linha) — `unclaimIssue` apaga a entrada "
            "do session-registry ao liberar (#6453), entao ausencia e esperada. "
            "Nao e possivel confirmar nem descartar fabricacao so por isso; cannot-verify."
        ),
    }


def run(
    repo: Path,
    report_path: Path,
    sessions_dir: Path,
    tick_window_min: int,
    now: dt.datetime,
    open_issues_json: Path | None,
) -> dict:
    session = latest_continuo_session(sessions_dir)
    report_exists = report_path.exists()
    report_text = report_path.read_text(encoding="utf-8", errors="replace") if report_exists else None

    open_issue_count = resolve_open_issue_count(open_issues_json)
    claimed_in_registry = all_continuo_claimed_issues(sessions_dir)

    checks = [
        check_report_freshness(report_path, session, tick_window_min, now),
        check_classification_count(report_text, open_issue_count),
        check_claimed_issues(report_text, claimed_in_registry, sessions_dir.is_dir()),
    ]

    statuses = {c["status"] for c in checks}
    if "fabrication_suspected" in statuses:
        overall = "fabrication_suspected"
    elif statuses <= {"ok", "not_applicable"}:
        overall = "ok"
    else:
        overall = "indeterminate"

    return {
        "status": overall,
        "report_path": str(report_path),
        "tick_window_min": tick_window_min,
        "session_correlated": session.get("sessionId") if session else None,
        "checks": checks,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--repo", type=str, default=str(DEFAULT_REPO),
                    help=f"raiz do repo diaria-studio (default: {DEFAULT_REPO})")
    ap.add_argument("--report-path", type=str, default=None,
                    help="override do path do relatorio (default: {repo}/data/continuo/last-tick-report.md)")
    ap.add_argument("--sessions-dir", type=str, default=None,
                    help="override do dir de sessoes (default: {repo}/data/sessions)")
    ap.add_argument("--tick-window-min", type=int, default=DEFAULT_TICK_WINDOW_MIN,
                    help=f"janela de frescor do relatorio, em minutos (default: {DEFAULT_TICK_WINDOW_MIN})")
    ap.add_argument("--now-iso", type=str, default=None,
                    help="override de 'agora' em ISO 8601 (testes)")
    ap.add_argument("--open-issues-json", type=str, default=None,
                    help="arquivo JSON com issues abertas (testes/offline) em vez de chamar `gh`")
    ap.add_argument("--json", action="store_true", help="saida JSON")
    args = ap.parse_args()

    repo = Path(args.repo)
    report_path = Path(args.report_path) if args.report_path else repo / REPORT_REL_PATH
    sessions_dir = Path(args.sessions_dir) if args.sessions_dir else repo / SESSIONS_REL_DIR
    now = _parse_iso(args.now_iso) or dt.datetime.now(dt.timezone.utc)
    open_issues_json = Path(args.open_issues_json) if args.open_issues_json else None

    result = run(repo, report_path, sessions_dir, args.tick_window_min, now, open_issues_json)

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(f"[tick-claim-fabrication] status={result['status']} "
              f"(sessao correlacionada: {result['session_correlated']})")
        for c in result["checks"]:
            print(f"  [{c['status']}] {c['check']}: {c['details']}")

    return {"ok": 0, "fabrication_suspected": 2, "indeterminate": 3}[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
