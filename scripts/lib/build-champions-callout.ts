/**
 * build-champions-callout.ts (#2725)
 *
 * Preenche o texto do box de início de mês (campeões do É IA? + sorteio do
 * erro intencional) — criado manualmente na edição 260701, agora reutilizável
 * e auto-gerado (#2727 já deu suporte de renderer: renderIntroCallout
 * titleStyle="body" + sub-cabeçalho fully-bold + extractIntroCallout greedy).
 *
 * Puro e testável: recebe o `podium` (top-3 do leaderboard, de
 * `_internal/04-leaderboard-top1.json`) + a config `raffle` (de
 * `platform.config.json`) + os labels de mês/data já resolvidos, e retorna o
 * texto INTERNO do callout (sem o `**` de wrap externo — mesmo contrato de
 * `extractIntroCallout`/`renderIntroCallout`: quem escreve o `**...**` no
 * markdown bruto é o caller, `inject-champions-callout.ts`).
 *
 * Template de referência: `data/snippets/intro-campeoes-sorteio.md`.
 */

/** Mirror de MONTH_NAMES_PT (workers/poll/src/lib.ts, #1080) — duplicado aqui
 * pra evitar import cross-package (mesma convenção de `editionToMonthSlug`
 * em fetch-leaderboard-top1.ts, #1345). */
export const MONTH_NAMES_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

export interface PodiumEntry {
  nickname: string;
  rank: number;
}

export interface RaffleConfig {
  meet_url: string;
  /** Mês (YYYY-MM) + dia do mês (do mês da EDIÇÃO corrente, não do mês
   * celebrado) em que o sorteio ao vivo acontece — #4583: substitui o antigo
   * `day_of_month` fixo, que nascia desatualizado todo mês (não existe "dia
   * fixo do sorteio"). `mes` é validado pelo caller
   * (`inject-champions-callout.ts`) contra o mês da edição ANTES de chegar
   * aqui — esta função só consome `dia` já validado. Ex: `{ mes: "2026-07",
   * dia: 2 }` → sorteio "2 de julho" na edição 260701. */
  sorteio_do_mes: {
    mes: string;
    dia: number;
  };
  /** "HH:MM" 24h. */
  hora_inicio: string;
  /** "HH:MM" 24h. */
  hora_fim: string;
}

/** Pure: "YYYY-MM" → nome do mês em PT-BR minúsculo. null se slug malformado
 * ou mês fora de 01-12. */
export function monthLabelFromSlug(slug: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(slug);
  if (!m) return null;
  const idx = parseInt(m[2], 10) - 1;
  return MONTH_NAMES_PT[idx] ?? null;
}

/** Pure: "HH:MM" → rótulo PT-BR — "13:30" → "13h30", "14:00" → "14h" (omite
 * minutos quando :00). Input malformado retorna verbatim (fail-open, o texto
 * sai com o valor cru em vez de quebrar a geração). */
export function formatHourPt(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const hh = m[1];
  const mm = m[2];
  return mm === "00" ? `${hh}h` : `${hh}h${mm}`;
}

/** Pure: "YYYY-MM" + dia → "{dia} de {mês}" (mês da EDIÇÃO corrente — quando o
 * sorteio ao vivo acontece — não o mês celebrado pelo pódio). null se slug
 * malformado. */
export function raffleDateLabel(editionMonthSlug: string, dayOfMonth: number): string | null {
  const monthName = monthLabelFromSlug(editionMonthSlug);
  if (!monthName) return null;
  return `${dayOfMonth} de ${monthName}`;
}

/**
 * Monta o texto INTERNO do box campeões/sorteio (sem `**` externo).
 *
 * Requer os 3 ranks (1, 2, 3) presentes no `podium` — sem pódio completo não
 * há box (retorna `null`, caller decide logar + pular a injeção, #2725 item 4:
 * "em meses sem o box... não injetar").
 *
 * `leaderboardUrl` (#4506, pedido do editor 260803): link pro ranking
 * completo, logo após o pódio top-3. Opcional/fail-open — omitido quando
 * `undefined` (ex: `poll.worker_url` ausente em `platform.config.json`),
 * nunca bloqueia a geração do box por causa dele.
 */
export function buildChampionsCallout(
  podium: PodiumEntry[],
  raffle: RaffleConfig,
  championsMonthLabel: string,
  raffleDateLabelResolved: string,
  leaderboardUrl?: string,
): string | null {
  const byRank = new Map(podium.map((p) => [p.rank, p.nickname]));
  const first = byRank.get(1);
  const second = byRank.get(2);
  const third = byRank.get(3);
  if (!first || !second || !third) return null;

  const horaInicio = formatHourPt(raffle.hora_inicio);
  const horaFim = formatHourPt(raffle.hora_fim);

  const leaderboardLine = leaderboardUrl
    ? `\n\n[Veja o ranking completo](${leaderboardUrl})`
    : "";

  return `🎉 Os campeões do É IA? em ${championsMonthLabel}:

🥇 ${first}

🥈 ${second}

🥉 ${third}${leaderboardLine}

Sorteio

O sorteio entre quem achou o erro intencional será ao vivo no dia ${raffleDateLabelResolved}, das ${horaInicio} às ${horaFim}, no [Google Meet](${raffle.meet_url}). Será uma caneca entre quem encontrou o erro intencional e outra entre os Patronos. Apareça para ver quem vai ganhar caneca e bater um papo sobre IA.`;
}
