/**
 * monthly-eia-prev-result.ts (#2948)
 *
 * Follow-up de #2709: aquele PR adicionou o SUPORTE de render (opt-in) da
 * linha "Resultado da última edição: X% acertaram" no bloco É IA? mensal
 * (`renderEia`/`draftToEmail` em `monthly-render.ts`, param
 * `prevResultLine`/`eiaPrevResultLine`), mas nenhum caller buscava o dado
 * real — este módulo faz esse wiring.
 *
 * Fonte: Worker `poll` → `GET /stats?edition={cicloAnterior}&brand=clarice`
 * — o MESMO endpoint que a diária consome via `fetch-poll-stats.ts`
 * (`GET /stats?edition=` sem `&brand=`, default "diaria" no Worker). Reusa
 * `fetchPollStats` (fetch + threshold MIN_RESPONSES=5) e `buildPrevResultLine`
 * (texto + regra de below_threshold) em vez de reinventar — mesmos helpers
 * que a diária já usa em `eia-compose.ts`.
 *
 * "Edição anterior" pro É IA? mensal é o CICLO do mês de conteúdo anterior —
 * `eiaEditionFromYymm(prevYymm(yymm))`. Ex: yymm atual "2606" (junho) → mês
 * de conteúdo anterior "2605" (maio) → ciclo "2605-06" (a mesma key de voto
 * que `renderEia` usou pra montar a URL de voto daquela edição).
 *
 * Degrada gracioso (retorna `null`, nunca lança) quando: 1ª edição do ano
 * (nenhum ciclo anterior votado), poll sem votos, ou abaixo do piso de
 * confiança — nesses casos o render omite a linha (comportamento opt-in do
 * #2709, não um erro).
 */

import { fetchPollStats, type PollStatsOutput, type PollBrand } from "../../fetch-poll-stats.ts";
import { buildPrevResultLine } from "../../eia-compose.ts";
import { eiaEditionFromYymm } from "./monthly-render.ts";

/**
 * Pure: mês de conteúdo anterior no formato YYMM.
 * "2606" → "2605"; "2601" → "2512" (virada de ano).
 */
export function prevYymm(yymm: string): string {
  if (!/^\d{4}$/.test(yymm)) throw new Error(`YYMM inválido: ${yymm}`);
  const yy = Number(yymm.slice(0, 2));
  const mm = Number(yymm.slice(2, 4));
  if (mm < 1 || mm > 12) throw new Error(`mês inválido: ${yymm}`);
  const prevMm = mm === 1 ? 12 : mm - 1;
  const prevYy = mm === 1 ? yy - 1 : yy;
  return `${String(prevYy).padStart(2, "0")}${String(prevMm).padStart(2, "0")}`;
}

export interface FetchMonthlyEiaPrevResultOptions {
  workerUrl?: string;
  /** Injeção pra teste (#633) — evita mockar rede/fetch global. */
  fetchPollStatsImpl?: (
    edition: string,
    opts?: { brand?: PollBrand; workerUrl?: string },
  ) => Promise<PollStatsOutput>;
}

/**
 * Busca o "% acertaram" do É IA? mensal do ciclo de conteúdo anterior
 * (brand=clarice) e monta a linha pronta pra passar como `eiaPrevResultLine`
 * em `draftToEmail` (que repassa pra `renderEia`). `null` quando não há dado
 * confiável — ver doc do módulo.
 *
 * @param yymm mês de CONTEÚDO do ciclo atual (ex: "2606").
 */
export async function fetchMonthlyEiaPrevResultLine(
  yymm: string,
  opts: FetchMonthlyEiaPrevResultOptions = {},
): Promise<string | null> {
  const prevEdition = eiaEditionFromYymm(prevYymm(yymm));
  const fetchImpl = opts.fetchPollStatsImpl ?? fetchPollStats;
  const stats = await fetchImpl(prevEdition, { brand: "clarice", workerUrl: opts.workerUrl });
  return buildPrevResultLine(stats);
}
