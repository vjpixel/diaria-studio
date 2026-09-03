/**
 * scripts/lib/metrics/captura-log.ts (#7174, F2 do épico #7172; estendido em
 * #7179, F7 — schema por-DIA + `origem_serie`)
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
 * Módulo PURO (sem I/O) — o append em si (`appendFileSync`) fica nos CLIs
 * (`scripts/diaria-subscribers-ingest-kit.ts`, `scripts/metrics-backfill-
 * cadastros.ts`), que são a única camada com I/O deste par, mesmo padrão
 * do resto do épico.
 *
 * ## `origem_serie` (F7, #7179)
 *
 * Todo registro passa a carregar `origem_serie`, distinguindo QUEM escreveu
 * a linha e COM QUE GRANULARIDADE:
 *   - `kit-vivo`         — F2, 1 linha por EXECUÇÃO da captura viva do Kit.
 *   - `backfill-beehiiv` — F7, 1 linha por DIA reconstruído a partir dos
 *     snapshots locais da Beehiiv (`data/beehiiv-backup/`), cobrindo
 *     2025-09-02..2026-08-24.
 *   - `seed-kit`         — F7, 1 linha por DIA da janela 2026-08-25 até o
 *     dia do armamento de F2 — SÓ o registro de "houve coleta nesse dia"
 *     (o `created_at` real já vem de graça na 1ª execução de F2); nunca
 *     carrega contagem de cadastro própria.
 *
 * `dia` (`AAAA-MM-DD`, fronteira BRT) é obrigatório nas linhas `backfill-
 * beehiiv`/`seed-kit` (1 linha = 1 dia, não 1 execução) e ausente nas linhas
 * `kit-vivo` (que continuam 1 linha por execução — `captured_at` já basta).
 * `hasCaptureOnDay` abaixo resolve por `dia` quando presente e cai para
 * `captured_at` (convertido pra BRT) quando não.
 */

/** As 3 procedências que uma linha de `captura-log.jsonl` pode ter — ver
 *  docstring do módulo. Opcional (`undefined`) nas linhas gravadas ANTES
 *  desta extensão (#7179) — `hasCaptureOnDay` trata a ausência como
 *  `kit-vivo` implícito (comportamento idêntico ao anterior a esta issue). */
export type OrigemSerie = "kit-vivo" | "backfill-beehiiv" | "seed-kit";

export interface CapturaLogEntry {
  /** Identificador único desta execução — `${platform}-${ISO timestamp}`. */
  captura_id: string;
  /** ISO 8601 — quando a execução RODOU (não o dia lógico dela). Para
   *  linhas por-DIA (`backfill-beehiiv`/`seed-kit`), é o instante em que o
   *  backfill rodou, não o dia reconstruído — o dia reconstruído mora em
   *  `dia`, nunca aqui. */
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
  /** Procedência da linha (F7, #7179) — ver docstring do módulo.
   *  `undefined` em linhas gravadas antes desta extensão. */
  origem_serie?: OrigemSerie;
  /** `AAAA-MM-DD`, fronteira BRT — obrigatório só nas linhas por-DIA
   *  (`backfill-beehiiv`/`seed-kit`, F7, #7179). Ausente nas linhas
   *  `kit-vivo` (por-EXECUÇÃO, `captured_at` já identifica o dia). */
  dia?: string;
}

/** Constrói 1 entry pronta pra serializar — função pura, sem timestamp
 *  implícito (o chamador passa `capturedAt`, nunca `new Date()` aqui, pra
 *  manter o módulo testável sem mock de relógio). `origemSerie`/`dia` são
 *  opcionais pra não quebrar os chamadores pré-#7179 (F2, que continua sem
 *  os dois — ver docstring do módulo). @pure */
export function buildCapturaLogEntry(input: {
  platform: string;
  capturedAt: string;
  totalRetornadoApi: number;
  novosGravados: number;
  eventosEstado: number;
  exit: number;
  origemSerie?: OrigemSerie;
  dia?: string;
}): CapturaLogEntry {
  return {
    captura_id: `${input.platform}-${input.capturedAt}`,
    captured_at: input.capturedAt,
    total_retornado_api: input.totalRetornadoApi,
    novos_gravados: input.novosGravados,
    eventos_estado: input.eventosEstado,
    exit: input.exit,
    ...(input.origemSerie ? { origem_serie: input.origemSerie } : {}),
    ...(input.dia ? { dia: input.dia } : {}),
  };
}

/** Serializa 1 entry como 1 linha JSONL (com o `\n` final). @pure */
export function serializeCapturaLogEntry(entry: CapturaLogEntry): string {
  return JSON.stringify(entry) + "\n";
}

/**
 * Mesma fórmula de `brtDayKey` em `scripts/lib/metrics/acquisition-store-
 * deps.ts`/`scripts/lib/clarice-envio-policy.ts` — reimplementada aqui, não
 * importada, pelo mesmo motivo documentado nesses dois módulos: manter este
 * arquivo PURO e sem depender de outro módulo do domínio só por uma
 * conversão de fuso de 3 linhas. @pure
 */
function brtDayKey(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/**
 * A partir das linhas JÁ EXISTENTES de `captura-log.jsonl` (parseadas), diz
 * se um dado dia (AAAA-MM-DD, fronteira BRT) teve pelo menos 1 execução
 * registrada. Usado por F5 pra distinguir `INDETERMINADO` (nenhuma linha =
 * nunca capturado nesse dia) de "0 cadastros" (linha existe, `novos_gravados:
 * 0`).
 *
 * Resolução por linha (F7, #7179): usa `dia` quando presente (linhas
 * `backfill-beehiiv`/`seed-kit`, que são por-DIA); cai para `captured_at`
 * convertido pra BRT quando `dia` está ausente (linhas `kit-vivo`, por-
 * EXECUÇÃO, e qualquer linha gravada antes desta extensão). @pure
 */
export function hasCaptureOnDay(entries: readonly CapturaLogEntry[], day: string): boolean {
  return entries.some((e) => (e.dia ?? brtDayKey(e.captured_at)) === day);
}
