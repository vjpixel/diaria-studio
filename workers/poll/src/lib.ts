/**
 * workers/poll/src/lib.ts — helpers puros do Worker `diar-ia-poll`.
 *
 * Funções aqui não dependem de Cloudflare runtime (KV, env, crypto.subtle,
 * fetch). Extraído de `index.ts` pra permitir testes Node sem mock do
 * Worker runtime (#1083).
 */

// ── Date formatting (#1080) ──────────────────────────────────────────────────

export const MONTH_NAMES_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** AAMMDD → "10 de maio de 2026". Memória `feedback_no_aammdd_for_subscribers.md`.
 * Invalid input (não-AAMMDD, MM/DD fora de range) → retorna input cru (safe). */
export function formatEditionDate(edition: string): string {
  if (!/^\d{6}$/.test(edition)) return edition;
  const yy = parseInt(edition.slice(0, 2), 10);
  const mm = parseInt(edition.slice(2, 4), 10);
  const dd = parseInt(edition.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return edition;
  return `${dd} de ${MONTH_NAMES_PT[mm - 1]} de ${2000 + yy}`;
}

// ── HTML escape (#1083) ──────────────────────────────────────────────────────

/** Escape HTML attribute/text — previne XSS quando valores user-controlled
 * (ex: email do subscriber) são interpolados no votePageHtml form. */
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── valid_editions validation (#1086) ────────────────────────────────────────

/** Parseia raw KV value de `valid_editions` retornando set ou null se ausente.
 * Corrupted JSON ou shape inválido → console.error + null (fail-open). */
export function parseValidEditions(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error("[parseValidEditions] not array:", typeof parsed);
      return null;
    }
    return parsed.filter((x): x is string => typeof x === "string");
  } catch (e) {
    console.error("[parseValidEditions] JSON parse failed:", (e as Error).message);
    return null;
  }
}

/** True se edition está autorizada a receber votos. null/empty = aceita qualquer (compat). */
export function isValidEdition(set: string[] | null, edition: string): boolean {
  if (!set || set.length === 0) return true;
  return set.includes(edition);
}
