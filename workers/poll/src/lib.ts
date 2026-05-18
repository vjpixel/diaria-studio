/**
 * workers/poll/src/lib.ts — helpers puros do Worker `poll`.
 *
 * Funções aqui não dependem de Cloudflare runtime (KV, env, crypto.subtle,
 * fetch). Extraído de `index.ts` pra permitir testes Node sem mock do
 * Worker runtime (#1083).
 */

// ── Trailing slash normalization (#1319) ────────────────────────────────────

/**
 * Retorna o path sem trailing slash se redirect for necessário, ou null se
 * o path original já está canonical. Usado pra emitir 301 → versão sem slash
 * antes do router que faz strict equality match.
 *
 * Regras:
 * - Raiz "/" preservada (não é trailing-slash redundante)
 * - /img/{key} preservado (prefix match, key pode terminar em "/" raro)
 * - Tudo mais com trailing slash redireciona pra versão sem
 */
export function redirectTargetForTrailingSlash(path: string): string | null {
  if (path.length > 1 && path.endsWith("/") && !path.startsWith("/img/")) {
    return path.slice(0, -1);
  }
  return null;
}

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

// ── Period label (#1083) ─────────────────────────────────────────────────────

/**
 * Retorna o nome do mês em pt-BR (capitalizado) baseado em `now` interpretado
 * em BRT (UTC-3). Usado como `periodLabel` no leaderboard.
 *
 * Pure pra testabilidade — caller passa Date determinístico em testes.
 *
 * Exemplo: `currentPeriodLabelBrt(new Date('2026-06-01T02:30:00Z'))` → "Maio"
 * (UTC-3 ainda é 31 de maio às 23:30 BRT).
 */
export function currentPeriodLabelBrt(now: Date): string {
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const monthName = MONTH_NAMES_PT[brt.getUTCMonth()];
  return monthName.charAt(0).toUpperCase() + monthName.slice(1);
}

// ── Reset mensal do leaderboard (#1077) ─────────────────────────────────────

/**
 * Retorna a chave de archive `score-archive:{YYYY-MM}:{email}` pra arquivar
 * o score antes do reset. YYYY-MM é o mês **anterior** (acabou de fechar) em
 * BRT — quando o cron roda no dia 1 às 03:01 UTC (00:01 BRT), o mês a arquivar
 * é o mês prévio.
 *
 * Pure — caller passa `now` determinístico em testes.
 */
export function archiveKeyForReset(email: string, now: Date): string {
  // Subtrair 1 dia pra cair no mês anterior (cron roda no dia 1 do novo mês)
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  brt.setUTCDate(0); // dia 0 do mês atual = último dia do mês anterior
  const year = brt.getUTCFullYear();
  const month = String(brt.getUTCMonth() + 1).padStart(2, "0");
  return `score-archive:${year}-${month}:${email}`;
}

/** Retorna a label do mês que acabou de fechar (usado no reset-log). */
export function previousPeriodLabelBrt(now: Date): string {
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  brt.setUTCDate(0); // dia 0 do mês atual = último dia do mês anterior
  const monthName = MONTH_NAMES_PT[brt.getUTCMonth()];
  return monthName.charAt(0).toUpperCase() + monthName.slice(1);
}
