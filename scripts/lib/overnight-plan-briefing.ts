/**
 * scripts/lib/overnight-plan-briefing.ts (#7497)
 *
 * Fecha a lacuna que a #7497 descreve: até esta issue, `plan.json` não
 * registrava POR QUE a Fase 0 do `/diaria-overnight`/`/diaria-continuo` não
 * fez a `AskUserQuestion` do briefing numa dada rodada — o silêncio (a)
 * "rodou sem editor presente" e (b) "havia editor e a pergunta não foi
 * feita, contrariando o passo 5 da Fase 0" ficavam indistinguíveis a partir
 * do plano sozinho. `batch_approval` já carregava 3 causas fundidas
 * (`--dry-run`/auto sem gate; resume de plano legado; briefing feito sem o
 * item de agrupamento) e, na prática, ganhou uma 4ª ("não houve briefing
 * nenhum") sem nenhum campo dedicado a dizer isso.
 *
 * Achado concreto que motivou (05/09/2026): `data/overnight/260905/plan.json`
 * tinha `batch_approval: "default_proposed"` + `loop_estendido: false` +
 * `machine_id: "helios"` — compatível tanto com "rodou sem editor" quanto
 * com "defeito silencioso", sem nada no plano que distinguisse os dois. A
 * investigação da #7493 provou que a FONTE de perguntas (`precisa-resposta`)
 * tinha secado, mas não conseguiu fechar se o fallback de loop-estendido
 * ainda estava sendo perguntado.
 *
 * Este módulo é só o guard de FORMATO (mesmo papel que
 * `overnight-plan-motivo.ts` cumpre para `motivo` de issue `pulada`): o
 * campo raiz `briefing` do `plan.json`, uma vez presente, precisa ter
 * `reason` dentro do vocabulário fechado e consistente com `asked`. Plano
 * sem o campo (anterior a este PR) é tratado como legado — fail-open, mesma
 * disciplina de `session_id`/`machine_id`/`in_round` ausentes.
 *
 * Puro (`checkOvernightPlanBriefing`) + CLI em
 * `scripts/check-overnight-plan-briefing.ts`.
 *
 * @see .claude/skills/diaria-overnight/SKILL.md Fase 0 passo 5 (schema +
 *      instrução de quando gravar cada `reason`)
 * @see scripts/lib/overnight-plan-motivo.ts (padrão irmão, motivo de issue
 *      pulada em vez de reason de briefing)
 */

/**
 * Vocabulário fechado de `briefing.reason`:
 * - `"asked"` — a `AskUserQuestion` do briefing (precisa-resposta e/ou
 *   loop-estendido) foi de fato invocada nesta rodada.
 * - `"dry-run"` — modo `--dry-run`/`--no-gates`: sem gate humano por
 *   desenho, a pergunta nunca deveria ter sido feita.
 * - `"plano-legado"` — resume de um `plan.json` anterior a este campo, ou
 *   rodada interrompida antes do passo 5 gravar o valor real.
 * - `"sem-editor-presente"` — sinal disponível (rodada headless/cron, sem
 *   indício de sessão interativa) sugere que não havia editor pra
 *   perguntar. É heurística, não prova (ver docstring da SKILL — detectar
 *   "editor presente" com certeza pode não ser possível).
 * - `"desconhecido"` — nenhuma das causas legítimas acima explica a
 *   ausência da pergunta. Este é o valor que torna (b) do relato acima
 *   visível: rodada com sinal de editor presente e `asked: false` sem causa
 *   legítima registrada é candidata a defeito, não a silêncio esperado.
 */
export const OVERNIGHT_BRIEFING_REASONS = [
  "asked",
  "dry-run",
  "plano-legado",
  "sem-editor-presente",
  "desconhecido",
] as const;

export type OvernightBriefingReason = (typeof OVERNIGHT_BRIEFING_REASONS)[number];

const VALID_REASONS: ReadonlySet<string> = new Set(OVERNIGHT_BRIEFING_REASONS);

/** Type guard: `reason` pertence ao vocabulário fechado `OVERNIGHT_BRIEFING_REASONS`. */
export function isOvernightBriefingReason(reason: string): reason is OvernightBriefingReason {
  return VALID_REASONS.has(reason);
}

