/**
 * build-champions-callout.ts (#2725; #9236 — hoje só o Sorteio)
 *
 * Preenche o texto do box de início de mês (sorteio do erro intencional; até
 * #9236 também trazia os campeões do É IA?, que migraram pro box do É IA?) —
 * criado manualmente na edição 260701, agora reutilizável e auto-gerado (#2727 já deu suporte de renderer: renderIntroCallout
 * titleStyle="body" + sub-cabeçalho fully-bold + extractIntroCallout greedy).
 *
 * Puro e testável: recebe a config `raffle` (de `platform.config.json`) + o
 * label de data já resolvido, e retorna o
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
 * Monta o texto INTERNO do callout de intro do Sorteio (sem `**` externo).
 *
 * #9236 (pedido do editor 30/09/2026): o callout de início de mês ficou SÓ com
 * o Sorteio. O bloco de campeões do É IA? ("Os campeões do É IA? em {mês}:" +
 * 🥇/🥈/🥉 + "Veja o ranking completo") saiu daqui e passou a ser renderizado
 * dentro do box do É IA? (`renderLeaderboardTop1Row` em
 * `newsletter-render-html.ts`), nas 3 primeiras edições do mês. Por isso esta
 * função não recebe mais o pódio — o callout não depende dele.
 *
 * Efeito colateral desejado (#9242): sem apelidos de leitores na região de
 * intro, um e-mail mascarado `perli…@***` nunca mais soma `**` ímpar ao
 * markdown que `extractIntroCallout`/`stacked-intro-callouts` parseiam.
 *
 * O 1º parágrafo ("🎉 Sorteio") vira o título do callout (marcador 🎉 →
 * `hasCeremonyMarker`, `titleStyle="body"`), igual ao que o editor aplicou à
 * mão na edição 261001.
 */
export function buildRaffleCallout(
  raffle: RaffleConfig,
  raffleDateLabelResolved: string,
): string {
  const horaInicio = formatHourPt(raffle.hora_inicio);
  const horaFim = formatHourPt(raffle.hora_fim);

  return `🎉 Sorteio

O sorteio entre quem achou o erro intencional será ao vivo no dia ${raffleDateLabelResolved}, das ${horaInicio} às ${horaFim}, no [Google Meet](${raffle.meet_url}). Será uma caneca entre quem encontrou o erro intencional e outra entre os Patronos. Apareça para ver quem vai ganhar caneca e bater um papo sobre IA.`;
}
