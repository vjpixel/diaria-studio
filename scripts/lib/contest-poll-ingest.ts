/**
 * contest-poll-ingest.ts (#7209, fatia 14 do épico #7163)
 *
 * Miolo PURO da ingestão de 2 fatos de AÇÃO DELIBERADA do leitor — resposta
 * ao concurso "ache o erro" e voto do "É IA?" — pro store unificado
 * `diaria-subscribers-db.ts`. Mesmo padrão de `kit-subscribers-ingest.ts`/
 * `beehiiv-subscribers-ingest.ts`: testável sem rede, `DatabaseSync`
 * `:memory:` injetada, nenhuma chamada de I/O aqui.
 *
 * ## Por que os dois entram como `event`, tipo NOVO (não `subtype`)
 *
 * Ver o comentário de `EVENT_TYPES` em `diaria-subscribers-db.ts` — decisão
 * já registrada lá, não repetida aqui: `contest_reply`/`poll_vote` são eixos
 * PRÓPRIOS (ação deliberada da pessoa), não refinamento de um tipo já
 * modelado.
 *
 * ## `platform` gravado como `"beehiiv"` — decisão explícita, não omissão
 *
 * `event.platform` é `NOT NULL` e restrito a `PLATFORMS` (`beehiiv` |
 * `brevo_diaria` | `kit`) — nem resposta de e-mail (via Gmail) nem voto do
 * Worker `poll` têm uma "plataforma de origem" nesse sentido; as duas são
 * ações de quem já É assinante em alguma das 3. `"beehiiv"` é a escolha
 * (não `"kit"`/`"brevo_diaria"`) porque é a plataforma PRIMÁRIA da diária
 * hoje — o efeito prático é transitório: `resolveIdentitiesByEmail`
 * (`diaria-subscribers-identity-resolve.ts`, fatia 5, #6589) funde por
 * e-mail canonicalizado DEPOIS da ingestão, então uma pessoa que só existe
 * na Beehiiv via este módulo se funde com o alias Kit/Brevo dela assim que
 * ambos forem ingeridos — a etiqueta de plataforma aqui não prende a pessoa
 * a essa plataforma pra sempre, só precisa satisfazer o `NOT NULL` até a
 * fusão rodar.
 *
 * ## Identidade anônima do voto — NUNCA funde (#4433, `purge-leaderboard`)
 *
 * O Worker `poll` cria uma identidade `{uuid}@web.eia.diaria.local` pra
 * quem vota sem se identificar (ver `resolveLinkedAnonymousIdentities` em
 * `purge-leaderboard-plan.ts`). `ingestPollVotes` NUNCA chama
 * `ensureSubscriber` pra esse padrão — voto anônimo é contado em
 * `skippedAnonymous`, nunca vira `subscriber`/`event`. Só quem se
 * identificou (e-mail real, `poll_sig`/magic link) entra no store.
 *
 * ## `data/contest-entries.jsonl` — fonte, não escrita por este repo
 *
 * O corpo da issue #7209 descreve o schema (`reader_email`, `reader_name`,
 * `edition`, `reply_thread_id`, `confirmed_at`) como já existente em disco;
 * nenhum script deste checkout grava esse arquivo hoje (não localizado —
 * grep no repo inteiro não acha nenhum consumidor/produtor) — pode ser
 * mantido manualmente pelo editor ou por um processo fora deste repo.
 * `parseContestEntriesJsonl` é TOLERANTE ao formato descrito na issue
 * (mesma disciplina de `parseIntentionalErrorsJsonl`,
 * `scripts/lib/intentional-errors.ts`: linha que não parseia ou sem
 * `reader_email` é ignorada, nunca aborta o resto do arquivo) — se o schema
 * real divergir, ajustar aqui é uma mudança pequena e isolada.
 *
 * ## Score do voto — FORA de escopo desta 1ª passada
 *
 * `ingestPollVotes` grava a AÇÃO (quem votou, quando, em qual edição) —
 * não o valor do voto (`score:{email}` do Worker `poll`). `event` não tem
 * coluna de valor genérico, e `subtype` é documentado (ver `SCHEMA` em
 * `diaria-subscribers-db.ts`) como refinamento de TIPO, não payload — usar
 * `subtype` pra carregar o score misturaria as duas semânticas. Decisão
 * explícita de escopo: o fato "esta pessoa votou nesta edição" já cobre o
 * pedido central da issue ("resposta datada por pessoa e por edição");
 * persistir o valor do voto fica pra quando houver um consumidor real que
 * precise dele (nenhum citado no corpo da issue).
 *
 * ## Wiring de rede — FORA de escopo (mesma razão do Kit em #7206)
 *
 * O fetch real de `data/contest-entries.jsonl` (arquivo local, sem rede) é
 * trivial e poderia ser wireado num CLI — não feito aqui só por não haver
 * consumidor/produtor localizado pra confirmar o schema ao vivo. O fetch do
 * voto do "É IA?" (Beehiiv custom field `poll_sig` — já coberto
 * GENERICAMENTE por `extractBeehiivCustomFieldAttributes`, nenhuma mudança
 * necessária — e o Worker `poll`, que exige `wrangler`/KV ao vivo) fica de
 * fora desta unidade pelo guard de publicação do overnight/develop (nunca
 * rede real numa sessão automatizada) — mesma decisão já registrada em
 * `kit-subscribers-ingest.ts` pro Kit event.url (#7206).
 */

