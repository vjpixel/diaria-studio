/**
 * scripts/lib/metrics/kit-active-history.ts (#7916, fatia 3/N)
 *
 * Série histórica DIÁRIA da contribuição do Kit pra `base-ativa` — o que a
 * fatia 1/N (docstring de `studio-metrics.ts`) documentou como lacuna
 * conhecida: "o store não guarda série histórica do Kit por dia, só o
 * estado ATUAL, e reusar a contagem de HOJE como se fosse 'ontem' inflaria/
 * desinflaria a variação calculada de forma silenciosa". Esta fatia grava
 * 1 snapshot por dia (contagem de `subscription` Kit ativa + frescor,
 * `getKitActiveSummary`) toda vez que a task agendada `Diaria-Kit-Roster-
 * Ingest` roda com `--write` (ver `diaria-subscribers-ingest-kit.ts`) — sem
 * cron novo, sem chamada de rede nova: piggyback no ingest que já existe.
 *
 * ## Formato: JSONL append-only, mesmo padrão de `captura-log.jsonl`
 *
 * Fica FORA do store SQLite de propósito, mesma razão de `captura-log.jsonl`
 * (docstring de `captura-log.ts`): o schema do #6464 descreve o ESTADO
 * ATUAL de um assinante, não uma série temporal agregada — misturar as duas
 * coisas na mesma tabela obrigaria uma tabela de fatos temporal nova dentro
 * do store, um escopo maior do que esta fatia pede.
 *
 * Append-only, NUNCA idempotente no arquivo: rodar a ingestão 2x no mesmo
 * dia grava 2 linhas com o mesmo `dia` — `findKitActiveCountForDay` resolve
 * por ÚLTIMA linha do dia (mesmo espírito de "captura-log ganha 1 linha por
 * EXECUÇÃO", não por dia lógico) — a leitura mais recente do dia já
 * reflete o estado mais atualizado do store até aquele ponto.
 *
 * ## `dia` é BRT, não UTC
 *
 * Mesmo cuidado de `isoToBrtDay` (`acquisition-cohort.ts`) e `brtDayKey`
 * (`captura-log.ts`) — uma ingestão de madrugada UTC pode cair no dia
 * ANTERIOR em BRT. Reimplementado aqui via `unixSecondsToBrtDate`
 * (`beehiiv-publish-date.ts`) em vez de importar de `acquisition-cohort.ts`,
 * que é módulo de domínio de coorte de assinante — este arquivo não deveria
 * depender dele só por uma conversão de fuso de 3 linhas (mesma disciplina
 * documentada na docstring de `brtDayKey`).
 *
 * Módulo PURO (sem I/O) — o append em si (`appendFileSync`) e a leitura do
 * arquivo (`readFileSync`) ficam no CLI/camada de leitura chamadores
 * (`diaria-subscribers-ingest-kit.ts` escreve; `studio-metrics.ts` lê),
 * mesmo padrão do resto do épico #7172/#6464.
 */

import { unixSecondsToBrtDate } from "../beehiiv-publish-date.ts";

export interface KitActiveHistoryEntry {
  /** `AAAA-MM-DD`, fronteira BRT — o dia lógico deste snapshot (derivado de
   *  `captured_at`, nunca informado solto pelo chamador, pra impedir uma
   *  linha com `dia` divergente do timestamp real da captura). */
  dia: string;
  /** ISO 8601 — quando a captura RODOU (não necessariamente meia-noite do
   *  `dia`). Preservado pra depuração e pra eventual re-derivação de `dia`
   *  se a fórmula de fuso mudar no futuro. */
  captured_at: string;
  /** `KitActiveSummary.count` no momento da captura — `subscription` com
   *  `platform='kit' AND status='active'` no store. Nunca `null`: só
   *  gravamos linha quando a contagem foi de fato observável (o chamador
   *  decide se grava; este módulo não representa "sem dado" como linha). */
  count: number;
  /** `KitActiveSummary.asOf` no momento da captura — `null` quando
   *  `count === 0` (nenhuma linha Kit ativa a datar), mesma semântica de
   *  `KitActiveSummary.asOf`. */
  asOf: string | null;
}

/** Constrói 1 entry pronta pra serializar — função pura, sem timestamp
 *  implícito (o chamador passa `capturedAt`, nunca `new Date()` aqui, mesmo
 *  padrão de `buildCapturaLogEntry`). `capturedAt` inválido (não parseável
 *  como Date) lança — o chamador (CLI) já tem um `capturedAt` válido de
 *  `new Date().toISOString()`; propagar um erro aqui é melhor que gravar
 *  `dia: "Invalid Date"` em silêncio. @pure */
export function buildKitActiveHistoryEntry(input: {
  capturedAt: string;
  count: number;
  asOf: string | null;
}): KitActiveHistoryEntry {
  const ms = new Date(input.capturedAt).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`buildKitActiveHistoryEntry: capturedAt inválido: ${input.capturedAt}`);
  }
  return {
    dia: unixSecondsToBrtDate(Math.floor(ms / 1000)),
    captured_at: input.capturedAt,
    count: input.count,
    asOf: input.asOf,
  };
}

/** Serializa 1 entry como 1 linha JSONL (com o `\n` final). @pure */
export function serializeKitActiveHistoryEntry(entry: KitActiveHistoryEntry): string {
  return JSON.stringify(entry) + "\n";
}

/**
 * Parseia o conteúdo bruto de `kit-active-history.jsonl` em entries —
 * linhas em branco e linhas corrompidas (JSON inválido, ou sem os 4 campos
 * esperados) são IGNORADAS silenciosamente, nunca lançam — mesmo padrão de
 * `loadCapturaLog` (`studio-metrics.ts`): 1 linha ruim não pode derrubar a
 * série inteira. @pure
 */
export function parseKitActiveHistoryLines(raw: string): KitActiveHistoryEntry[] {
  const entries: KitActiveHistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<KitActiveHistoryEntry>;
      if (
        typeof parsed.dia === "string" &&
        typeof parsed.captured_at === "string" &&
        typeof parsed.count === "number" &&
        (parsed.asOf === null || typeof parsed.asOf === "string")
      ) {
        entries.push({ dia: parsed.dia, captured_at: parsed.captured_at, count: parsed.count, asOf: parsed.asOf ?? null });
      }
    } catch {
      continue; // linha corrompida — ignora
    }
  }
  return entries;
}

/**
 * Contagem do Kit ativo para `dia` (`AAAA-MM-DD`, BRT) — resolve pela
 * ÚLTIMA entry com esse `dia` na lista (ordem de aparição no arquivo =
 * ordem de captura, `appendFileSync` só cresce), nunca a primeira: entre
 * 2 capturas no mesmo dia, a mais recente é a leitura mais atualizada do
 * store até aquele ponto. `null` quando nenhuma entry cobre `dia` —
 * "esta pergunta não tem resposta ainda", nunca `0` fabricado. @pure
 */
export function findKitActiveCountForDay(entries: readonly KitActiveHistoryEntry[], dia: string): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].dia === dia) return entries[i].count;
  }
  return null;
}
