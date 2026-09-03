/**
 * scripts/lib/route-marker-staleness.ts (#7270 Parte 2, #7288 Parte B)
 *
 * As duas issues são o MESMO defeito de fundo — um rótulo de roteamento
 * (`bloqueada` via label, `agendada` via marcador `aguardando-ate:`) que
 * ninguém reavalia vira mentira durável — e por isso compartilham UM alarme
 * periódico em vez de dois. `scripts/route-marker-staleness-alarm.ts` (CLI)
 * varre TODAS as issues abertas e reporta 5 categorias de achado, todas
 * determinísticas (nenhum julgamento heurístico de "isto parece
 * estacionamento"):
 *
 *   - `bloqueada-sem-marcador`      — label de bloqueio sem `ExecutionBlock`
 *     (#7270: 9 de 12 issues bloqueadas não tinham NENHUM marcador). Desde
 *     que `scripts/route-issue.ts` passou a embutir o marcador
 *     automaticamente (#7270), este achado só deveria aparecer pra issues
 *     bloqueadas por `gh issue edit` direto, fora do verbo — sinal de que
 *     alguém contornou o mecanismo.
 *   - `bloqueada-depends-on-fechada`  — `condicao.tipo === "depends_on"` cuja
 *     issue-alvo já fechou. BACKSTOP: `scripts/reconcile-issue-dependencies.ts`
 *     já deveria ter removido a label sozinho (mesmo marcador `depends-on:`,
 *     #7137) — este achado só aparece se o reconciliador não rodou
 *     recentemente (task agendada atrasada/falhando).
 *   - `bloqueada-externa-sem-atualizacao` — `condicao.tipo === "externo"` (o
 *     ÚNICO caso sem auto-desarme, por natureza) sem nenhum comentário
 *     `route-issue` há N dias. É o único achado desta lista que de fato
 *     precisa de revisão HUMANA — os outros 4 são backstop/sintoma de
 *     mecanismo que já deveria ter agido sozinho.
 *   - `agendada-motivo-cita-issue-fechada` — a razão do `route-issue`
 *     `--track agendada` mais recente cita `#N` e `#N` já está `CLOSED`
 *     (#7288: 3 dos 11 casos medidos — #6771/#7043/#6624 — esperavam um
 *     evento que já tinha acontecido). Precedente de extrair `#N` de texto
 *     livre por regex: `block-staleness.ts` já faz isso pra `PR #N` em
 *     `nota`.
 *   - `agendada-renovada-multiplas-vezes` — ≥3 comentários `route-issue`
 *     com `track=agendada` na mesma issue — estender o prazo repetidamente
 *     é o sinal mais limpo de estacionamento (#7288 cita a #5998, 4
 *     reroteamentos em 6 dias).
 *
 * Este alarme **reporta, não desbloqueia/reroteia** — decisão explícita de
 * #7270 ("o alarme reporta, não desbloqueia... remover label é decisão de
 * quem tem contexto"), mesma postura do `on-hold-vencimento-alarm.ts`
 * (#5317) que este módulo espelha em estilo (digest sem estado/
 * idempotência persistente — reenvia todo achado pendente a cada rodada).
 *
 * A parte PURA (`findRouteMarkerStaleness`) recebe um
 * `RouteMarkerStalenessConsultor` injetável — nenhuma chamada de rede/`gh`
 * acontece aqui, só no CLI (`scripts/route-marker-staleness-alarm.ts`), que
 * monta o consultor real. Mesmo padrão de `scripts/lib/block-staleness.ts`.
 *
 * @see scripts/route-marker-staleness-alarm.ts (CLI/entrypoint)
 * @see scripts/lib/issue-decisions.ts (ExecutionBlock, BlockUnblockCondition)
 * @see scripts/lib/issue-route.ts (parseRouteIssueMarkerAtStart)
 * @see scripts/lib/block-staleness.ts (irmão — bloqueio caducado em plan.json, não em issue viva)
 */

import { latestExecutionBlockFor } from "./issue-decisions.ts";
import { parseRouteIssueMarkerAtStart } from "./issue-route.ts";
import { BLOCKED_LABELS_SET } from "./block-staleness.ts";
import { parseWaitUntil } from "./issue-exec-track.ts";

export interface RouteMarkerStalenessIssueInput {
  number: number;
  labels: readonly string[];
  body: string;
  state: "OPEN" | "CLOSED";
  /** Bodies de TODOS os comentários, na ordem cronológica que `gh` devolve
   * (mais antigo primeiro) — precisa pra achar o `route-issue` MAIS
   * RECENTE e contar renovações. */
  comments: readonly string[];
}

export type IssueLookupState = "OPEN" | "CLOSED" | "UNKNOWN";

/** Consultor injetável — implementação real (CLI) chama `gh`; testes
 * injetam fixtures em memória. `"UNKNOWN"` nunca produz achado (fail-soft,
 * mesma postura de `block-staleness.ts`). */
export interface RouteMarkerStalenessConsultor {
  getIssueState(issueNumber: number): IssueLookupState;
}

