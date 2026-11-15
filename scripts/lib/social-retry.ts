/**
 * scripts/lib/social-retry.ts (#13076)
 *
 * `--retry` por id dos publicadores sociais. A retomada pula `send_unknown`
 * (RESUME_SKIP_STATUSES, #13074): repostar sem conferir o perfil duplicaria o
 * post. A única saída era `--no-skip-existing`/`--force`, que desliga o skip de
 * TODOS os ids e republica os que já saíram. O Threads resolveu isso no #11105
 * com `--retry d2`; aqui a mesma regra, compartilhada com o Instagram (ids
 * d1/d2/d3/um) e o carrossel semanal (ids = canais).
 */
import { RESUME_SKIP_STATUSES, type PostEntry } from "./social-published-store.ts";

/** O que `--retry` aceita refazer: nada saiu (`failed`) ou o editor conferiu que não saiu (`send_unknown`). */
export const RETRYABLE_STATUSES: ReadonlySet<PostEntry["status"]> = new Set<PostEntry["status"]>(["failed", "send_unknown"]);

/**
 * Lê o valor de `--retry`. `null` = flag ausente (comportamento de sempre).
 * Flag sem valor ou id fora de `accepted` = erro. Ids em minúsculas.
 */
export function parseRetryIdList(
  raw: string | undefined,
  flagWithoutValue: boolean,
  accepted: readonly string[],
  opts: { noun: string; example: string },
): { ok: true; ids: Set<string> | null } | { ok: false; error: string } {
  if (raw === undefined && !flagWithoutValue) return { ok: true, ids: null };
  const ids = (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (ids.length === 0) return { ok: false, error: `--retry exige ${opts.noun} a re-tentar (ex: ${opts.example}; aceitos: ${accepted.join(", ")})` };
  const invalid = ids.filter((id) => !accepted.includes(id));
  if (invalid.length > 0) return { ok: false, error: `--retry: id(s) inválido(s) ${invalid.join(", ")} (aceitos: ${accepted.join(", ")})` };
  return { ok: true, ids: new Set(ids) };
}

export type ResumeRetryDecision =
  | { action: "dispatch" }
  /** Retomada normal: o id já tem entrada que não se refaz. */
  | { action: "skip-existing"; existing: PostEntry }
  /** Fora do `--retry`: não é tocado nesta execução. */
  | { action: "not-selected" }
  /** Pedido em `--retry`, mas o post já saiu ou está agendado: refazer duplicaria. */
  | { action: "retry-refused"; existing: PostEntry };

/**
 * Decide se um id entra nesta execução. Puro.
 *
 * `entries` = as entradas do store para esse id (mesma plataforma/destaque/página).
 * Com `--retry`: só os ids pedidos, e só se nenhuma entrada estiver fora de
 * `RETRYABLE_STATUSES` (sem entrada também despacha: nada saiu). Sem `--retry`:
 * a retomada de sempre (`skipExisting` pula o que está em RESUME_SKIP_STATUSES).
 */
export function decideResumeOrRetry(
  id: string,
  entries: readonly PostEntry[],
  opts: { skipExisting: boolean; retryIds: ReadonlySet<string> | null },
): ResumeRetryDecision {
  if (opts.retryIds) {
    if (!opts.retryIds.has(id)) return { action: "not-selected" };
    const blocking = entries.find((p) => !RETRYABLE_STATUSES.has(p.status));
    if (blocking) return { action: "retry-refused", existing: blocking };
    return { action: "dispatch" };
  }
  if (opts.skipExisting) {
    const existing = entries.find((p) => RESUME_SKIP_STATUSES.has(p.status));
    if (existing) return { action: "skip-existing", existing };
  }
  return { action: "dispatch" };
}
