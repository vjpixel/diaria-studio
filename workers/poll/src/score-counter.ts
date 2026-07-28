/**
 * workers/poll/src/score-counter.ts (#4169)
 *
 * Durable Object `ScoreCounter` — serializa o read-modify-write de
 * `score:{email}` (global) e `score-by-month:{monthSlug}:{email}` (mensal),
 * fechando a race que o #4168 (releitura fresca de `score:{email}` dentro de
 * `runVoteBookkeeping`, vote.ts) só ESTREITOU sem eliminar.
 *
 * ## Problema (#4169, follow-up do #4125 item 1 / #4168)
 * `updateScore`/`updateScoreByMonth` (vote.ts) fazem read-modify-write
 * NÃO-serializado em KV. Dois `runVoteBookkeeping` concorrentes do MESMO
 * e-mail (edições diferentes — o modo sequência permite votar em pares
 * sucessivos rapidamente, e o fast-path #3983 responde ao cliente ANTES de
 * qualquer escrita) podem intercalar entre o `get` e o `put`: o último a
 * gravar sobrescreve o incremento do outro. O leitor perde silenciosamente 1
 * ponto (global e/ou mensal) — sem erro, sem log.
 *
 * ## Solução: mesmo padrão do StatsCounter (#2223), opção (a)
 * - `ScoreCounter` é instanciado por `{brand}:{email}` — uma instância por
 *   jogador×brand (brand incluído pro mesmo isolamento diaria×clarice×web já
 *   usado por VoteDedup/StatsCounter — evita colisão quando o mesmo e-mail
 *   vota em brands distintos).
 * - O DO mantém o estado no seu PRÓPRIO storage SQLite:
 *     "score"        → ScoreData (global)
 *     "month:{slug}" → MonthScoreData (um registro por mês votado)
 * - `state.blockConcurrencyWhile` serializa CADA fetch ao MESMO DO — duas
 *   chamadas concorrentes (update-score OU update-month, mesmo email,
 *   edições diferentes) são processadas em série. Como as duas rotas vivem
 *   na MESMA instância (mesma chave `{brand}:{email}`), o mutex é único por
 *   jogador — não há como um /update-score e um /update-month do mesmo
 *   jogador intercalarem entre si nem consigo mesmos.
 * - O KV `score:{email}` / `score-by-month:{month}:{email}` continua sendo
 *   atualizado como ESPELHO pelo caller (vote.ts) após cada resposta do DO —
 *   compat com leitores externos que fazem `list()` sobre
 *   `score-by-month:{month}:*` (leaderboard mensal), algo que um DO
 *   por-email não consegue servir sozinho (cada instância só conhece o
 *   PRÓPRIO email, `list()` não existe nesse escopo).
 *
 * ## nickname NÃO vive aqui (decisão deliberada)
 * `nickname` é escrito por um caminho TOTALMENTE separado (`handleSetName`,
 * index.ts) que lê/escreve `score:{email}` DIRETO no KV, sem passar por
 * `updateScore` nem por este DO. Se o DO fosse a fonte de verdade de
 * `nickname` também, o mirror pós-voto (vote.ts, depois de cada resposta
 * deste DO) sobrescreveria de volta o nickname já definido pelo leitor com o
 * valor (nunca atualizado) que o DO guarda — regressão de perda de nickname.
 * Por isso `ScoreData`/`MonthScoreData` aqui só cobrem os campos que ESTE
 * fix precisa serializar (total/correct/streak/last_edition/last_vote_ts);
 * `nickname` continua sendo mesclado pelo CALLER a partir do KV mais recente
 * antes de cada write (ver `updateScore`/`updateScoreByMonth`, vote.ts) —
 * exatamente o mesmo comportamento (e a mesma janela de race residual,
 * pré-existente e fora de escopo) de antes desta mudança.
 *
 * ## Baseline seed (mesmo racional do #3115 em stats-counter.ts)
 * Um DO nunca inicializado (jogador que votou ANTES do deploy deste DO) é
 * indistinguível de um jogador zerado de verdade. O caller lê o espelho KV
 * ANTES de chamar o DO e passa como `kvBaseline` — usado SÓ quando o storage
 * do DO está `undefined` (nunca sobrescreve um estado real já gravado, mesmo
 * que zerado). Um `kvBaseline` STALE (lido antes de outro voto concorrente já
 * ter atualizado o DO) é inofensivo: só importa quando o storage NUNCA foi
 * tocado — assim que QUALQUER voto concorrente grava primeiro, o storage
 * deixa de ser `undefined` e o `kvBaseline` subsequente é ignorado. É esse
 * mecanismo que fecha a race: mesmo que o caller leia um `kvBaseline`
 * desatualizado, o DO usa o próprio estado (já correto, atualizado por quem
 * gravou primeiro) em vez do baseline.
 *
 * ## Streak (score global)
 * A lógica de streak (`isConsecutiveVotingPeriod`, lib.ts) é reaplicada aqui
 * byte-a-byte a partir de `updateScore` (vote.ts) — o DO precisa ser a ÚNICA
 * fonte que decide o próximo `score.streak` a partir de agora; duas
 * implementações da mesma regra (DO vs. fallback KV) poderiam divergir
 * silenciosamente se uma fosse editada sem a outra.
 *
 * ## Limitação residual conhecida: `/jogar/identify` (#3975/#3996, brand "web")
 * `performIdentifyMerge` (identify.ts) escreve `score:{email}` /
 * `score-by-month:{slug}:{email}` DIRETO no KV (merge de uma sessão anônima
 * com uma identidade e-mail) — um QUARTO caminho que bypassa este DO, além
 * de `handleSetName`. Na prática isso é inofensivo: `email` (identificado)
 * NUNCA é usado como identidade de ESCRITA por `/vote` (que só aceita o
 * token anônimo `{uuid}@web.eia.diaria.local`, #3976, ou a identidade de
 * sessão do gate #4054) — então o DO `web:{email}` tende a nunca ser
 * inicializado por essa chave e o `kvBaseline` (lido fresco a cada chamada)
 * sempre reflete o merge mais recente. O único cenário onde isso
 * degradaria é um e-mail que TAMBÉM vota diretamente sob essa identidade via
 * sessão do gate #4054 E recebe um merge do #3975 DEPOIS de o DO já estar
 * inicializado — nesse caso o próximo voto usaria o cache do DO (mais
 * antigo) e ignoraria o merge. Cruzamento de dois fluxos já complexos
 * (#3975×#4054), não observado em produção até #4169; não resolvido aqui
 * por escopo (a correção exigiria `performIdentifyMerge` também empurrar o
 * valor mesclado pro DO via um endpoint de replace) — reportar em issue
 * separada se for observado.
 *
 * ## Consistência com correções de gabarito (#4169, mesma classe do #4125 item 2)
 * `handleAdminCorrect` (index.ts) pode mudar retroativamente o campo
 * `correct` de votos já contabilizados (`adjustScoreCorrectOnly`/
 * `adjustScoreByMonthCorrectOnly`, vote.ts) — SEM passar pelos endpoints
 * `/update-score`/`/update-month` acima. Sem sincronizar o DO também, o
 * `correct` cacheado no storage do DO ficaria stale, e o PRÓXIMO voto real
 * incrementaria a partir da base ERRADA (perpetuando o erro em vez de
 * autocorrigir, que é o que acontecia no caminho 100%-KV antes deste fix).
 * `/adjust-correct` e `/adjust-month-correct` existem só para isso: aplicam
 * o MESMO delta ±1 clampado em 0 que `adjustScoreCorrectOnly`/
 * `adjustScoreByMonthCorrectOnly` já aplicam no KV, mas dentro do storage do
 * DO. Chamados best-effort/fail-soft pelo caller (nunca bloqueiam o backfill
 * do admin) — DO nunca inicializado é no-op (`adjusted: false`): o histórico
 * pré-deploy deste DO simplesmente não tem cache pra corrigir; o KV (fonte
 * usada por `/stats`-like readers) já foi corrigido de qualquer forma.
 *
 * ## Interface
 *   POST /update-score        — body: UpdateScorePayload         → { ok: true; score: ScoreData }
 *   POST /update-month        — body: UpdateMonthPayload         → { ok: true; month: MonthScoreData }
 *   POST /adjust-correct      — body: AdjustScoreCorrectPayload  → { ok: true; adjusted: boolean; score?: ScoreData }
 *   POST /adjust-month-correct — body: AdjustMonthCorrectPayload → { ok: true; adjusted: boolean; month?: MonthScoreData }
 */

