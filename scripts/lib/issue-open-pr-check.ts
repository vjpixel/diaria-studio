/**
 * scripts/lib/issue-open-pr-check.ts (#7788)
 *
 * Preflight de duplicidade contra PR ABERTA — a lacuna que
 * `scripts/lib/issue-duplicate-preflight.ts` (#7020/#7801) deixa por
 * desenho: aquele módulo só enxerga trabalho já MERGEADO
 * (`git log origin/master`). Uma PR aberta cobrindo a mesma issue — o
 * estado mais comum numa lane que abre PR a cada ~60min e drena a cada
 * ~120min (`/diaria-continuo`) — é invisível pra ele. Isso queimou
 * ~420k tokens de subagente na rodada overnight 260909 (#7788): dois
 * dispatches inteiros descobriram, já dentro da própria sessão, que uma PR
 * `continuo/fix-*` aberta já cobria o escopo.
 *
 * Este módulo é PURO — recebe a lista de PRs abertas já buscada
 * (`OpenPrInfo[]`, de `gh pr list --state open --json ...`) e devolve um
 * veredito. `scripts/lib/gh-open-pr-fetch.ts` faz o fetch real;
 * `scripts/check-issue-open-pr.ts` é o CLI fino que liga os dois — mesma
 * separação fetch/lógica/CLI já usada por `master-commit-fetch.ts` /
 * `issue-duplicate-preflight.ts` / `check-issue-duplicate-preflight.ts`.
 *
 * ## Duas vias de match, cada uma com ponto cego sozinha
 *
 * - **Número da issue** (`#N`, boundary de dígito — `#77` NUNCA casa com
 *   `#7788`, mesma técnica de `citesIssueNumber` em
 *   `issue-duplicate-preflight.ts`) no título/corpo da PR.
 * - **Padrão de branch** (`*fix-{N}*`, `*feat-{N}*`) — as duas PRs da
 *   rodada 260909 (`continuo/fix-7746-pr-cap`,
 *   `continuo/fix-7738-daily-send-queue`) só casam por esta via: o título
 *   delas não necessariamente cita `#N` (ex: PR do `continuo` só refere
 *   a issue no corpo, ou nem isso).
 *
 * ## Menção em prosa NÃO é cobertura de escopo (decisão deste módulo)
 *
 * Uma PR que apenas MENCIONA a issue (`relacionado a #7788`, `veja #7788`
 * — nenhum marcador `closes`/`fixes`/`resolves`) não é prova de que ela
 * RESOLVE a issue — é só uma citação, o mesmo tipo de sinal fraco que
 * `parseCommitCloseMarker` já trata como `refs`/`unknown` em vez de
 * `closes` no preflight de master. Por isso `matchKind: "mention-only"`
 * é reportado (visível pro coordenador) mas **não** eleva o veredito pra
 * `"open-pr-covers-scope"` sozinho — só `"closes-marker"` (marcador
 * explícito) ou `"branch-pattern"` (convenção de branch do repo, que É a
 * declaração de escopo da lane `continuo`/`develop`/`overnight`) contam
 * como cobertura. Isso evita o falso-positivo simétrico ao #7788: travar
 * o dispatch por causa de uma PR que só cita a issue de passagem.
 *
 * ## `cannot-verify` é um veredito de primeira classe
 *
 * Regra inegociável desta issue: falha de `gh` (indisponível, sem auth,
 * JSON malformado, rate limit) NUNCA pode virar "nenhuma PR aberta" — isso
 * transformaria uma falha de consulta em sinal verde, reintroduzindo em
 * silêncio o desperdício que a issue descreve (mesma classe do #7776 da
 * mesma rodada). Diferente de `master-commit-fetch.ts` (que é fail-soft
 * pra "sem indício de duplicidade" — comportamento aceito ali porque o
 * pior caso é um dispatch redundante que o item 14 (preflight do
 * subagente) ainda pega), aqui a superfície explícita é 3 vereditos
 * distintos, e quem decide "erro de fetch" é sempre `cannot-verify`, nunca
 * `no-open-pr` — ver `scripts/lib/gh-open-pr-fetch.ts` e
 * `scripts/check-issue-open-pr.ts`.
 *
 * @see scripts/lib/gh-open-pr-fetch.ts (fetch real via `gh pr list`)
 * @see scripts/check-issue-open-pr.ts (CLI)
 * @see scripts/lib/issue-duplicate-preflight.ts (preflight irmão — trabalho MERGEADO)
 * @see context/overnight-dispatch-rules.md item 14 (rede de segurança no subagente)
 * @see context/overnight-dispatch-rules.md item 16 (checklist de 3 perguntas pra PR alheia)
 * @see context/overnight-dispatch-rules.md item 21 (preflight de duplicidade do coordenador)
 */