import type { DatabaseSync } from "node:sqlite";
import { ensureSubscriber, recordEvent } from "./diaria-subscribers-db.ts";

// ---------------------------------------------------------------------------
// Resposta ao concurso "ache o erro" — data/contest-entries.jsonl
// ---------------------------------------------------------------------------

/** 1 linha de `data/contest-entries.jsonl`, schema do corpo da #7209. */
export interface ContestEntryRecord {
  reader_email: string;
  reader_name?: string;
  edition: string;
  reply_thread_id?: string;
  confirmed_at: string;
}

/**
 * Parse tolerante de `data/contest-entries.jsonl` — 1 JSON por linha. Linha
 * vazia, malformada, ou sem `reader_email`/`edition`/`confirmed_at`
 * utilizáveis é ignorada silenciosamente (nunca aborta o arquivo inteiro) —
 * mesmo padrão de `parseIntentionalErrorsJsonl`.
 */
export function parseContestEntriesJsonl(raw: string): ContestEntryRecord[] {
  const out: ContestEntryRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const p = parsed as Record<string, unknown>;
    if (typeof p.reader_email !== "string" || !p.reader_email.trim()) continue;
    if (typeof p.edition !== "string" || !p.edition.trim()) continue;
    if (typeof p.confirmed_at !== "string" || !p.confirmed_at.trim()) continue;
    out.push({
      reader_email: p.reader_email.trim(),
      reader_name: typeof p.reader_name === "string" && p.reader_name.trim() ? p.reader_name.trim() : undefined,
      edition: p.edition.trim(),
      reply_thread_id:
        typeof p.reply_thread_id === "string" && p.reply_thread_id.trim() ? p.reply_thread_id.trim() : undefined,
      confirmed_at: p.confirmed_at.trim(),
    });
  }
  return out;
}

export interface ContestReplyIngestResult {
  newEvents: number;
  alreadyKnown: number;
  subscribersTouched: number;
  skippedNoEmail: number;
}

/**
 * Chave natural do evento `contest_reply` — escopada por (e-mail, edição,
 * thread) quando `reply_thread_id` está presente (defende contra 2 threads
 * distintas da MESMA pessoa na MESMA edição, caso raro mas possível); cai
 * pra (e-mail, edição) quando ausente.
 */
export function buildContestReplyExternalId(email: string, edition: string, replyThreadId?: string): string {
  const base = `${email.trim().toLowerCase()}:contest_reply:${edition}`;
  return replyThreadId ? `${base}:${replyThreadId}` : base;
}

/**
 * Ingerir respostas ao concurso "ache o erro" — 1 `subscriber` (platform
 * `"beehiiv"`, ver docstring do módulo) + 1 `event` tipo `contest_reply`
 * por entrada. Idempotente via `INSERT OR IGNORE` (`recordEvent`).
 */
