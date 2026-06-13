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
 *   Fase 1 (autorização): DO grava `pending=true` + `claimed_at` (timestamp ISO),
 *     retorna `firstVote:true`.
 *     Um segundo request concorrente que chega neste ponto vê `pending=true` com
 *     `claimed_at` recente e é rejeitado como duplicado — serialização mantida.
 *   Fase 2 (confirmação): após sucesso das escritas KV, o Worker chama POST /confirm
 *     no DO. O DO persiste `voted=true` e limpa `pending` + `claimed_at`.
 *
 * RECONCILIAÇÃO em falha (INVARIANTE central):
 *   Se as escritas KV falham e o Worker NÃO chama /confirm, o DO fica em estado
 *   `pending=true, voted=false`. Um retry do votante:
 *     - Se `pending` ainda está "fresco" (age < PENDING_TTL_MS), é tratado como
 *       requisição concorrente de outro request → firstVote:false (barrado).
 *     - Se `pending` expirou (age >= PENDING_TTL_MS — crash entre pending e /confirm),
 *       o DO trata como voto abandonado e re-autoriza (firstVote:true), permitindo
 *       que o votante complete o voto normalmente.
 *   Isso garante que falha de escrita KV + crash NÃO bloqueia o votante para sempre.
 *
 * INVARIANTE de exatamente 1 voto:
 *   - Apenas o primeiro request a adquirir `pending` pode retornar `firstVote:true`.
 *   - Qualquer request concorrente que chegue enquanto `pending=true` E fresh
 *     é rejeitado — não pode adquirir pending em paralelo.
 *   - `pending` expirado = lock stale (crash confirmado) → re-adquirir é seguro
 *     porque não há request ativo segurando o lock.
 *   - Somente após /confirm (pending→voted) o slot está definitivamente queimado.
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

/**
 * TTL para o estado `pending` — lock adquirido na fase 1 mas ainda não confirmado.
 * Se o DO ficar em pending por mais que este tempo, considera-se que o Worker
 * crashou entre fase 1 e fase 2, e o lock é tratado como expirado (re-adquirir é seguro).
 * 5 minutos cobre qualquer timeout razoável de Worker (CF limita requests a 30s CPU time).
 */
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutos

/**
 * #2229 — Estado do pending: gravado atomicamente como unico objeto
 * (um unico storage.put) para nunca existir pending sem at.
 * Antes: dois puts separados podiam resultar em pending=true sem claimed_at
 * -> claimedTs=0 -> isExpired=true -> re-auth imediata de concurrent request.
 */
