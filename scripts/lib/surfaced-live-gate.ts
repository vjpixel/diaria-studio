/**
 * surfaced-live-gate.ts (#5919)
 *
 * Lógica PURA/testável para o gate mecânico de "surfacing ao vivo de
 * bloqueio tipo-editor" no `/diaria-develop` — o follow-up que a prosa da
 * skill adiava condicionalmente (SKILL.md §"Guard mecânico de fim de rodada",
 * #5727 item 5) e que a #5919 confirmou necessário: 2ª violação da regra
 * "#5727 — surfacear NA HORA", com custo real (janela de evidência do #5878
 * fechou sem captura do motivo da rejeição, 3ª vez na mesma conta Microsoft
 * Ads: #5702, #5878).
 *
 * ## O contrato (#5919)
 *
 * Toda entrada de `plan.json` com bloqueio tipo-editor (`what_unblocks`
 * preenchido) deve registrar explicitamente o campo `surfaced_live: boolean`:
 *
 *   - `true`  → o bloqueio foi surfaceado ao vivo pro editor (mensagem
 *               informativa no formato de 4 partes do #5727, ou
 *               `AskUserQuestion` para tipo 2), com `surfaced_live_at`
 *               recomendado (timestamp ISO);
 *   - `false` → NÃO foi surfaceado ao vivo — registro honesto, obrigatório
 *               na Seção de HANDOFF do relatório (fallback de ausência,
 *               descoberta tardia, resolução pela própria sessão).
 *
 * A ausência do campo é exatamente o modo de falha da #5919: em `260821c`,
 * a entrada do #5878 tinha `surfaced_at` (timestamp de classificação, campo
 * ambíguo que já existia) mas nenhum sinal de surfacing ao vivo — e ninguém
 * percebeu até a janela fechar. O gate torna essa omissão impossível de
 * compilar relatório.
 *
 * ## Veredito
 *
 * Dois níveis, não um:
 *
 *   - `failures[]` (bloqueiam, `exit 1`)  — campo `surfaced_live` AUSENTE
 *     ou com tipo errado (string `"true"`, `null`, número): o registro
 *     explícito nunca foi feito, que é o bug.
 *   - `warnings[]` (não bloqueiam, saem no stderr) — `false` explícito:
 *     decisão honesta registrada; o custo dela é aparecer no HANDOFF, não
 *     travar a sessão. Bloquear `false` em geral quebraria o Fallback de
 *     ausência legítimo (editor sai no meio, SKILL.md §Fallback) — over-broad
 *     demais sem classificação mecânica de "tipo 2", que a própria #5919
 *     reconhece não existir. Premissa registrada no PR: falhar só na
 *     AUSÊNCIA é a direção segura; `--strict` no entrypoint promove warning
 *     pra falha quando uma rodada quiser apertar.
 *
 * Puro, sem rede — recebe as entradas de `issues[]` já lidas do plan.json
 * pelo chamador (entrypoint: `scripts/check-surfaced-live.ts`). Mesmo padrão
 * de `scripts/lib/trade-off-label-gate.ts` (#5821) e
 * `scripts/lib/state-changed-tracker.ts`.
 */

/** Campo booleano obrigatório em toda entrada bloqueada de `issues[]`. */
export const SURFACED_LIVE_FIELD = "surfaced_live";

/** Timestamp ISO recomendado (não obrigatório) quando `surfaced_live: true`. */
export const SURFACED_LIVE_AT_FIELD = "surfaced_live_at";

/** Forma mínima dos campos do gate numa entrada de `issues[]` do plan.json. */
export interface SurfacedLiveIssueEntry {
  number?: number;
  status?: string;
  /** Bloqueio tipo-editor — presença não-vazia define "entrada bloqueada". */
  what_unblocks?: string | null;
  surfaced_live?: unknown;
  surfaced_live_at?: unknown;
  [key: string]: unknown;
}

export type SurfacedLiveFindingKind =
  /** `surfaced_live` ausente — o modo de falha real da #5919. */
  | "missing-field"
  /** `surfaced_live` presente mas não-boolean (string, null, número...). */
  | "wrong-type"
  /** `true` sem `surfaced_live_at` — recomendado, não obrigatório. */
  | "missing-timestamp";

