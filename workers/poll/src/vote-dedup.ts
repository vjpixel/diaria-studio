/**
 * workers/poll/src/vote-dedup.ts (#2187)
 *
 * Durable Object `VoteDedup` — serializa o caminho crítico de dedup+gravação
 * de voto por chave de email, eliminando a race read-modify-write que o KV
 * eventual-consistent expunha.
 *
 * ## Problema (antes)
 * KV é eventualmente consistente. Dois requests concorrentes do mesmo email
 * podiam ambos passar o guard `existing === null` antes do primeiro `put`
 * propagar, gerando double-increment de stats/score + voto duplicado no
 * leaderboard. Janela de race: típica de 100–500ms no KV CF edge.
 *
 * ## Solução
 * O DO serializa por email: um Durable Object por par `{edition}:{email}`.
 * O estado de "já votou?" é guardado no `state.storage` do DO (fortemente
 * consistente + serializado). A decisão de duplicado vem do storage do DO,
 * não do KV eventual.
 *
 * ## Commit em 2 fases (#2220)
 *
 * PROBLEMA ORIGINAL: o DO gravava `voted=true` ANTES das escritas KV downstream
 * (updateStatsCounter / updateScore / updateScoreByMonth / put voteKey). Se qualquer
 * dessas escritas lançasse (ex: KV overload), o slot ficava queimado — o retry do
 * votante recebia `firstVote:false` e ficava bloqueado para sempre com stats parciais.
 *
 * FIX (2 fases):
 *   Fase 1 (autorização): DO grava `pending=true` + `voted=false`, retorna `firstVote:true`.
 *     Um segundo request concorrente que chega neste ponto vê `pending=true` e é
 *     rejeitado como duplicado — serialização mantida.
 *   Fase 2 (confirmação): após sucesso das escritas KV, o Worker chama POST /confirm
 *     no DO. O DO persiste `voted=true` e limpa `pending`.
 *
 * RECONCILIAÇÃO em falha:
 *   Se as escritas KV falham e o Worker NÃO chama /confirm, o DO fica em estado
 *   `pending=true, voted=false`. No retry do votante, o DO detecta o pending e
 *   retorna `firstVote:true` novamente (permite re-tentar as escritas KV).
 *   Isso garante que falha de escrita KV NÃO bloqueia o votante permanentemente.
 *
 * INVARIANTE de exatamente 1 voto:
 *   - Apenas o primeiro request a adquirir `pending` pode retornar `firstVote:true`.
 *   - Qualquer request concorrente ou subsequente que chegue enquanto `pending=true`
 *     (confirmação pendente) é rejeitado — não pode re-tentar adquirir pending.
 *   - Somente após /confirm (pending→voted) o slot está definitivamente queimado;
 *     até lá, somente o primeiro adquirente pode re-tentar.
 *   - Um voto bem-sucedido resulta em exatamente 1 incremento KV + 1 /confirm.
 *
 * ## Migration path (KV legacy)
 * Votos gravados antes do deploy existem em KV como `vote:{edition}:{email}`.
 * O DO consulta esse KV legacy em seu primeiro acesso (estado DO ainda vazio):
 * se a chave existe no KV, seta o estado interno como "voted=true" e rejeita
 * o voto como duplicado. Isso garante que quem votou antes do deploy não
 * consegue votar novamente após o deploy — sem re-voto, sem perda de votos.
 *
 * ## Invariantes
 * - O DO cobre apenas a serialização do dedup de voto (`/vote` endpoint).
 * - Todos os outros endpoints (/stats, /leaderboard, /set-name, /admin/correct,
 *   /img, score/streak/score-by-month) permanecem intactos — não passam pelo DO.
 * - O DO não replica nem substitui o KV `vote:{edition}:{email}`; o handleVote
 *   continua gravando no KV como espelho/compat após a decisão do DO.
 * - Idempotente: se o DO já registrou o voto (voted=true), qualquer request
 *   subsequente do mesmo email é rejeitado como duplicado.
 */

/** Payload enviado no body do request interno para o DO (interno — não precisa de export). */
interface VoteDedupRequest {
  /** edition AAMMDD */
  edition: string;
  /** email lowercase, trimmed */
  email: string;
}