/** Estado agregado de CI da PR — `"unknown"` cobre tanto "sem
 * `statusCheckRollup` no payload" quanto "payload malformado"; nunca
 * confundido com `"pending"` (que significa "há checks, ainda rodando"). */
export type OpenPrCiState = "green" | "pending" | "failing" | "unknown";

/** Um nó de `statusCheckRollup` (`gh pr list --json statusCheckRollup`) —
 * shape mínimo usado para derivar `OpenPrCiState`. Mesmo shape de
 * `PrCheckNode` em `scripts/lib/pr-checks-gate.ts`, duplicado aqui de
 * propósito (módulo aditivo isolado, #7788 — ver nota de colisão de
 * arquivo no PR) em vez de importar daquele módulo, que este PR não toca. */
export interface OpenPrCheckRunLike {
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

/** Uma PR aberta, no shape mínimo que `gh pr list --json
 * number,title,body,headRefName,author,updatedAt,statusCheckRollup`
 * produz. */
export interface OpenPrInfo {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  author: { login: string } | null;
  /** ISO 8601. */
  updatedAt: string;
  statusCheckRollup?: OpenPrCheckRunLike[] | null;
}

/** `unknown` (sinal fraco, só citação em prosa) < `branch-pattern` <
 * `closes-marker` (sinal mais forte — marcador explícito de fechamento). */
export type OpenPrMatchKind = "closes-marker" | "branch-pattern" | "mention-only";

export interface OpenPrMatch {
  number: number;
  title: string;
  headRefName: string;
  author: string | null;
  updatedAt: string;
  ciState: OpenPrCiState;
  matchKind: OpenPrMatchKind;
}

export type OpenPrCheckVerdict = "no-open-pr" | "open-pr-covers-scope" | "cannot-verify";

export interface OpenPrCheckResult {
  verdict: OpenPrCheckVerdict;
  issueNumber: number;
  /** Todo match encontrado, incluindo `mention-only` (visível pro
   * coordenador mesmo quando não eleva o veredito). Ordenado por força de
   * match (`closes-marker` > `branch-pattern` > `mention-only`), depois
   * por `updatedAt` desc. */
  matches: OpenPrMatch[];
  /** Só presente quando `verdict === "cannot-verify"`. */
  error?: string;
  recommendation: string;
}

/** `#N` sem dígito colado antes/depois — mesma técnica de
 * `citesIssueNumber`/`numberBoundary` em `issue-duplicate-preflight.ts`
 * (não importado daqui pra manter este módulo sem dependência do arquivo
 * que a PR #7803 já toca — ver nota de colisão de arquivo). Evita `#77`
 * casar dentro de `#7788`. */
function citesIssue(text: string, issueNumber: number): boolean {
  return new RegExp(`(?<!\\d)#${issueNumber}(?!\\d)`).test(text);
}

/** `closes`/`fixes`/`resolves #N` (case-insensitive, plural incluso —
 * `fixes`/`resolves` já são a forma flexionada; `close`/`fix`/`resolve`
 * cobertos pelo `s?`). */
function hasClosesMarker(text: string, issueNumber: number): boolean {
  return new RegExp(`\\b(closes?|fix(?:es)?|resolves?)\\s+(?<!\\d)#${issueNumber}(?!\\d)`, "i").test(text);
}

/** Convenção de branch das lanes autônomas (`continuo/fix-N-slug`,
 * `overnight/fix-N-slug`, `develop/feat-N-slug`, etc) — extrai TODOS os
 * números de issue que a branch declara, não só o primeiro, porque a
 * convenção não impede `fix-7746-and-7738`. */
function branchDeclaredIssueNumbers(headRefName: string): number[] {
  const out: number[] = [];
  const re = /\b(?:fix|feat)-([0-9]+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(headRefName)) !== null) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}

/** Deriva `OpenPrCiState` de `statusCheckRollup` — versão minimalista do
 * mesmo raciocínio de `evaluatePrChecksGate`
 * (`scripts/lib/pr-checks-gate.ts`, não importado aqui de propósito, ver
 * nota de colisão de arquivo): payload ausente/malformado é `"unknown"`,
 * nunca lido como "0 checks reprovados" nem como "pending". Usado só pra
 * dar contexto ao coordenador (checklist item 16 #2 — "CI verde/rodando?")
 * — não decide o veredito de duplicidade em si. */
