/**
 * scripts/lib/develop-plan-motivo.ts (#5708)
 *
 * Fecha a 2ª causa raiz do #5708: um rótulo de espera INVENTADO ("gated no
 * D0", "timing do editor") gravado no campo `motivo` de uma issue `pulada`
 * do plan.json do /diaria-develop escapava de qualquer verificação — a
 * skill documenta um vocabulário fechado de motivos válidos
 * (`nao-destravavel-na-sessao`, `decisao-adiada`, `claimed-por-outra-sessao`),
 * mas nada validava que o texto gravado batesse com essa lista. Mesmo
 * espírito do guard de contagem do #5521 (`register-report.ts`, marcador
 * `<!-- unidades-mergeadas -->`): checagem mecânica e barata que faz o
 * desvio FALHAR em vez de passar em silêncio.
 *
 * Escopo: só `status === "pulada"` — os outros status (`mergeada`,
 * `draft-ci-vermelho`, `pendente`, `entregue-fora-de-codigo`) não usam
 * `motivo` do mesmo jeito (o caso `entregue-fora-de-codigo` tem seus
 * próprios campos, `fora_de_codigo_evidencia`/`fora_de_codigo_fechamento`,
 * #5441 — fora do escopo deste guard). `nao-destravavel-na-sessao` cobre
 * deliberadamente tanto o bloqueio cat. A/B/E não resolvido quanto a
 * implementação de issue elegível que falha sem nunca abrir PR (Fase 1
 * passo 5 do SKILL.md) — um só valor pros dois casos, de propósito.
 *
 * Puro (`findInvalidPuladaMotivos`/`checkDevelopPlanMotivosFromIssues`) + I/O
 * fino (`checkDevelopPlanMotivos`, lê o plan.json do disco). CLI em
 * `scripts/validate-develop-plan-motivo.ts`.
 *
 * @see .claude/skills/diaria-develop/SKILL.md § "'Nenhuma issue aberta' = estado terminal"
 * @see scripts/lib/state-changed-tracker.ts (padrão de estilo do gate)
 * @see scripts/lib/plan-issues-normalize.ts (`plan.issues` array vs dict)
 */

import { readFileSync } from "node:fs";
import { normalizeIssues, type IssuesBearing } from "./plan-issues-normalize.ts";

/**
 * Vocabulário fechado de `motivo` para issues `status: "pulada"` no
 * plan.json do /diaria-develop, exatamente como documentado em
 * `.claude/skills/diaria-develop/SKILL.md` § "'Nenhuma issue aberta' =
 * estado terminal". Um 4º valor legado (`rescan-limit`) existiu antes do
 * #5272 e foi removido junto do cap de re-varredura — nunca gravado por uma
 * sessão atual, não entra aqui.
 */
export const DEVELOP_PULADA_MOTIVOS = [
  "nao-destravavel-na-sessao",
  "decisao-adiada",
  "claimed-por-outra-sessao",
] as const;

export type DevelopPuladaMotivo = (typeof DEVELOP_PULADA_MOTIVOS)[number];

const VALID_SET: ReadonlySet<string> = new Set(DEVELOP_PULADA_MOTIVOS);

export interface DevelopPlanIssueLike {
  number?: number;
  status?: unknown;
  motivo?: unknown;
  [key: string]: unknown;
}

export interface InvalidMotivoEntry {
  number: number;
  /** `null` quando `motivo` está ausente ou não é string — issue `pulada`
   * sem motivo registrado é o mesmo problema, silenciosamente pior. */
  motivo: string | null;
}

/**
 * Pure: varre as issues já normalizadas (sempre array — via
 * `normalizeIssues`, agnóstico do plan.json ter gravado array ou dict),
 * devolve as `status: "pulada"` cujo `motivo` não bate com
 * `DEVELOP_PULADA_MOTIVOS`. Nunca lança.
 */
export function findInvalidPuladaMotivos(
  issues: DevelopPlanIssueLike[],
): InvalidMotivoEntry[] {
  const out: InvalidMotivoEntry[] = [];
  for (const issue of issues) {
    if (issue?.status !== "pulada") continue;
    const motivo = typeof issue.motivo === "string" ? issue.motivo : null;
    if (motivo !== null && VALID_SET.has(motivo)) continue;
    const number = typeof issue.number === "number" ? issue.number : Number.NaN;
    out.push({ number, motivo });
  }
  return out;
}

export type DevelopPlanMotivoCheckResult =
  | { status: "ok" }
  | { status: "invalid"; entries: InvalidMotivoEntry[] };

/** Pure: veredito a partir das issues já normalizadas. */
export function checkDevelopPlanMotivosFromIssues(
  issues: DevelopPlanIssueLike[],
): DevelopPlanMotivoCheckResult {
  const entries = findInvalidPuladaMotivos(issues);
  if (entries.length === 0) return { status: "ok" };
  return { status: "invalid", entries: [...entries].sort((a, b) => a.number - b.number) };
}

/** I/O: lê o plan.json do disco (array ou dict, #4860) e devolve o veredito. */
export function checkDevelopPlanMotivos(planPath: string): DevelopPlanMotivoCheckResult {
  const raw = readFileSync(planPath, "utf8");
  const plan = JSON.parse(raw) as IssuesBearing<DevelopPlanIssueLike>;
  const issues = normalizeIssues(plan);
  return checkDevelopPlanMotivosFromIssues(issues);
}
