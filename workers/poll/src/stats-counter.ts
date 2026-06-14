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
 *   POST /increment  — body: IncrementPayload → { ok: true; stats: StatsCounterData }
 *   GET  /stats      → { ok: true; stats: StatsCounterData }
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
   */
  private async handleIncrement(request: Request): Promise<Response> {
    return await this.state.blockConcurrencyWhile(async () => {
      const payload = await request.json() as IncrementPayload;
      const { choice, correct } = payload;

      const stored = await this.state.storage.get<StatsCounterData>("stats");
      const stats: StatsCounterData = stored ?? { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };

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
}
