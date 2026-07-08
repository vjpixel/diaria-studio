import type { Env } from "./index";
import { rankEntries, type LeaderboardEntry } from "./leaderboard";
import {
  type Brand,
  currentMonthSlugBrt,
  monthSlugCompare,
  parseMonthSlug,
  MONTH_NAMES_PT,
  BRAND_INFO,
  leaderboardHref,
  formatEditionDateForBrand,
} from "./lib";
import { htmlEscape, renderSeoMeta } from "./lib"; // #3106: meta description/OG/Twitter/canonical/favicon
import { renderRuleStyles, renderFooterStyles, renderBrandFooter } from "./lib"; // #3113: régua teal + rodapé de marca
import { corsHeaders, json, votePageHtml } from "./index";
// #3111: tokens do DS canônico gerados por scripts/generate-worker-tokens.ts a
// partir de scripts/lib/shared/design-tokens.ts — nunca hardcodear valores de
// cor/fonte inline aqui (ver test/poll-ds-tokens.test.ts para a trava).
import { DS_COLORS, DS_FONTS } from "./ds-tokens.generated";

export interface LeaderTop1Entry {
  nickname: string;
  pct: number;
  correct: number;
  total: number;
}

export function computeTop1(
  scores: Array<{ email: string; nickname: string | null; correct: number; total: number }>,
): LeaderTop1Entry[] {
  const withNickname = scores
    .filter((s) => s.nickname && s.nickname.trim().length > 0)
    .filter((s) => s.total > 0)
    .map((s) => ({
      nickname: s.nickname!,
      correct: s.correct,
      total: s.total,
      pct: Math.round((s.correct / s.total) * 100),
    }));
  if (withNickname.length === 0) return [];

  // Tiebreaker: nickname ASC (estável + previsível pra cache)
  withNickname.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    if (b.correct !== a.correct) return b.correct - a.correct;
    return a.nickname.localeCompare(b.nickname);
  });

  const top = withNickname[0];
  return withNickname.filter((s) => s.pct === top.pct && s.correct === top.correct);
}

/**
 * Pure (#1160 followup): retorna leitores nos ranks 1, 2 e 3 do leaderboard
 * mensal, na mesma ordem do leaderboard público (dense rank, tiebreaker
 * nickname ASC). Critério de rank: `rankEntries` em ./leaderboard (correct
 * DESC, total DESC, nickname ASC).
 *
 * Entries sem nickname são incluídas com email mascarado (`user@***`) —
 * mesma política do leaderboard público (renderLeaderboardHtml). Issue #1353
 * é o follow-up pra incentivar leitores a definir nickname.
 *
 * Output: array de `{ nickname, rank }` em ordem de exibição. Campo
 * `nickname` é o display final (nickname real OU email mascarado).
 * Ranks empatados compartilham número (dense): 1, 1, 2, 3, 3 é válido.
 *
 * Caso 6+ pessoas em rank 1: retorna todas (renderer decide cap visual).
 */
export interface PodiumEntry {
  nickname: string;
  rank: number;
}

function maskEmail(email: string): string {
  return email.replace(/@.*/, "@***");
}

export function computePodium(
  scores: Array<{ email: string; nickname: string | null; correct: number; total: number }>,
): PodiumEntry[] {
  // Reusa rankEntries com shape LeaderboardEntry (precisa pct + streak).
  const eligible = scores
    .filter((s) => s.total > 0)
    .map((s) => {
      const hasNickname = s.nickname && s.nickname.trim().length > 0;
      const display = hasNickname ? s.nickname!.trim() : maskEmail(s.email);
      return {
        email: s.email,
        nickname: display,
        correct: s.correct,
        total: s.total,
        pct: s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0,
        streak: 0,
      };
    });
  if (eligible.length === 0) return [];
  const ranked = rankEntries(eligible);
  return ranked
    .filter((e) => e.rank <= 3)
    .map((e) => ({ nickname: e.nickname!, rank: e.rank }));
}

export async function handleLeaderboardTop1(url: URL, env: Env): Promise<Response> {
  // #1345: ?period=YYYY-MM filtra mês específico via score-by-month index;
  // omitted = mês corrente. Default mantém compat com clientes existentes.
  const periodParam = url.searchParams.get("period");
  const monthSlug = periodParam ?? currentMonthSlugBrt(new Date());
  const parsed = parseMonthSlug(monthSlug);
  if (!parsed) {
    return json({ error: "period inválido — use YYYY-MM" }, 400, env);
  }

  // #1348: usa snapshot pré-computado em vez de list+gets inline.
  const scores = await getOrComputeSnapshot(env, monthSlug);
  const top1 = computeTop1(scores);
  // #1160 followup: podium (ranks 1-3) pra newsletter. Mantém top1 pra
  // back-compat com clientes existentes; podium é o campo novo recomendado.
  const podium = computePodium(scores);
  const periodLabel = `${MONTH_NAMES_PT[parsed.month - 1].charAt(0).toUpperCase()}${MONTH_NAMES_PT[parsed.month - 1].slice(1)}`;
  return json({ top1, podium, period: periodLabel, period_slug: monthSlug }, 200, env);
}

// ── Snapshot key (#1348) ──────────────────────────────────────────────────

/**
 * Entry shape no snapshot — mesma estrutura usada em handlers e em
 * scoreByMonthEntriesToLeaderboard. Persistido como JSON em
 * `leaderboard-snapshot:{slug}`.
 *
 * #2123: `last_vote_ts` incluído pra que o dense-rank use o tiebreaker
 * real (voto mais recente) também no caminho snapshot — sem o campo, o
 * `rankEntries` caia no fallback de displayKey para TODOS os empates.
 * Back-compat: snapshots antigos sem o campo são tratados como undefined
 * (fallback de displayKey) — sem migração necessária.
 */
export interface SnapshotEntry {
  email: string;
  nickname: string | null;
  correct: number;
  total: number;
  /** #2123: ISO 8601 timestamp do voto mais recente — tiebreaker em `rankEntries`. */
  last_vote_ts?: string;
}

interface SnapshotPayload {
  entries: SnapshotEntry[];
  computed_at: string;
}

