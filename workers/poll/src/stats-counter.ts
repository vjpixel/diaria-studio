/**
 * workers/poll/src/stats-counter.ts (#2223)
 *
 * Durable Object `StatsCounter` — serializa o read-modify-write do contador
 * agregado `stats:{edition}` edition-wide, eliminando a race que o KV
 * eventual-consistent expunha.
 *
 * ## Problema original (#2223, pré-existente)
 * `updateStatsCounter` fazia read-modify-write NÃO-serializado em `stats:{edition}`,
 * compartilhado entre TODOS os votantes concorrentes da mesma edição.
 * O DO `VoteDedup` serializa por email, mas NÃO serializa o contador edition-wide.
 * Sob burst pós-envio (dezenas de votos simultâneos), todos leem o mesmo valor stale
 * e cada um escreve +1 — vários incrementos se perdem → /stats mostra totais errados.
 *
 * ## Solução: opção (a) — DO mantém o contador no seu próprio storage SQLite
 * - `StatsCounter` é instanciado por `{brand}:{edition}` (brand incluído para
 *   isolamento entre diaria e clarice — mesmo padrão do VoteDedup).
 * - O `state.blockConcurrencyWhile` serializa o increment dentro do DO.
 * - O /stats endpoint agora lê do DO (via método `/stats`) em vez do KV.
 * - O KV `stats:{edition}` ainda é atualizado como espelho para compat
 *   (scripts externos que leem diretamente o KV não quebram).
 *
 * ## Idempotência com guard-keys (#2229)
 * O guard `counted:{edition}:{email}:stats` no KV continua sendo a barreira
 * primária de "esse votante já foi contado?". O DO serializa o incremento em si
 * — a decisão de SE incrementa ainda é do guard-key (em `handleVote`). O DO não
 * quebra essa idempotência; apenas garante que quando dois incrementos chegam
 * "ao mesmo tempo" (guard-key não presente para ambos), eles são processados em
 * série — não simultaneamente perdendo o segundo.
 *
 * ## Schema do storage SQLite (DO storage)
 * stats  →  { total: number; voted_a: number; voted_b: number; correct_count: number }
 *
 * ## Interface de comunicação
 *   POST /increment  — incrementa o contador (body JSON: IncrementPayload)
 *   GET  /stats      — retorna o estado atual do contador
 */

/** Payload do request interno de incremento. */
export interface IncrementPayload {
  /** Escolha do votante: "A" | "B" */
  choice: "A" | "B";
  /** true se o votante acertou, false se errou, null se gabarito ainda não definido */
  correct: boolean | null;
  /**
   * #3115: snapshot do espelho KV `stats:{edition}` no momento da chamada, usado
   * SOMENTE quando o storage do DO nunca foi inicializado (`stored === undefined`).
   *
   * Contexto: `StatsCounter` respondia `stored ?? {total:0,...}` — um DO nunca
   * inicializado (ex: edição publicada antes do deploy do DO, #2223) é
   * indistinguível de um DO com zero votos de verdade. Isso já corrompia leitura
   * (/stats, corrigido em handleStats via mergeStatsWithKvFallback) — mas também
   * corrompia ESCRITA: um voto retroativo (#2867) numa edição pré-#2223 faria o
   * DO "nascer" do zero (0→1) e espelhar {total:1} de volta no KV, sobrescrevendo
   * o registro histórico correto que só existia no KV.
   *
   * Fix: o caller (updateStatsCounter em vote.ts) lê o espelho KV ANTES de
   * chamar /increment e passa aqui. Se o DO nunca foi inicializado, usa este
   * valor como baseline em vez de {0,0,0,0} — preserva o histórico pré-DO.
   * Se o DO JÁ tem estado (mesmo que zerado por votos reais), este campo é
   * ignorado — nunca sobrescreve um estado real já gravado no DO.
   */
  kvBaseline?: StatsCounterData | null;
}

/**
 * #3115: valida shape de um possível baseline vindo do KV — todos os campos
 * devem ser inteiros não-negativos. Protege contra um `stats:{edition}` KV
 * corrompido/malformado virar seed inválido do DO.
 */
export function isValidStatsCounterData(data: unknown): data is StatsCounterData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    Number.isInteger(d.total) && (d.total as number) >= 0 &&
    Number.isInteger(d.voted_a) && (d.voted_a as number) >= 0 &&
    Number.isInteger(d.voted_b) && (d.voted_b as number) >= 0 &&
    Number.isInteger(d.correct_count) && (d.correct_count as number) >= 0
  );
}

/**
 * #3115: resolve o valor "melhor" entre o que o DO StatsCounter responde e o
 * espelho KV `stats:{edition}` — usado em `/stats` (handleStats).
 *
 * Problema: um DO respondendo `{total:0,...}` é ambíguo — pode ser (a) um DO
 * nunca inicializado (edição pré-deploy do DO, #2223) OU (b) uma edição real
 * com zero votos. `handleStats` só caía no fallback KV quando o DO ERRAVA
 * (exception/5xx) — uma resposta all-zero "válida" nunca disparava o fallback,
 * então toda edição com votos anteriores ao deploy do DO ficava permanentemente
 * reportando zero, mesmo com o KV tendo o valor histórico correto.
 *
 * Fix: comparar o `total` de ambas as fontes e usar a de maior valor (nunca
 * per-field — os 4 campos são correlacionados, então tomamos o objeto inteiro
 * de uma fonte, não uma mistura). Preserva o caso "zero real" (DO=0 E KV=0 ou
 * ausente) sem virar falso-positivo de "precisa fallback": nesse caso ambos
 * concordam em 0, o resultado permanece 0.
 *
 * `doStats === null` (DO indisponível/erro) → usa KV puro (ou zero se ausente).
 */
