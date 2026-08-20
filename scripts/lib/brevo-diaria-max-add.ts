/**
 * brevo-diaria-max-add.ts (#5772)
 *
 * Deriva `--max-add N` pro dispatch automático do canal Brevo diária na
 * Etapa 5 (`brevo-diaria-stage5-dispatch.ts`) — substitui o gate humano do
 * Passo 4 de `/diaria-brevo-diaria` (que continua existindo pro disparo
 * manual/ad-hoc, ver SKILL.md) por um cálculo determinístico, coerente com
 * "Perguntar é exceção" (CLAUDE.md, #5321).
 *
 * Fórmula (decisão do editor, comentário 2026-08-20 da issue #5772):
 *   N = max(0, targetTotal - totalAtual)
 *
 * `targetTotal` vem de `platform.config.json` → `brevo_diaria.stage5_target_total`
 * (hoje 290, constante distinta de `daily_send_cap` — ver nota no config).
 * `totalAtual` é `computeCurrentActiveCount` (sync-pending-to-brevo.ts) sobre
 * o store local (`data/brevo-diaria/contacts.json`) — leitura puramente
 * local, sem chamada de rede, mesma fonte que `sync-pending-to-brevo.ts` já
 * usa pra calcular `fila: X/Y ocupados`.
 *
 * Tudo aqui é puro/testável — I/O (existência do store, leitura do config)
 * fica isolado no caller (`brevo-diaria-stage5-dispatch.ts`).
 */

/** Pura — a fórmula em si, sem I/O. */
export function computeStage5MaxAdd(totalAtual: number, targetTotal: number): number {
  return Math.max(0, targetTotal - totalAtual);
}

export type ResolveStage5MaxAddResult =
  | { ok: true; totalAtual: number; targetTotal: number; maxAdd: number }
  | { ok: false; reason: string };

/**
 * Pura — resolve o resultado completo (ou o motivo de skip) a partir de
 * inputs já carregados pelo caller. Nunca lança — qualquer input ausente/
 * inválido vira `{ok: false, reason}`, que o dispatcher trata como "pular o
 * canal com aviso" (fail-soft, #5772 — falha na derivação de `--max-add`
 * nunca deve travar os demais publicadores da Etapa 5).
 */
export function resolveStage5MaxAdd(params: {
  storeExists: boolean;
  currentActiveCount: number;
  targetTotal: number | undefined | null;
}): ResolveStage5MaxAddResult {
  if (!params.storeExists) {
    return {
      ok: false,
      reason:
        "store ausente (data/brevo-diaria/contacts.json) — provável junction data/ (OneDrive) não montada. " +
        "Pulando o canal Brevo diária nesta rodada da Etapa 5.",
    };
  }
  const { targetTotal } = params;
  if (targetTotal == null || !Number.isFinite(targetTotal) || targetTotal < 0) {
    return {
      ok: false,
      reason:
        "brevo_diaria.stage5_target_total ausente/inválido em platform.config.json — sem este default, a " +
        "Etapa 5 não sabe até quanto crescer a fila sem perguntar (#5772). Pulando o canal Brevo diária " +
        "nesta rodada; configure o campo pra reativar.",
    };
  }
  const totalAtual = params.currentActiveCount;
  return { ok: true, totalAtual, targetTotal, maxAdd: computeStage5MaxAdd(totalAtual, targetTotal) };
}
