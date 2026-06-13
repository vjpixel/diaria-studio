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
 *
 * ## Chave do DO
 * `idFromName(`${edition}:${email}`)` — instância única por par edição+email.
 * Isso garante que dois votos do MESMO email na MESMA edição são serializados;
 * votos do mesmo email em edições diferentes usam instâncias distintas (correto).
 */

/** Payload enviado no body do request interno para o DO (interno — não precisa de export). */
interface VoteDedupRequest {
  /** edition AAMMDD */
  edition: string;
  /** email lowercase, trimmed */
  email: string;
}

/** Resposta do DO para o handleVote. */
export interface VoteDedupResponse {
  /** true = primeiro voto (deve prosseguir com gravação normal); false = duplicado */
  firstVote: boolean;
}

/**
 * VoteDedup — Durable Object que serializa dedup de voto por email+edition.
 *
 * Interface de comunicação: fetch interno com body JSON `VoteDedupRequest`.
 * Retorna JSON `VoteDedupResponse`.
 *
 * State storage usa `voted` (boolean) como único campo — basta saber se o
 * voto desta instância (email×edition) já foi registrado.
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

    // Executa atomicamente dentro do DO (serializado por runtime DO)
    return await this.state.blockConcurrencyWhile(async () => {
      // Verifica estado interno primeiro (fonte de verdade forte)
      const voted = await this.state.storage.get<boolean>("voted");

      if (voted) {
        // DO já registrou este voto — duplicado
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
        // para que requests futuros sejam rejeitados sem re-consultar o KV.
        await this.state.storage.put("voted", true);
        const resp: VoteDedupResponse = { firstVote: false };
        return new Response(JSON.stringify(resp), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Nenhum voto existente — registrar este como o primeiro voto
      await this.state.storage.put("voted", true);
      const resp: VoteDedupResponse = { firstVote: true };
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }
}