interface PendingState {
  at: string; // ISO 8601 timestamp de quando o lock foi adquirido
}

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
 * State storage (schema após #2229):
 *   `pending`  (PendingState = { at: string })  — lock adquirido; voto autorizado mas
 *                                                   escritas KV ainda pendentes. Gravado
 *                                                   como objeto atômico num único put para
 *                                                   evitar estado pending-sem-timestamp.
 *   `voted`    (boolean)                         — voto confirmado (escritas KV concluídas)
 *
 * Headers reconhecidos pelo caller:
 *   `X-KV-Vote-Exists: 1`        — KV legacy já tem `vote:{edition}:{email}`; DO inicializa
 *                                   como voted=true sem passar por pending.
 *   `X-KV-VoteKey-Committed: 1`  — todas as escritas KV (incluindo voteKey) foram concluídas
 *                                   mas /confirm falhou. DO reconcilia pending→voted e retorna
 *                                   firstVote:false sem re-incrementar contadores.
 *
 * Tabela de transições de estado (handleAuthorize):
 *   voted=true                              → firstVote:false  (duplicado definitivo)
 *   pending fresco + X-KV-VoteKey-Committed → voted=true, firstVote:false (reconciliação)
 *   pending fresco                          → firstVote:false  (request concorrente)
 *   pending expirado (>= TTL)              → re-autoriza (re-adquire lock, firstVote:true)
 *   vazio + X-KV-Vote-Exists               → voted=true, firstVote:false (migração legado)
 *   vazio                                  → pending={ at }, firstVote:true
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

    // P3-11: usar === em vez de endsWith pra evitar false-match em paths como
    // /foo/confirm ou /vote-dedup/confirm/extra.
    if (path === "/confirm") {
      return this.handleConfirm();
    }

    // Default: /vote-dedup — fase 1 (autorização)
    return this.handleAuthorize(request);
  }

  /**
   * Fase 1: autoriza o voto.
   *
   * Transições de estado:
   *   voted=true                         → firstVote:false (já confirmado, duplicado definitivo)
   *   pending=true E fresh (< TTL)       → firstVote:false (request concorrente, duplicado)
   *   pending=true E expirado (>= TTL)   → re-autoriza (firstVote:true, reset claimed_at)
   *                                        lock stale por crash entre fase 1 e /confirm
   *   vazio + X-KV-Vote-Exists           → gravar voted=true, firstVote:false (legado KV)
   *   vazio                              → gravar pending=true + claimed_at, firstVote:true
   */
  private async handleAuthorize(request: Request): Promise<Response> {
    return await this.state.blockConcurrencyWhile(async () => {
      // P3-12: batch das duas leituras em um único storage.get para reduzir round-trips.
      // Retorna Map com valores (undefined se não existir).
      const stored = await this.state.storage.get<boolean | PendingState>(["voted", "pending"]);
      const voted = stored.get("voted") as boolean | undefined;
      const pendingRaw = stored.get("pending") as PendingState | undefined;

      if (voted) {
        // DO já confirmou este voto — duplicado definitivo
        const resp: VoteDedupResponse = { firstVote: false };
        return new Response(JSON.stringify(resp), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (pendingRaw) {
        // Lock adquirido — verificar se é fresco ou expirado.
        // #2229 item 1: pendingRaw.at sempre presente (objeto atomico gravado em put unico).
        const claimedTs = pendingRaw.at ? new Date(pendingRaw.at).getTime() : 0;
        const ageMs = Date.now() - claimedTs;
        const isExpired = ageMs >= PENDING_TTL_MS;

        if (!isExpired) {
          // #2229 item 3: reconciliacao via voteKey.
          // Se o Worker passou X-KV-VoteKey-Committed: 1, significa que todas as
          // escritas KV (incluindo voteKey) foram bem-sucedidas mas /confirm falhou.
          // O DO reconcilia pending->voted para que o proximo request nao re-incremente.
          const voteKeyCommitted = request.headers.get("X-KV-VoteKey-Committed") === "1";
          if (voteKeyCommitted) {
            await this.state.storage.put("voted", true);
            await this.state.storage.delete("pending");
            const resp: VoteDedupResponse = { firstVote: false };
            return new Response(JSON.stringify(resp), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }

          // Pending fresco sem voteKey confirmado: barrar.
          const resp: VoteDedupResponse = { firstVote: false };
          return new Response(JSON.stringify(resp), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Pending expirado: crash confirmado — re-adquirir o lock e re-autorizar.
        // (cai no código de aquisição abaixo após o bloco pending)
      }

      // DO não tem estado (ou pending expirado) — verificar KV legacy.
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

      // Nenhum voto existente (ou lock expirado) — fase 1: adquirir lock (pending).
      // #2229 item 1: pending gravado como objeto atomico { at: ISO } (um unico put).
      // Antes: dois puts separados podiam resultar em pending=true sem claimed_at
      // -> claimedTs=0 -> isExpired=true -> re-auth imediata -> double-vote.
      const pendingState: PendingState = { at: new Date().toISOString() };
      await this.state.storage.put("pending", pendingState);
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
   *
   * P2-5: só confirma se existe `pending` (estado "em progresso"). Se chamado
   * em um DO virgem (sem pending), é no-op — não queima o slot de um votante
   * futuro.
   */
  private async handleConfirm(): Promise<Response> {
    return await this.state.blockConcurrencyWhile(async () => {
      const pending = await this.state.storage.get<PendingState>("pending");
      if (!pending) {
        // DO não tem pending — /confirm chamado em DO virgem ou após voted=true.
        // No-op: não queima slot, não causa erro.
        return new Response(JSON.stringify({ confirmed: false, reason: "no_pending" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      await this.state.storage.put("voted", true);
      await this.state.storage.delete("pending");
      return new Response(JSON.stringify({ confirmed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }
}