/**
 * #1348: lê snapshot pré-computado de `leaderboard-snapshot:{slug}` se existir,
 * senão recompute via `computeSnapshotEntries` (list + parallel gets) e
 * persiste. Lazy compute pattern — write-time invalidate, read-time refresh.
 *
 * Reduz subrequest budget de ~500 (1 list + N gets) pra 1 KV get no hot path.
 * Cold path (após invalidate) paga compute uma vez, próximos reads hit cache.
 */
export async function getOrComputeSnapshot(
  env: Env,
  slug: string,
): Promise<SnapshotEntry[]> {
  const snapKey = `leaderboard-snapshot:${slug}`;
  const cached = await env.POLL.get(snapKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as SnapshotPayload;
      if (Array.isArray(parsed.entries)) return parsed.entries;
    } catch {
      // Corrupted snapshot — fall through pra recompute
    }
  }
  const entries = await computeSnapshotEntries(env, slug);
  // #1666: não persistir snapshot VAZIO. handleLeaderboardByMonth precisa ler
  // entries mesmo pra mês futuro (o gate "ainda não começou" depende de
  // entries.length por causa do D+1 que acumula votos antes do slug virar), mas
  // um GET /leaderboard/{mês-futuro} sem votos (rota não-autenticada;
  // parseMonthSlug aceita anos 2000-2099) gravava um snapshot vazio por slug →
  // write amplification. Sem votos não há o que cachear; o 1º voto invalida e
  // reinicia o ciclo normal (o list de checagem segue cheap p/ prefix vazio).
  if (entries.length === 0) return entries;
  const payload: SnapshotPayload = {
    entries,
    computed_at: new Date().toISOString(),
  };
  // #1349 review fix D: TTL 24h como safety net. Se algum write path
  // futuro esquecer de invalidar, snapshot reseta sozinho em 24h ao invés
  // de ficar stale forever. Custo: re-compute diário mesmo sem invalidação.
  await env.POLL.put(snapKey, JSON.stringify(payload), { expirationTtl: 86400 });
  return entries;
}

/**
 * #1348: deleta snapshot do slug. Chamado de write-paths
 * (updateScoreByMonth, adjustScoreByMonthCorrectOnly, propagateNicknameByMonth).
 *
 * Race: 2 votes concorrentes ambos deletam, ambos vão computar no próximo
 * read. Idempotent — última escrita do snapshot é a correta no momento.
 */
export async function invalidateSnapshot(env: Env, slug: string): Promise<void> {
  await env.POLL.delete(`leaderboard-snapshot:${slug}`);
}

/**
 * #2113(b): lê o snapshot do slug, faz upsert da entry do leitor e regravo.
 *
 * Modelo HÍBRIDO (F1/F2/F3 — PR #2155 self-review):
 *
 *   - Snapshot PRESENTE e é array válido → upsert da própria entry preservando
 *     TTL 24h (#2129). Mantém read-your-own-write (#2113b) sem subrequests extras.
 *
 *   - Snapshot AUSENTE (null) OU corrompido (JSON inválido ou parsed.entries não
 *     é array) → skip-on-missing: NÃO grava snapshot nenhum. Deixa o próximo
 *     GET fazer full-compute via getOrComputeSnapshot (caminho lazy já existente).
 *
 * Rationale do skip-on-missing vs. computeSnapshotEntries no voto (#F3):
 *   handleVote já consumiu ~12 subrequests. computeSnapshotEntries adiciona
 *   1 list + N gets — para N≥35 votantes estoura o free-tier (50/req).
 *   Skip-on-missing resolve #2152 (nunca grava snapshot de 1 que esconde os
 *   outros N) e #F1/#F2 (corrompido não persiste como 1-entry por 24h) sem
 *   risco de estourar o orçamento de subrequests no caminho quente do voto.
 *   O próximo GET lazy-computa tudo corretamente.
 *
 * #2129 (fix): TTL 24h ao regravar — não rebaixa o cache de 24h do compute
 *   path. Read-your-own-write é garantido pela escrita da entry, não pelo TTL.
 *
 * Race entre votos concorrentes: última escrita vence. Snapshot é cache;
 * o próximo recompute produz o estado correto de qualquer forma.
 *
 * Cap de entradas no snapshot (#2125 — documentado):
 *   O upsert NÃO capa o número de entries no snapshot intencionalmente. O snapshot
 *   persiste TODOS os votantes para que o compute-path (getOrComputeSnapshot) possa
 *   fazer ranking correto sobre o conjunto completo. O cap visual de 50 é aplicado
 *   APENAS no render (handleLeaderboardByMonth: `rankEntries(scores).slice(0, 50)`)
 *   — não aqui. Capar no write esconderia votantes #51+ do ranking e quebraria o
 *   dense-rank para quem está perto do corte.
 *
 *   Volume esperado: ~50–200 votantes/mês em produção (Diar.ia). O snapshot por
 *   mês (JSON em KV) cresce ~200 bytes/votante → <40KB para 200 votantes, bem
 *   abaixo do limite de 128MB do KV da Cloudflare.
 */