import { type Brand, isConsecutiveVotingPeriod } from "./lib";

/** Shape do score GLOBAL armazenado no DO (sem nickname — ver rationale acima). */
export interface ScoreData {
  total: number;
  correct: number;
  streak: number;
  last_edition: string | null;
}

/** Shape do score MENSAL armazenado no DO (sem nickname — ver rationale acima). */
export interface MonthScoreData {
  total: number;
  correct: number;
  last_edition: string | null;
  last_vote_ts?: string;
}

function defaultScore(): ScoreData {
  return { total: 0, correct: 0, streak: 0, last_edition: null };
}

function defaultMonthScore(): MonthScoreData {
  return { total: 0, correct: 0, last_edition: null };
}

/**
 * #4169: mesmo padrão de validação de shape do #3115 (isValidStatsCounterData,
 * stats-counter.ts) — protege contra um `kvBaseline` malformado virar seed
 * inválido do DO.
 */
export function isValidScoreData(data: unknown): data is ScoreData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    Number.isInteger(d.total) && (d.total as number) >= 0 &&
    Number.isInteger(d.correct) && (d.correct as number) >= 0 &&
    Number.isInteger(d.streak) && (d.streak as number) >= 0 &&
    (d.last_edition === null || typeof d.last_edition === "string")
  );
}

