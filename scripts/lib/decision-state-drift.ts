/**
 * scripts/lib/decision-state-drift.ts (#10105)
 *
 * Alarme "estado real contradiz decisão registrada do editor".
 *
 * Incidente que motivou: em 30/09/2026 o editor decidiu "manter a rampa
 * Clarice pausada" (marcador `decisao-editor` na #8099). Em 01/10 o kill
 * switch `data/clarice-envio-enabled.json` foi religado sem rastro e a rampa
 * enviou todo dia até 12/10 — nada cruzava a decisão gravada com o toggle.
 *
 * Mecanismo: o marcador `decisao-editor` (`issue-decisions.ts`) ganhou o
 * campo opcional machine-readable `estado_esperado: {toggle, enabled}`. Este
 * módulo pega a decisão VIGENTE (a mais recente) de cada issue aberta, e se
 * ela declara um estado esperado, compara com o toggle real. Nunca interpreta
 * a prosa de `pergunta`/`resposta` — decisão sem `estado_esperado` não é
 * vigiada (premissa decidida no #10105: marcador estruturado, não heurística
 * de texto).
 *
 * "Vigente" = a decisão mais recente da issue. Uma decisão posterior SEM
 * `estado_esperado` substitui a anterior (o editor decidiu de novo e não
 * pediu vigilância), então não alarma. Issue fechada não entra: fechar a
 * issue encerra a decisão.
 *
 * Miolo puro (`checkDecisionStates`, `formatDriftReportLines`) + I/O fino
 * (`fetchOpenIssuesWithTrustedComments`, `productionToggleReader`). Consumido
 * por `scripts/check-decision-state-drift.ts` (CLI, usado pelo
 * `/diaria-desbloqueia`) e pelo relatório diário de `clarice-envio-run.ts`.
 */
import { spawnSync } from "node:child_process";
import { trustedCommentBodies } from "./trusted-comment-author.ts";
import {
  latestDecisionFor,
  type IssueDecision,
  type VerifiableToggle,
} from "./issue-decisions.ts";
import { readClariceEnvioEnabledState } from "./clarice-envio-enabled.ts";
import { readClariceNovosEnabledState } from "./clarice-novos-enabled.ts";

export interface IssueWithComments {
  number: number;
  title?: string;
  /** Corpos de comentário de autor CONFIÁVEL, em ordem cronológica. */
  commentBodies: readonly string[];
}

export interface ToggleReading {
  enabled: boolean;
  updatedAt: string | null;
  machine?: string | null;
  sessionId?: string | null;
  reason?: string | null;
  fileAbsent?: true;
}

export type ToggleReader = (toggle: VerifiableToggle) => ToggleReading;

export interface DecisionStateCheck {
  issue: number;
  title: string | null;
  toggle: VerifiableToggle;
  expectedEnabled: boolean;
  actualEnabled: boolean;
  /** `true` quando o estado real bate com o esperado. */
  ok: boolean;
  decision: IssueDecision;
  toggleState: ToggleReading;
}

/**
 * Para cada issue cuja decisão vigente declara `estado_esperado`, lê o toggle
 * (uma vez por toggle, cacheado) e compara. Issues sem decisão, ou cuja
 * decisão vigente não declara estado, não aparecem no resultado.
 */
export function checkDecisionStates(
  issues: readonly IssueWithComments[],
  readToggle: ToggleReader,
): DecisionStateCheck[] {
  const cache = new Map<VerifiableToggle, ToggleReading>();
  const read = (t: VerifiableToggle): ToggleReading => {
    let v = cache.get(t);
    if (!v) {
      v = readToggle(t);
      cache.set(t, v);
    }
    return v;
  };
  const checks: DecisionStateCheck[] = [];
  for (const issue of issues) {
    const decision = latestDecisionFor(issue.commentBodies);
    if (!decision?.estado_esperado) continue;
    const { toggle, enabled: expectedEnabled } = decision.estado_esperado;
    const toggleState = read(toggle);
    checks.push({
      issue: issue.number,
      title: issue.title ?? null,
      toggle,
      expectedEnabled,
      actualEnabled: toggleState.enabled,
      ok: toggleState.enabled === expectedEnabled,
      decision,
      toggleState,
    });
  }
  return checks;
}

export function driftsOf(checks: readonly DecisionStateCheck[]): DecisionStateCheck[] {
  return checks.filter((c) => !c.ok);
}

const onOff = (b: boolean) => (b ? "LIGADO" : "PAUSADO");

function provenance(state: ToggleReading): string {
  if (state.fileAbsent) return "default de arquivo ausente";
  const since = state.updatedAt ?? "data desconhecida";
  if (!state.machine && !state.reason) return `desde ${since}, SEM RASTRO (sem máquina/motivo)`;
  return `desde ${since}, máquina ${state.machine ?? "?"}${state.sessionId ? `, sessão ${state.sessionId}` : ""}, motivo: ${state.reason ?? "não informado"}`;
}