export async function upsertOwnEntryInSnapshot(
  env: Env,
  slug: string,
  own: SnapshotEntry,
): Promise<void> {
  const snapKey = `leaderboard-snapshot:${slug}`;
  const cached = await env.POLL.get(snapKey);

  // Snapshot AUSENTE → skip-on-missing: deixa getOrComputeSnapshot lazy-reconstruir.
  // Gravar snapshot de 1 entrada aqui esconderia os N votantes existentes (#2152).
  if (!cached) return;

  let entries: SnapshotEntry[];
  try {
    const parsed = JSON.parse(cached) as { entries: SnapshotEntry[]; computed_at: string };
    if (!Array.isArray(parsed.entries)) {
      // Snapshot corrompido (JSON válido mas estrutura errada) → skip, lazy-rebuild.
      // Antes do fix persistia como 1-entry por 24h (#F1).
      await env.POLL.delete(snapKey);
      return;
    }
    entries = parsed.entries;
  } catch {
    // JSON inválido → skip, lazy-rebuild (#F2).
    await env.POLL.delete(snapKey);
    return;
  }

  // Snapshot presente e válido: upsert da própria entry.
  const emailLower = own.email.toLowerCase();
  const idx = entries.findIndex((e) => e.email.toLowerCase() === emailLower);
  if (idx >= 0) {
    // #2123 (review): own com last_vote_ts EXPLICITAMENTE undefined apagaria o valor
    // existente via spread — filtra chaves undefined antes do merge.
    // #2130 (pass2): filtro field-aware — null é filtrado só onde é inválido (ex:
    // last_vote_ts nunca é null em produção — ver computeSnapshotEntries). Para campos
    // onde null tem semântica de "limpar" (nickname: string | null), null é PRESERVADO
    // intencionalmente, permitindo que upsert limpe um nickname existente.
    const ownDefined = Object.fromEntries(
      Object.entries(own).filter(([k, v]) => {
        if (v === undefined) return false; // nunca spreada undefined
        if (v === null && k === "last_vote_ts") return false; // null aqui é fantasma
        return true; // nickname:null e outros null são valores legítimos
      }),
    );
    entries[idx] = { ...entries[idx], ...ownDefined, email: emailLower } as SnapshotEntry;
  } else {
    entries.push({ ...own, email: emailLower });
  }
  const payload = { entries, computed_at: new Date().toISOString() };
  // #2129: TTL 24h — same safety net do compute path (getOrComputeSnapshot).
  // TTL 300s estava invertido: expirava 5min após o último voto →
  // recompute (list + N gets) repetido em cada pico de leitura pós-envio.
  // Read-your-own-write é garantido pela escrita da entry, não pelo TTL curto.
  await env.POLL.put(snapKey, JSON.stringify(payload), { expirationTtl: 86400 }); // 24h
}

/**
 * #1348 (C): compute path — lista todas as `score-by-month:{slug}:*` keys
 * e fetcha values em batches paralelos. Reduz latência cold-path de ~15s
 * (500 gets sequenciais) pra ~750ms (25 batches × 30ms).
 *
 * batchSize=20 escolhido pra ficar dentro do limite subrequest do Worker
 * (free tier 50/req; paid 1000/req). Conservador — pode subir pra 50
 * se necessário.
 */
const SNAPSHOT_GET_BATCH_SIZE = 20;

export async function computeSnapshotEntries(
  env: Env,
  slug: string,
): Promise<SnapshotEntry[]> {
  const prefix = `score-by-month:${slug}:`;
  const keys: string[] = [];
  for await (const k of listAllKeys(env, prefix)) keys.push(k);

  const entries: SnapshotEntry[] = [];
  for (let i = 0; i < keys.length; i += SNAPSHOT_GET_BATCH_SIZE) {
    const batch = keys.slice(i, i + SNAPSHOT_GET_BATCH_SIZE);
    const values = await Promise.all(batch.map((k) => env.POLL.get(k)));
    for (let j = 0; j < batch.length; j++) {
      const raw = values[j];
      if (!raw) continue;
      // #1349 review fix A: try/catch evita que 1 entry corrompida derrube
      // o compute inteiro. Entry malformada é skipada e logada.
      let entry: { nickname?: string | null; correct?: number; total?: number; last_vote_ts?: string };
      try {
        entry = JSON.parse(raw);
      } catch {
        console.error(`[snapshot] skip corrupted entry: ${batch[j]}`);
        continue;
      }
      // #2123: propaga last_vote_ts pra SnapshotEntry — tiebreaker de dense-rank
      // via snapshot (rankEntries usa o campo; sem ele cai em displayKey).
      // undefined quando a entry foi gravada antes de #1383 ou na migração de
      // backfill — fallback de displayKey preservado sem migração.
      const snapshotEntry: SnapshotEntry = {
        email: batch[j].replace(prefix, ""),
        nickname: entry.nickname ?? null,
        correct: entry.correct ?? 0,
        total: entry.total ?? 0,
      };
      // #2130 (pass2): guarda pra SnapshotEntry só quando é string não-nula —
      // guarda assimétrico (!== undefined mas não !== null) criava gap onde null
      // passava direto e corrupia o campo no snapshot (tiebreaker de dense-rank).
      if (entry.last_vote_ts != null) snapshotEntry.last_vote_ts = entry.last_vote_ts;
      entries.push(snapshotEntry);
    }
  }
  return entries;
}

/**
 * #1345 followup: iterator paginado de KV list. Cloudflare KV list retorna
 * no máximo 1000 keys por call — sem cursor handling, entries silenciosamente
 * desaparecem em escala. Yield names um por um pra caller iterar.
 *
 * Exported pra ser testável (#1347): caller passa mock env com `POLL.list`
 * que simula resposta multi-page.
 */
