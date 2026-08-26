/**
 * pr-checks-gate.ts (#6225)
 *
 * Lógica PURA/testável para a **condição 1** do gate de merge autônomo
 * (overnight/develop/continuo, #2210/#2222): "todos os checks do PR estão
 * verdes?". A formulação anterior, só em prosa na SKILL —
 *
 *   `gh pr checks {N} --json bucket --jq '[.[] | select(.bucket != "pass")] | length'`
 *
 * — não roda no `gh` 2.46.0 do `helios` (apt do Ubuntu): a flag `--json` só
 * chegou em `gh pr checks` em versão posterior. O comando falha em stderr
 * com `exit 1`, e dentro de `$(...)` isso vira **string vazia** — qualquer
 * comparação que trate "vazio" como "0 achados" (`[ -z "$X" ]`,
 * `${X:-0}`) inverte o gate pra falso-verde (achado ao vivo #6225, aplicado
 * ao PR #6212).
 *
 * Este módulo substitui a condição 1 por `gh pr view --json
 * statusCheckRollup`, que roda na versão instalada tanto no `helios` quanto
 * na máquina do editor (confirmado na própria issue #6225). O I/O (chamar
 * `gh`, tratar exit code/JSON malformado) fica no entrypoint CLI
 * (`scripts/check-pr-checks-gate.ts`) — mesmo padrão de
 * `scripts/lib/trade-off-label-gate.ts` / `scripts/check-trade-off-label-cleared.ts`.
 * Este arquivo só decide, a partir do payload já parseado, qual é o
 * veredito.
 *
 * ## Por que 4 estados, não 2 ("verde"/"vermelho")
 *
 * A condição 2 do mesmo gate (threads de review) já trata "a query falhou"
 * como caso distinto de "0 threads não-resolvidas" (ver
 * `.claude/skills/diaria-overnight/SKILL.md`, comentário "nunca tratar erro
 * como 0 threads"). A condição 1 não tinha esse guard — é o próprio bug
 * desta issue. Por isso o veredito distingue:
 *
 *   - `"pass"`    : todos os checks presentes estão `COMPLETED` com
 *                   conclusão de sucesso (`SUCCESS`/`NEUTRAL`/`SKIPPED`).
 *                   Único estado que autoriza a condição 1 do gate.
 *   - `"fail"`    : ao menos um check `COMPLETED` com conclusão que não é
 *                   de sucesso (`FAILURE`, `CANCELLED`, `TIMED_OUT`,
 *                   `ACTION_REQUIRED`, `STALE`, `STARTUP_FAILURE`, etc).
 *   - `"pending"` : nenhum check falhou, mas ao menos um ainda não é
 *                   `COMPLETED` (rodando/enfileirado) — **ou** o PR não tem
 *                   nenhum check registrado ainda (`statusCheckRollup`
 *                   vazio). Mesmo espírito do "exit 8 / lista vazia =
 *                   PENDENTE, nunca verde nem vermelho" já documentado na
 *                   SKILL pro `--watch`: um PR recém-criado, antes dos jobs
 *                   serem registrados pelo GitHub, não pode ler como "0
 *                   checks reprovados" só porque o array está vazio.
 *   - `"error"`   : o payload não tem o formato esperado (`statusCheckRollup`
 *                   ausente ou não é array) — sintoma de resposta malformada
 *                   do `gh`/API. Puro nunca lança; quem detecta falha de
 *                   *comando* (exit code != 0, JSON.parse jogando) é o
 *                   entrypoint CLI, que produz este mesmo veredito antes de
 *                   sequer chamar a função pura daqui.
 *
 * **Nenhum destes 4 estados equivale a "autorizado" exceto `"pass"`** — é
 * essa a garantia central: comando que falhou (seja na chamada ao `gh`, seja
 * num payload que não bate o formato esperado) nunca é lido como "0 checks
 * reprovados, logo pode mergear".
 */

export type PrChecksGateVerdict = "pass" | "fail" | "pending" | "error";

export interface PrCheckNode {
  name?: string;
  /** Ex: `"COMPLETED"`, `"IN_PROGRESS"`, `"QUEUED"`, `"PENDING"`. */
  status?: string | null;
  /** Ex: `"SUCCESS"`, `"FAILURE"`, `"NEUTRAL"`, `"SKIPPED"`, `null` (ainda rodando). */
  conclusion?: string | null;
}

export interface PrChecksGateResult {
  verdict: PrChecksGateVerdict;
  /** Nomes dos checks com conclusão que não é sucesso (só quando `verdict === "fail"`). */
  failingChecks: string[];
  /** Nomes dos checks ainda não `COMPLETED` (só quando `verdict === "pending"` por check em andamento). */
  pendingChecks: string[];
  /** Motivo legível — sempre presente, útil pra log/halt banner. */
  reason: string;
}

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Decide o veredito da condição 1 do gate a partir do `statusCheckRollup`
 * já parseado de `gh pr view --json statusCheckRollup`. Puro, sem rede;
 * nunca lança — payload malformado vira `verdict: "error"`, nunca uma
 * exceção que o chamador precisaria capturar pra não confundir com "pass".
 */
export function evaluatePrChecksGate(statusCheckRollup: unknown): PrChecksGateResult {
  if (!Array.isArray(statusCheckRollup)) {
    return {
      verdict: "error",
      failingChecks: [],
      pendingChecks: [],
      reason: "statusCheckRollup ausente ou não é um array — payload malformado, nunca tratar como 0 checks reprovados.",
    };
  }

  if (statusCheckRollup.length === 0) {
    return {
      verdict: "pending",
      failingChecks: [],
      pendingChecks: [],
      reason: "nenhum check registrado ainda no PR (statusCheckRollup vazio) — pendente, não é aprovação por ausência.",
    };
  }

  const failingChecks: string[] = [];
  const pendingChecks: string[] = [];

  for (const raw of statusCheckRollup) {
    const node = (raw ?? {}) as PrCheckNode;
    const label = typeof node.name === "string" && node.name.length > 0 ? node.name : "(sem nome)";
    if (node.status !== "COMPLETED") {
      pendingChecks.push(label);
      continue;
    }
    const conclusion = typeof node.conclusion === "string" ? node.conclusion : null;
    if (!conclusion || !PASSING_CONCLUSIONS.has(conclusion)) {
      failingChecks.push(label);
    }
  }

  if (failingChecks.length > 0) {
    return {
      verdict: "fail",
      failingChecks,
      pendingChecks,
      reason: `${failingChecks.length} check(s) reprovado(s): ${failingChecks.join(", ")}`,
    };
  }

  if (pendingChecks.length > 0) {
    return {
      verdict: "pending",
      failingChecks: [],
      pendingChecks,
      reason: `${pendingChecks.length} check(s) ainda não concluído(s): ${pendingChecks.join(", ")}`,
    };
  }

  return {
    verdict: "pass",
    failingChecks: [],
    pendingChecks: [],
    reason: `${statusCheckRollup.length} check(s), todos concluídos com sucesso.`,
  };
}

/** Açúcar pro chamador que só quer o booleano de autorização da condição 1. */
export function isPrChecksGateGreen(result: PrChecksGateResult): boolean {
  return result.verdict === "pass";
}