/** Mesmo racional de `isValidScoreData`, para o registro mensal. */
export function isValidMonthScoreData(data: unknown): data is MonthScoreData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    Number.isInteger(d.total) && (d.total as number) >= 0 &&
    Number.isInteger(d.correct) && (d.correct as number) >= 0 &&
    (d.last_edition === null || typeof d.last_edition === "string") &&
    (d.last_vote_ts === undefined || typeof d.last_vote_ts === "string")
  );
}

export interface UpdateScorePayload {
  edition: string;
  correct: boolean | null;
  brand: Brand;
  kvBaseline?: ScoreData | null;
}

export interface UpdateMonthPayload {
  edition: string;
  monthSlug: string;
  correct: boolean | null;
  kvBaseline?: MonthScoreData | null;
}

export interface AdjustScoreCorrectPayload {
  prevCorrect: boolean | null;
  newCorrect: boolean;
}

export interface AdjustMonthCorrectPayload {
  monthSlug: string;
  prevCorrect: boolean | null;
  newCorrect: boolean;
}

/**
 * ScoreCounter — Durable Object que serializa score:{email} e
 * score-by-month:{month}:{email} por jogador.
 *
 * Uma instância por `{brand}:{email}` — brand incluído pelo mesmo motivo de
 * isolamento de VOTE_DEDUP/STATS_COUNTER.
 */