export function ingestContestReplies(
  db: DatabaseSync,
  entries: readonly ContestEntryRecord[],
  now: string = new Date().toISOString(),
): ContestReplyIngestResult {
  let newEvents = 0;
  let alreadyKnown = 0;
  let subscribersTouched = 0;
  let skippedNoEmail = 0;

  for (const entry of entries) {
    const email = entry.reader_email.trim().toLowerCase();
    if (!email) {
      skippedNoEmail++;
      continue;
    }
    const subscriberId = ensureSubscriber(db, "beehiiv", null, email, now);
    subscribersTouched++;
    const { inserted } = recordEvent(db, {
      subscriberId,
      platform: "beehiiv",
      type: "contest_reply",
      externalEventId: buildContestReplyExternalId(email, entry.edition, entry.reply_thread_id),
      edicao: entry.edition,
      ts: entry.confirmed_at,
    });
    if (inserted) newEvents++;
    else alreadyKnown++;
  }

  return { newEvents, alreadyKnown, subscribersTouched, skippedNoEmail };
}

// ---------------------------------------------------------------------------
// Voto do "É IA?" — Worker poll (score:{email} / score-by-month:{slug}:{email})
// ---------------------------------------------------------------------------

/** Domínio da identidade anônima do voto web (ver `resolveLinkedAnonymousIdentities`,
 *  `purge-leaderboard-plan.ts`). Case-insensitive — o Worker sempre grava
 *  minúsculo, mas o guard não deve depender disso. */
const ANONYMOUS_POLL_EMAIL_SUFFIX = "@web.eia.diaria.local";

/**
 * `true` quando `email` é a identidade anônima que o Worker `poll` cria pra
 * quem vota sem se identificar — NUNCA deve virar `subscriber`/`event`
 * (#4433: fundir essa identidade com uma pessoa real é o bug que
 * `purge-leaderboard` existe pra corrigir; este guard evita introduzi-lo).
 */
export function isAnonymousPollIdentity(email: string): boolean {
  return email.trim().toLowerCase().endsWith(ANONYMOUS_POLL_EMAIL_SUFFIX);
}

/** 1 voto do "É IA?" já resolvido (e-mail real, não a chave bruta do KV) —
 *  o fetch do Worker `poll` (`wrangler`/KV ao vivo) fica fora desta unidade,
 *  ver docstring do módulo. `edition` é o slug da edição votada. */
export interface PollVoteRecord {
  email: string;
  edition: string;
  ts: string;
}

export interface PollVoteIngestResult {
  newEvents: number;
  alreadyKnown: number;
  subscribersTouched: number;
  skippedAnonymous: number;
  skippedNoEmail: number;
}

/** Chave natural do evento `poll_vote` — (e-mail, edição), 1 voto por
 *  pessoa por edição é o modelo do Worker `poll` (`score-by-month:{slug}:{email}`). */
export function buildPollVoteExternalId(email: string, edition: string): string {
  return `${email.trim().toLowerCase()}:poll_vote:${edition}`;
}

/**
 * Ingerir votos do "É IA?" já identificados (e-mail real) — pula qualquer
 * `email` que case `isAnonymousPollIdentity` (contado em `skippedAnonymous`,
 * nunca vira `subscriber`). Idempotente via `INSERT OR IGNORE`.
 *
 * Grava só a AÇÃO (quem, quando, qual edição) — não o valor do voto (score)
 * — ver "Score do voto — FORA de escopo" na docstring do módulo.
 */
export function ingestPollVotes(
  db: DatabaseSync,
  votes: readonly PollVoteRecord[],
  now: string = new Date().toISOString(),
): PollVoteIngestResult {
  let newEvents = 0;
  let alreadyKnown = 0;
  let subscribersTouched = 0;
  let skippedAnonymous = 0;
  let skippedNoEmail = 0;

  for (const vote of votes) {
    const email = vote.email.trim().toLowerCase();
    if (!email) {
      skippedNoEmail++;
      continue;
    }
    if (isAnonymousPollIdentity(email)) {
      skippedAnonymous++;
      continue;
    }
    const subscriberId = ensureSubscriber(db, "beehiiv", null, email, now);
    subscribersTouched++;
    const { inserted } = recordEvent(db, {
      subscriberId,
      platform: "beehiiv",
      type: "poll_vote",
      externalEventId: buildPollVoteExternalId(email, vote.edition),
      edicao: vote.edition,
      ts: vote.ts,
    });
    if (inserted) newEvents++;
    else alreadyKnown++;
  }

  return { newEvents, alreadyKnown, subscribersTouched, skippedAnonymous, skippedNoEmail };
}
