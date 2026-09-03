/**
 * attribution-keys.ts (#7173, Passo 1)
 *
 * Primitivas PURAS de normalização/agrupamento/janela de atribuição, movidas
 * de `scripts/cohort-engagement.ts` para `scripts/lib/shared/` — sem NENHUM
 * import além de `node:`/npm, ao contrário do arquivo de origem.
 *
 * **Por que a mudança (medido em 02/09/2026):** `scripts/cohort-engagement.ts`
 * tem `import "dotenv/config"` no topo, e `scripts/lib/cac.ts` importava as
 * mesmas 6 primitivas DIRETO dele — então `await import("scripts/lib/cac.ts")`
 * num processo iniciado SEM `ADMIN_SECRET` no ambiente terminava COM a
 * variável populada (dotenv lê `.env` e seta `process.env` como side effect
 * do import). Um módulo "puro, sem I/O" carregando I/O na cadeia de imports
 * contamina qualquer teste do corpus que espere ambiente limpo. Este arquivo
 * não importa `dotenv` nem qualquer coisa que o faça — é o ponto de partida
 * correto para `scripts/lib/metrics/acquisition-class.ts` (F1, nunca importa
 * de `cohort-engagement.ts` nem de `cac.ts`).
 *
 * `scripts/cohort-engagement.ts` e `scripts/lib/cac.ts` RE-EXPORTAM destas
 * primitivas — nenhum consumidor existente muda de import.
 *
 * Nenhuma função aqui toca disco/rede/ambiente. @pure em todo o módulo.
 */

/**
 * Janela FECHADA de cadastro. Campos nomeados em vez de dois `number | null`
 * posicionais de propósito (achado do fleet review da PR #4751): as duas
 * bordas têm semânticas diferentes — uma inclusiva, outra exclusiva — e
 * posicionais adjacentes do mesmo tipo são trocáveis sem o compilador
 * reclamar.
 */
export interface CohortWindow {
  /** Epoch em segundos do início do dia de `--since`. Inclusivo. `null` = sem borda inferior. */
  since: number | null;
  /** Epoch em segundos do início do dia SEGUINTE ao de `--until`. Exclusivo. `null` = sem borda superior. */
  untilExclusive: number | null;
}

/**
 * Normaliza um valor de atribuição (utm_source ou referring_site):
 * null/undefined/"" → "__none__"; qualquer outro valor → lowercase trimmed.
 *
 * @pure
 */
export function normalizeKey(raw: unknown): string {
  if (raw == null) return "__none__";
  const s = String(raw).trim().toLowerCase();
  return s === "" ? "__none__" : s;
}

/**
 * Resolve a chave de grupo de um assinante: `utm_source` normalizado; se
 * ausente (__none__), cai para `referring_site` normalizado.
 *
 * @pure
 */
export function resolveGroupKey(sub: { utm_source?: string | null; referring_site?: string | null }): string {
  const utm = normalizeKey(sub.utm_source);
  if (utm !== "__none__") return utm;
  return normalizeKey(sub.referring_site);
}

/**
 * Converte "AAAA-MM-DD" no epoch (segundos, UTC) do INÍCIO daquele dia.
 * Lança se o formato for inválido — CLI guard trata a mensagem.
 *
 * @pure
 */
function parseDayToEpochSeconds(day: string, flag: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) {
    throw new Error(`${flag} inválido: "${day}" (esperado AAAA-MM-DD)`);
  }
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
  // `Date.UTC` NÃO devolve NaN para mês/dia fora de faixa — ele ROLA
  // (Date.UTC(2026, 12, 45) = 2027-02-14). Sem esta verificação de
  // ida-e-volta, uma data inválida seria aceita em silêncio e mediria uma
  // janela completamente diferente da pedida.
  const dt = new Date(ms);
  if (
    dt.getUTCFullYear() !== Number(y) ||
    dt.getUTCMonth() !== Number(mo) - 1 ||
    dt.getUTCDate() !== Number(d)
  ) {
    throw new Error(`${flag} inválido: "${day}" (data não existe)`);
  }
  return Math.floor(ms / 1000);
}

/**
 * Converte "AAAA-MM-DD" no epoch (segundos, UTC) do INÍCIO daquele dia — borda
 * INFERIOR inclusiva da janela.
 *
 * @pure
 */
export function parseSinceToEpochSeconds(since: string): number {
  return parseDayToEpochSeconds(since, "--since");
}

/**
 * Converte "AAAA-MM-DD" no epoch (segundos, UTC) que serve de limite
 * superior EXCLUSIVO — o início do dia SEGUINTE.
 *
 * A exclusividade é detalhe interno; a semântica exposta ao usuário é
 * inclusiva. Somar 86400 a uma meia-noite UTC é seguro: UTC não tem horário
 * de verão, e o Unix time nunca representa segundo bissexto — todo dia do
 * calendário tem exatamente 86400 nesse modelo.
 *
 * @pure
 */
export function parseUntilToEpochSecondsExclusive(until: string): number {
  return parseDayToEpochSeconds(until, "--until") + 86_400;
}

/**
 * Filtra registros por uma janela FECHADA de cadastro: `created` >= `since`
 * (inclusivo) e `created` < `untilExclusive`.
 *
 * Registro sem `created` é excluído quando QUALQUER borda é informada — não
 * há como verificar a condição, e assumir presente enviesaria a métrica.
 *
 * @pure
 */
export function filterWindow<T extends { created?: number | null }>(
  items: T[],
  window: CohortWindow,
): T[] {
  const { since, untilExclusive } = window;
  if (since == null && untilExclusive == null) return items;
  return items.filter((item) => {
    if (typeof item.created !== "number") return false;
    if (since != null && item.created < since) return false;
    if (untilExclusive != null && item.created >= untilExclusive) return false;
    return true;
  });
}