export class ScoreCounter {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/update-score" && request.method === "POST") {
      return this.handleUpdateScore(request);
    }
    if (path === "/update-month" && request.method === "POST") {
      return this.handleUpdateMonth(request);
    }
    if (path === "/adjust-correct" && request.method === "POST") {
      return this.handleAdjustCorrect(request);
    }
    if (path === "/adjust-month-correct" && request.method === "POST") {
      return this.handleAdjustMonthCorrect(request);
    }

    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Incrementa o score GLOBAL de forma serializada — espelha byte-a-byte a
   * lógica de `updateScore` (vote.ts), incluindo o cálculo de streak
   * (`isConsecutiveVotingPeriod`, lib.ts).
   */
  private async handleUpdateScore(request: Request): Promise<Response> {
    return await this.state.blockConcurrencyWhile(async () => {
      const payload = await request.json() as UpdateScorePayload;
      const { edition, correct, brand, kvBaseline } = payload;

      const stored = await this.state.storage.get<ScoreData>("score");
      let score: ScoreData;
      if (stored !== undefined) {
        score = stored;
      } else if (kvBaseline && isValidScoreData(kvBaseline)) {
        score = { ...kvBaseline };
      } else {
        score = defaultScore();
      }

      score.total += 1;
      if (correct === true) {
        const continues = isConsecutiveVotingPeriod(score.last_edition, edition, brand);
        score.streak = continues ? (score.streak || 0) + 1 : 1;
        score.correct += 1;
        score.last_edition = edition;
      } else if (correct === false) {
        score.streak = 0;
        score.last_edition = edition;
      }

      await this.state.storage.put("score", score);

      return new Response(JSON.stringify({ ok: true, score }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  /**
   * Incrementa o score MENSAL de forma serializada — espelha byte-a-byte a
   * lógica de `updateScoreByMonth` (vote.ts). Nickname NÃO é gerenciado aqui
   * (ver rationale no header do arquivo) — o caller mescla o nickname a
   * partir do KV antes de gravar o mirror.
   */
  private async handleUpdateMonth(request: Request): Promise<Response> {
    return await this.state.blockConcurrencyWhile(async () => {
      const payload = await request.json() as UpdateMonthPayload;
      const { edition, monthSlug, correct, kvBaseline } = payload;
      const storageKey = `month:${monthSlug}`;

      const stored = await this.state.storage.get<MonthScoreData>(storageKey);
      let month: MonthScoreData;
      if (stored !== undefined) {
        month = stored;
      } else if (kvBaseline && isValidMonthScoreData(kvBaseline)) {
        month = { ...kvBaseline };
      } else {
        month = defaultMonthScore();
      }

      month.total += 1;
      if (correct === true) month.correct += 1;
      month.last_edition = edition;
      month.last_vote_ts = new Date().toISOString();

      await this.state.storage.put(storageKey, month);

      return new Response(JSON.stringify({ ok: true, month }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  /**
   * Ajusta `score.correct` em ±1 (clampado em 0) — mesma lógica de
   * `adjustScoreCorrectOnly` (vote.ts), chamada por `handleAdminCorrect`
   * (index.ts) durante o backfill de gabarito. NUNCA toca total/streak.
   *
   * DO nunca inicializado (`stored === undefined`) → no-op (`adjusted:
   * false`): não há cache pra corrigir; o KV (fonte de `/update-score` na
   * próxima vez que este DO for semeado) já foi corrigido pelo caller.
   */
  private async handleAdjustCorrect(request: Request): Promise<Response> {
    return await this.state.blockConcurrencyWhile(async () => {
      const payload = await request.json() as AdjustScoreCorrectPayload;
      const { prevCorrect, newCorrect } = payload;

      const stored = await this.state.storage.get<ScoreData>("score");
      if (stored === undefined) {
        return new Response(JSON.stringify({ ok: true, adjusted: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (prevCorrect === newCorrect) {
        return new Response(JSON.stringify({ ok: true, adjusted: false, score: stored }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (prevCorrect !== true && newCorrect === true) {
        stored.correct += 1;
      } else if (prevCorrect === true && newCorrect === false) {
        stored.correct = Math.max(0, stored.correct - 1);
      }

      await this.state.storage.put("score", stored);

      return new Response(JSON.stringify({ ok: true, adjusted: true, score: stored }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  /** Mesmo racional de `handleAdjustCorrect`, para o registro mensal. */
  private async handleAdjustMonthCorrect(request: Request): Promise<Response> {
    return await this.state.blockConcurrencyWhile(async () => {
      const payload = await request.json() as AdjustMonthCorrectPayload;
      const { monthSlug, prevCorrect, newCorrect } = payload;
      const storageKey = `month:${monthSlug}`;

      const stored = await this.state.storage.get<MonthScoreData>(storageKey);
      if (stored === undefined) {
        return new Response(JSON.stringify({ ok: true, adjusted: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (prevCorrect === newCorrect) {
        return new Response(JSON.stringify({ ok: true, adjusted: false, month: stored }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (prevCorrect !== true && newCorrect === true) {
        stored.correct += 1;
      } else if (prevCorrect === true && newCorrect === false) {
        stored.correct = Math.max(0, stored.correct - 1);
      }

      await this.state.storage.put(storageKey, stored);

      return new Response(JSON.stringify({ ok: true, adjusted: true, month: stored }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }
}