export type RouteMarkerFindingCategory =
  | "bloqueada-sem-marcador"
  | "bloqueada-depends-on-fechada"
  | "bloqueada-externa-sem-atualizacao"
  | "agendada-motivo-cita-issue-fechada"
  | "agendada-renovada-multiplas-vezes";

export interface RouteMarkerFinding {
  number: number;
  category: RouteMarkerFindingCategory;
  detail: string;
}

/** #7270 — issue "externo" sem nenhuma atualização há mais desse número de
 * dias vira achado. O sinal de "atualização" é só `recorded_at` do
 * marcador `bloqueio-execucao` — desde que `route-issue.ts` passou a
 * embutir o marcador automaticamente no MESMO comentário do roteamento
 * (#7270), `recorded_at` É o timestamp desse comentário, não um sinal
 * separado (um marcador escrito antes dessa mudança, à mão, também usava
 * o `recorded_at` da própria escrita — nunca houve um 2º relógio
 * independente aqui). 30 dias — mesma ordem de grandeza do ciclo de
 * revisão que a issue original propôs ("semanalmente"), com folga: o
 * alarme roda semanal mas só ACUSA quando o bloqueio já está velho o
 * bastante pra valer a pena interromper o editor, não a cada rodada. */
export const STALE_EXTERNAL_DAYS = 30;

/** #7288 — número de comentários `route-issue --track agendada` na MESMA
 * issue que já conta como "renovado demais". A #5998 (citada na issue de
 * origem) teve 4 em 6 dias — 3 é o piso que já denuncia o padrão sem
 * esperar chegar a 4. */
export const AGENDADA_RENEWAL_THRESHOLD = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pure: dias corridos entre uma data (`AAAA-MM-DD` ou ISO completo — o
 * formato que `ExecutionBlock.recorded_at` pode assumir, ver
 * `scripts/route-issue.ts`) e `now`. `NaN` se `dateStr` não parsear —
 * caller trata como "não verificável", nunca como achado. */
function daysSince(dateStr: string, now: Date): number {
  const parsed = new Date(dateStr.length <= 10 ? `${dateStr}T00:00:00Z` : dateStr);
  if (Number.isNaN(parsed.getTime())) return NaN;
  return (now.getTime() - parsed.getTime()) / DAY_MS;
}

/** Extrai a razão do comentário `route-issue` mais recente com
 * `track=agendada` — formato exato de `buildCommentBody` em
 * `scripts/route-issue.ts`: `Roteado para **agendada** — {reason}` (SEM
 * ponto final quando há razão — o ponto só aparece na variante sem razão,
 * `Roteado para **agendada**.`) numa linha própria. `null` se a linha não
 * bater (comentário pré-#7288 sem razão, ou marcador presente mas prosa
 * alterada manualmente). */
function extractAgendadaReason(commentBody: string): string | null {
  const match = commentBody.match(/^Roteado para \*\*agendada\*\*(?:\.$| — (.+)$)/m);
  if (!match) return null;
  return match[1] ?? null;
}

/** Todos os `#N` citados num texto livre — mesmo precedente de
 * `extractPrNumber` em `block-staleness.ts` (extrai `PR #N` de `nota`). */