/** Uma linha por divergência, pronta pro relatório/terminal. Vazio = nada a avisar. */
export function formatDriftReportLines(checks: readonly DecisionStateCheck[]): string[] {
  return driftsOf(checks).map(
    (c) =>
      `⚠️  DECISÃO CONTRADITA (#${c.issue}${c.title ? ` "${c.title}"` : ""}): decisão do editor de ${c.decision.decided_at} ` +
      `manda ${c.toggle} ${onOff(c.expectedEnabled)}, mas o toggle está ${onOff(c.actualEnabled)} (${provenance(c.toggleState)}). ` +
      `Decisão: "${c.decision.resposta}". Confirme com o editor antes da próxima onda — ou registre nova decisão na issue.`,
  );
}

// ─── I/O fino ───────────────────────────────────────────────────────────────

export type FetchIssuesResult =
  | { ok: true; issues: IssueWithComments[] }
  | { ok: false; error: string };

/**
 * Parse puro do stdout de `gh issue list|view --json number,title,comments`
 * (objeto único ou array). Filtra comentários por autor confiável (#9752 —
 * o repo é público e o marcador tem formato documentado).
 */
export function parseIssuesJson(stdout: string): FetchIssuesResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    return { ok: false, error: `JSON inválido do gh: ${(e as Error).message}` };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const issues: IssueWithComments[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "item não-objeto no JSON do gh" };
    const r = raw as { number?: unknown; title?: unknown; comments?: unknown };
    if (typeof r.number !== "number") return { ok: false, error: "issue sem number no JSON do gh" };
    const bodies = trustedCommentBodies(r.comments);
    if (bodies === null) return { ok: false, error: `issue #${r.number} sem array comments no JSON do gh` };
    issues.push({ number: r.number, title: typeof r.title === "string" ? r.title : undefined, commentBodies: bodies });
  }
  return { ok: true, issues };
}

/**
 * Issues ABERTAS com comentários. Uma chamada `gh issue list` (~5s com ~50
 * issues). Limitação conhecida: o `gh` traz no máximo os primeiros 100
 * comentários por issue — decisão gravada além disso não é vista.
 */
export function fetchOpenIssuesWithTrustedComments(cwd: string): FetchIssuesResult {
  const r = spawnSync(
    "gh",
    ["issue", "list", "--state", "open", "--limit", "500", "--json", "number,title,comments"],
    { cwd, encoding: "utf8", timeout: 60_000 },
  );
  if (r.error) return { ok: false, error: `gh falhou: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, error: `gh saiu ${r.status}: ${(r.stderr ?? "").trim().slice(0, 300)}` };
  return parseIssuesJson(r.stdout ?? "");
}

/** Issues específicas (qualquer estado), via `gh issue view` uma a uma. */
export function fetchIssuesWithTrustedComments(numbers: readonly number[], cwd: string): FetchIssuesResult {
  const issues: IssueWithComments[] = [];
  for (const n of numbers) {
    const r = spawnSync("gh", ["issue", "view", String(n), "--json", "number,title,comments"], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (r.error || r.status !== 0) {
      return { ok: false, error: `gh issue view ${n} falhou: ${r.error?.message ?? (r.stderr ?? "").trim().slice(0, 300)}` };
    }
    const parsed = parseIssuesJson(r.stdout ?? "");
    if (!parsed.ok) return parsed;
    issues.push(...parsed.issues);
  }
  return { ok: true, issues };
}

/** Leitor real dos toggles verificáveis — mesmo arquivo que os runners leem. */
export function productionToggleReader(rootDir: string): ToggleReader {
  return (toggle) => {
    switch (toggle) {
      case "clarice-envio-enabled":
        return readClariceEnvioEnabledState(rootDir);
      case "clarice-novos-enabled":
        return readClariceNovosEnabledState(rootDir);
    }
  };
}

/**
 * Linhas pro relatório diário do envio. Fail-soft: falha do `gh` vira UMA
 * linha de aviso (o alarme não rodou), nunca exceção — o relatório não pode
 * cair por causa do alarme, mas também não pode fingir que conferiu.
 */
export function decisionDriftReportLines(
  fetchIssues: () => FetchIssuesResult,
  readToggle: ToggleReader,
): string[] {
  let fetched: FetchIssuesResult;
  try {
    fetched = fetchIssues();
  } catch (e) {
    fetched = { ok: false, error: (e as Error).message };
  }
  if (!fetched.ok) {
    return [
      `⚠️  alarme decisão×toggle (#10105) NÃO rodou: ${fetched.error} — não dá pra afirmar que nenhuma decisão do editor foi contradita.`,
    ];
  }
  return formatDriftReportLines(checkDecisionStates(fetched.issues, readToggle));
}
