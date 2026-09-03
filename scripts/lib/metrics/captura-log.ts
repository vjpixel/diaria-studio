/**
 * scripts/lib/metrics/captura-log.ts (#7174, F2 do épico #7172)
 *
 * O único arquivo FORA do store `diaria-subscribers-db.ts` que esta fatia
 * escreve — 1 linha por EXECUÇÃO da captura (não por assinante), o que
 * separa "dia com 0 cadastros" (a execução rodou, achou 0 registros novos)
 * de "dia sem coleta" (a execução não rodou, ou abortou por guard). É dali
 * que F5 (metas/streak) deriva o estado `INDETERMINADO`.
 *
 * Formato: JSONL append-only, 1 objeto `CapturaLogEntry` por linha. Fica
 * FORA do store SQLite de propósito — o schema do #6464 descreve
 * ASSINANTE, não EXECUÇÃO; misturar as duas coisas na mesma tabela
 * confundiria "quantos assinantes existem" com "quantas vezes rodamos".
 *
 * Idempotente NOS DADOS (upsertSubscription/recordEvent), NUNCA no log:
 * rodar a captura 2x no mesmo dia grava 2 linhas aqui — se a 2ª execução
 * sobrescrevesse a 1ª, um dia com uma coleta boa e uma falha ficaria
 * indistinguível de um dia com coleta única.
 *
 * Módulo PURO (sem I/O) — o append em si (`appendFileSync`) fica no CLI
 * (`scripts/diaria-subscribers-ingest-kit.ts`), que é a única camada com
 * I/O deste par, mesmo padrão do resto do épico.
 */

export interface CapturaLogEntry {
  /** Identificador único desta execução — `${platform}-${ISO timestamp}`. */
  captura_id: string;
  /** ISO 8601 — quando a execução RODOU (não o dia lógico dela). */
  captured_at: string;
  /** Total de registros retornados pela API nesta execução (antes de
   *  qualquer filtro). */
  total_retornado_api: number;
  /** Quantos `subscriber`/`subscription` foram gravados como NOVOS
   *  (primeira vez vistos) — não confundir com `total_retornado_api`,
   *  que inclui reingestão de quem já era conhecido. */
  novos_gravados: number;
  /** Quantos eventos de MUDANÇA DE ESTADO (subscribe/unsub) foram
   *  gravados como novos nesta execução. */
  eventos_estado: number;
  /** Exit code da execução — `0` sucesso, outro valor = falha parcial/total
   *  (a linha ainda é gravada mesmo em falha, pra provar que a execução
   *  RODOU, só não completou). */
  exit: number;
}

/** Constrói 1 entry pronta pra serializar — função pura, sem timestamp
 *  implícito (o chamador passa `capturedAt`, nunca `new Date()` aqui, pra
 *  manter o módulo testável sem mock de relógio). @pure */
export function buildCapturaLogEntry(input: {
  platform: string;
  capturedAt: string;
  totalRetornadoApi: number;
  novosGravados: number;
  eventosEstado: number;
  exit: number;
}): CapturaLogEntry {
  return {
    captura_id: `${input.platform}-${input.capturedAt}`,
    captured_at: input.capturedAt,
    total_retornado_api: input.totalRetornadoApi,
    novos_gravados: input.novosGravados,
    eventos_estado: input.eventosEstado,
    exit: input.exit,
  };
}

/** Serializa 1 entry como 1 linha JSONL (com o `\n` final). @pure */
export function serializeCapturaLogEntry(entry: CapturaLogEntry): string {
  return JSON.stringify(entry) + "\n";
}

/**
 * A partir das linhas JÁ EXISTENTES de `captura-log.jsonl` (parseadas), diz
 * se um dado dia (AAAA-MM-DD, fronteira UTC — quem chama decide se quer BRT
 * convertendo antes) teve pelo menos 1 execução registrada. Usado por F5
 * pra distinguir `INDETERMINADO` (nenhuma linha = nunca capturado nesse dia)
 * de "0 cadastros" (linha existe, `novos_gravados: 0`). @pure
 */
export function hasCaptureOnDay(entries: readonly CapturaLogEntry[], day: string): boolean {
  return entries.some((e) => e.captured_at.slice(0, 10) === day);
}