export interface OvernightPlanBriefingLike {
  asked?: unknown;
  reason?: unknown;
  precisa_resposta_count?: unknown;
  loop_estendido_asked?: unknown;
  batch_approval_asked?: unknown;
  [key: string]: unknown;
}

export interface OvernightPlanRootLike {
  briefing?: unknown;
  [key: string]: unknown;
}

export type OvernightPlanBriefingCheckResult =
  | { status: "ok"; present: boolean }
  | { status: "invalid"; problems: string[] };

/**
 * Pure: valida o campo raiz `briefing` de um plan.json já parseado.
 *
 * Campo ausente → `{ status: "ok", present: false }` (fail-open, plano
 * anterior a este PR — mesma disciplina de `session_id`/`in_round`
 * ausentes documentada no SKILL.md).
 *
 * Campo presente → valida: `asked` é boolean; `reason` está no vocabulário
 * fechado; `reason === "asked"` se e somente se `asked === true` (os dois
 * campos nunca podem discordar — é justamente essa discordância que
 * reintroduziria a ambiguidade que esta issue fecha); `precisa_resposta_count`
 * é número ≥ 0 quando presente; `loop_estendido_asked`/`batch_approval_asked`
 * são boolean quando presentes. Nunca lança.
 */
export function checkOvernightPlanBriefingFromRoot(
  plan: OvernightPlanRootLike,
): OvernightPlanBriefingCheckResult {
  if (plan.briefing === undefined || plan.briefing === null) {
    return { status: "ok", present: false };
  }

  const problems: string[] = [];
  const briefing = plan.briefing as OvernightPlanBriefingLike;

  if (typeof briefing !== "object" || Array.isArray(briefing)) {
    return { status: "invalid", problems: ["briefing não é um objeto"] };
  }

  const asked = briefing.asked;
  if (typeof asked !== "boolean") {
    problems.push(`briefing.asked ausente ou não-boolean: ${JSON.stringify(asked)}`);
  }

  const reason = briefing.reason;
  if (typeof reason !== "string" || !isOvernightBriefingReason(reason)) {
    problems.push(
      `briefing.reason fora do vocabulário fechado (${OVERNIGHT_BRIEFING_REASONS.join(", ")}): ${JSON.stringify(reason)}`,
    );
  } else if (typeof asked === "boolean") {
    const shouldBeAsked = reason === "asked";
    if (asked !== shouldBeAsked) {
      problems.push(
        `briefing.asked (${asked}) inconsistente com briefing.reason ("${reason}") — "asked" exige reason "asked" e vice-versa`,
      );
    }
  }

  if (briefing.precisa_resposta_count !== undefined) {
    const count = briefing.precisa_resposta_count;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      problems.push(`briefing.precisa_resposta_count inválido: ${JSON.stringify(count)}`);
    }
  }

  for (const field of ["loop_estendido_asked", "batch_approval_asked"] as const) {
    const value = briefing[field];
    if (value !== undefined && typeof value !== "boolean") {
      problems.push(`briefing.${field} deveria ser boolean: ${JSON.stringify(value)}`);
    }
  }

  if (problems.length > 0) return { status: "invalid", problems };
  return { status: "ok", present: true };
}

/**
 * Pure: `true` quando o `briefing` do plano está presente, estruturalmente
 * válido, e sinaliza o cenário (b) do relato da #7497 — rodada em que a
 * pergunta não foi feita (`asked: false`) sem nenhuma causa legítima
 * conhecida (`reason: "desconhecido"`). Não é veredito de defeito
 * confirmado — é o sinal barato que a issue pediu para o relatório da
 * Fase 2 poder mostrar em vez de deixar passar em silêncio.
 */
export function isSuspiciousMissingBriefing(plan: OvernightPlanRootLike): boolean {
  const briefing = plan.briefing as OvernightPlanBriefingLike | undefined;
  if (!briefing || typeof briefing !== "object") return false;
  return briefing.asked === false && briefing.reason === "desconhecido";
}
