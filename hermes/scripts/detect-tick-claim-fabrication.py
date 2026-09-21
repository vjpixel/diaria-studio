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
      dentro da janela do tick. A janela do tick é derivada do próprio
      relatório (mtime ± `tick-window-min`, default 45min — mesmo valor que
      `watch-continuo-health.sh` checagem #3 já usa como "tick é de 30min +
      folga"), e a sessão `kind=continuo` é correlacionada por
      **sobreposição de janela** (`correlate_continuo_session`) contra
      essa janela — nunca a sessão mais recente de outro tick. Sem sessão
      cuja janela se sobreponha, cai em "sem sessão pra correlacionar".
      Sessão correlacionada e recente sem relatório fresco = suspeita forte
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
          ter terminado cedo após falhas de credencial no início). Com a
          correlação por sobreposição, esse tick agora não herda a sessão
          de outro tick (o que era o bug do #7641) e entra em
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

      **Falso positivo #8521 (20/09/2026), duas causas independentes,
      confirmadas ao vivo contra o tick de 15:36 UTC de 20/09/2026:**

      1. **Negação não reconhecida.** A linha real do relatório dizia
         "#8518, #8517 e #8516 foram lidas frescas via REST (...) e
         barradas pelo check-continuo-coherence (...); não foram
         reivindicadas." — `_CLAIM_KEYWORDS` casa "reivindicadas" dentro de
         "não foram reivindicadas" sem notar a negação, e o mecanismo de
         "segmento anterior" (usado pra `"- #500: descrição. Claim
         registrada."`) linkava a lista de refs do segmento anterior a essa
         ocorrência — as 3 issues entravam como claim quando o relatório
         explicitamente as descrevia como NÃO reivindicadas. Corrigido com
         `_NEGATION_MARKER`: uma ocorrência do keyword de claim precedida
         por "não"/"nunca" numa janela curta (`_NEGATION_WINDOW` chars) é
         descartada antes de qualquer associação a lista de refs.

      2. **`endSession` apaga o registro inteiro, não só `claimed_issues`.**
         Diferente de `unclaimIssue` (que zera só o campo, caso (c) acima),
         `endSession` (`scripts/lib/session-registry.ts`) roda `rmSync` no
         arquivo `data/sessions/continuo-{tag}-{sessionId}.json` inteiro ao
         fim de um tick que segue o protocolo até o fim — mesmo quando o
         tick tinha uma claim real e ATIVA (#8515: reivindicada, PR #8520
         aberta de verdade, branch `continuo/fix-8515-carousel-fixed-width`
         confirmada via `gh`, claim nunca liberada porque o trabalho segue
         pendente de CI/review). Pelo desenho atual, qualquer issue
         reivindicada e ainda not-yet-unclaimed no momento em que o tick
         termina fica estruturalmente invisível a
         `all_continuo_claimed_issues` assim que o detector rodar depois do
         fim do tick — que é o caso comum (o watchdog roda o detector
         minutos depois, não durante). Diferente do #7537 (a sessão nunca
         chegou a rodar `session-registry.ts end` de verdade — ficou viva
         no registro, não some), aqui a ausência só existe porque comandos
         REAIS rodaram até o fim. `data/session-lifecycle.jsonl`
         (append-only, `logSessionLifecycleEvent`, nunca reescrito)
         registra o evento `"ended"` com `sessionId`/`startedAt`/
         `lastHeartbeat` mesmo depois do registro em `data/sessions/`
         sumir — só que esse evento não carrega `claimed_issues` (o
         lifecycle log não guarda isso hoje). Mitigação adotada:
         `check_claimed_issues` agora recebe `ended_session_in_window`
         (calculado a partir desse log, mesma janela do tick) — quando
         existe um evento `"ended"` REAL sobrepondo a janela,
         `missing_held` deixa de virar `fabrication_suspected`
         incondicional e vira `indeterminate` (cannot-verify, nunca "ok"
         silencioso). Este sinal só pode existir se `session-registry.ts
         end` de fato rodou (é um append de comando real, não texto livre
         do modelo) — não reabre a janela que o #7537 explora (lá a sessão
         nunca chegava a "ended" de verdade). **Limitação residual,
         documentada e não resolvida aqui:** se um coordenador rodasse
         `end` de verdade mas fabricasse uma claim específica que nunca
         passou por `claimIssueCheckAndSet`, este sinal sozinho não
         distingue os dois casos. **Resolvido (#8521 residuo):**
         `endSession` (e o GC, evento `gc-removed-without-end`, que este
         detector NAO le — so le `ended`) grava `claimed_issues_ever`, o
         HISTORICO de claims (inclui as liberadas por unclaim antes do
         `end`, senao a liberacao viraria falso positivo). O detector une o
         historico de todos os `ended` sobrepostos a janela; alegada fora
         da uniao -> fabrication_suspected, dentro -> ok. Qualquer evento
         legado (sem o campo) -> indeterminate.

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
# #8521: log append-only de `scripts/lib/session-registry.ts` (`endSession`)
# — sobrevive à remoção do registro `data/sessions/continuo-*.json` que o
# próprio `endSession` faz (`rmSync`, ver `all_continuo_claimed_issues`).
LIFECYCLE_LOG_REL_PATH = Path("data") / "session-lifecycle.jsonl"

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
_CLAIM_KEYWORDS = re.compile(r"reivindic|reivindiq|claim", re.IGNORECASE)

# **#8377 (2026-09-18).** O detector lia QUALQUER #NNNN em uma linha que
# mencionava "reivindic"/"claim", independentemente de se tratar de um
# claim DECLARADO por este coordenador. No relatório do tick 15:54, a linha
# "Após #8356, não havia outra unidade primária livre: #8355 está
# reivindicada pelo Overnight; #8354 tem colisão documentada com a PR #8358;
# #8353/#8352/#8351/#8350/#8349/#8344/#8336 foram barradas pelo gate de
# coerência; #8341 foi fechada" continha "reivindicada" (só pra #8355, e
# ainda assim attribuída a OUTRA sessão), mas o detector marcou todos os 10
# #NNNN da linha como `fabrication_suspected` — 12 dos 13 alertas foram
# falsos positivos. A raiz é que "reivindicada" é um verbo que aparece em
# narrativa de backlog, não só em declaração de claim próprio.
#
# Três filtros, aplicados em `extract_claimed_issue_refs`:
#   1. **Segmento por cláusula** — o claim keyword e o #NNNN devem estar no
#      MESMO segmento, separado por `;` ou `. ` seguido de maiúscula/#.
#      Impede que um #NNNN distante no mesmo parágrafo seja capturado.
#   2. **PR #NNNN não é issue** — "colisão documentada com a PR #8358" é
#      referência a pull request, não a claim de issue.
#   3. **Claim attribuído a outro ator** — "#8355 está reivindicada pelo
#      Overnight" descreve quem DETÉM o claim, não o coordenador do tick
#      declarando-o. Só exclui quando o actor é explicitamente outro
#      (outro/outros/outra/outraz/overnight/terceiro) — "reivindicada pelo
#      mesmo tick" (#8356, linha 5 do relatório real) é claim PRÓPRIO.
#   4. **Cobertura de outro issue** — "#7807: o trabalho já estava coberto
#      por #7808" (caso de teste #7996) é cobertura, não claim.
# **#8377 (2026-09-18), parte 2.** A segmento por cláusula sozinho não
# basta: em "Após #8356, não havia outra unidade primária livre: #8355
# está reivindicada pelo Overnight", o #8356 está no MESMO segmento que
# "reivindicada" (a keyword se refere a #8355, attribuída a outro ator) —
# e o segmento filter não o exclui. O que difere um claim real de uma
# referência narrativa que divide cláusula com um keyword é a
# PROXIMIDADE: no claim real o #NNNN está junto ao verbo
# ("#8356 está reivindicada", "reivindicada #300"); na narrativa ele
# aparece longe ("Após #8356, ... reivindicada"). Janela de 40 chars —
# cobre "#8356 está reivindicada pelo mesmo tick" (dist ~11) e
# "reivindicada #300" (adjacente), e descarta o #8356 a 52 chars do
# keyword no relatório real do tick 15:54.
#
# **#8377 (revisão, falsos negativos).** A janela fixa de 40 chars descartava
# claims REAIS em listas longas ("#8301, #8302, ..., #8306") e títulos longos
# ("- #8400 corrigir o parser ... (reivindicada)."), e o split por `;`
# separava o número do keyword ("Claims: #100; #101"). A associação agora é
# ESTRUTURAL, não por distância fixa: o keyword se liga à LISTA de refs
# (`_REF_LIST`: #N separados por `,` `/` `;` `&` `e` `ou`) mais próxima —
# só uma, a de menor distância, então "Após #8356, ... : #8355 está
# reivindicada" continua ligando só #8355 — mais a lista que ABRE o item
# ("- #8400 título longo (reivindicada)", até `_LEADING_MAX_GAP` chars).
# `;` só separa cláusulas quando NÃO está entre dois refs.
_LEADING_MAX_GAP = 160
_CLAUSE_SPLIT = re.compile(r"\. (?=[A-Z#])")
_REF_SEMI = re.compile(r"(#\d+)\s*;\s*(?=#\d)")
_REF_LIST = re.compile(
    r"#\d+\b(?:(?:\s*,\s*e\s+|\s*[,/;&]\s*|\s+(?:e|ou)\s+)#\d+\b)*",
    re.IGNORECASE,
)
_LEADING_LIST = re.compile(r"^\s*(?:[-*•]\s*|\d+[.)]\s*)?(?=#\d)")
_PR_REF = re.compile(r"\bPR\s+#(\d+)\b", re.IGNORECASE)
_OTHERS_CLAIM = re.compile(
    r"(?P<refs>" + _REF_LIST.pattern + r")"
    r"[^#]{0,80}?\breivindicad\w*\s+(?:por|pelo|pelas)\s+"
    r"(?:outr[oa]|outros|outras|overnight|terceir[oa])\b",
    re.IGNORECASE,
)
_COVERED_BY = re.compile(
    r"(?:cobert\w*|mantid\w*|retid\w*|segurad\w*)\s+"
    r"(?:por|pelo|pelas)?\s*#(\d+)\b",
    re.IGNORECASE,
)

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

# #8521 (20/09/2026): "não foram reivindicadas"/"nunca foi reivindicada"
# casava como claim POSITIVO porque `_CLAIM_KEYWORDS` só procura a palavra
# "reivindic*", sem olhar o que vem antes. Caso real: "#8518, #8517 e #8516
# ... ; não foram reivindicadas." — o keyword em "não foram reivindicadas"
# ficava no seu próprio segmento (após o `;`) e herdava a lista de refs do
# segmento ANTERIOR pelo mecanismo de "segmento que abre com lista" (usado
# legitimamente por `"- #500: descrição. Claim registrada."`), produzindo
# 3 falsos `fabrication_suspected` para issues que o relatório descrevia
# explicitamente como NÃO reivindicadas. Uma ocorrência do keyword
# precedida por "não"/"nunca" dentro de `_NEGATION_WINDOW` caracteres é
# descartada ANTES de qualquer associação a lista de refs — nunca vira
# claim, próprio ou de terceiro.
_NEGATION_MARKER = re.compile(r"\bn[ãa]o\b|\bnunca\b", re.IGNORECASE)
_NEGATION_WINDOW = 30


def _is_negated_claim_keyword(segment: str, keyword_start: int) -> bool:
    """True quando um marcador de negação ('não'/'nunca') aparece dentro de
    `_NEGATION_WINDOW` caracteres imediatamente ANTES do keyword de claim
    no mesmo segmento — ex: 'não foram reivindicadas'. Janela curta e
    escopada ao mesmo segmento (nunca cruza `;`/`. `+maiúscula, que já
    dividem cláusulas antes desta checagem rodar) para não apagar um claim
    genuíno distante de um "não" solto em outra parte da frase."""
    window_start = max(0, keyword_start - _NEGATION_WINDOW)
    window = segment[window_start:keyword_start]
    return bool(_NEGATION_MARKER.search(window))


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


def ended_continuo_session_in_window(
    lifecycle_log_path: Path,
    window_start: dt.datetime,
    window_end: dt.datetime,
) -> dict | None:
    """#8521: `endSession` (`scripts/lib/session-registry.ts`) roda `rmSync`
    no arquivo `data/sessions/continuo-*.json` INTEIRO ao fim de um tick que
    completa o protocolo — não só zera `claimed_issues` como `unclaimIssue`
    (caso (c) do docstring do módulo). Uma issue reivindicada e ainda
    not-yet-unclaimed nesse momento (trabalho real em andamento, ex: PR
    aberta aguardando CI/review) fica estruturalmente ausente de
    `all_continuo_claimed_issues` assim que o detector rodar depois do fim
    do tick — o caso comum, já que o watchdog roda minutos depois, não
    durante.

    `data/session-lifecycle.jsonl` (append-only, nunca reescrito,
    `logSessionLifecycleEvent`) registra um evento `"ended"` com
    `sessionId`/`startedAt`/`lastHeartbeat` mesmo depois do registro em
    `data/sessions/` sumir. Esse evento só pode existir se
    `session-registry.ts end` de fato RODOU (comando real, não texto livre
    do modelo) — não reabre a janela que o #7537 explora, onde a sessão
    nunca chegava a "ended" de verdade (ficava viva/travada no registro).

    Devolve o 1º evento `kind=continuo`/`event=ended` cuja janela
    `[startedAt, lastHeartbeat]` se sobrepõe a `[window_start, window_end]`
    (mesma semântica de `correlate_continuo_session`), ou `None` — arquivo
    ausente, JSON malformado por linha (ignorada, nunca derruba as demais),
    ou nenhuma sobreposição. Fail-soft: nunca lança."""
    if not lifecycle_log_path.exists():
        return None
    try:
        raw = lifecycle_log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    first: dict | None = None
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("event") != "ended" or event.get("kind") != "continuo":
            continue
        started = _parse_iso(event.get("startedAt"))
        heartbeat = _parse_iso(event.get("lastHeartbeat")) or started
        if started is None or heartbeat is None:
            continue
        if window_start <= heartbeat and started <= window_end:
            # #8521: prefere um evento que carregue o snapshot
            # `claimed_issues`; senao devolve o 1o sobreposto (legado).
            if isinstance(event.get("claimed_issues_ever"), list):
                return event
            if first is None:
                first = event
    return first


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
    """Extrai números de issue (#NNNN) cujo claim este coordenador DECLARA
    no relatório — restringe a busca a contexto plausível de claim
    declarado, em vez de casar QUALQUER #NNNN solto em uma linha que
    mencione "reivindicad"/"claim" (ver `_CLAIM_KEYWORDS`).

    Um #NNNN conta como claim declarado somente quando:
      1. está no MESMO segmento cláusula que o keyword (segmentos separados
         por `;` ou `. ` seguido de maiúscula/#) — evita capturar um
         #NNNN distante no mesmo parágrafo;
      2. não é uma referência a `PR #NNNN` (pull request, não issue);
      3. não está em uma cláusula do tipo "#X está reivindicada por Y" —
         aí o claim é de OUTRO ator (ex: "pelo Overnight"), não deste
         coordenador.

    Devolve `{issue: released}` — `released=True` quando a MESMA LINHA
    também sinaliza liberação do claim (`_RELEASE_SIGNAL`, ex: "Claim
    liberada"). O sinal de liberação é avaliado por LINHA (não por
    segmento cláusula): o verbo de liberação pode legítimamente aparecer
    em um clause distante do #NNNN na mesma linha — ex: "#8356 está
    reivindicada pelo mesmo tick; liberação completa" (o `;` separa os dois
    segmentos) ou "#7807: ... Claim liberada." (separados por `.`). Avaliar
    por segmento orfanearia o sinal e converteria um claim liberado (ausente
    do registro por design do `unclaimIssue`, #6453) em
    `fabrication_suspected` — falso positivo na direção que este detector
    deve evitar (#7996). Ver `check_claimed_issues` e a seção (c) do
    docstring do módulo para o porquê disso importar. Se o mesmo número
    aparecer em mais de uma linha, `released` vira `True` assim que
    QUALQUER uma delas sinalizar liberação (OR, nunca perde o sinal)."""
    refs: dict[int, bool] = {}
    for line in report_text.splitlines():
        line_released = bool(_RELEASE_SIGNAL.search(line))
        # `;` entre dois refs é separador de LISTA, não de cláusula.
        norm = _REF_SEMI.sub(lambda m: m.group(1) + ",", line)
        # `;` restante separa cláusulas; `. ` + maiúscula/# também.
        segments = [
            seg
            for part in norm.split(";")
            for seg in _CLAUSE_SPLIT.split(part)
        ]
        for idx, segment in enumerate(segments):
            # #8521: descarta ocorrência do keyword negada ("não foram
            # reivindicadas") ANTES de qualquer associação a lista de refs
            # — nunca chega a virar claim, nem próprio nem de terceiro.
            kws = [
                kw for kw in _CLAIM_KEYWORDS.finditer(segment)
                if not _is_negated_claim_keyword(segment, kw.start())
            ]
            if not kws:
                continue
            lists = list(_REF_LIST.finditer(segment))
            attached: list[re.Match] = []
            if lists:
                lead = _LEADING_LIST.match(segment)
                for kw in kws:
                    before = [l for l in lists if l.end() <= kw.start()]
                    after = [l for l in lists if l.start() >= kw.end()]
                    # Leading-list só se aplica quando é a MESMA lista que o
                    # heurístico de distância (abaixo) já escolheria — nunca
                    # uma lista DIFERENTE só porque abre a linha. #8463:
                    # "#8355 ficou bloqueada porque #8354 foi reivindicada
                    # pelo Overnight" tem #8355 abrindo a linha, mas quem
                    # "reivindicada" de fato reclama é #8354 (mais perto,
                    # já excluído por `_OTHERS_CLAIM` abaixo) — sem esta
                    # checagem, #8355 entrava como claim próprio fabricado
                    # só por ser a 1ª lista da linha, mesmo não sendo a que
                    # o keyword se refere.
                    if lead and lists[0].start() == lead.end() and (
                        kw.start() - lists[0].end() <= _LEADING_MAX_GAP
                    ) and (not before or before[-1] is lists[0]):
                        attached.append(lists[0])
                    cand = []
                    db = kw.start() - before[-1].end() if before else None
                    da = after[0].start() - kw.end() if after else None
                    if db is not None and (da is None or db <= da):
                        cand.append(before[-1])
                    if da is not None and (db is None or da <= db):
                        cand.append(after[0])
                    attached.extend(cand)
            elif idx > 0:
                # "- #N: descrição. Claim registrada." — o keyword abre a
                # cláusula seguinte; liga à lista que ABRE a anterior.
                prev = segments[idx - 1]
                lead = _LEADING_LIST.match(prev)
                if lead:
                    m0 = _REF_LIST.match(prev, lead.end())
                    if m0:
                        attached.append(m0)
                        segment = prev + ". " + segment
            if not attached:
                continue
            # Exclusões aplicadas SÓ ao número que as justificou (#8377).
            pr_ref_n = {int(n) for n in _PR_REF.findall(segment)}
            others_n = set()
            for om in _OTHERS_CLAIM.finditer(segment):
                refs_text = om.group("refs")
                for n_s in _ISSUE_REF.findall(refs_text):
                    others_n.add(int(n_s))
            covered_n = {int(n) for n in _COVERED_BY.findall(segment)}
            for lm in attached:
                for n_s in _ISSUE_REF.findall(lm.group(0)):
                    n = int(n_s)
                    if n in pr_ref_n or n in others_n or n in covered_n:
                        continue
                    refs[n] = refs.get(n, False) or line_released
    return refs


def check_report_freshness(
    report_path: Path,
    session: dict | None,
    tick_window_min: int,
    now: dt.datetime,
) -> dict:
    """Checagem (a): relatório existe e tem mtime dentro da janela do tick.

    A sessão passada já foi correlacionada por SOBREPOSIÇÃO DE JANELA
    (`correlate_continuo_session`, no `run`) contra a janela do tick
    atual — nunca a sessão mais recente de outro tick. Janela: se há
    sessão `continuo` registrada, usa
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
    # que a sessao correlacionada por `correlate_continuo_session` (janela
    # do proprio relatorio ± buffer) nao é necessariamente a que escreveu
    # o relatorio: um tick pode concluir (inclusive escrever o relatorio)
    # sem nunca registrar `data/sessions/continuo-*.json` para si mesmo (ex:
    # tick curto que falha cedo em credencial e só faz o minimo). Sem outra
    # sessao registrada pra correlacionar a esse mtime mais novo, nao dá pra
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


def ended_continuo_events_in_window(
    lifecycle_log_path: Path,
    window_start: dt.datetime,
    window_end: dt.datetime,
) -> list[dict]:
    """#8521: TODOS os eventos `ended` de `continuo` sobrepostos a janela
    (duas sessoes podem se sobrepor). Fail-soft, nunca lanca."""
    out: list[dict] = []
    try:
        raw = lifecycle_log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return out
    for line in raw.splitlines():
        try:
            event = json.loads(line.strip())
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("event") != "ended" or event.get("kind") != "continuo":
            continue
        started = _parse_iso(event.get("startedAt"))
        heartbeat = _parse_iso(event.get("lastHeartbeat")) or started
        if started is None or heartbeat is None:
            continue
        if window_start <= heartbeat and started <= window_end:
            out.append(event)
    return out


def _snapshot_from_events(events: list[dict]) -> set[int] | None:
    """#8521: UNIAO do historico de claims (`claimed_issues_ever`, que inclui
    claims liberadas por unclaim antes do `end`) de todos os eventos. Se
    QUALQUER evento e legado (sem o campo) devolve None: nao da pra afirmar
    ausencia -> o chamador cai em indeterminate."""
    if not events:
        return None
    union: set[int] = set()
    for ev in events:
        ever = ev.get("claimed_issues_ever")
        if not isinstance(ever, list):
            return None
        for n in list(ever) + list(ev.get("claimed_issues") or []):
            try:
                union.add(int(n))
            except (TypeError, ValueError):
                continue
    return union


def _snapshot_from_event(event: dict | None) -> set[int] | None:
    """#8521: `claimed_issues` do evento 'ended', ou None quando o evento
    e legado (sem o campo) ou ausente — o chamador cai no comportamento
    anterior (indeterminate)."""
    if not event or not isinstance(event.get("claimed_issues_ever"), list):
        return None
    out: set[int] = set()
    for n in event["claimed_issues"]:
        try:
            out.add(int(n))
        except (TypeError, ValueError):
            continue
    return out


def check_claimed_issues(
    report_text: str | None,
    claimed_in_registry: set[int],
    sessions_dir_exists: bool,
    ended_session_in_window: bool = False,
    ended_claimed_snapshot: set[int] | None = None,
) -> dict:
    """Checagem (c): issues citadas como reivindicadas no relatório
    aparecem de fato em algum `claimed_issues` do session-registry.

    `ended_session_in_window` (#8521, default `False` — parâmetro
    retrocompatível, testes existentes que chamam sem ele preservam o
    comportamento antigo): `True` quando `ended_continuo_session_in_window`
    achou um evento `"ended"` REAL (`data/session-lifecycle.jsonl`) cuja
    janela se sobrepõe à do tick sendo checado. Ver docstring do módulo,
    seção (c), "Falso positivo #8521" — `endSession` apaga o registro
    INTEIRO (não só `claimed_issues`, diferente de `unclaimIssue`), então
    uma claim real e ainda ativa no fim de um tick que terminou o protocolo
    normalmente fica ausente de `claimed_in_registry` por desenho, não por
    fabricação."""
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
    if missing_held and ended_session_in_window and ended_claimed_snapshot is not None:
        # #8521 (residuo): o evento 'ended' carrega o snapshot de
        # HISTORICO de claims (`claimed_issues_ever`, gravado por
        # `endSession`; inclui claims liberadas por unclaim antes do `end`;
        # uniao de todos os eventos sobrepostos). Consta -> claim real. Nao
        # consta -> `end` rodou de verdade mas a claim nunca passou por
        # `claimIssueCheckAndSet` = fabricacao especifica.
        fabricated = sorted(n for n in missing_held if n not in ended_claimed_snapshot)
        if fabricated:
            return {
                "check": "claimed_issues",
                "status": "fabrication_suspected",
                "details": (
                    f"issue(s) {fabricated} citada(s) como reivindicada(s) no relatorio mas "
                    "ausentes tanto de `data/sessions/continuo-*.json` quanto do historico "
                    "`claimed_issues_ever` do evento 'ended' real (data/session-lifecycle.jsonl) — "
                    "`end` rodou, mas o mecanismo de claim nunca rodou para esse(s) numero(s)."
                ),
            }
        return {
            "check": "claimed_issues",
            "status": "ok",
            "details": (
                f"issue(s) {missing_held} ausentes do registro vivo mas presentes no snapshot "
                "`claimed_issues` do evento 'ended' real da sessao — claim verificada."
            ),
        }
    if missing_held:
        if ended_session_in_window:
            # #8521: um evento "ended" REAL (log append-only, só existe se
            # `session-registry.ts end` de fato rodou) sobrepondo a janela
            # do tick explica a ausencia sem exigir fabricacao — o mesmo
            # tick pode ter reivindicado a issue e terminado o protocolo
            # normalmente com o trabalho ainda em andamento (endSession
            # apaga o registro INTEIRO, nao so claimed_issues). Nao e
            # "ok" (nao da pra confirmar que o mecanismo de claim rodou
            # pra ESSE numero especifico, so que a sessao existiu e
            # terminou de verdade) — cannot-verify, igual ao caso (a)/#7996.
            return {
                "check": "claimed_issues",
                "status": "indeterminate",
                "details": (
                    f"issue(s) {missing_held} citada(s) como reivindicada(s) no relatorio mas "
                    "ausente(s) de todo registro `data/sessions/continuo-*.json` — HA um evento "
                    "'ended' real (data/session-lifecycle.jsonl) sobrepondo a janela do tick, "
                    "que so existe se `session-registry.ts end` rodou de verdade (nao texto "
                    "livre do modelo). `endSession` apaga o registro INTEIRO ao terminar um "
                    "tick que completou o protocolo, entao uma claim real e ainda ativa "
                    "(trabalho em andamento) fica ausente por desenho, nao por fabricacao — "
                    "cannot-verify, nao 'ok' silencioso (achado #8521)."
                    + (f" issue(s) {missing_released} tambem ausentes mas com liberacao "
                       "documentada na mesma linha."
                       if missing_released else "")
                ),
            }
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


def correlate_continuo_session(
    sessions_dir: Path,
    tick_window_start: dt.datetime,
    tick_window_end: dt.datetime,
    buffer_minutes: int = DEFAULT_TICK_WINDOW_MIN,
) -> dict | None:
    """Escolhe a sessão `kind=continuo` cuja janela [startedAt,
    lastHeartbeat] se sobrepõe à janela do tick cujo relatório estamos
    checando.

    Diferente de `latest_continuo_session` (que pega a MAIS RECENTE de
    QUALQUER tick — a fonte do #7641), a correlação aqui é por
    **sobreposição de janela**: só uma sessão que de fato rodou dentro
    do tick atual (ou perto o suficiente pra ser dela) pode ser usada
    pra ancorar `check_report_freshness`. Um tick que NUNCA registrou
    `data/sessions/continuo-*.json` para si (ex: terminou cedo após
    falha de credencial — o caso real do #7641) não herda a sessão de
    um tick anterior, que é exatamente o que causou a correlação errada
    em silêncio.

    Mesmo primitivo de `scripts/lib/continuo-session-registration-check.ts`
    (#7890, `windowsOverlap`): janela do tick expandida por
    `bufferMinutes` de cada lado vs. [startedAt, lastHeartbeat] da
    sessão; qualquer timestamp ilegível descarta a sessão (conservador,
    nunca afirma sobreposição sobre dado corrompido).

    Devolve None (não erro) quando o diretório não existe, não há
    registro `kind=continuo` ou nenhuma sessão se sobrepuser — o caller
    trata como "sem sessão pra correlacionar", e `check_report_freshness`
    já lida com isso de forma fail-soft.
    """
    if not sessions_dir.is_dir():
        return None
    buffer = dt.timedelta(minutes=buffer_minutes)
    tick_start = tick_window_start - buffer
    tick_end = tick_window_end + buffer
    for f in sorted(sessions_dir.glob("continuo-*.json")):
        try:
            record = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if record.get("kind") != "continuo":
            continue
        started = _parse_iso(record.get("startedAt"))
        heartbeat = _parse_iso(record.get("lastHeartbeat")) or started
        if started is None or heartbeat is None:
            continue
        # Sobreposição de [tick_start, tick_end] x [started, heartbeat]
        if tick_start <= heartbeat and started <= tick_end:
            return record
    return None


def run(
    repo: Path,
    report_path: Path,
    sessions_dir: Path,
    tick_window_min: int,
    now: dt.datetime,
    open_issues_json: Path | None,
    lifecycle_log_path: Path | None = None,
) -> dict:
    # Janela do tick atual: ancorada no relatório quando existe (o mtime
    # é o único sinal de "quando este tick escreveu") ou em `now` quando
    # o relatório nunca foi escrito. A correlação de sessão é por
    # sobreposição dessa janela — ver `correlate_continuo_session`.
    report_exists = report_path.exists()
    if report_exists:
        mtime = dt.datetime.fromtimestamp(
            report_path.stat().st_mtime, tz=dt.timezone.utc
        )
        tick_window_start = mtime - dt.timedelta(minutes=tick_window_min)
        tick_window_end = mtime + dt.timedelta(minutes=tick_window_min)
    else:
        tick_window_start = now - dt.timedelta(minutes=tick_window_min)
        tick_window_end = now
    session = correlate_continuo_session(
        sessions_dir, tick_window_start, tick_window_end
    )
    report_text = report_path.read_text(encoding="utf-8", errors="replace") if report_exists else None

    open_issue_count = resolve_open_issue_count(open_issues_json)
    claimed_in_registry = all_continuo_claimed_issues(sessions_dir)

    # #8521: correlaciona por SOBREPOSIÇÃO DE JANELA contra o log
    # append-only de lifecycle, mesmo primitivo de `correlate_continuo_session`
    # mas contra um log que sobrevive ao `rmSync` de `endSession` (ver
    # `ended_continuo_session_in_window`).
    resolved_lifecycle_log = (
        lifecycle_log_path if lifecycle_log_path is not None
        else repo / LIFECYCLE_LOG_REL_PATH
    )
    ended_events = ended_continuo_events_in_window(
        resolved_lifecycle_log, tick_window_start, tick_window_end
    )
    ended_session = ended_events[0] if ended_events else None

    checks = [
        check_report_freshness(report_path, session, tick_window_min, now),
        check_classification_count(report_text, open_issue_count),
        check_claimed_issues(
            report_text, claimed_in_registry, sessions_dir.is_dir(),
            ended_session_in_window=ended_session is not None,
            ended_claimed_snapshot=_snapshot_from_events(ended_events),
        ),
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
    ap.add_argument("--lifecycle-log-path", type=str, default=None,
                    help="override do log append-only de lifecycle (default: {repo}/data/session-lifecycle.jsonl, #8521)")
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
    lifecycle_log_path = (
        Path(args.lifecycle_log_path) if args.lifecycle_log_path
        else repo / LIFECYCLE_LOG_REL_PATH
    )
    now = _parse_iso(args.now_iso) or dt.datetime.now(dt.timezone.utc)
    open_issues_json = Path(args.open_issues_json) if args.open_issues_json else None

    result = run(
        repo, report_path, sessions_dir, args.tick_window_min, now, open_issues_json,
        lifecycle_log_path=lifecycle_log_path,
    )

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