function extractIssueRefs(text: string): number[] {
  const nums = new Set<number>();
  for (const m of text.matchAll(/#(\d+)/g)) nums.add(Number(m[1]));
  return [...nums];
}

/**
 * #7316 review (silent-failure-hunter) — cobertura do CONSULTOR: quantas
 * issues distintas foram consultadas via `consultor.getIssueState` (só as
 * 2 categorias `-depends-on-fechada`/`-motivo-cita-issue-fechada`
 * dependem disso — as outras 3 nunca chamam o consultor) e quantas
 * devolveram `"UNKNOWN"` (o `gh` falhou naquela consulta). Achado real: o
 * CLI (`scripts/route-marker-staleness-alarm.ts`) engolia toda falha de
 * `gh issue view` como `"UNKNOWN"` sem NENHUM contador — se o `gh`
 * degradar no meio da rodada (token expirado, rate limit), o alarme roda
 * até o fim e reporta "0 achados" exatamente como reportaria um estado
 * genuinamente limpo. É o mesmo defeito que o #7270/#7288 existem pra
 * atacar (estado importante some, nada distingue "não achei" de "não
 * consegui olhar"), reproduzido dentro do próprio alarme que os fecha.
 *
 * `queried`/`unknown` contam issues DISTINTAS (não chamadas — memoização
 * do consultor real já colapsa consultas repetidas da mesma issue).
 */
export interface ConsultorCoverage {
  queried: number;
  unknown: number;
}

/** Fração de `coverage.unknown` acima da qual a varredura é considerada
 * degradada o bastante pra precisar dizer isso alto (log + e-mail), não só
 * registrar um número. 10% — qualquer falha isolada (1-2 issues num `gh`
 * soluçando) não vira alarme por si só; uma fração de dois dígitos já é
 * sinal de degradação real (token expirando, rate limit em curso), não
 * ruído de rede pontual. */
export const UNKNOWN_FRACTION_WARN_THRESHOLD = 0.1;

/** Pure: descreve a cobertura do consultor em texto — `null` quando não há
 * NENHUMA consulta `"UNKNOWN"` (cobertura completa, nada a dizer). Quando
 * há, sempre devolve uma mensagem; `severe` distingue "poucas falhas
 * isoladas" (log apenas) de "fração alta o bastante pra precisar dizer no
 * e-mail que a varredura foi PARCIAL, não limpa" — ver
 * `UNKNOWN_FRACTION_WARN_THRESHOLD`. */
export function describeConsultorCoverage(
  coverage: ConsultorCoverage,
  threshold: number = UNKNOWN_FRACTION_WARN_THRESHOLD,
): { severe: boolean; message: string } | null {
  if (coverage.unknown === 0) return null;
  const fraction = coverage.queried > 0 ? coverage.unknown / coverage.queried : 1;
  const pct = Math.round(fraction * 100);
  const severe = fraction >= threshold;
  const message = severe
    ? `varredura PARCIAL — ${coverage.unknown}/${coverage.queried} consultas ao GitHub falharam (${pct}%). ` +
      `0 achados nas categorias que dependem dessas consultas (bloqueada-depends-on-fechada, ` +
      `agendada-motivo-cita-issue-fechada) NÃO é garantia de estado limpo — pode ser cobertura incompleta.`
    : `${coverage.unknown}/${coverage.queried} consultas ao GitHub falharam (${pct}%) — cobertura reduzida, ` +
      `abaixo do limiar de alarme (${Math.round(threshold * 100)}%).`;
  return { severe, message };
}

/**
 * Pure: varre issues ABERTAS e devolve os achados das 5 categorias — ver
 * docblock do módulo. Ordenado por número de issue crescente
 * (determinístico, independente da ordem de `gh issue list`).
 */
export function findRouteMarkerStaleness(
  issues: readonly RouteMarkerStalenessIssueInput[],
  consultor: RouteMarkerStalenessConsultor,
  now: Date,
): RouteMarkerFinding[] {
  const findings: RouteMarkerFinding[] = [];

  for (const issue of issues) {
    if (issue.state !== "OPEN") continue;

    const hasBlockedLabel = issue.labels.some((l) => BLOCKED_LABELS_SET.has(l));
    if (hasBlockedLabel) {
      const block = latestExecutionBlockFor(issue.comments);
      if (block === null) {
        findings.push({
          number: issue.number,
          category: "bloqueada-sem-marcador",
          detail:
            "label de bloqueio presente sem nenhum marcador bloqueio-execucao válido — motivo/condição de desbloqueio não registrados (#7270)",
        });
        continue;
      }
      if (block.condicao.tipo === "depends_on") {
        const state = consultor.getIssueState(block.condicao.issue);
        if (state === "CLOSED") {
          findings.push({
            number: issue.number,
            category: "bloqueada-depends-on-fechada",
            detail: `dependência #${block.condicao.issue} já fechou — reconcile-issue-dependencies.ts deveria ter removido a label sozinho`,
          });
        }
        continue;
      }
      // condicao.tipo === "externo" — o único caso sem auto-desarme.
      const days = daysSince(block.recorded_at, now);
      if (!Number.isNaN(days) && days >= STALE_EXTERNAL_DAYS) {
        findings.push({
          number: issue.number,
          category: "bloqueada-externa-sem-atualizacao",
          detail: `condição externa ("${block.condicao.descricao}") sem atualização há ${Math.floor(days)} dias (limiar ${STALE_EXTERNAL_DAYS})`,
        });
      }
      continue;
    }

    // Sem label de bloqueio — só interessa se tiver o marcador
    // aguardando-ate: (a issue classifica "agendada" ou já expirou).
    if (parseWaitUntil(issue.body) === null) continue;

    const agendadaComments = issue.comments.filter((c) => parseRouteIssueMarkerAtStart(c) === "agendada");
    if (agendadaComments.length >= AGENDADA_RENEWAL_THRESHOLD) {
      findings.push({
        number: issue.number,
        category: "agendada-renovada-multiplas-vezes",
        detail: `${agendadaComments.length} comentários route-issue com track=agendada — deferimento repetido, provável estacionamento (#7288)`,
      });
    }

    const latestAgendadaComment = agendadaComments[agendadaComments.length - 1];
    if (latestAgendadaComment) {
      const reasonText = extractAgendadaReason(latestAgendadaComment);
      if (reasonText) {
        for (const cited of extractIssueRefs(reasonText)) {
          if (consultor.getIssueState(cited) === "CLOSED") {
            findings.push({
              number: issue.number,
              category: "agendada-motivo-cita-issue-fechada",
              detail: `razão do agendamento cita #${cited}, que já está fechada — a data marcada não reflete mais o motivo`,
            });
            break; // 1 achado por issue nesta categoria já é suficiente sinal
          }
        }
      }
    }
  }

  return findings.sort((a, b) => a.number - b.number || a.category.localeCompare(b.category));
}