export function mergeStatsWithKvFallback(
  doStats: StatsCounterData | null,
  kvStats: StatsCounterData | null,
): StatsCounterData {
  if (doStats === null) {
    return kvStats ?? { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };
  }
  if (kvStats && kvStats.total > doStats.total) {
    return kvStats;
  }
  return doStats;
}

/** Payload do request interno de ajuste de correct_count (admin-correct). */
export interface AdjustCorrectPayload {
  /** Novo correct_count absoluto calculado pelo backfill. */
  correct_count: number;
}

/** Shape do contador armazenado no DO. */
export interface StatsCounterData {
  total: number;
  voted_a: number;
  voted_b: number;
  correct_count: number;
}

/**
 * StatsCounter — Durable Object que serializa o contador stats edition-wide.
 *
 * Uma instância por `{brand}:{edition}` — brand incluído para isolamento
 * entre diaria×clarice (evita colisão quando o mesmo edition-code é usado
 * em brands distintos).
 *
 * Interface:
 *   POST /increment       — body: IncrementPayload    → { ok: true; stats: StatsCounterData }
 *   POST /adjust-correct  — body: AdjustCorrectPayload → { ok: true; stats: StatsCounterData }
 *   GET  /stats           → { ok: true; stats: StatsCounterData }
 */
export class StatsCounter {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/stats" && request.method === "GET") {
      return this.handleGetStats();
    }

    if (path === "/increment" && request.method === "POST") {
      return this.handleIncrement(request);
    }

    if (path === "/adjust-correct" && request.method === "POST") {
      return this.handleAdjustCorrect(request);
    }

    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Lê o estado atual do contador.
   * Não serializado (leitura pura — sem concorrência de escrita aqui).
   */
  private async handleGetStats(): Promise<Response> {
    const stored = await this.state.storage.get<StatsCounterData>("stats");
    const stats: StatsCounterData = stored ?? { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };
    return new Response(JSON.stringify({ ok: true, stats }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Incrementa o contador de forma serializada.
   *
   * `blockConcurrencyWhile` garante que dois POSTs /increment concorrentes do
   * mesmo DO são processados em série — o segundo lê o valor já atualizado pelo
   * primeiro, sem perda de incremento.
   *
   * Fix #3: valida `choice` ∈ {A,B} antes de incrementar — payload inválido
   * retorna 400 sem tocar o estado, evitando corrupção de total vs voted_a+voted_b.
   */
  private async handleIncrement(request: Request): Promise<Response> {
    return await this.state.blockConcurrencyWhile(async () => {
      const payload = await request.json() as IncrementPayload;
      const { choice, correct, kvBaseline } = payload;

      // Validação de choice: só "A" ou "B" são valores legítimos.
      // Rejeita qualquer outro valor com 400 sem alterar o estado do contador.
      // Sem esta guarda, um payload malformado incrementa `total` sem incrementar
      // voted_a ou voted_b → total ≠ voted_a + voted_b (corrupção invariante).
      if (choice !== "A" && choice !== "B") {
        return new Response(JSON.stringify({ error: "invalid choice — must be A or B" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const stored = await this.state.storage.get<StatsCounterData>("stats");
      // #3115: `stored === undefined` significa "este DO nunca foi inicializado"
      // — distinto de um DO com estado real zerado (que teria sido explicitamente
      // gravado por um increment anterior, mesmo que resultasse em zeros). Só neste
      // caso (nunca inicializado) usamos o baseline do KV como seed — nunca
      // sobrescreve um `stored` já existente, mesmo que seja {0,0,0,0} real.
      let stats: StatsCounterData;
      if (stored !== undefined) {
        stats = stored;
      } else if (kvBaseline && isValidStatsCounterData(kvBaseline)) {
        stats = { ...kvBaseline };
      } else {
        stats = { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };
      }

      stats.total += 1;
      if (choice === "A") stats.voted_a += 1;
      if (choice === "B") stats.voted_b += 1;
      if (correct === true) stats.correct_count += 1;

      await this.state.storage.put("stats", stats);

      return new Response(JSON.stringify({ ok: true, stats }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  /**
   * Ajusta `correct_count` para o valor absoluto passado pelo handleAdminCorrect.
   *
   * Chamado após o backfill de gabarito (POST /admin/correct) para manter o DO
   * consistente com o KV — sem isso, `/stats` (que lê do DO) retornaria um
   * correct_count stale (do momento dos votos originais) mesmo após a correção
   * do gabarito.
   *
   * Serializado via `blockConcurrencyWhile` para não raçar com increments
   * concorrentes (ex: votos chegando enquanto o admin aplica o gabarito).
   */
  private async handleAdjustCorrect(request: Request): Promise<Response> {
    return await this.state.blockConcurrencyWhile(async () => {
      const payload = await request.json() as AdjustCorrectPayload;
      const { correct_count } = payload;

      if (typeof correct_count !== "number" || correct_count < 0 || !Number.isInteger(correct_count)) {
        return new Response(JSON.stringify({ error: "invalid correct_count — must be non-negative integer" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const stored = await this.state.storage.get<StatsCounterData>("stats");
      const stats: StatsCounterData = stored ?? { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };

      // Substitui apenas correct_count; total/voted_a/voted_b permanecem intactos.
      stats.correct_count = correct_count;

      await this.state.storage.put("stats", stats);

      return new Response(JSON.stringify({ ok: true, stats }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }
}
