/**
 * #3011: comparação centralizada entre o timestamp de uma seção com dado
 * PRÉ-COMPUTADO (KV, atualizado por cron separado — #2932) e o timestamp do
 * cabeçalho da dashboard ("Dados em tempo real — carregado às {now} BRT").
 *
 * Sem essa comparação, uma tabela pré-computada defasada em horas/dias podia
 * ser lida como se fosse do MESMO instante do cabeçalho — já causou decisão
 * errada uma vez (ver #1172 na memória do projeto). O pedido do editor
 * (#3011) foi: mostrar a nota de "atualizado em Y" só quando o dado
 * pré-computado DIVERGE do cabeçalho (não sempre, como hoje em algumas
 * seções) — mas sem virar ruído por jitter de poucos segundos/minutos entre
 * o cron gravar o KV e o request do dashboard renderizar o cabeçalho.
 *
 * Função pura: nenhuma seção deve reimplementar essa decisão — sempre chamar
 * `shouldShowStalenessNote` e gatear a nota (texto/formato já existente,
 * inalterado) por ela.
 */

/** Tolerância default (minutos) — absorve jitter comum entre cron e request. */
export const DEFAULT_STALENESS_TOLERANCE_MINUTES = 5;

/**
 * Retorna `true` quando o timestamp da seção (`sectionIso`, ISO 8601) diverge
 * do timestamp do cabeçalho (`headerDate`) além da tolerância — ou seja,
 * quando a nota de "atualizado em ..." deve ser exibida.
 *
 * `sectionIso` ausente/não-parseável → `false` (sem dado, sem nota — cada
 * seção já trata esse caso separadamente com seu próprio stub gracioso).
 *
 * A comparação é feita pela diferença absoluta em milissegundos contra
 * `toleranceMinutes`: qualquer divergência de dia (sempre >> tolerância) ou
 * de hora dentro do MESMO dia (tipicamente >> tolerância, exceto jitter de
 * poucos minutos perto de fronteiras) resulta em `true`; jitter de segundos
 * a poucos minutos entre o cron gravar o KV e o request atual resulta em
 * `false`.
 */
export function shouldShowStalenessNote(
  sectionIso: string | null | undefined,
  headerDate: Date,
  toleranceMinutes: number = DEFAULT_STALENESS_TOLERANCE_MINUTES,
): boolean {
  if (!sectionIso) return false;
  const sectionMs = Date.parse(sectionIso);
  if (!Number.isFinite(sectionMs)) return false;
  const diffMs = Math.abs(headerDate.getTime() - sectionMs);
  return diffMs > toleranceMinutes * 60_000;
}