export async function* listAllKeys(env: Env, prefix: string): AsyncGenerator<string> {
  let cursor: string | undefined;
  do {
    const result: KVNamespaceListResult<unknown, string> = await env.POLL.list({ prefix, cursor });
    for (const key of result.keys) yield key.name;
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
}

// ── /leaderboard/{YYYY-MM} (#1345) ───────────────────────────────────────────

/**
 * Pure (#1345): extrai entries de `score-by-month:{slug}:*` em
 * shape LeaderboardEntry pra alimentar rankEntries + render.
 *
 * Caller fornece o array já materializado (pra ser testável sem KV mock).
 * Entries sem `total` (corrompidas) viram pct=0; entries sem nickname
 * caem no fallback de email masked igual ao /leaderboard atual.
 */
export function scoreByMonthEntriesToLeaderboard(
  entries: Array<{
    email: string;
    nickname: string | null;
    correct: number;
    total: number;
    last_vote_ts?: string;
  }>,
): LeaderboardEntry[] {
  return entries.map((e) => {
    const pct = e.total > 0 ? Math.round((e.correct / e.total) * 100) : 0;
    return {
      email: e.email,
      nickname: e.nickname,
      correct: e.correct,
      total: e.total,
      pct,
      streak: 0, // streak é per-edition; não tracked no índice mensal (out of scope)
      // #1383: propaga last_vote_ts pro rankEntries usar como tiebreaker
      last_vote_ts: e.last_vote_ts,
    };
  });
}

/**
 * Pure (260601): decide se mostra a tela "ainda não começou" pro mês pedido.
 * Só quando o mês é estritamente futuro (`slugCmp > 0`) E não há nenhum voto
 * registrado ainda (`entryCount === 0`). Edição D+1 publica no dia 1º e já
 * acumula votos no bucket do mês antes de `currentMonthSlugBrt` virar — então
 * um mês "futuro" com votos deve renderizar a leaderboard, não a mensagem.
 */
export function shouldShowMonthNotStarted(slugCmp: number, entryCount: number): boolean {
  return slugCmp > 0 && entryCount === 0;
}

/**
 * Handler `/leaderboard/{YYYY-MM}` — lê apenas score-by-month:{slug}:* e
 * renderiza o mesmo HTML do leaderboard atual. Cache header diferente
 * conforme mês passado (immutable) vs corrente (1h).
 */
export async function handleLeaderboardByMonth(
  monthSlug: string,
  env: Env,
  brand: Brand = "diaria",
  canonicalPath?: string, // #3106: override usado por handleLeaderboard() — canonical de "/leaderboard", não "/leaderboard/{slug}"
): Promise<Response> {
  const parsed = parseMonthSlug(monthSlug);
  if (!parsed) {
    return new Response(votePageHtml("Mês inválido. Use formato YYYY-MM (ex: 2026-05).", false, null, null, null, brand), {
      status: 404, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }

  const currentSlug = currentMonthSlugBrt(new Date());
  const slugCmp = monthSlugCompare(monthSlug, currentSlug);

  // #1348: usa snapshot pré-computado em vez de list+gets inline.
  const entries = await getOrComputeSnapshot(env, monthSlug);
  const scores = scoreByMonthEntriesToLeaderboard(entries);

  // "Ainda não começou" só quando o mês é futuro E não há votos ainda.
  // Edição D+1 (publica dia 1º) já acumula votos no bucket do mês antes de
  // `currentMonthSlugBrt` virar — sem o `entries.length === 0`, o leitor que
  // votou via o link e via "ainda não começou" em vez do próprio voto (260601).
  if (shouldShowMonthNotStarted(slugCmp, entries.length)) {
    return new Response(votePageHtml(
      `O leaderboard de ${MONTH_NAMES_PT[parsed.month - 1]} de ${parsed.year} ainda não começou.`,
      false, null, null, null, brand,
    ), {
      status: 404, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }
  const periodLabel = `${MONTH_NAMES_PT[parsed.month - 1].charAt(0).toUpperCase()}${MONTH_NAMES_PT[parsed.month - 1].slice(1)}`;
  const isPast = slugCmp < 0;
  // #1345 followup: cache curto pro mês corrente — votos atualizam em real-time
  // e cache de 1h fazia leitor ver leaderboard stale por ~1h após votar.
  // 60s é suficiente pra absorver pico de tráfego sem mascarar updates.
  const cacheControl = isPast
    ? "public, max-age=2592000, immutable" // 30d, mês fechado nunca muda
    : "public, max-age=60"; // 60s pro mês corrente

  return renderLeaderboardHtml(
    scores, periodLabel, parsed.year, cacheControl, brand, "month",
    canonicalPath ?? leaderboardHref(brand, monthSlug),
  );
}

// ── /leaderboard/{YYYY-MM}.json (#2475 — endpoint JSON com métricas completas) ─

/**
 * Entry shape exposta pelo endpoint `/leaderboard/{YYYY-MM}.json`.
 * Inclui correct/total para TODOS os ranks (diferente do /leaderboard/top1
 * que só expõe métricas de rank=1 via campo `top1`).
 */
export interface LeaderboardJsonEntry {
  rank: number;
  medal: string;
  nickname: string;
  correct: number;
  total: number;
  pct: number;
}

/**
 * Handler `GET /leaderboard/{YYYY-MM}.json` (#2475)
 *
 * Retorna JSON array com todos os entries rankeados do mês, incluindo
 * correct/total para ranks 1-N (resolve o bug onde ranks 2/3 apareciam
 * com zeros no dashboard). Reusa a mesma pipeline de agregação do HTML:
 * getOrComputeSnapshot → scoreByMonthEntriesToLeaderboard → rankEntries.
 *
 * Cache: idêntico ao HTML (30d immutable para meses fechados, 60s para corrente).
 * CORS: sim (via corsHeaders helper).
 */
export async function handleLeaderboardByMonthJson(
  monthSlug: string,
  env: Env,
  brand: Brand = "diaria",
): Promise<Response> {
  const parsed = parseMonthSlug(monthSlug);
  if (!parsed) {
    return json({ error: "Mês inválido. Use formato YYYY-MM (ex: 2026-05)." }, 400, env);
  }

  const currentSlug = currentMonthSlugBrt(new Date());
  const slugCmp = monthSlugCompare(monthSlug, currentSlug);

  const entries = await getOrComputeSnapshot(env, monthSlug);

  // Mês futuro sem votos ainda
  if (shouldShowMonthNotStarted(slugCmp, entries.length)) {
    return json({ entries: [], period_slug: monthSlug, message: `O leaderboard de ${monthSlug} ainda não começou.` }, 200, env);
  }

  const scores = scoreByMonthEntriesToLeaderboard(entries);
  const ranked = rankEntries(scores);

  const medals = ["🥇", "🥈", "🥉"];
  const jsonEntries: LeaderboardJsonEntry[] = ranked.map((e) => {
    const rawNickname = e.nickname ?? null;
    const displayNickname = rawNickname
      ? rawNickname
      : (() => {
          const at = e.email.indexOf("@");
          return at > 0 ? `${e.email.slice(0, at)}@***` : `${e.email.slice(0, 4)}***`;
        })();
    return {
      rank: e.rank,
      medal: e.rank <= 3 ? medals[e.rank - 1] : "",
      nickname: displayNickname,
      correct: e.correct,
      total: e.total,
      pct: e.pct,
    };
  });

  const isPast = slugCmp < 0;
  const cacheControl = isPast
    ? "public, max-age=2592000, immutable" // 30d, mês fechado nunca muda
    : "public, max-age=60"; // 60s pro mês corrente

  return new Response(JSON.stringify({ entries: jsonEntries, period_slug: monthSlug }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
      ...corsHeaders(env),
    },
  });
}

// ── /leaderboard/{YYYY} (#2006 — visão ANUAL; default da Clarice News) ───────

/**
 * Pure (#2006): merge dos snapshots mensais de um ano em entries anuais —
 * soma (correct, total) por email; nickname = último não-nulo na ordem dos
 * meses (mês mais recente vence, espelhando a propagação de nickname mensal).
 */
export function mergeYearEntries(perMonth: SnapshotEntry[][]): SnapshotEntry[] {
  const byEmail = new Map<string, SnapshotEntry>();
  for (const month of perMonth) {
    for (const e of month) {
      const key = e.email.toLowerCase();
      const prev = byEmail.get(key);
      if (!prev) {
        // #2018: armazenar email lowercase — case divergente entre meses
        // (ex: "A@X.com" em jan, "a@x.com" em fev) resultava em entrada
        // com email original (mixed-case) na saída, quebrando exibição e
        // lookups subsequentes. Normalizar aqui garante consistência.
        byEmail.set(key, { ...e, email: key });
      } else {
        prev.correct += e.correct;
        prev.total += e.total;
        if (e.nickname) prev.nickname = e.nickname;
      }
    }
  }
  return [...byEmail.values()];
}

/**
 * Handler `/leaderboard/{YYYY}` — agrega os 12 meses do ano (snapshots mensais,
 * reusando o cache do #1348) e renderiza com título anual. É o período padrão
 * da Clarice News (#2006): cada leitor da mensal vota 1×/mês, então o ranking
 * mensal é degenerado (0/1 ou 1/1); o ano dá até 12 chances.
 */
export async function handleLeaderboardByYear(
  yearStr: string,
  env: Env,
  brand: Brand = "diaria",
): Promise<Response> {
  const year = parseInt(yearStr, 10);
  if (!/^\d{4}$/.test(yearStr) || year < 2000 || year > 2099) {
    return new Response(votePageHtml("Ano inválido. Use formato YYYY (ex: 2026).", false, null, null, null, brand), {
      status: 404, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }
  const currentSlug = currentMonthSlugBrt(new Date());
  const currentYear = parseInt(currentSlug.slice(0, 4), 10);
  const currentMonth = parseInt(currentSlug.slice(5, 7), 10);

  // Meses a agregar: ano passado = 12; ano corrente = até o mês atual (não
  // materializa snapshot de mês futuro — #1666); ano futuro = nenhum.
  const lastMonth = year < currentYear ? 12 : year === currentYear ? currentMonth : 0;
  // #2018: Promise.all em paralelo — subrequest budget free-tier permite N
  // concorrentes em paralelo (cada getOrComputeSnapshot é 1 KV get no hot
  // path, N≤12). Serial tinha latência O(N×RTT); agora é O(1×RTT) no hot path.
  const slugs = Array.from({ length: lastMonth }, (_, i) => `${yearStr}-${String(i + 1).padStart(2, "0")}`);
  const perMonth: SnapshotEntry[][] = await Promise.all(slugs.map((slug) => getOrComputeSnapshot(env, slug)));
  const entries = mergeYearEntries(perMonth);

  if (year > currentYear && entries.length === 0) {
    return new Response(votePageHtml(`O leaderboard de ${year} ainda não começou.`, false, null, null, null, brand), {
      status: 404, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }
  const scores = scoreByMonthEntriesToLeaderboard(entries);
  const cacheControl = year < currentYear
    ? "public, max-age=2592000, immutable" // ano fechado nunca muda
    : "public, max-age=60"; // corrente: real-time-ish (igual ao mensal)
  return renderLeaderboardHtml(scores, "", year, cacheControl, brand, "year", leaderboardHref(brand, yearStr));
}

/** Pure render — separado pra ser reusado por `/leaderboard` (corrente) + `/leaderboard/{YYYY-MM}`. */
function renderLeaderboardHtml(
  scores: LeaderboardEntry[],
  periodLabel: string,
  year: number,
  cacheControl: string,
  brand: Brand = "diaria",
  periodKind: "month" | "year" = "month", // #2006: visão anual (Clarice News)
  canonicalPath?: string, // #3106: path canônico da view atual (default = /leaderboard)
): Response {
  // #1905: título/copy/link por marca (Diar.ia diário vs Clarice News mensal).
  const info = BRAND_INFO[brand];
  // #2006: "Leaderboard de 2026" (ano) vs "Leaderboard de Maio de 2026" (mês).
  const heading = periodKind === "year" ? `Leaderboard de ${year}` : `Leaderboard de ${periodLabel} de ${year}`;
  const periodNoun = periodKind === "year" ? "este ano" : "esse mês";
  // #1092 + #1256: dense ranking — leitores empatados em (correct, total)
  // ocupam o mesmo número e o próximo grupo é +1 (1, 1, 2 — não 1, 1, 3).
  const ranked = rankEntries(scores).slice(0, 50);

  const rows = ranked.map((s) => {
    const display = s.nickname || s.email.replace(/@.*/, "@***");
    // #2191: usa htmlEscape (de lib.ts) em vez de replace inline que omitia "'".
    const escaped = htmlEscape(display);
    const trClass = s.rank === 1 ? ' class="leader"' : '';
    return `<tr${trClass}>
      <td>${s.medal}</td>
      <td>${escaped}</td>
      <td>${s.correct}/${s.total}</td>
    </tr>`;
  }).join("\n");

  const pageTitle = `${heading} | ${info.name}`;
  const path = canonicalPath ?? "/leaderboard";
  const seoMeta = renderSeoMeta({
    title: pageTitle,
    description: `Quem mais acertou ${periodNoun} qual imagem foi gerada por IA no jogo "É IA?" da ${info.name}. Veja o ranking dos leitores.`,
    path,
  });
  // #3108: sub-copy com 2 links (diar.ia.br + Clarice) é EXCLUSIVA do brand
  // clarice — cross-promoção só faz sentido pra quem está na newsletter mensal.
  // Brand diaria mantém o texto original inalterado.
  const subCopy = brand === "clarice"
    ? `<p class="sub">Quem mais acertou ${periodNoun} qual imagem foi gerada pela <a href="https://diaria.beehiiv.com">diar.ia.br</a> na newsletter da <a href="${info.siteUrl}">${info.shortName ?? info.name}</a>.</p>`
    : `<p class="sub">Quem mais acertou ${periodNoun} qual imagem foi gerada por IA na <a href="${info.siteUrl}">${info.name}</a>.</p>`;
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pageTitle}</title>
${seoMeta}
<style>
  /* #1936: design system canônico — importados de ds-tokens.generated.ts
     (#3111 — antes hardcoded inline aqui). Webfont Geist (Google Fonts)
     removido: Cursos/Livros já não carregavam o arquivo, cai pra system sans. */
  body { font-family: ${DS_FONTS.sans}; max-width: 640px; margin: 40px auto; padding: 0 20px; color: ${DS_COLORS.ink}; background: ${DS_COLORS.paper}; }
  h1 { font-family: ${DS_FONTS.serif}; font-size: 1.7rem; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 4px; }
  p.sub { color: rgba(23,20,17,0.6); font-size: 0.95rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th { text-align: left; padding: 8px; border-bottom: 1px solid ${DS_COLORS.ink}; font-size: 0.72rem; color: rgba(23,20,17,0.62); text-transform: uppercase; letter-spacing: 0.08em; font-family: ${DS_FONTS.sans}; }
  td { padding: 10px 8px; border-bottom: 1px solid ${DS_COLORS.rule}; }
  tr.leader td { font-weight: 600; color: ${DS_COLORS.brand}; }
  a { color: ${DS_COLORS.ink}; text-decoration: underline; }
  .kicker { font-family: ${DS_FONTS.sans}; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(23,20,17,0.6); margin: 0 0 12px 0; }
  p.nav { margin: 14px 0 0 0; font-size: 0.85rem; }
  p.nav a { font-weight: 600; }
${renderRuleStyles()}
${renderFooterStyles()}
</style>
</head>
<body>
<p class="kicker">É IA?</p>
<hr class="rule">
<h1>${heading}</h1>
${subCopy}
<p class="nav"><a href="${leaderboardHref(brand, String(year))}">Ver ranking anual de ${year}</a> · <a href="${archiveHref(brand, String(year))}">Votar em edições passadas</a></p>
<table>
<thead><tr><th>#</th><th>Leitor(a)</th><th>Acertos</th></tr></thead>
<tbody>${rows || "<tr><td colspan=3 style='color:rgba(23,20,17,0.45);text-align:center;padding:20px'>Ainda sem votos.</td></tr>"}</tbody>
</table>
<p style="margin-top:30px;font-size:0.8rem;color:rgba(23,20,17,0.62)">Critérios: acertos absolutos (1º); em caso de empate, mais tentativas vence (2º).</p>
<p style="margin-top:8px;font-size:0.8rem;color:rgba(23,20,17,0.62)">Atualizado em tempo real · Nicknames escolhidos pelos leitores · E-mails mascarados</p>
${renderBrandFooter(brand)}
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": cacheControl }
  });
}

// ── /leaderboard ──────────────────────────────────────────────────────────────

export async function handleLeaderboard(env: Env, brand: Brand = "diaria"): Promise<Response> {
  // #1345: /leaderboard agora delega pro slug do mês corrente. Schema único
  // (`score-by-month:*`) — `score:*` global continua mantido pra all-time
  // potencial mas não é mais lido pelo leaderboard.
  // #3106: canonical explícito de "/leaderboard" (self) — sem isso o override
  // default de handleLeaderboardByMonth apontaria canonical pro slug do mês
  // corrente, e o crawler indexaria a URL errada pra quem chegou via "/leaderboard".
  return handleLeaderboardByMonth(currentMonthSlugBrt(new Date()), env, brand, leaderboardHref(brand));
}

// ── /leaderboard/{YYYY}/arquivo — arquivo retroativo (#2867) ────────────────
//
// Decisão de produto (issue #2867, comentário do editor 260703): assinantes
// que entraram no meio do ano podem votar retroativamente nas edições de
// {YYYY} já publicadas. O voto PONTUA no ranking anual (`/leaderboard/{YYYY}`)
// — não é só arquivo estático. Mecânica: página lista as edições do ano
// (data + link), o assinante digita o e-mail, vota, e o voto é registrado com
// dedup por email+edição reusando o Durable Object `VoteDedup` existente (via
// o próprio handler `/vote` — ver #2867 em vote.ts, que agora aceita edições
// fora da janela recente de `valid_editions` quando `correct:{edition}` já
// está definido). Anti-gaming: (a) a página de voto NÃO revela a resposta
// correta antes do voto — só depois de votar, via a página de resultado
// normal do `/vote`; (b) 1 voto por edição, via o dedup DO existente;
// (c) escopo restrito às edições do ano pedido na URL (só listamos/aceitamos
// edições que já têm gabarito fechado — sem geração de links por-assinante
// em massa).

/**
 * Pure (#3113 item 9): "hoje" em AAMMDD (BRT) — mesmo offset fixo de -3h usado
 * em toda formatação de data deste worker (ver `currentMonthSlugBrt`/
 * `archiveKeyForReset` em lib.ts). Usado só pra comparação lexicográfica
 * contra edições AAMMDD (strings zero-padded de mesmo tamanho comparam igual
 * a números).
 */
function todayAammddBrt(now: Date): string {
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const yy = String(brt.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(brt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(brt.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Pure (#2867): extrai as edições AAMMDD de um ano a partir dos nomes das
 * chaves KV `correct:{edition}` (gabarito definido = edição realmente
 * publicada com poll fechado — ver `close-poll.ts`). Filtra pelo ano exato
 * (2 dígitos AA do AAMMDD) e ordena DESC (mais recente primeiro). Chaves com
 * formato diferente de AAMMDD (ex: ciclo mensal Clarice `2605-06`) são
 * ignoradas — só interessam edições diárias aqui.
 *
 * #3113 (item 9): também exclui edições com data > hoje (BRT). O gabarito
 * (`correct:{edition}`) pode ser definido ANTES do e-mail de fato sair (ex:
 * durante a preparação de imagens/revisão) — sem este filtro, o arquivo
 * expunha uma edição futura como votável antes da newsletter ser publicada.
 * `now` opcional (default `new Date()`) — pra determinismo em teste.
 */
export function extractEditionsForYear(correctKeyNames: string[], year: string, now: Date = new Date()): string[] {
  const yy = year.slice(2);
  const today = todayAammddBrt(now);
  const set = new Set<string>();
  for (const k of correctKeyNames) {
    const edition = k.startsWith("correct:") ? k.slice("correct:".length) : k;
    if (!/^\d{6}$/.test(edition)) continue;
    if (edition.slice(0, 2) !== yy) continue;
    if (edition > today) continue; // #3113 item 9: ainda não chegou a data
    set.add(edition);
  }
  return [...set].sort().reverse();
}

/**
 * Pure (#3113 item 10): agrupa edições AAMMDD (já ordenadas DESC) por mês,
 * preservando a ordem de entrada — uma lista flat de edições diárias passa de
 * 200 itens/ano sem agrupamento. Assume todas as edições do MESMO ano (o
 * caller já filtra por ano em `extractEditionsForYear`) — o heading mostra só
 * o nome do mês (o ano já aparece no `<h1>` da página).
 */
export interface EditionMonthGroup {
  monthLabel: string;
  editions: string[];
}

export function groupEditionsByMonth(editions: string[]): EditionMonthGroup[] {
  const groups: EditionMonthGroup[] = [];
  let currentMonth: string | null = null;
  for (const ed of editions) {
    const mm = ed.slice(2, 4);
    if (mm !== currentMonth) {
      const monthName = MONTH_NAMES_PT[parseInt(mm, 10) - 1] ?? mm;
      const monthLabel = monthName.charAt(0).toUpperCase() + monthName.slice(1);
      groups.push({ monthLabel, editions: [] });
      currentMonth = mm;
    }
    groups[groups.length - 1].editions.push(ed);
  }
  return groups;
}

/** Pure (#2867): href do arquivo — lista do ano (sem `edition`) ou voto de 1
 * edição (com `edition`), preservando `?brand=` só pra não-default. */
export function archiveHref(brand: Brand, year: string, edition?: string): string {
  const base = edition ? `/leaderboard/${year}/arquivo/${edition}` : `/leaderboard/${year}/arquivo`;
  return brand === "diaria" ? base : `${base}?brand=${brand}`;
}

/** Pure render (#2867): lista de edições do ano com link pra página de voto
 * individual de cada uma. NÃO revela gabarito nenhum — só data + link. */
export function renderArchiveListHtml(
  editions: string[],
  year: string,
  brand: Brand = "diaria",
): Response {
  const info = BRAND_INFO[brand];
  // #3113 (item 10): agrupado por mês (heading + <ul> próprio) em vez de uma
  // única lista flat — evita >200 itens/ano sem estrutura.
  const sections = groupEditionsByMonth(editions)
    .map((g) => {
      const items = g.editions
        .map((ed) => `<li><a href="${archiveHref(brand, year, ed)}">${htmlEscape(formatEditionDateForBrand(ed, brand))}</a></li>`)
        .join("\n");
      return `<h2 class="month-heading">${htmlEscape(g.monthLabel)}</h2>\n<ul>${items}</ul>`;
    })
    .join("\n");
  const rows = sections || "<ul><li>Nenhuma edição disponível ainda.</li></ul>";
  const pageTitle = `Arquivo ${htmlEscape(year)} — É IA? | ${info.name}`;
  const seoMeta = renderSeoMeta({
    title: pageTitle,
    description: `Vote retroativamente nas edições de ${year} do jogo "É IA?" e concorra no leaderboard anual da ${info.name}.`,
    path: archiveHref(brand, year),
  });
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pageTitle}</title>
${seoMeta}
<style>
  /* #1936: design system canônico — importados de ds-tokens.generated.ts
     (#3111 — antes hardcoded inline aqui). Webfont Geist (Google Fonts)
     removido: Cursos/Livros já não carregavam o arquivo, cai pra system sans. */
  body { font-family: ${DS_FONTS.sans}; max-width: 640px; margin: 40px auto; padding: 0 20px; color: ${DS_COLORS.ink}; background: ${DS_COLORS.paper}; }
  h1 { font-family: ${DS_FONTS.serif}; font-size: 1.7rem; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 4px; }
  p.sub { color: rgba(23,20,17,0.6); font-size: 0.95rem; }
  ul { list-style: none; padding: 0; margin-top: 20px; }
  li { padding: 12px 8px; border-bottom: 1px solid ${DS_COLORS.rule}; font-size: 1.02rem; }
  a { color: ${DS_COLORS.ink}; text-decoration: underline; }
  .kicker { font-family: ${DS_FONTS.sans}; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(23,20,17,0.6); margin: 0 0 12px 0; }
  /* #3113 (item 10): heading de mês — agrupa a lista flat que passaria de
     200 itens/ano. Reusa a mesma convenção visual do .kicker (sans, uppercase,
     letter-spacing), em teal (acento reservado a links/kickers no DS). */
  .month-heading { font-family: ${DS_FONTS.sans}; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${DS_COLORS.brand}; margin: 28px 0 0; }
  .month-heading + ul { margin-top: 8px; }
${renderRuleStyles()}
${renderFooterStyles()}
</style>
</head>
<body>
<p class="kicker">É IA? — arquivo</p>
<hr class="rule">
<h1>Arquivo de ${htmlEscape(year)}</h1>
<p class="sub">Vote nas edições passadas de ${htmlEscape(year)} — o seu voto conta pro <a href="${leaderboardHref(brand, year)}">leaderboard anual</a>.</p>
${rows}
${renderBrandFooter(brand)}
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}

/**
 * Pure render (#2867): página de voto de 1 edição do arquivo. Mostra as duas
 * imagens A/B SEM rótulo nenhum (anti-gaming — não revela qual é a IA antes
 * do voto; o resultado só aparece na página padrão de `/vote` após votar).
 * O form submete via GET pro `/vote` já existente — SEM `sig` (merge-tag
 * mode, o mesmo caminho sem-HMAC que `handleVote` já suporta pra emails não
 * substituídos por template — aqui o e-mail vem digitado pelo leitor).
 */
export function renderArchiveVoteHtml(
  edition: string,
  year: string,
  brand: Brand = "diaria",
): Response {
  const info = BRAND_INFO[brand];
  const brandHidden = brand === "diaria" ? "" : `<input type="hidden" name="brand" value="${htmlEscape(brand)}">`;
  const imgA = `/img/img-${edition}-01-eia-A.jpg`;
  const imgB = `/img/img-${edition}-01-eia-B.jpg`;
  const dateLabel = htmlEscape(formatEditionDateForBrand(edition, brand));
  const pageTitle = `É IA? — ${dateLabel} | ${info.name}`;
  const seoMeta = renderSeoMeta({
    title: pageTitle,
    description: `Qual imagem foi gerada por IA? Vote na edição de ${dateLabel} e valha ponto no leaderboard anual de ${year} da ${info.name}.`,
    path: archiveHref(brand, year, edition),
  });
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pageTitle}</title>
${seoMeta}
<style>
  /* #1936: design system canônico — importados de ds-tokens.generated.ts
     (#3111 — antes hardcoded inline aqui). Webfont Geist (Google Fonts)
     removido: Cursos/Livros já não carregavam o arquivo, cai pra system sans. */
  body { font-family: ${DS_FONTS.sans}; font-size: 17px; max-width: 560px; margin: 40px auto; padding: 0 20px; text-align: center; color: ${DS_COLORS.ink}; background: ${DS_COLORS.paper}; }
  h1 { font-family: ${DS_FONTS.serif}; font-size: 1.5rem; margin-bottom: 4px; letter-spacing: -0.01em; }
  p.sub { color: rgba(23,20,17,0.62); font-size: 0.95rem; }
  .email-row { margin: 20px 0; }
  .email-input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid ${DS_COLORS.rule}; border-radius: 4px; font-size: 1rem; font-family: ${DS_FONTS.sans}; }
  .choices { display: flex; gap: 12px; margin: 20px 0; justify-content: center; flex-wrap: wrap; }
  .choice { flex: 1 1 240px; max-width: 260px; }
  .choice img { width: 100%; height: auto; border-radius: 6px; display: block; }
  /* #3110: fundo ink, não teal — botão cheio em teal reprovava
     contraste AA (~3:1 vs mínimo 4.5:1). Ink+onInk dá ~15:1. */
  .choice button { margin-top: 8px; width: 100%; padding: 10px 12px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 1rem; font-family: ${DS_FONTS.sans}; }
  a { color: ${DS_COLORS.ink}; text-decoration: underline; }
  /* #3113 (item 8): abaixo de 600px, o layout ANTERIOR empilhava as escolhas em
     largura total (flex-basis: 100%) — a imagem A + botão preenchiam a tela
     inteira, permitindo votar em A sem nunca rolar até ver a imagem B. Mantém
     as 2 escolhas lado a lado (cada uma dividindo o espaço disponível) em vez
     de empilhar — as duas imagens ficam visíveis ao mesmo tempo, sem precisar
     de scroll nem de JS pra gatear o botão. */
  @media (max-width: 600px) {
    .choices { gap: 8px; }
    .choice { flex: 1 1 0; max-width: none; }
  }
${renderFooterStyles()}
</style>
</head>
<body>
<h1>Qual imagem foi gerada por IA?</h1>
<p class="sub">Edição de ${dateLabel} — vale ponto no leaderboard anual de ${htmlEscape(year)}.</p>
<form action="/vote" method="GET">
  <input type="hidden" name="edition" value="${htmlEscape(edition)}">
  ${brandHidden}
  <div class="email-row">
    <input type="email" name="email" placeholder="seu@email.com" required class="email-input">
  </div>
  <div class="choices">
    <div class="choice"><img src="${imgA}" alt="Imagem A" loading="lazy"><button type="submit" name="choice" value="A">Essa é a IA (A)</button></div>
    <div class="choice"><img src="${imgB}" alt="Imagem B" loading="lazy"><button type="submit" name="choice" value="B">Essa é a IA (B)</button></div>
  </div>
</form>
<p><a href="${archiveHref(brand, year)}">← voltar ao arquivo de ${htmlEscape(year)}</a></p>
${renderBrandFooter(brand)}
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Handler `GET /leaderboard/{YYYY}/arquivo` — lista as edições do ano com
 * gabarito fechado (ver `extractEditionsForYear`). */
export async function handleLeaderboardArchive(
  yearStr: string,
  env: Env,
  brand: Brand = "diaria",
): Promise<Response> {
  const year = parseInt(yearStr, 10);
  if (!/^\d{4}$/.test(yearStr) || year < 2000 || year > 2099) {
    return new Response(votePageHtml("Ano inválido. Use formato YYYY (ex: 2026).", false, null, null, null, brand), {
      status: 404, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }
  const yy = yearStr.slice(2);
  const keys: string[] = [];
  for await (const k of listAllKeys(env, `correct:${yy}`)) keys.push(k);
  const editions = extractEditionsForYear(keys, yearStr);
  return renderArchiveListHtml(editions, yearStr, brand);
}

/** Handler `GET /leaderboard/{YYYY}/arquivo/{AAMMDD}` — página de voto de 1
 * edição arquivada. 404 se a edição não pertence ao ano da URL, ou se ainda
 * não tem gabarito fechado (nunca foi publicada / poll não fechado). */
export async function handleArchiveVotePage(
  yearStr: string,
  edition: string,
  env: Env,
  brand: Brand = "diaria",
): Promise<Response> {
  if (!/^\d{4}$/.test(yearStr) || !/^\d{6}$/.test(edition) || edition.slice(0, 2) !== yearStr.slice(2)) {
    return new Response(votePageHtml("Link inválido.", false, null, null, null, brand), {
      status: 404, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }
  const correctRaw = await env.POLL.get(`correct:${edition}`);
  // #3113 (item 9): mesma checagem de `extractEditionsForYear` — sem ela, a
  // página de voto do arquivo continuaria acessível via URL direta (mesmo
  // AAMMDD, adivinhado ou incrementado a partir de uma edição já pública)
  // mesmo depois da LISTA parar de mostrar a edição futura. Mesma mensagem
  // do "sem gabarito" — o assinante não precisa saber o motivo específico.
  if (!correctRaw || edition > todayAammddBrt(new Date())) {
    return new Response(
      votePageHtml("Essa edição não está disponível para votação retroativa.", false, null, null, null, brand),
      { status: 404, headers: { "Content-Type": "text/html;charset=utf-8" } },
    );
  }
  return renderArchiveVoteHtml(edition, yearStr, brand);
}