/** Resposta do DO para o handleVote (interna — não exportada; usada só dentro deste módulo). */
interface VoteDedupResponse {
  /** true = primeiro voto (deve prosseguir com gravação normal); false = duplicado */
  firstVote: boolean;
}

/**
 * VoteDedup — Durable Object que serializa dedup de voto por email+edition.
 *
 * Interface de comunicação:
 *   POST /vote-dedup  — fase 1: solicita autorização do voto
 *   POST /confirm     — fase 2: confirma sucesso das escritas KV
 *
 * State storage:
 *   `pending` (boolean) — voto autorizado mas escritas KV ainda pendentes
 *   `voted`   (boolean) — voto confirmado (escritas KV concluídas)
 *
 * O DO também aceita um header `X-KV-Vote-Exists: 1` passado pelo caller
 * quando o KV legacy já tem `vote:{edition}:{email}` — isso permite inicializar
 * o estado do DO como "voted=true" sem uma leitura interna do KV (que o DO
 * não tem acesso direto; o caller já fez a leitura de forma mais eficiente).
 */
export class VoteDedup {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path.endsWith("/confirm")) {
      return this.handleConfirm();
    }

    // Default: /vote-dedup — fase 1 (autorização)
    return this.handleAuthorize(request);
  }

  /**
   * Fase 1: autoriza o voto.
   *
   * Transições de estado:
   *   voted=true              → firstVote:false (já confirmado, duplicado definitivo)
   *   pending=true            → firstVote:false (outro request está confirmando, duplicado)
   *   vazio + X-KV-Vote-Exists → gravar voted=true, firstVote:false (legado KV)
   *   vazio                   → gravar pending=true, firstVote:true (primeiro voto)
   */
  private async handleAuthorize(request: Request): Promise<Response> {
    return await this.state.blockConcurrencyWhile(async () => {
      // Fonte de verdade forte: verificar estado interno do DO
      const voted = await this.state.storage.get<boolean>("voted");
      if (voted) {
        // DO já confirmou este voto — duplicado definitivo
        const resp: VoteDedupResponse = { firstVote: false };
        return new Response(JSON.stringify(resp), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      const pending = await this.state.storage.get<boolean>("pending");
      if (pending) {
        // Outro request está em processo de confirmação das escritas KV.
        // Rejeitar como duplicado — somente o adquirente original pode re-tentar.
        const resp: VoteDedupResponse = { firstVote: false };
        return new Response(JSON.stringify(resp), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // DO não tem estado — verificar se o KV legacy já tem este voto.
      // O caller passa o header X-KV-Vote-Exists: "1" quando detectou o voto
      // no KV antes de chamar o DO (evita que o DO precise de acesso ao KV).
      const kvVoteExists = request.headers.get("X-KV-Vote-Exists") === "1";
      if (kvVoteExists) {
        // Voto legado existe no KV — inicializa o estado DO como "voted"
        // (pula fase pending: não há escritas KV a confirmar; o voto já está no KV).
        await this.state.storage.put("voted", true);
        const resp: VoteDedupResponse = { firstVote: false };
        return new Response(JSON.stringify(resp), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Nenhum voto existente — fase 1: marcar como pending (não voted ainda).
      // O estado `pending` reserva o slot para este request sem commitar de forma
      // permanente. Se as escritas KV falharem e o Worker não chamar /confirm,
      // o estado fica `pending=true, voted=false` — o retry do votante pode re-tentar.
      await this.state.storage.put("pending", true);
      const resp: VoteDedupResponse = { firstVote: true };
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  /**
   * Fase 2: confirma o voto após sucesso das escritas KV.
   *
   * Chamado pelo Worker após updateStatsCounter + updateScore + updateScoreByMonth
   * + put(voteKey) completarem sem erro. Transiciona pending→voted definitivamente.
   *
   * Idempotente: se chamado mais de uma vez (retry de rede no Worker), não causa
   * problemas — apenas seta voted=true novamente.
   */
  private async handleConfirm(): Promise<Response> {
    return await this.state.blockConcurrencyWhile(async () => {
      await this.state.storage.put("voted", true);
      await this.state.storage.delete("pending");
      return new Response(JSON.stringify({ confirmed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }
}