export function deriveOpenPrCiState(rollup: OpenPrCheckRunLike[] | null | undefined): OpenPrCiState {
  if (!Array.isArray(rollup)) return "unknown";
  if (rollup.length === 0) return "pending";
  const FAIL_STATES = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"]);
  const PASS_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  let sawPending = false;
  for (const node of rollup) {
    const conclusion = (node.conclusion ?? node.state ?? "").toUpperCase();
    const status = (node.status ?? "").toUpperCase();
    if (conclusion && FAIL_STATES.has(conclusion)) return "failing";
    if (status && status !== "COMPLETED") { sawPending = true; continue; }
    if (conclusion && !PASS_STATES.has(conclusion)) { sawPending = true; }
  }
  return sawPending ? "pending" : "green";
}

const MATCH_KIND_STRENGTH: Record<OpenPrMatchKind, number> = {
  "closes-marker": 2,
  "branch-pattern": 1,
  "mention-only": 0,
};

/**
 * Veredito puro: dada a issue e a lista de PRs abertas já buscadas, decide
 * se há uma PR cobrindo o escopo. Nunca lança, nunca faz I/O.
 */
export function assessOpenPrCoverage(issueNumber: number, prs: readonly OpenPrInfo[]): OpenPrCheckResult {
  const matches: OpenPrMatch[] = [];

  for (const pr of prs) {
    const title = pr.title ?? "";
    const body = pr.body ?? "";
    const branchNumbers = branchDeclaredIssueNumbers(pr.headRefName ?? "");

    let matchKind: OpenPrMatchKind | null = null;
    if (hasClosesMarker(title, issueNumber) || hasClosesMarker(body, issueNumber)) {
      matchKind = "closes-marker";
    } else if (branchNumbers.includes(issueNumber)) {
      matchKind = "branch-pattern";
    } else if (citesIssue(title, issueNumber) || citesIssue(body, issueNumber)) {
      matchKind = "mention-only";
    }

    if (matchKind === null) continue;

    matches.push({
      number: pr.number,
      title,
      headRefName: pr.headRefName ?? "",
      author: pr.author?.login ?? null,
      updatedAt: pr.updatedAt ?? "",
      ciState: deriveOpenPrCiState(pr.statusCheckRollup),
      matchKind,
    });
  }

  matches.sort((a, b) => {
    const strengthDiff = MATCH_KIND_STRENGTH[b.matchKind] - MATCH_KIND_STRENGTH[a.matchKind];
    if (strengthDiff !== 0) return strengthDiff;
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });

  const coveringMatches = matches.filter((m) => m.matchKind !== "mention-only");

  if (coveringMatches.length > 0) {
    const top = coveringMatches[0];
    return {
      verdict: "open-pr-covers-scope",
      issueNumber,
      matches,
      recommendation:
        `PR #${top.number} (branch ${top.headRefName}, autor ${top.author ?? "desconhecido"}, ` +
        `CI ${top.ciState}, atualizada ${top.updatedAt || "data desconhecida"}) parece cobrir #${issueNumber} ` +
        `(match: ${top.matchKind}). Antes de dispatchar, aplicar o checklist de 3 perguntas do item 16 de ` +
        `context/overnight-dispatch-rules.md (autor conhecido? CI verde/rodando? atualizada nas últimas ` +
        `~24-48h?) — as 3 juntas justificam esperar; falhando qualquer uma, tratar como se a PR não existisse.`,
    };
  }

  if (matches.length > 0) {
    // Só mention-only: visível, mas não é razão pra travar o dispatch.
    return {
      verdict: "no-open-pr",
      issueNumber,
      matches,
      recommendation:
        `Nenhuma PR aberta parece RESOLVER #${issueNumber} — ${matches.length} PR(s) só a MENCIONAM em prosa ` +
        `(matchKind mention-only), sem marcador de fechamento nem branch na convenção fix-N/feat-N. ` +
        `Não tratado como cobertura de escopo; dispatch segue normal.`,
    };
  }

  return {
    verdict: "no-open-pr",
    issueNumber,
    matches: [],
    recommendation: `Nenhuma PR aberta cita #${issueNumber} nem segue a convenção de branch fix-${issueNumber}/feat-${issueNumber}. Dispatch normal.`,
  };
}
