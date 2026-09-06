/**
 * scripts/lib/ads-daily-digest.ts (#7487)
 *
 * Núcleo PURO/testável do digest diário de gasto em ads (task
 * `Diaria-Ads-Daily-Digest`, ~10h BRT — depois de `Diaria-Google-Ads-Spend-Ingest`,
 * 09:50). Diferente dos alarmes existentes (`ads-test-watch.ts` só envia
 * e-mail quando há marco acionável; `google-ads-ingest-spend.ts` nunca
 * envia e-mail), este script SEMPRE envia — o ponto da issue é eliminar a
 * ambiguidade entre "sem gasto" e "task falhou" (nenhum e-mail chegando não
 * pode significar as duas coisas).
 *
 * ## Granularidade — "gasto do dia anterior" é um DELTA, não um dado bruto
 *
 * `data/aquisicao/spend.csv` (ver `aquisicao-spend.ts`) guarda só o total
 * ACUMULADO por `canal+mes` — a ingestão do Google Ads (GAQL) reagrega uma
 * janela de dias e SUBSTITUI a linha do mês inteiro a cada corrida, não
 * grava um valor "de ontem" separado. Pra derivar "quanto mudou desde
 * ontem", este módulo persiste um HISTÓRICO leve (`AdsDailyDigestHistory`,
 * escrito pelo CLI em `data/aquisicao/.ads-daily-digest-history.json`) com
 * o total de cada `canal+mes` na última execução, e o delta é a diferença
 * entre o total de hoje e o total gravado ontem. Primeira execução de um
 * `canal+mes` (sem entrada anterior) não tem baseline — reportado como tal,
 * nunca coagido a "gastou X hoje" quando na verdade é histórico acumulado
 * de antes deste mecanismo existir.
 *
 * ## Extensível por canal (#5502)
 *
 * Nenhuma função aqui hardcoda "Google Ads" — opera sobre `SpendRow[]`
 * genérico. Quando Meta/Microsoft Ads ganharem ingestão real em
 * `spend.csv`, aparecem automaticamente no digest sem mudança de código
 * aqui (só na fonte que popula `spend.csv`).
 */

import type { SpendRow } from "./aquisicao-spend.ts";
import { ADS_TEST_2608_BRACOS } from "./ads-test-run-state.ts";
import { CHANNEL_GROUP_KEYS, subscribersForChannel, countLeitoresV1 } from "./cac.ts";
import type { BeehiivBackupSubscriber } from "./beehiiv-backup-snapshots.ts";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Histórico leve pra derivar delta diário (canal+mes -> total na última corrida)
// ---------------------------------------------------------------------------

export interface ChannelSpendHistoryEntry {
  canal: string;
  mes: string;
  valor: number;
}

export interface AdsDailyDigestHistory {
  rows: ChannelSpendHistoryEntry[];
  /** ISO timestamp de quando este histórico foi gravado — só informativo. */
  capturedAt: string;
}

export function emptyDigestHistory(): AdsDailyDigestHistory {
  return { rows: [], capturedAt: "" };
}

/** @pure */
export function toHistoryRows(spendRows: SpendRow[]): ChannelSpendHistoryEntry[] {
  return spendRows.map((r) => ({ canal: r.canal, mes: r.mes, valor: r.valor }));
}

// ---------------------------------------------------------------------------
// Delta por canal+mes
// ---------------------------------------------------------------------------

export interface ChannelDeltaRow {
  canal: string;
  mes: string;
  moeda: string;
  totalAtual: number;
  /** `null` = canal+mes sem entrada no histórico anterior (1ª checagem). */
  totalAnterior: number | null;
  /** `null` = sem baseline pra calcular incremento diário (ver acima). */
  deltaDia: number | null;
}

/**
 * Compara os totais ATUAIS de `spend.csv` contra o histórico da checagem
 * anterior, canal+mes a canal+mes. Uma linha presente em `previousRows` mas
 * ausente em `currentRows` (canal que sumiu do CSV) é simplesmente ignorada
 * — não há "delta negativo por remoção" a reportar.
 *
 * @pure
 */