export interface SurfacedLiveFinding {
  /** Número da issue, quando a entrada o tem. */
  issue: number | null;
  kind: SurfacedLiveFindingKind;
  what_unblocks: string;
  status?: string;
  detail: string;
}

export interface SurfacedLiveGateResult {
  /** Entradas bloqueadas examinadas (com `what_unblocks` não-vazio). */
  blockedCount: number;
  /** Entradas com `surfaced_live === true`. */
  okCount: number;
  /** Entradas com `surfaced_live === false` explícito (warning, não falha). */
  falseCount: number;
  /** Ausência/tipo errado do campo — bloqueiam (`exit 1`). */
  failures: SurfacedLiveFinding[];
  /** `true` sem timestamp + `false` explícito — avisos, não bloqueiam. */
  warnings: SurfacedLiveFinding[];
}

function blockedEntries(
  entries: readonly SurfacedLiveIssueEntry[],
): Array<{ entry: SurfacedLiveIssueEntry; what: string }> {
  const out: Array<{ entry: SurfacedLiveIssueEntry; what: string }> = [];
  for (const entry of entries ?? []) {
    if (entry == null || typeof entry !== "object") continue;
    const what = typeof entry.what_unblocks === "string" ? entry.what_unblocks.trim() : "";
    if (what.length > 0) out.push({ entry, what });
  }
  return out;
}

function issueOf(entry: SurfacedLiveIssueEntry): number | null {
  return typeof entry.number === "number" && Number.isInteger(entry.number)
    ? entry.number
    : null;
}

function statusOf(entry: SurfacedLiveIssueEntry): string | undefined {
  return typeof entry.status === "string" && entry.status.length > 0 ? entry.status : undefined;
}

/**
 * Decide o veredito do gate a partir das entradas de `issues[]` já lidas do
 * plan.json (I/O é responsabilidade do chamador). Nunca lança; aceita
 * `null`/`undefined` como lista vazia.
 */
export function checkSurfacedLive(
  entries: readonly SurfacedLiveIssueEntry[] | null | undefined,
): SurfacedLiveGateResult {
  const result: SurfacedLiveGateResult = {
    blockedCount: 0,
    okCount: 0,
    falseCount: 0,
    failures: [],
    warnings: [],
  };

  for (const { entry, what } of blockedEntries(entries ?? [])) {
    result.blockedCount += 1;
    const issue = issueOf(entry);
    const status = statusOf(entry);

    if (!("surfaced_live" in entry) || entry.surfaced_live === undefined) {
      result.failures.push({
        issue,
        kind: "missing-field",
        what_unblocks: what,
        status,
        detail: `campo '${SURFACED_LIVE_FIELD}' ausente — registre true (surfaceado ao vivo) ou false (não surfaceado, vai pro HANDOFF)`,
      });
      continue;
    }

    if (typeof entry.surfaced_live !== "boolean") {
      result.failures.push({
        issue,
        kind: "wrong-type",
        what_unblocks: what,
        status,
        detail: `'${SURFACED_LIVE_FIELD}' precisa ser boolean, veio ${JSON.stringify(entry.surfaced_live)}`,
      });
      continue;
    }

    if (entry.surfaced_live === false) {
      result.falseCount += 1;
      result.warnings.push({
        issue,
        kind: "missing-timestamp",
        what_unblocks: what,
        status,
        detail: `${SURFACED_LIVE_FIELD}=false — bloqueio NÃO surfaceado ao vivo; obrigatório na Seção de HANDOFF do relatório`,
      });
      continue;
    }

    // surfaced_live === true — timestamp recomendado, não obrigatório.
    result.okCount += 1;
    const at = typeof entry.surfaced_live_at === "string" && entry.surfaced_live_at.trim().length > 0;
    if (!at) {
      result.warnings.push({
        issue,
        kind: "missing-timestamp",
        what_unblocks: what,
        status,
        detail: `${SURFACED_LIVE_FIELD}=true sem '${SURFACED_LIVE_AT_FIELD}' — timestamp ISO recomendado`,
      });
    }
  }

  return result;
}
