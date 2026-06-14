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
      const { choice, correct } = payload;

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