export function computeChannelDeltas(
  currentRows: SpendRow[],
  previousRows: ChannelSpendHistoryEntry[],
): ChannelDeltaRow[] {
  const prevMap = new Map(previousRows.map((r) => [`${r.canal}|${r.mes}`, r.valor]));
  return currentRows.map((r) => {
    const key = `${r.canal}|${r.mes}`;
    const hasPrev = prevMap.has(key);
    const prev = hasPrev ? prevMap.get(key)! : null;
    const deltaDia = hasPrev ? round2(r.valor - prev!) : null;
    return { canal: r.canal, mes: r.mes, moeda: r.moeda, totalAtual: r.valor, totalAnterior: prev, deltaDia };
  });
}

/** "Houve gasto no período" para fins da mensagem "sem gasto" da issue —
 *  conta tanto um delta positivo quanto uma 1ª checagem com total > 0
 *  (nunca reportar "sem gasto" quando na verdade não há baseline ainda).
 *  @pure */
export function hasSpendInPeriod(deltas: ChannelDeltaRow[]): boolean {
  return deltas.some((d) => (d.deltaDia !== null ? d.deltaDia > 0 : d.totalAtual > 0));
}

// ---------------------------------------------------------------------------
// Teste 2608 — gasto acumulado (soma de TODOS os meses, todos os 3 braços)
// ---------------------------------------------------------------------------

/** @pure */
export function sumTeste2608Spend(spendRows: SpendRow[], bracos: readonly string[] = ADS_TEST_2608_BRACOS): number {
  const bracosSet = new Set(bracos);
  return round2(spendRows.filter((r) => bracosSet.has(r.canal)).reduce((sum, r) => sum + r.valor, 0));
}

export interface Teste2608Summary {
  emAndamento: boolean;
  totalAcumulado: number;
  bracos: readonly string[];
}

/**
 * `emAndamento` = existe `run-state.json` E a data de hoje ainda está
 * dentro da janela de veiculação (`d0..fim_janela`, inclusive) — fora
 * dessa janela o teste está encerrado/em cauda, e a issue pede o resumo só
 * "se em andamento" (`(se em andamento)`). `runState` é `null` quando o
 * arquivo simplesmente não existe (teste ainda não começou) — sem lançar.
 *
 * @pure
 */
export function summarizeTeste2608(
  spendRows: SpendRow[],
  runState: { d0: string; fim_janela: string; bracos: readonly string[] } | null,
  todayIso: string,
): Teste2608Summary | null {
  if (!runState) return null;
  const emAndamento = todayIso >= runState.d0 && todayIso <= runState.fim_janela;
  return {
    emAndamento,
    totalAcumulado: sumTeste2608Spend(spendRows, runState.bracos),
    bracos: runState.bracos,
  };
}

// ---------------------------------------------------------------------------
// Leitores adquiridos por canal + custo por leitor (mesma métrica do #5236)
// ---------------------------------------------------------------------------

export interface ChannelReaderSummary {
  canal: string;
  leitores: number;
  custoPorLeitor: number | null;
}

/**
 * Soma o gasto acumulado (todos os meses) por canal a partir de
 * `spend.csv` — só canais que `cac.ts` sabe reconhecer via
 * `CHANNEL_GROUP_KEYS` entram no resultado (mesma restrição de
 * `subscribersForChannel`: um canal sem chaves conhecidas não tem como ser
 * casado contra `utm_source`/`referring_site`).
 *
 * @pure
 */
export function totalSpendByKnownChannel(spendRows: SpendRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of spendRows) {
    if (!(row.canal in CHANNEL_GROUP_KEYS)) continue;
    out.set(row.canal, round2((out.get(row.canal) ?? 0) + row.valor));
  }
  return out;
}

/**
 * `subs === null` = sem snapshot Beehiiv local disponível — devolve
 * `null` (nunca uma lista vazia, que seria indistinguível de "há canais
 * mas 0 leitores"). Custo por leitor é `null` quando ainda não há nenhum
 * leitor-v1 atribuído ao canal (divisão por zero evitada explicitamente,
 * não um `Infinity`/`NaN` silencioso).
 *
 * @pure
 */
export function computeReadersByChannel(
  subs: BeehiivBackupSubscriber[] | null,
  spendByChannel: Map<string, number>,
): ChannelReaderSummary[] | null {
  if (subs === null) return null;
  const out: ChannelReaderSummary[] = [];
  for (const [canal, gastoTotal] of spendByChannel.entries()) {
    const leitores = countLeitoresV1(subscribersForChannel(subs, canal));
    out.push({ canal, leitores, custoPorLeitor: leitores > 0 ? round2(gastoTotal / leitores) : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

export interface AdsDailyDigestEmailInput {
  /** Data do período reportado (ontem), formato `YYYY-MM-DD`. */
  periodDate: string;
  deltas: ChannelDeltaRow[];
  teste2608: Teste2608Summary | null;
  /** `null` = sem snapshot Beehiiv local disponível. */
  readers: ChannelReaderSummary[] | null;
  readersSnapshotDate: string | null;
}

/** @pure */
export function buildAdsDailyDigestEmail(input: AdsDailyDigestEmailInput): { subject: string; body: string } {
  const subject = `Ads Daily Digest — ${input.periodDate}`;
  const lines: string[] = [];
  const gastoHouve = hasSpendInPeriod(input.deltas);

  lines.push(`Resumo diário de gasto em ads — período: ${input.periodDate}`);
  lines.push("");

  if (input.deltas.length === 0) {
    lines.push("SEM GASTO no período — nenhum canal cadastrado em spend.csv ainda.");
  } else if (!gastoHouve) {
    lines.push("SEM GASTO no período — nenhum canal registrou incremento desde a última checagem.");
    lines.push("");
    lines.push("Totais acumulados por canal (sem mudança relevante):");
    for (const d of input.deltas) {
      lines.push(`  - ${d.canal} (${d.mes}): ${d.moeda} ${d.totalAtual.toFixed(2)}`);
    }
  } else {
    lines.push("Gasto por canal (incremento desde a última checagem):");
    for (const d of input.deltas) {
      const detalhe =
        d.deltaDia === null
          ? `total mês ${d.mes}: ${d.moeda} ${d.totalAtual.toFixed(2)} (1ª checagem — sem baseline pra incremento diário)`
          : `+${d.moeda} ${d.deltaDia.toFixed(2)} (total mês ${d.mes}: ${d.moeda} ${d.totalAtual.toFixed(2)})`;
      lines.push(`  - ${d.canal}: ${detalhe}`);
    }
  }

  lines.push("");
  if (input.teste2608 && input.teste2608.emAndamento) {
    lines.push(`Teste 2608 (em andamento) — gasto acumulado total: R$ ${input.teste2608.totalAcumulado.toFixed(2)}`);
    lines.push(`  Braços: ${input.teste2608.bracos.join(", ")}`);
    lines.push("");
  }

  if (input.readers === null) {
    lines.push("Leitores adquiridos por canal: indisponível (sem snapshot Beehiiv local ainda).");
  } else if (input.readers.length === 0) {
    lines.push("Leitores adquiridos por canal: nenhum canal reconhecido com gasto registrado.");
  } else {
    lines.push(`Leitores adquiridos por canal (snapshot ${input.readersSnapshotDate ?? "?"}):`);
    for (const r of input.readers) {
      const custo = r.custoPorLeitor === null ? "N/A (ainda sem leitor)" : `R$ ${r.custoPorLeitor.toFixed(2)}/leitor`;
      lines.push(`  - ${r.canal}: ${r.leitores} leitor(es) — custo por leitor: ${custo}`);
    }
  }

  lines.push("");
  lines.push("(Este e-mail é sempre enviado, mesmo sem gasto — issue #7487, elimina ambiguidade com falha da task.)");

  return { subject, body: lines.join("\n") };
}
