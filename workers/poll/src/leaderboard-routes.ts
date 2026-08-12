import type { Env } from "./index";
import { rankEntries, partitionLeaderboardForDisplay, type LeaderboardEntry } from "./leaderboard";
import {
  type Brand,
  currentMonthSlugBrt,
  monthSlugCompare,
  parseMonthSlug,
  MONTH_NAMES_PT,
  BRAND_INFO,
  leaderboardHref,
  formatEditionDateForBrand,
  renderBrandShellStyles, // #3113: régua teal + rodapé de marca
  renderBrandFooter, // #3113: régua teal + rodapé de marca
  todayAammddBrt, // #3113 item 9: também usado por handleVote (vote.ts)
  withBrandQuery, // #3118 item 12: archiveHref
  brandHiddenInput, // #3118 item 12: renderArchiveVoteHtml
  maskEmail, // #3118 item 11: consolida as 3 implementações de mascaramento de email
  hashEmailForMatch, // #4029 item 2: uid opaco por linha pro self-highlight client-side
  closedPeriodCacheControl, // #3118 item 2: cache de período fechado — 1h, não mais 30d immutable
  AAMMDD_RE, // #3297: substitui as 2 cópias inline de /^\d{6}$/ deste arquivo
  CYCLE_EDITION_RE, // #4419: formato de ciclo Clarice YYMM-MM — arquivo mensal aceita, não só AAMMDD
  isValidVoteEditionFormat, // #4419: aceita AAMMDD|ciclo — mesmo regex combinado de handleEditions
  cycleForLegacyMonthlyEdition, // #4419: normaliza marcador legado AAMMDD → ciclo YYMM-MM (mesmo uso de handleEditions)
  legacyMonthlyEditionForCycle, // #4419: direção inversa — ciclo → marcador legado, pra checar correct: sob a chave antiga
  envioMonthYear, // #3464: heading do arquivo mensal Clarice mostra mês de ENVIO, não de conteúdo
  buildBrandSiteUrl, // #3978: href com UTM da sub-copy do leaderboard
  isAnonymousWebIdentity, // #3975: filtra identidade anônima do brand web fora do ranking público
  lightboxScript, // #4007: script do lightbox de zoom — reusado nas 5 superfícies do par de imagens (#4125 item 3: quiz incluído)
  renderLightboxMarkup, // #4007: markup do <dialog> de zoom
  renderLightboxStyles, // #4007: CSS do lightbox + badge de lupa
  renderNicknameFormHtml, // #4232: bloco nick-box reusado do resultado do voto
  renderNicknameFormStyles, // #4232: CSS do nick-box, idem
  isValidVoteEmailFormat, // #4232: valida forma do email recebido via query param
  safeParseKv, // #4232: parse seguro de score:{email} (mesmo padrão de handleSetName)
  type SubscribeBoxState, // #4418 §2b
  resolveVoteIdentityBoxKind, // #4438: decisão A/B/nenhuma centralizada (mesmo helper de vote.ts) — não reimplementar à mão
  resolveSetNameConfirmationBanner, // #4418 §3: faixa de confirmação pós-redirect de /set-name
  renderArchiveButtonStyles, // #4420: CSS do botão do link de arquivo (mesmo tratamento de /vote)
} from "./lib";
import { htmlEscape, renderSeoMeta } from "./lib"; // #3106: meta description/OG/Twitter/canonical/favicon
import { corsHeaders, hmacVerify, json, votePageHtml } from "./index";
// #3111: tokens do DS canônico gerados por scripts/generate-worker-tokens.ts a
// partir de scripts/lib/shared/design-tokens.ts — nunca hardcodear valores de
// cor/fonte inline aqui (ver test/poll-ds-tokens.test.ts para a trava).
import { DS_COLORS, DS_FONTS } from "./ds-tokens.generated";

/**
 * #4029 (item 1, decisão do editor 260724): quantas linhas o leaderboard
 * renderiza no máximo — antes um valor fixo de 50 direto em
 * `renderLeaderboardHtml`. Içado pra constante nomeada porque agora tem um
 * segundo consumidor implícito de intenção (o comentário de
 * `upsertOwnEntryInSnapshot` abaixo referencia o mesmo número).
 */
export const LEADERBOARD_DISPLAY_CAP = 500;

export interface LeaderTop1Entry {
  nickname: string;
  pct: number;
  correct: number;
  total: number;
}

export function computeTop1(
  // #4123: `email` OPCIONAL — entries vindas do snapshot (`getOrComputeSnapshot`,
  // via handleLeaderboardTop1 abaixo) não carregam mais e-mail cru, só
  // `masked`/`uid` (SnapshotEntry). Chamadas diretas com dados crus (testes,
  // outros consumidores) continuam passando `email` normalmente.
  scores: Array<{ email?: string; nickname: string | null; correct: number; total: number }>,
): LeaderTop1Entry[] {
  const withNickname = scores
    // #3975: entradas sob a identidade anônima do brand web (token client-side
    // ainda não associado a um e-mail via /jogar/identify) nunca aparecem no
    // ranking público — continuam existindo no KV (upsertOwnEntryInSnapshot
    // nunca as apaga), só ficam fora da exibição até o jogador se identificar.
    // #4123: entries do snapshot já vêm PRÉ-filtradas na escrita (computeSnapshotEntries/
    // upsertOwnEntryInSnapshot) e não carregam `email` — o guard `s.email === undefined`
    // trata esse caso como "já garantidamente não-anônimo", nunca como bypass do filtro.
    .filter((s) => s.email === undefined || !isAnonymousWebIdentity(s.email))
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

export function computePodium(
  // #4123: `email` OPCIONAL, `masked` NOVO (opcional) — mesmo racional de
  // computeTop1 acima. Entries do snapshot trazem `masked` (já mascarado na
  // escrita) em vez de `email` cru.
  scores: Array<{ email?: string; masked?: string; nickname: string | null; correct: number; total: number }>,
): PodiumEntry[] {
  // Reusa rankEntries com shape LeaderboardEntry (precisa pct + streak).
  // #3113: medalha exige correct >= 1 — sem isso, o tiebreak "mais tentativas
  // vence" (#1163) podia colocar alguém com 0 acertos no pódio (0/2 rankeia
  // acima de 0/1), degenerando o "campeão do mês" pra quem nunca acertou nada.
  // Filtra ANTES do rankEntries (não depois) pra que o próximo candidato
  // elegível suba pro rank 1/2/3 — não deixa o pódio com "buracos".
  const eligible = scores
    // #3975: mesmo filtro de computeTop1 acima — identidade anônima web nunca
    // aparece no pódio público. #4123: guard `email === undefined` (ver
    // computeTop1) — entries do snapshot já vêm pré-filtradas.
    .filter((s) => s.email === undefined || !isAnonymousWebIdentity(s.email))
    .filter((s) => s.total > 0 && s.correct >= 1)
    .map((s) => {
      const hasNickname = s.nickname && s.nickname.trim().length > 0;
      // #4123: prefere `masked` (já derivado na escrita do snapshot) — só
      // recalcula `maskEmail(s.email)` on-the-fly quando a entry ainda traz
      // e-mail cru (chamada direta, fora do pipeline do snapshot).
      const display = hasNickname ? s.nickname!.trim() : (s.masked ?? maskEmail(s.email ?? ""));
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
 *
 * #4123: NUNCA mais `email` cru — este payload é `JSON.stringify`ado direto
 * pro KV (`leaderboard-snapshot:{slug}`), e um bug NÃO relacionado (#4111,
 * `/img/{key}` sem allowlist de prefixo) já vazou publicamente ~50 e-mails de
 * leitores lidos DIRETO desta chave. `uid`/`masked` são derivados do e-mail
 * cru NO MOMENTO da escrita (`computeSnapshotEntries`/`upsertOwnEntryInSnapshot`,
 * únicos pontos onde o e-mail cru ainda existe em memória) e nunca revertem
 * pro e-mail original — mesmo se esta chave vazar de novo por qualquer outro
 * bug futuro, não há e-mail nenhum pra extrair dela.
 */
export interface SnapshotEntry {
  /** #4123: hash opaco (`hashEmailForMatch`) do e-mail cru — usado pro
   * matching (upsert por identidade) e pelo self-highlight client-side (#4029),
   * que precisa do hash do e-mail REAL (não de `masked`, que é lossy). */
  uid: string;
  /** #4123: local-part mascarado (`maskEmail`) — usado como fallback de
   * exibição quando não há nickname. */
  masked: string;
  nickname: string | null;
  correct: number;
  total: number;
  /** #2123: ISO 8601 timestamp do voto mais recente — tiebreaker em `rankEntries`. */
  last_vote_ts?: string;
}

/**
 * #4123: detecta snapshot no formato LEGADO (pré-fix, com `email` cru por
 * entry) — usado tanto por `getOrComputeSnapshot` (cache-hit) quanto por
 * `upsertOwnEntryInSnapshot` (upsert em snapshot existente) pra tratar
 * qualquer resíduo do formato antigo como INVÁLIDO, forçando recompute/
 * skip em vez de propagar (ou re-persistir) e-mail cru. Auto-expurga a PII
 * residual sem precisar de migração manual — a próxima escrita já regrava
 * no formato novo (uid/masked).
 */
function hasLegacyEmailField(entries: unknown[]): boolean {
  return entries.some((e) => e !== null && typeof e === "object" && "email" in e);
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
      // #4123: formato legado (e-mail cru por entry) é tratado como cache
      // INVÁLIDO — cai pro recompute abaixo, que já grava no formato novo
      // (uid/masked) e sobrescreve o resíduo de PII sozinho, sem migração
      // manual. Nunca retorna/propaga o e-mail cru residual.
      if (Array.isArray(parsed.entries) && !hasLegacyEmailField(parsed.entries)) return parsed.entries;
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
 *   fazer ranking correto sobre o conjunto completo. O cap visual (LEADERBOARD_DISPLAY_CAP,
 *   #4029: 500, antes 50) é aplicado APENAS no render (renderLeaderboardHtml:
 *   `visible.slice(0, LEADERBOARD_DISPLAY_CAP)`) — não aqui. Capar no write esconderia
 *   votantes além do cap do ranking e quebraria o dense-rank para quem está perto do corte.
 *
 *   Volume esperado: ~50–200 votantes/mês em produção (diar.ia.br). O snapshot por
 *   mês (JSON em KV) cresce ~200 bytes/votante → <40KB para 200 votantes, bem
 *   abaixo do limite de 128MB do KV da Cloudflare.
 */
/**
 * #4123: shape de ENTRADA de `upsertOwnEntryInSnapshot` — carrega o e-mail
 * CRU do votante (parâmetro em memória, nunca persistido). Distinto de
 * `SnapshotEntry` (o que É gravado no KV) desde a correção da issue #4123 —
 * antes os dois eram o mesmo tipo, e era exatamente esse `email` que ia
 * parar (cru) dentro do JSON de `leaderboard-snapshot:{slug}`.
 */
export interface OwnScoreEntry {
  email: string;
  nickname: string | null;
  correct: number;
  total: number;
  last_vote_ts?: string;
}

export async function upsertOwnEntryInSnapshot(
  env: Env,
  slug: string,
  own: OwnScoreEntry,
): Promise<void> {
  // #4123: identidade anônima do brand web nunca entra no snapshot. Antes
  // (#3975) essas entries eram gravadas com e-mail cru e só ficavam de fora
  // da EXIBIÇÃO pública (filtro em computeTop1/computePodium/
  // scoreByMonthEntriesToLeaderboard, no momento da LEITURA). Agora que o
  // snapshot não persiste mais e-mail (só uid/masked, derivados e
  // irreversíveis — ver SnapshotEntry acima), o filtro TEM que acontecer
  // aqui: é o único ponto deste write path onde o e-mail cru ainda existe.
  if (isAnonymousWebIdentity(own.email)) return;

  const snapKey = `leaderboard-snapshot:${slug}`;
  const cached = await env.POLL.get(snapKey);

  // Snapshot AUSENTE → skip-on-missing: deixa getOrComputeSnapshot lazy-reconstruir.
  // Gravar snapshot de 1 entrada aqui esconderia os N votantes existentes (#2152).
  if (!cached) return;

  let entries: SnapshotEntry[];
  try {
    const parsed = JSON.parse(cached) as { entries: SnapshotEntry[]; computed_at: string };
    // #4123: formato legado (e-mail cru por entry) tratado igual a corrompido
    // — skip + lazy-rebuild. Nunca re-persiste o upsert em cima de um
    // resíduo de PII do formato antigo.
    if (!Array.isArray(parsed.entries) || hasLegacyEmailField(parsed.entries)) {
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

  // #4123: uid/masked derivados do e-mail cru AQUI, uma única vez — nunca
  // persistidos como e-mail dali em diante. `uid` (hash opaco) substitui
  // `email.toLowerCase()` como critério de matching da própria entry.
  const uid = hashEmailForMatch(own.email);
  const masked = maskEmail(own.email);

  // Snapshot presente e válido: upsert da própria entry.
  const idx = entries.findIndex((e) => e.uid === uid);
  if (idx >= 0) {
    // #2123 (review): own com last_vote_ts EXPLICITAMENTE undefined apagaria o valor
    // existente via spread — filtra chaves undefined antes do merge.
    // #2130 (pass2): filtro field-aware — null é filtrado só onde é inválido (ex:
    // last_vote_ts nunca é null em produção — ver computeSnapshotEntries). Para campos
    // onde null tem semântica de "limpar" (nickname: string | null), null é PRESERVADO
    // intencionalmente, permitindo que upsert limpe um nickname existente.
    // #4123: `email` nunca entra no spread — `own` só existe pra derivar
    // uid/masked acima; o merge usa só nickname/correct/total/last_vote_ts.
    const { email: _ownEmail, ...ownRest } = own;
    const ownDefined = Object.fromEntries(
      Object.entries(ownRest).filter(([k, v]) => {
        if (v === undefined) return false; // nunca spreada undefined
        if (v === null && k === "last_vote_ts") return false; // null aqui é fantasma
        return true; // nickname:null e outros null são valores legítimos
      }),
    );
    entries[idx] = { ...entries[idx], ...ownDefined, uid, masked } as SnapshotEntry;
  } else {
    const pushed: SnapshotEntry = { uid, masked, nickname: own.nickname, correct: own.correct, total: own.total };
    if (own.last_vote_ts != null) pushed.last_vote_ts = own.last_vote_ts;
    entries.push(pushed);
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
 *
 * #4443 (reconferido — item 8 da issue, não corrigido aqui, fora de escopo):
 * o batch PACEIA os gets, mas o TOTAL de subrequests desta função escala com
 * `keys.length` (Nº de votantes do mês), não é limitado pelo batch — um mês
 * com mais de 50 votantes já estouraria o teto do free plan mesmo com este
 * batching, se o worker `poll` descer de plano (motivação do #4443/#4442).
 * O comentário do dedup de nickname em index.ts já registra "~60+" votantes
 * observados — este limite provavelmente já foi cruzado pelo menos uma vez.
 * Reportado como finding no PR do #4443 (rota `/leaderboard`, fora do escopo
 * de `/jogar/seq-state`) — não resolvido aqui.
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
      // #4123: e-mail cru só existe NESTE escopo (extraído do nome da chave
      // KV) — é o único lugar do compute path onde ele existe em memória.
      // Filtra identidade anônima do brand web ANTES de derivar/persistir
      // (#3975 aplicava esse filtro na LEITURA — computeTop1/computePodium/
      // scoreByMonthEntriesToLeaderboard; agora que o snapshot não carrega
      // mais e-mail, não dá pra filtrar depois: uid/masked não revertem pro
      // e-mail original, então uma entry anônima que escapasse daqui ficaria
      // pra sempre irreconhecível como anônima nos consumidores a jusante).
      const rawEmail = batch[j].replace(prefix, "");
      if (isAnonymousWebIdentity(rawEmail)) continue;
      // #2123: propaga last_vote_ts pra SnapshotEntry — tiebreaker de dense-rank
      // via snapshot (rankEntries usa o campo; sem ele cai em displayKey).
      // undefined quando a entry foi gravada antes de #1383 ou na migração de
      // backfill — fallback de displayKey preservado sem migração.
      // #4123: `uid`/`masked` substituem `email` — derivados aqui (único
      // ponto com o e-mail cru) e nunca revertidos. Ver SnapshotEntry acima.
      const snapshotEntry: SnapshotEntry = {
        uid: hashEmailForMatch(rawEmail),
        masked: maskEmail(rawEmail),
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
 *
 * #4123: `email` ficou OPCIONAL e `masked`/`uid` (opcionais) foram
 * adicionados — os 3 call sites de produção (handleLeaderboardByMonth,
 * handleLeaderboardByMonthJson, handleLeaderboardByYear) alimentam esta
 * função com `SnapshotEntry[]` (uid/masked, sem e-mail cru — ver #4123).
 * CUIDADO (revisor): esta função continua aceitando e-mail cru normalmente
 * pra quem chama fora do pipeline do snapshot (testes, uso direto) — o
 * comportamento COM `email` presente não muda em nada.
 */
export function scoreByMonthEntriesToLeaderboard(
  entries: Array<{
    email?: string;
    masked?: string;
    uid?: string;
    nickname: string | null;
    correct: number;
    total: number;
    last_vote_ts?: string;
  }>,
): LeaderboardEntry[] {
  return entries
    // #3975: mesmo filtro de computeTop1/computePodium — cobre os 3 pontos de
    // renderização que consomem esta função (handleLeaderboardByMonth,
    // handleLeaderboardByMonthJson, handleLeaderboardByYear via mergeYearEntries).
    // #4123: guard `e.email === undefined` — entries do snapshot já vêm
    // pré-filtradas na escrita (computeSnapshotEntries/upsertOwnEntryInSnapshot),
    // então a ausência de `email` aqui significa "já garantidamente não-anônimo".
    .filter((e) => e.email === undefined || !isAnonymousWebIdentity(e.email))
    .map((e) => {
      const pct = e.total > 0 ? Math.round((e.correct / e.total) * 100) : 0;
      return {
        email: e.email,
        masked: e.masked,
        uid: e.uid,
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

// ── Nickname form no leaderboard (#4232) ─────────────────────────────────────
//
// Reusa o esquema de link assinado (HMAC `email`+`sig`) que já protege
// `/set-name` (index.ts, handleSetName) — o mesmo sig gerado por vote.ts
// (`hmacSign(env.POLL_SECRET, "setname:" + email)`, ver #1078) agora também
// viaja no link "Ver leaderboard" da página de resultado do voto (votePageHtml,
// index.ts) quando o leitor ainda não definiu nickname. Aqui verificamos essa
// MESMA sig e, se válida e o leitor ainda não tem nickname, renderizamos o
// mesmo bloco `nick-box` direto no leaderboard — sem precisar votar de novo
// pra ver o form.

// #4250: atraso do retry único abaixo (bounded — nunca mais de 1 espera por
// request). KV costuma converger bem abaixo disso; documentado como
// constante nomeada em vez de literal solto pro racional ficar buscável.
const NICKNAME_FORM_SCORE_RETRY_MS = 150;

/**
 * #4232: resolve se o form de nickname deve renderizar nesta view do
 * leaderboard, a partir de `email`+`sig` na query string. Fail-closed em
 * QUALQUER caso ambíguo — parâmetro ausente, forma de e-mail inválida, sig
 * inválida/expirada, e-mail sem voto registrado (`score:{email}` ausente) ou
 * nickname já definido: todos retornam `null` (nunca expõe o form
 * indevidamente). `env` é o env BRANDED (`bEnv` no router de index.ts) — mesmo
 * KV namespace que `handleSetName`/vote.ts leem `score:{email}`.
 *
 * `brand === "web"` sempre retorna `null` — mesmo escopo do #4232: o brand
 * `web` (`/jogar` standalone) já resolve nickname via identidade local
 * (`eia_web_identified_email`, #3975) + form de identificação inline, não via
 * link assinado por e-mail. Defesa em profundidade — `votePageHtml` (index.ts)
 * já não anexa `email`/`sig` ao link "Ver leaderboard" pro brand `web`, mas
 * nada impede alguém de montar a URL manualmente.
 *
 * #4250 (fix — race de baixa severidade, achado no review consolidado
 * develop 260728): `/vote` sempre toma o fast-path (`ctx.waitUntil`, #3983,
 * `handleVoteFastPath`/vote.ts) — a resposta (com o link "Ver leaderboard"
 * carregando `email`+`sig`, é ISSO que autoriza a sig aqui) é enviada ANTES
 * de `runVoteBookkeeping` gravar `score:{email}` no KV em background. Pra um
 * votante de PRIMEIRA vez, se esse leitor (ou um prefetch do navegador)
 * acessar esta URL antes dessa escrita terminar, `env.POLL.get` abaixo não
 * encontrava `score:{email}` ainda e o form silenciosamente não renderizava
 * — justo pra população-alvo do CTA. Fix escolhido (decisão do editor,
 * #4250): retry ÚNICO, com atraso curto, só neste read opcional/decorativo —
 * NUNCA no fast-path de `/vote` em si (hot path, #3983; esperar
 * `runVoteBookkeeping` ali de volta introduziria a latência que o #3983
 * existe pra eliminar, pra TODO votante de primeira vez, não só quem cai
 * nesta race — risco desproporcional pra uma race P3 de baixo impacto). Uma
 * sig válida só é alcançável tendo genuinamente recebido a resposta de
 * `/vote` (depende de `POLL_SECRET`), então "sig válida + score ausente" é,
 * na prática, ou esta race (retry resolve) ou uma anomalia real (retry
 * apenas confirma o `null`, mesmo resultado fail-closed de antes — nunca
 * piora).
 */
export async function resolveLeaderboardNicknameForm(
  url: URL,
  env: Env,
  brand: Brand,
): Promise<{ email: string; sig: string } | null> {
  if (brand === "web") return null;
  const email = url.searchParams.get("email")?.toLowerCase().trim();
  const sig = url.searchParams.get("sig");
  if (!email || !sig) return null;
  if (!isValidVoteEmailFormat(email)) return null;

  const valid = await hmacVerify(env.POLL_SECRET, `setname:${email}`, sig);
  if (!valid) {
    // Log (não bloqueia) — distingue "sig inválida/expirada" das demais
    // causas de `null` (sem voto, já tem nickname), que são estado normal e
    // não precisam de sinal — achado do review consolidado (#4232): sem
    // isso, um POLL_SECRET rotacionado ou uma divergência de normalização de
    // email entre votePageHtml (quem assina) e esta função (quem verifica)
    // ficaria invisível em produção — "a CTA parou de aparecer" sem nenhum
    // log pra correlacionar.
    console.error(JSON.stringify({ event: "leaderboard_nickname_form_invalid_sig", email }));
    return null;
  }

  // #4232 (achado do review consolidado, silent-failure-hunter): `env.POLL.get`
  // é uma chamada de rede real (KV) e PODE lançar (erro interno, rate-limit)
  // — sem este try/catch, uma falha aqui derrubava a página de leaderboard
  // INTEIRA (scores/HTML já computados, request inteira 500) por causa de um
  // form OPCIONAL/decorativo. Fail-closed real: qualquer exceção vira `null`
  // (mesmo contrato documentado acima — "nunca expõe o form indevidamente"),
  // nunca propaga pro caller.
  try {
    let raw = await env.POLL.get(`score:${email}`);
    // #4250: só retry quando a 1ª leitura veio vazia — o caminho quente
    // (score já gravado, o caso comum fora da race) nunca paga o atraso.
    if (raw === null) {
      await new Promise<void>((resolve) => setTimeout(resolve, NICKNAME_FORM_SCORE_RETRY_MS));
      raw = await env.POLL.get(`score:${email}`);
    }
    const score = safeParseKv<{ nickname?: string | null }>(raw, "leaderboard_nickname_form_score_parse_error", email);
    if (!score || score.nickname) return null; // sem voto registrado (mesmo após o retry), ou já tem nickname
    return { email, sig };
  } catch (e) {
    console.error(JSON.stringify({ event: "leaderboard_nickname_form_kv_error", email, error: String(e) }));
    return null;
  }
}

/**
 * #4418 §2b: resolve a "Caixa B" (oferta de assinatura) pro leaderboard —
 * mesmo esquema de link assinado de `resolveLeaderboardNicknameForm` acima,
 * mas para o caso OPOSTO: o leitor JÁ tem apelido salvo e ainda não
 * confirmou o opt-in (`score.optin !== true`), só brand `clarice`.
 *
 * Deliberadamente uma função SEPARADA (não uma extensão de
 * `resolveLeaderboardNicknameForm`) — a issue #4418 recomenda trazer a
 * Caixa B pro leaderboard ("Recomendação: levar"), mas `resolveLeaderboardNicknameForm`
 * já tem ~10 casos de teste travando seu contrato exato (retry #4250,
 * fail-closed, etc.) — misturar as duas responsabilidades ali arriscaria
 * regredir esse contrato só pra acrescentar um ramo novo. Duplica a
 * verificação de sig (custo desprezível — HMAC + 1 KV get, tráfego baixo
 * desta página) em troca de duas funções simples e independentemente
 * testáveis.
 */
export async function resolveLeaderboardSubscribeBox(
  url: URL,
  env: Env,
  brand: Brand,
): Promise<SubscribeBoxState | null> {
  if (brand !== "clarice") return null;
  const email = url.searchParams.get("email")?.toLowerCase().trim();
  const sig = url.searchParams.get("sig");
  if (!email || !sig) return null;
  if (!isValidVoteEmailFormat(email)) return null;

  // #4418 self-review (achado do silent-failure-hunter): `hmacVerify` e o
  // `env.POLL.get` seguinte estavam em try/catch SEPARADOS — uma exceção do
  // HMAC (ex: crypto.subtle falhando) escapava sem cair no fail-closed
  // documentado no header desta função, derrubando a página de leaderboard
  // inteira por causa de um bloco opcional/decorativo. Mesmo padrão de
  // `resolveLeaderboardViewerEmail` logo abaixo — try/catch cobrindo TODO o
  // caminho pós-validação de forma, não só a leitura de KV.
  try {
    const valid = await hmacVerify(env.POLL_SECRET, `setname:${email}`, sig);
    if (!valid) return null; // já logado por resolveLeaderboardNicknameForm no mesmo request (sig igual)

    const raw = await env.POLL.get(`score:${email}`);
    const score = safeParseKv<{ nickname?: string | null; optin?: boolean }>(raw, "leaderboard_subscribe_box_score_parse_error", email);
    // #4438 (fleet review oficial, achado 2 — type-design-analyzer): reusa
    // resolveVoteIdentityBoxKind (lib.ts) em vez de reimplementar a mesma
    // regra à mão — antes esta condição divergia silenciosamente de
    // resolveVoteIdentityBoxKind se um dos dois lados mudasse sem o outro
    // acompanhar (exatamente o risco que o helper compartilhado existe pra
    // evitar). `brand === "clarice"` já garantido pelo guard no topo da
    // função — "subscribe" só é possível aqui mesmo.
    if (resolveVoteIdentityBoxKind(score, brand) !== "subscribe") return null; // sem apelido (Caixa A é quem cobre isso), ou já assinou
    return { email, sig, nickname: score!.nickname! };
  } catch (e) {
    // #4418 self-review: `email_domain`, nunca o e-mail cru no log — mesmo
    // padrão PII-safe já usado em todo o resto do worker (ex: vote.ts,
    // set_name_beehiiv_subscribe_failed/_exception em index.ts).
    console.error(JSON.stringify({ event: "leaderboard_subscribe_box_error", email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
    return null;
  }
}

/**
 * #4418 §2c: resolve o e-mail do VIEWER identificado (via `email`+`sig`
 * assinados na query string) pro self-highlight server-side do leaderboard —
 * independente de ter ou não apelido/opt-in (ao contrário das duas funções
 * acima, que só retornam algo quando HÁ uma caixa a oferecer). Só verifica a
 * sig — nenhuma leitura de KV — porque o self-highlight só precisa comparar
 * contra o `uid` já presente nas entries do snapshot já carregado pelo
 * handler (ver `renderLeaderboardHtml`), não precisa reler `score:{email}`.
 *
 * `brand === "web"` sempre retorna `null` — aquele brand já tem seu PRÓPRIO
 * mecanismo de self-highlight client-side (`localStorage`, #4029), sem link
 * assinado por e-mail (não há `email`+`sig` a verificar).
 */
export async function resolveLeaderboardViewerEmail(
  url: URL,
  env: Env,
  brand: Brand,
): Promise<string | null> {
  if (brand === "web") return null;
  const email = url.searchParams.get("email")?.toLowerCase().trim();
  const sig = url.searchParams.get("sig");
  if (!email || !sig) return null;
  if (!isValidVoteEmailFormat(email)) return null;
  try {
    const valid = await hmacVerify(env.POLL_SECRET, `setname:${email}`, sig);
    return valid ? email : null;
  } catch (e) {
    // #4418 self-review: email_domain, nunca o e-mail cru (mesmo padrão do
    // resto do worker — ver resolveLeaderboardSubscribeBox acima).
    console.error(JSON.stringify({ event: "leaderboard_viewer_email_hmac_error", email_domain: email.split("@")[1] ?? "unknown", error: String(e) }));
    return null;
  }
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
  // #4232: URL da request — quando presente, resolve email+sig (query params)
  // pro form de nickname. Opcional pra não quebrar as dezenas de chamadas
  // diretas já existentes em teste (sem url = comportamento idêntico ao
  // pré-#4232, nunca renderiza o form).
  url?: URL,
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
      `O ranking de ${MONTH_NAMES_PT[parsed.month - 1]} de ${parsed.year} ainda não começou.`,
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
    ? closedPeriodCacheControl() // #3118 item 2: 1h (não mais 30d immutable — voto retroativo)
    : "public, max-age=60"; // 60s pro mês corrente

  // #4232: resolve o form de nickname (email+sig do link "Ver leaderboard")
  // só quando a request carrega `url` (router de index.ts sempre passa).
  const nicknameForm = url ? await resolveLeaderboardNicknameForm(url, env, brand) : null;
  // #4418 §2b: Caixa B só é checada quando a Caixa A não se aplica (mutuamente
  // exclusivas por estado de score:{email} — evita 1 KV get redundante).
  const subscribeBox = url && !nicknameForm ? await resolveLeaderboardSubscribeBox(url, env, brand) : null;
  // #4418 §2c: self-highlight — independente de A/B, qualquer viewer com
  // email+sig válidos é identificado.
  const viewerEmail = url ? await resolveLeaderboardViewerEmail(url, env, brand) : null;
  // #4418 §3: faixa de confirmação pós-redirect de /set-name (pura, sem KV).
  const confirmationBanner = url ? resolveSetNameConfirmationBanner(url) : null;

  return renderLeaderboardHtml(
    scores, periodLabel, parsed.year, cacheControl, brand, "month",
    canonicalPath ?? leaderboardHref(brand, monthSlug),
    nicknameForm,
    subscribeBox,
    viewerEmail,
    confirmationBanner,
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
    return json({ entries: [], period_slug: monthSlug, message: `O ranking de ${monthSlug} ainda não começou.` }, 200, env);
  }

  const scores = scoreByMonthEntriesToLeaderboard(entries);
  const ranked = rankEntries(scores);

  const medals = ["🥇", "🥈", "🥉"];
  const jsonEntries: LeaderboardJsonEntry[] = ranked.map((e) => {
    const rawNickname = e.nickname ?? null;
    // #3118 (item 11): maskEmail (lib.ts) consolida esta 3ª implementação —
    // era a única das 3 com fallback pra email sem "@" (agora canônico).
    // Ternário (não `??`) preservado deliberadamente — nickname "" (vazio,
    // não deveria ocorrer via handleSetName mas defensivo p/ dado histórico)
    // deve cair pro masked email como antes, não ser exibido como string vazia.
    // #4123: prefere `e.masked` (já derivado na escrita do snapshot — o
    // caminho de produção real, via getOrComputeSnapshot acima); fallback
    // `maskEmail(e.email)` só cobre chamada direta fora do pipeline do snapshot.
    const displayNickname = rawNickname ? rawNickname : (e.masked ?? maskEmail(e.email ?? ""));
    return {
      rank: e.rank,
      // #3113: medalha exige correct >= 1 (mesmo gate de rankEntries/computePodium
      // — ver leaderboard.ts). Sem isso, rank<=3 por "mais tentativas vence"
      // (#1163) com 0 acertos ainda ganharia emoji de medalha aqui.
      medal: e.rank <= 3 && e.correct >= 1 ? medals[e.rank - 1] : "",
      nickname: displayNickname,
      correct: e.correct,
      total: e.total,
      pct: e.pct,
    };
  });

  const isPast = slugCmp < 0;
  const cacheControl = isPast
    ? closedPeriodCacheControl() // #3118 item 2: 1h (não mais 30d immutable — voto retroativo)
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
 * soma (correct, total) por leitor; nickname = último não-nulo na ordem dos
 * meses (mês mais recente vence, espelhando a propagação de nickname mensal).
 *
 * #4123: chave de merge é `uid` (hash opaco), não mais `email.toLowerCase()`
 * — SnapshotEntry não carrega mais e-mail cru. `uid` já é derivado de
 * `hashEmailForMatch`, que normaliza trim+lowercase ANTES de hashear (ver
 * lib.ts) — mesma garantia de estabilidade entre meses que a normalização
 * de e-mail antiga (case divergente entre meses ainda cai no mesmo uid).
 */
export function mergeYearEntries(perMonth: SnapshotEntry[][]): SnapshotEntry[] {
  const byUid = new Map<string, SnapshotEntry>();
  for (const month of perMonth) {
    for (const e of month) {
      const prev = byUid.get(e.uid);
      if (!prev) {
        byUid.set(e.uid, { ...e });
      } else {
        prev.correct += e.correct;
        prev.total += e.total;
        if (e.nickname) prev.nickname = e.nickname;
        // #3118 (item 1): last_vote_ts deve refletir o voto mais recente entre
        // TODOS os meses agregados — os slugs de `perMonth` chegam em ordem
        // cronológica (ver handleLeaderboardByYear), então sem esta comparação
        // a 1ª ocorrência (mês mais ANTIGO) nunca era sobrescrita por um mês
        // mais recente, invertendo o critério #1383 ("voto mais recente vence
        // empate") especificamente na visão ANUAL — o mensal (rankEntries
        // direto sobre 1 snapshot) já não tinha esse bug.
        if (e.last_vote_ts && (!prev.last_vote_ts || e.last_vote_ts > prev.last_vote_ts)) {
          prev.last_vote_ts = e.last_vote_ts;
        }
      }
    }
  }
  return [...byUid.values()];
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
  // #4232: mesmo racional do parâmetro homônimo em handleLeaderboardByMonth —
  // opcional, resolve o form de nickname só quando presente.
  url?: URL,
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
    return new Response(votePageHtml(`O ranking de ${year} ainda não começou.`, false, null, null, null, brand), {
      status: 404, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }
  const scores = scoreByMonthEntriesToLeaderboard(entries);
  const cacheControl = year < currentYear
    ? closedPeriodCacheControl() // #3118 item 2: 1h (não mais 30d immutable — voto retroativo)
    : "public, max-age=60"; // corrente: real-time-ish (igual ao mensal)
  // #4232 / #4418: mesmo racional de handleLeaderboardByMonth acima.
  const nicknameForm = url ? await resolveLeaderboardNicknameForm(url, env, brand) : null;
  const subscribeBox = url && !nicknameForm ? await resolveLeaderboardSubscribeBox(url, env, brand) : null;
  const viewerEmail = url ? await resolveLeaderboardViewerEmail(url, env, brand) : null;
  const confirmationBanner = url ? resolveSetNameConfirmationBanner(url) : null;
  return renderLeaderboardHtml(
    scores, "", year, cacheControl, brand, "year", leaderboardHref(brand, yearStr),
    nicknameForm, subscribeBox, viewerEmail, confirmationBanner,
  );
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
  // #4232: presente (resolvido via resolveLeaderboardNicknameForm) só quando
  // o leitor chegou com email+sig válidos e ainda não tem nickname — renderiza
  // o mesmo bloco nick-box da tela de resultado do voto.
  nicknameForm: { email: string; sig: string } | null = null,
  // #4418 §2b: Caixa B — quando o leitor JÁ tem apelido salvo e ainda não
  // confirmou o opt-in (brand clarice). Mutuamente exclusivo com
  // `nicknameForm` (resolveLeaderboardSubscribeBox só roda quando
  // `resolveLeaderboardNicknameForm` retornou null, ver handleLeaderboardByMonth/ByYear).
  subscribeBox: SubscribeBoxState | null = null,
  // #4418 §2c: e-mail do viewer identificado (email+sig válidos na query
  // string), independente de ter caixa A/B a oferecer — usado só pro
  // self-highlight server-side (diaria/clarice; brand web usa o mecanismo
  // client-side já existente, ver selfHighlightHtml abaixo).
  viewerEmail: string | null = null,
  // #4418 §3: faixa de confirmação pós-redirect de /set-name bem-sucedido.
  confirmationBanner: string | null = null,
): Response {
  // #1905: título/copy/link por marca (diar.ia.br diário vs Clarice News mensal).
  const info = BRAND_INFO[brand];
  // #2006: "Leaderboard de 2026" (ano) vs "Leaderboard de Maio de 2026" (mês).
  const heading = periodKind === "year" ? `Ranking de ${year}` : `Ranking de ${periodLabel} de ${year}`;
  const periodNoun = periodKind === "year" ? "este ano" : "esse mês";
  // #1092 + #1256: dense ranking — leitores empatados em (correct, total)
  // ocupam o mesmo número e o próximo grupo é +1 (1, 1, 2 — não 1, 1, 3).
  // #4122 (decisão do editor 260727): a cauda de baixo-engajamento
  // (#4008 item 2 — corte de quem tinha < MIN_ATTEMPTS_FOR_LEADERBOARD_LISTING
  // tentativas) foi REVERTIDA de propósito — TODO MUNDO aparece listado agora,
  // pra que ninguém fique invisível (o corte também produzia o achado
  // "self-highlight mente pra quem está na cauda": o jogador via "você ainda
  // não aparece" mesmo tendo jogado). `partitionLeaderboardForDisplay` é
  // chamado com `minAttempts=0` — ninguém é filtrado (total nunca é negativo),
  // mas o re-ranqueamento denso (`assignDenseRanks`, #4122/PR #4128) continua
  // rodando: vira no-op no caminho normal (sem corte, a ordem/ranks batem com
  // `rankedAll`), e segue disponível como a mesma peça reusável que protege
  // contra buracos de rank caso o cap de 500 abaixo algum dia precise cortar
  // no meio de um grupo empatado.
  // #4029 (item 1, decisão do editor 260724): corte visual subiu de 50 pra
  // LEADERBOARD_DISPLAY_CAP (500) — cobre qualquer volume realista hoje
  // (diária: ~50-200 votantes/mês, ver comentário em
  // upsertOwnEntryInSnapshot acima; web é bem menor ainda) sem risco de
  // estourar o HTML/render no mobile.
  const rankedAll = rankEntries(scores);
  const { visible } = partitionLeaderboardForDisplay(rankedAll, 0);
  const ranked = visible.slice(0, LEADERBOARD_DISPLAY_CAP);

  // #4418 §2c: self-highlight server-side (diaria/clarice) — uid do viewer
  // identificado via email+sig válidos (`resolveLeaderboardViewerEmail`).
  // Mecanismo DIFERENTE do self-highlight client-side do brand `web` (script
  // abaixo, gated `brand === "web"`, casa contra `localStorage`): aqui o
  // servidor já SABE quem está olhando (a própria URL carrega a assinatura),
  // então a marcação acontece direto no render — sem JS, sem `data-uid`
  // emitido (guard do #4162 intacto: o atributo continua só pro brand web).
  const selfUid = viewerEmail !== null ? hashEmailForMatch(viewerEmail) : null;

  const rows = ranked.map((s) => {
    // #3118 (item 11): maskEmail (lib.ts) — consolida com as outras 2 implementações.
    // #4123: prefere `s.masked` (já derivado na escrita do snapshot — nunca
    // recalcula a partir de e-mail cru aqui, que nem existe mais na maioria
    // dos casos). Fallback pra `maskEmail(s.email)` só cobre chamadas diretas
    // fora do pipeline do snapshot (testes/back-compat).
    const display = s.nickname || s.masked || maskEmail(s.email ?? "");
    // #2191: usa htmlEscape (de lib.ts) em vez de replace inline que omitia "'".
    const escaped = htmlEscape(display);
    // #4418 §2c: match só roda quando há um viewer identificado (short-circuit
    // — `hashEmailForMatch` por linha só paga o custo quando faz sentido).
    const isSelfRow = selfUid !== null && (s.uid ?? hashEmailForMatch(s.email ?? "")) === selfUid;
    const rowClasses = [s.rank === 1 ? "leader" : null, isSelfRow ? "self-row" : null].filter(Boolean).join(" ");
    const classAttr = rowClasses ? ` class="${rowClasses}"` : "";
    // #4418 §2c: âncora pra rolagem direta (ranking longo não exige caça) —
    // usada pelo `#self-row` no fragment da URL de redirect pós-/set-name.
    const idAttr = isSelfRow ? ' id="self-row"' : "";
    const selfBadge = isSelfRow ? ' <span class="self-badge">você</span>' : "";
    // #3977: coluna de percentual — `s.pct` já vem calculado por rankEntries
    // (leaderboard.ts, a partir de scoreByMonthEntriesToLeaderboard acima),
    // só não chegava no template HTML.
    // #4029 (item 2): data-uid opaco (hashEmailForMatch, lib.ts) — o script
    // de self-highlight (brand web, ver selfHighlightHtml abaixo) casa a
    // PRÓPRIA identidade local contra este atributo sem o servidor nunca
    // expor e-mail de ninguém em claro no HTML.
    // #4123: prefere `s.uid` (hash já derivado do e-mail REAL no momento da
    // escrita do snapshot) — recalcular a partir de `s.email` só serve pro
    // fallback de chamada direta fora do pipeline do snapshot (mesmo racional
    // do `display` acima). NUNCA hashear `s.masked` aqui — é lossy e produziria
    // um uid que o self-highlight client-side (que hasheia o e-mail real) jamais
    // conseguiria casar.
    // #4162: só emite o atributo quando `brand === "web"` — o ÚNICO brand
    // com script consumidor (selfHighlightHtml abaixo é gated do mesmo jeito).
    // Antes o data-uid saía em TODOS os brands (inclusive diaria/clarice, sem
    // nenhum script pra ler) — FNV-1a de 32 bits sem sal é reversível offline
    // (dado um e-mail candidato, dá pra recomputar o hash e desmascarar a
    // linha `wut…@***`), então servir o atributo onde ninguém o consome só
    // ampliava a superfície de exposição sem ganho nenhum. Não implementamos
    // aqui um uid salgado por segredo do worker (mitigaria a reversibilidade
    // que PERMANECE no brand web) — decisão do editor foi descartar esse
    // escopo nesta rodada. #4418: o self-highlight de diaria/clarice usa o
    // uid só em MEMÓRIA do servidor (comparação acima) — nunca serializado
    // como atributo HTML pra esses brands, guard intacto.
    const uidAttr = brand === "web" ? ` data-uid="${s.uid ?? hashEmailForMatch(s.email ?? "")}"` : "";
    return `<tr${classAttr}${idAttr}${uidAttr}>
      <td>${s.medal}</td>
      <td>${escaped}${selfBadge}</td>
      <td>${s.correct}/${s.total}</td>
      <td>${s.pct}%</td>
    </tr>`;
  }).join("\n");

  const pageTitle = `${heading} | ${info.name}`;
  const path = canonicalPath ?? "/leaderboard";
  const seoMeta = renderSeoMeta({
    title: pageTitle,
    description: `Quem mais acertou ${periodNoun} qual imagem foi gerada por IA no jogo "É IA?" da ${info.name}. Veja o ranking dos leitores.`,
    path,
    brand,
  });
  // #3108: sub-copy com 2 links (diar.ia.br + Clarice) é EXCLUSIVA do brand
  // clarice — cross-promoção só faz sentido pra quem está na newsletter mensal.
  // Brand diaria mantém o texto original inalterado.
  // #3978: hrefs com UTM (era "https://diaria.beehiiv.com" SEM parâmetro
  // nenhum no ramo clarice, e `info.siteUrl` cru no ramo diaria — nenhum dos
  // dois media o funil). `diariaHref` sempre aponta pro brand "diaria" (a
  // diária cross-promovida na cópia da clarice), não pro `brand` local desta
  // função (que é "clarice" nesse ramo).
  const diariaHref = buildBrandSiteUrl("diaria", "leaderboard-copy", "eia-leaderboard-copy");
  const brandHref = buildBrandSiteUrl(brand, "leaderboard-copy", "eia-leaderboard-copy");
  // #4569 (260804, pedido do editor): o envio Beehiiv apoiadores passou a
  // usar `pollBrand: "clarice"` (#4521), compartilhando este leaderboard com
  // 2 audiências (Clarice/Brevo + Beehiiv apoiadores) — "da Clarice" com link
  // pra clarice.ai deixou de descrever a única audiência real. Troca por
  // "mensal" (texto plano, sem link) — descreve a newsletter mensal em si,
  // não uma marca específica. O 1º link (diariaHref → diar.ia.br) fica
  // intacto; só o 2º (brandHref → clarice.ai) sai desta sub-copy.
  const subCopy = brand === "clarice"
    ? `<p class="sub">Quem mais acertou ${periodNoun} qual imagem foi gerada pela <a href="${htmlEscape(diariaHref)}">diar.ia.br</a> na newsletter mensal.</p>`
    : `<p class="sub">Quem mais acertou ${periodNoun} qual imagem foi gerada por IA na <a href="${htmlEscape(brandHref)}">${info.name}</a>.</p>`;
  // #3615: link do arquivo só pra clarice — mesmo gate já aplicado à página
  // de voto (votePageHtml, index.ts) pelo #3578. Diária não tem mais acesso
  // ao arquivo em NENHUMA superfície; web também não (#3589 — web é a
  // sequência do mês anterior, sem conceito de arquivo).
  // #4420: sai de dentro de `<p class="nav">` — vira bloco/botão próprio,
  // mesmo tratamento visual do botão equivalente em `votePageHtml` (index.ts,
  // "/vote") — pedido do editor: "não existirem dois pesos visuais pro mesmo
  // lugar". Copy inalterada ("Votar em edições passadas").
  const archiveButtonHtml = brand === "clarice"
    ? `<p class="archive-cta"><a class="archive-btn" href="${archiveHref(brand, String(year))}">Votar em edições passadas</a></p>`
    : "";
  // #3615 (item 2, feedback do editor): "Ver ranking anual" só faz sentido
  // pra brand com leaderboard ANUAL (`BRAND_INFO[brand].leaderboardPeriod ===
  // "year"` — hoje só clarice) — mesma abstração que `leaderboardHref` já usa
  // internamente pra decidir a conversão mensal→anual do slug. Diária/web têm
  // leaderboard MENSAL (fecha todo mês) — não existe "ranking anual" pra
  // linkar. `navHtml` fica "" (parágrafo inteiro some) quando não há link
  // (só o anual, desde #4420 — o arquivo virou botão separado acima) pra
  // oferecer.
  // #4049: além do gate de brand, também não linkar quando a view ATUAL já é
  // a anual — evitava um self-link cujo href era byte-a-byte o canonicalPath
  // da própria página (`handleLeaderboardByYear` chama com periodKind="year").
  const annualLinkHtml = BRAND_INFO[brand].leaderboardPeriod === "year" && periodKind !== "year"
    ? `<a href="${leaderboardHref(brand, String(year))}">Ver ranking anual de ${year}</a>`
    : "";
  const navHtml = annualLinkHtml ? `<p class="nav">${annualLinkHtml}</p>` : "";
  // #4232: bloco de identidade (Caixa A — mesmo markup da tela de resultado
  // do voto) — só quando resolveLeaderboardNicknameForm validou email+sig da
  // query string. `showOptIn: brand === "clarice"` traz o checkbox pro
  // leaderboard também (recomendação da issue #4418 §2: "outra superfície de
  // conversão pelo mesmo código"). `surface: "leaderboard"` troca o rótulo do
  // botão pra "Salvar" (não "Salvar e ver o leaderboard" — autorreferente
  // nesta página, #4562).
  //
  // #4562: a Caixa B (renderSubscribeBoxHtml/subscribeBox) SAIU do
  // leaderboard — os 2 CTAs dela ("Assinar e ver o leaderboard" / "Ver o
  // leaderboard") apontavam pro leaderboard numa página que já É o
  // leaderboard. `subscribeBox` continua resolvido acima (ver
  // handleLeaderboardByMonth/ByYear) só porque também alimenta `identified`
  // (cache-control) mais abaixo — não porque ainda tem HTML a oferecer aqui.
  const identityBoxHtml = nicknameForm
    ? renderNicknameFormHtml(nicknameForm, brand, brand === "clarice", "leaderboard")
    : "";
  // #4418 §3: faixa de confirmação pós-redirect de /set-name — topo da
  // página, acima do heading (é a PRIMEIRA coisa que o leitor vê ao chegar
  // do redirect, reportando as duas ações: apelido salvo + resultado do
  // cadastro, quando aplicável).
  const confirmationBannerHtml = confirmationBanner
    ? `<p class="confirm-banner">${confirmationBanner}</p>`
    : "";
  // #4122 (decisão do editor 260727): agregado "+ N jogadores" removido —
  // era a contrapartida visual do corte de cauda revertido acima
  // (`partitionLeaderboardForDisplay` agora chamado com minAttempts=0,
  // hiddenCount sempre 0). Sem ninguém escondido, o agregado perde sentido.
  // #4029 (item 2): self-highlight — destaca a linha do PRÓPRIO jogador
  // quando ele visita o ranking. Só faz sentido pro brand `web` (único com
  // identidade local persistida — `localStorage["eia_web_identified_email"]`,
  // #3975/jogar.ts); diaria/clarice votam por e-mail com link assinado, sem
  // nenhuma identidade client-side pra casar contra `data-uid` — o bloco
  // inteiro fica de fora nesses brands (script seria sempre no-op).
  // Match acontece 100% no BROWSER: o servidor nunca sabe quem está olhando
  // (sem sessão/cookie novo) e o HTML nunca carrega e-mail de ninguém em
  // claro — só o `data-uid` opaco (hashEmailForMatch, gêmeo JS abaixo) já
  // presente em cada `<tr>` desde o `.map()` de `rows` acima.
  const selfHighlightHtml = brand === "web" ? `<p id="self-cta" class="self-cta" hidden>Você ainda não aparece no ranking desta identidade. <a href="/jogar">Jogue e entre no ranking</a>.</p>
<script>
(function () {
  function hashEmailForMatch(email) {
    var normalized = (email || "").trim().toLowerCase();
    var hash = 0x811c9dc5;
    for (var i = 0; i < normalized.length; i++) {
      hash = hash ^ normalized.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    var hex = (hash >>> 0).toString(16);
    while (hex.length < 8) hex = "0" + hex;
    return hex;
  }
  var email = null;
  try { email = window.localStorage.getItem("eia_web_identified_email"); } catch (e) {}
  if (!email) return;
  var uid = hashEmailForMatch(email);
  var row = document.querySelector('tr[data-uid="' + uid + '"]');
  if (row) {
    row.classList.add("self-row");
    var nameCell = row.children[1];
    if (nameCell) nameCell.innerHTML += ' <span class="self-badge">você</span>';
    if (row.scrollIntoView) row.scrollIntoView({ block: "center", behavior: "smooth" });
  } else {
    var cta = document.getElementById("self-cta");
    if (cta) cta.hidden = false;
  }
})();
</script>` : "";
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
  /* #3113 item 6: cinzas via opacity sobre ink aboliram — texto secundário é
     SEMPRE ink sólido, hierarquia vem de tamanho/peso (DS canônico, ver nota
     em design-tokens.ts: "não há cinzas na paleta"). */
  p.sub { color: ${DS_COLORS.ink}; font-size: 0.95rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th { text-align: left; padding: 8px; border-bottom: 1px solid ${DS_COLORS.ink}; font-size: 0.72rem; color: ${DS_COLORS.ink}; text-transform: uppercase; letter-spacing: 0.08em; font-family: ${DS_FONTS.sans}; }
  td { padding: 10px 8px; border-bottom: 1px solid ${DS_COLORS.rule}; }
  tr.leader td { font-weight: 600; color: ${DS_COLORS.brand}; }
  a { color: ${DS_COLORS.ink}; text-decoration: underline; }
  .kicker { font-family: ${DS_FONTS.sans}; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: ${DS_COLORS.ink}; margin: 0 0 12px 0; }
  p.nav { margin: 14px 0 0 0; font-size: 0.85rem; }
  p.nav a { font-weight: 600; }
  /* #4029 (item 2): self-highlight — linha do próprio jogador. */
  tr.self-row td { background: ${DS_COLORS.paperAlt}; font-weight: 600; }
  tr.self-row td:first-child { border-left: 3px solid ${DS_COLORS.brand}; }
  .self-badge { display: inline-block; padding: 2px 8px; background: ${DS_COLORS.brand}; color: ${DS_COLORS.paper}; border-radius: 4px; font-size: 0.7rem; font-weight: 700; margin-left: 6px; }
  .self-cta { margin-top: 14px; padding: 12px 16px; background: ${DS_COLORS.paperAlt}; border-radius: 8px; font-size: 0.85rem; }
  /* #4418 §3: faixa de confirmação pós-redirect de /set-name. */
  .confirm-banner { margin: 0 0 20px 0; padding: 14px 16px; background: ${DS_COLORS.paperAlt}; border-radius: 8px; font-size: 0.95rem; }
${renderNicknameFormStyles()}
${renderArchiveButtonStyles()}
${renderBrandShellStyles()}
</style>
</head>
<body>
<p class="kicker">É IA?</p>
<hr class="rule">
${confirmationBannerHtml}
<h1>${heading}</h1>
${subCopy}
${navHtml}
${archiveButtonHtml}
${identityBoxHtml}
<table>
<thead><tr><th>#</th><th>Jogador(a)</th><th>Acertos</th><th>%</th></tr></thead>
<tbody>${rows || `<tr><td colspan=4 style='color:${DS_COLORS.ink};text-align:center;padding:20px'>Ainda sem votos.</td></tr>`}</tbody>
</table>
${selfHighlightHtml}
<p style="margin-top:30px;font-size:0.8rem;color:${DS_COLORS.ink}">Critérios: acertos absolutos (1º); em caso de empate, mais tentativas vence (2º).</p>
<p style="margin-top:8px;font-size:0.8rem;color:${DS_COLORS.ink}">Atualizado em tempo real · Nicknames escolhidos pelos leitores · E-mails mascarados</p>
${renderBrandFooter(brand)}
</body>
</html>`;

  // #4232 (achado do review consolidado — code-reviewer): quando `nicknameForm`
  // está presente, a página carrega o e-mail CRU do leitor + uma sig HMAC
  // válida pra `/set-name` (mesmo par usado no hidden input do form) — mesma
  // classe de payload sensível que `voteHtmlResponse` (index.ts) já trata com
  // `no-store` ("voto é estado mutável por-usuário"). Servir essa versão com
  // `Cache-Control: public` (o cacheControl normal do período) arriscaria um
  // cache intermediário (proxy corporativo, navegador de máquina compartilhada)
  // guardar a resposta por URL e servir o e-mail+sig de um leitor pra outro
  // dentro do TTL. `no-store` só nesta resposta específica — o caminho SEM
  // nicknameForm (a esmagadora maioria do tráfego) mantém o cache normal.
  // #4418 §2c: `subscribeBox`/`viewerEmail` carregam o MESMO par email+sig
  // sensível (subscribeBox por construção; viewerEmail é o e-mail já
  // verificado por sig) — mesmo racional, mesmo `no-store`.
  const identified = nicknameForm !== null || subscribeBox !== null || viewerEmail !== null;
  const finalCacheControl = identified ? "no-store, no-cache, must-revalidate" : cacheControl;
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": finalCacheControl }
  });
}

// ── /leaderboard ──────────────────────────────────────────────────────────────

export async function handleLeaderboard(env: Env, brand: Brand = "diaria", url?: URL): Promise<Response> {
  // #1345: /leaderboard agora delega pro slug do mês corrente. Schema único
  // (`score-by-month:*`) — `score:*` global continua mantido pra all-time
  // potencial mas não é mais lido pelo leaderboard.
  // #3106: canonical explícito de "/leaderboard" (self) — sem isso o override
  // default de handleLeaderboardByMonth apontaria canonical pro slug do mês
  // corrente, e o crawler indexaria a URL errada pra quem chegou via "/leaderboard".
  // #4232: `url` repassado pra resolver o form de nickname (query params
  // email+sig), quando presente.
  return handleLeaderboardByMonth(currentMonthSlugBrt(new Date()), env, brand, leaderboardHref(brand), url);
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
    if (!AAMMDD_RE.test(edition)) continue;
    if (edition.slice(0, 2) !== yy) continue;
    if (edition > today) continue; // #3113 item 9: ainda não chegou a data
    set.add(edition);
  }
  return [...set].sort().reverse();
}

/**
 * Pure (#4419): equivalente de `extractEditionsForYear` acima, mas pra brand
 * com `leaderboardPeriod === "year"` (hoje só `clarice`) — o arquivo dessa
 * marca deve listar só as edições MENSAIS de ciclo (`YYMM-MM`), nunca as
 * edições DIÁRIAS que também vivem no `correct:` cru compartilhado (bug raiz
 * do #4419: `extractEditionsForYear` mantém só `AAMMDD_RE`, então filtrava
 * IN as edições diárias e IGNORAVA de propósito qualquer chave de ciclo).
 *
 * Duas fontes, dois papéis (mesmo racional de `handleEditions`, vote.ts):
 *   - `statsEditionNames`: sufixos de `stats:{edition}` do namespace BRANDED
 *     da marca (só existe depois do 1º voto NAQUELA marca) — é a ÚNICA fonte
 *     que sabe com certeza "esta edição pertence à clarice" (o `correct:` cru
 *     é compartilhado entre marcas e não carrega esse sinal sozinho). Aceita
 *     tanto o marcador LEGADO AAMMDD (pré-#2115, ex: `260531`) quanto o
 *     formato novo de ciclo (`2605-06`) — normalizado aqui via
 *     `cycleForLegacyMonthlyEdition` pro mesmo ciclo, dedup automático via Set.
 *   - `correctKeyNames`: nomes crus das chaves `correct:{...}` (namespace cru
 *     compartilhado, ver `handleLeaderboardArchive`) — usado só pra checar se
 *     o gabarito do ciclo já foi FECHADO (`close-poll.ts`). Um ciclo pode ter
 *     o gabarito gravado sob a chave NOVA (`correct:2605-06`) OU a chave
 *     LEGADA (`correct:260531`, pré-cutover) — os dois são checados via
 *     `legacyMonthlyEditionForCycle` antes de decidir "sem gabarito ainda".
 *
 * Filtra pelo ano de CONTEÚDO (2 primeiros dígitos do ciclo — mesmo critério
 * de `extractEditionsForYear`; a página já reconcilia CONTEÚDO×ENVIO só na
 * exibição via `groupEditionsByMonth`/`formatEditionDateForBrand`, não no
 * filtro). Sem "edição futura" (#3113 item 9): esse conceito pressupõe um dia
 * real de calendário (AAMMDD) — um ciclo `YYMM-MM` não representa um dia, e a
 * intersecção com `correct:` FECHADO já é o gate real de "já aconteceu".
 *
 * #4435 (achado silent-failure-hunter do review pré-merge do #4419, MEDIUM,
 * não-bloqueante — 2 efeitos colaterais ACEITOS, documentados aqui em vez de
 * corrigidos):
 *
 *   (a) Um ciclo com `correct:` FECHADO mas ZERO votos ainda registrados
 *   NAQUELA marca (`stats:{ciclo}` branded ainda ausente) fica invisível
 *   nesta listagem — não porque o ciclo "não está fechado", mas porque
 *   `statsEditionNames` (a única fonte que sabe com certeza "esta edição É
 *   da clarice") ainda não tem entrada pra ele. A heurística de
 *   pertencimento via presença de `stats:` dá um falso-negativo justo nesse
 *   caso. Efeito esperado (trade-off, não bug) — desaparece sozinho assim
 *   que o 1º voto do ciclo chega e popula `stats:{ciclo}` branded.
 *
 *   (b) A chave legada `correct:{legacyMarker}` (ex: `correct:260531`) é
 *   sintaticamente INDISTINGUÍVEL de uma edição DIÁRIA real publicada no
 *   mesmo dia — `isClosed` acima trata "existe valor em
 *   `correct:{legacyMarker}`" como prova de que o CICLO da clarice fechou,
 *   sem cross-check de que aquele valor foi de fato escrito por um
 *   `close-poll.ts --brand clarice` (em vez de um close-poll normal da
 *   edição diária publicada naquela data). Risco BOUNDED — só ciclos legados
 *   pré-cutover #2115 têm essa ambiguidade; o formato novo de ciclo
 *   (`YYMM-MM`) não colide com nenhum formato de edição diária. Mesma
 *   colisão já nomeada em `scripts/close-poll.ts` (comentário do #2006:
 *   "colisão real: 260531 é uma data de edição diária válida") — ver também
 *   o comentário espelho em `handleArchiveVotePage` abaixo, onde o mesmo
 *   `legacyMarker` é lido pra decidir se a página de voto de 1 edição existe.
 */
export function extractMonthlyEditionsForYear(
  statsEditionNames: string[],
  correctKeyNames: string[],
  year: string,
): string[] {
  const yy = year.slice(2);
  const closedRaw = new Set(
    correctKeyNames.map((k) => (k.startsWith("correct:") ? k.slice("correct:".length) : k)),
  );
  const set = new Set<string>();
  for (const raw of statsEditionNames) {
    if (!isValidVoteEditionFormat(raw)) continue;
    const cycle = CYCLE_EDITION_RE.test(raw) ? raw : cycleForLegacyMonthlyEdition(raw);
    if (!cycle) continue;
    if (cycle.slice(0, 2) !== yy) continue;
    const legacyMarker = legacyMonthlyEditionForCycle(cycle);
    const isClosed = closedRaw.has(cycle) || (legacyMarker !== null && closedRaw.has(legacyMarker));
    if (!isClosed) continue;
    set.add(cycle);
  }
  return [...set].sort().reverse();
}

/**
 * Pure (#3113 item 10): agrupa edições AAMMDD (já ordenadas DESC) por mês,
 * preservando a ordem de entrada — uma lista flat de edições diárias passa de
 * 200 itens/ano sem agrupamento. Assume todas as edições do MESMO ano (o
 * caller já filtra por ano em `extractEditionsForYear`) — o heading mostra só
 * o nome do mês (o ano já aparece no `<h1>` da página).
 *
 * #3464: pra `brand` com `leaderboardPeriod === "year"` (só `clarice` hoje),
 * o heading agrupa pelo mês de ENVIO, não de CONTEÚDO — mesmo racional de
 * `formatEditionDateForBrand` (o `mm` embutido no AAMMDD é sempre o mês de
 * CONTEÚDO; o leitor recebeu o e-mail no mês SEGUINTE). Só a exibição muda —
 * `editions` dentro de cada grupo continuam os AAMMDD crus originais (hrefs
 * intactos). Wrap dezembro→janeiro: uma edição de conteúdo=dezembro exibe
 * "Janeiro" (mês de envio, ano seguinte) mesmo permanecendo agrupada dentro
 * da página do ano de CONTEÚDO — o filtro de ano (`extractEditionsForYear`)
 * não muda, só o rótulo. Brand `diaria` (`leaderboardPeriod === "month"`)
 * mantém o comportamento original (agrupa pelo mês embutido no AAMMDD).
 *
 * #3473 (fix do achado de review sobre #3464 — heading "Janeiro" vs link
 * "Janeiro de 2027"): `pageYear` opcional = ano de CONTEÚDO da página
 * (`/leaderboard/{pageYear}/arquivo`). Quando o ano de EXIBIÇÃO do grupo
 * (envio) diverge de `pageYear` — só ocorre no wrap dezembro→janeiro — o
 * heading passa a carregar o ano ("Janeiro de 2027") em vez do mês nu
 * ("Janeiro"), que na página "Arquivo de 2026" lia-se como janeiro/2026 e
 * contradizia o link do item logo abaixo (que já mostrava "Janeiro de 2027"
 * via `formatEditionDateForBrand`). `pageYear` omitido (chamadas de teste
 * unitário pré-#3473) preserva o comportamento antigo (mês nu sempre) —
 * back-compat.
 */
export interface EditionMonthGroup {
  monthLabel: string;
  editions: string[];
}

export function groupEditionsByMonth(
  editions: string[],
  brand: Brand = "diaria",
  pageYear?: string, // #3473: ano de CONTEÚDO da página — reconcilia heading↔link no wrap dez→jan
): EditionMonthGroup[] {
  const showEnvioMonth = BRAND_INFO[brand].leaderboardPeriod === "year"; // #3464
  const pageYearNum = pageYear !== undefined ? parseInt(pageYear, 10) : null;
  const groups: EditionMonthGroup[] = [];
  let currentGroupKey: string | null = null;
  for (const ed of editions) {
    const contentYy = parseInt(ed.slice(0, 2), 10);
    const contentMm = parseInt(ed.slice(2, 4), 10);
    let displayMm = contentMm;
    let displayYear = 2000 + contentYy;
    if (showEnvioMonth && contentMm >= 1 && contentMm <= 12) {
      const envio = envioMonthYear(2000 + contentYy, contentMm);
      displayMm = envio.month;
      displayYear = envio.year;
    }
    // #3473: groupKey inclui o ano de exibição — sem isso, um "Janeiro"
    // normal (mesmo ano da página) e um "Janeiro" do wrap dezembro→janeiro
    // (ano seguinte) colapsariam no mesmo grupo se ambos aparecessem na
    // mesma página (não ocorre hoje — só 1 ano de conteúdo por página — mas
    // defensivo, mesmo racional do #3113 item 9).
    const groupKey = `${displayYear}-${String(displayMm).padStart(2, "0")}`;
    if (groupKey !== currentGroupKey) {
      const monthName = MONTH_NAMES_PT[displayMm - 1] ?? ed.slice(2, 4);
      let monthLabel = monthName.charAt(0).toUpperCase() + monthName.slice(1);
      // #3473: heading carrega o ano quando ele diverge do ano da página —
      // elimina a contradição heading↔link no wrap dezembro→janeiro.
      if (pageYearNum !== null && displayYear !== pageYearNum) {
        monthLabel = `${monthLabel} de ${displayYear}`;
      }
      groups.push({ monthLabel, editions: [] });
      currentGroupKey = groupKey;
    }
    groups[groups.length - 1].editions.push(ed);
  }
  return groups;
}

/** Pure (#2867): href do arquivo — lista do ano (sem `edition`) ou voto de 1
 * edição (com `edition`), preservando `?brand=` só pra não-default. */
export function archiveHref(brand: Brand, year: string, edition?: string): string {
  const base = edition ? `/leaderboard/${year}/arquivo/${edition}` : `/leaderboard/${year}/arquivo`;
  return withBrandQuery(base, brand); // #3118 item 12
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
  const sections = groupEditionsByMonth(editions, brand, year) // #3464: heading por mês de ENVIO pra brand=clarice; #3473: year reconcilia heading↔link no wrap dez→jan
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
    description: `Vote retroativamente nas edições de ${year} do jogo "É IA?" e concorra no ranking anual da ${info.name}.`,
    path: archiveHref(brand, year),
    brand,
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
  /* #3113 item 6: cinzas via opacity sobre ink aboliram — ver renderLeaderboardHtml acima. */
  p.sub { color: ${DS_COLORS.ink}; font-size: 0.95rem; }
  ul { list-style: none; padding: 0; margin-top: 20px; }
  li { padding: 12px 8px; border-bottom: 1px solid ${DS_COLORS.rule}; font-size: 1.02rem; }
  a { color: ${DS_COLORS.ink}; text-decoration: underline; }
  .kicker { font-family: ${DS_FONTS.sans}; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: ${DS_COLORS.ink}; margin: 0 0 12px 0; }
  /* #3113 (item 10): heading de mês — agrupa a lista flat que passaria de
     200 itens/ano. Reusa a mesma convenção visual do .kicker (sans, uppercase,
     letter-spacing), em teal (acento reservado a links/kickers no DS). */
  .month-heading { font-family: ${DS_FONTS.sans}; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${DS_COLORS.brand}; margin: 28px 0 0; }
  .month-heading + ul { margin-top: 8px; }
${renderBrandShellStyles()}
</style>
</head>
<body>
<p class="kicker">É IA? — arquivo</p>
<hr class="rule">
<h1>Arquivo de ${htmlEscape(year)}</h1>
<p class="sub">Vote nas edições passadas de ${htmlEscape(year)} — o seu voto conta pro <a href="${leaderboardHref(brand, year)}">ranking anual</a>.</p>
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
 *
 * #3473 (fix do achado de review sobre #3464): pra `brand` com
 * `leaderboardPeriod === "year"` e edição de conteúdo=dezembro, `dateLabel`
 * (via `formatEditionDateForBrand`) mostra o mês/ano de ENVIO ("janeiro de
 * 2027"), mas o voto conta pro leaderboard do ano de CONTEÚDO (`year`, que é
 * sempre o ano de conteúdo — ver guard em `handleArchiveVotePage`:
 * `edition.slice(0,2) === yearStr.slice(2)`). Sem reconciliar, a subcopy
 * citava os dois anos como se fossem o mesmo ("Edição de janeiro de 2027 —
 * vale ponto no leaderboard anual de 2026"), contradição literal.
 * `leaderboardYearNote` anota explicitamente o mês de CONTEÚDO quando os
 * anos divergem, sem alterar `dateLabel` (mês de envio continua exibido,
 * intencional desde #3464) nem `year` (continua o ano de CONTEÚDO — invariante
 * de indexação do leaderboard, não mexido aqui).
 */
export function renderArchiveVoteHtml(
  edition: string,
  year: string,
  brand: Brand = "diaria",
): Response {
  const info = BRAND_INFO[brand];
  const brandHidden = brandHiddenInput(brand); // #3118 item 12
  const imgA = `/img/img-${edition}-01-eia-A.jpg`;
  const imgB = `/img/img-${edition}-01-eia-B.jpg`;
  const dateLabel = htmlEscape(formatEditionDateForBrand(edition, brand));
  const pageTitle = `É IA? — ${dateLabel} | ${info.name}`;
  // #3473: mês de CONTEÚDO extraído do próprio AAMMDD (`edition`) — quando é
  // dezembro E o brand mostra mês de envio, o ano do `dateLabel` (envio,
  // 2027) diverge do `year` da página/leaderboard (conteúdo, 2026).
  const contentMm = parseInt(edition.slice(2, 4), 10);
  const yearMismatch = BRAND_INFO[brand].leaderboardPeriod === "year" && contentMm === 12;
  const contentMonthName = MONTH_NAMES_PT[contentMm - 1] ?? "";
  const leaderboardYearNote = yearMismatch
    ? ` (conteúdo de ${contentMonthName} de ${htmlEscape(year)})`
    : "";
  const seoMeta = renderSeoMeta({
    title: pageTitle,
    description: `Qual imagem foi gerada por IA? Vote na edição de ${dateLabel}${leaderboardYearNote} e valha ponto no ranking anual de ${year} da ${info.name}.`,
    path: archiveHref(brand, year, edition),
    brand,
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
  /* #3113 item 6: cinzas via opacity sobre ink aboliram — ver renderLeaderboardHtml acima. */
  p.sub { color: ${DS_COLORS.ink}; font-size: 0.95rem; }
  .kicker { font-family: ${DS_FONTS.sans}; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: ${DS_COLORS.ink}; margin: 0 0 12px 0; }
  .email-row { margin: 20px 0; }
  .email-input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid ${DS_COLORS.rule}; border-radius: 4px; font-size: 1rem; font-family: ${DS_FONTS.sans}; }
  .choices { display: flex; gap: 12px; margin: 20px 0; justify-content: center; flex-wrap: wrap; }
  .choice { flex: 1 1 240px; max-width: 260px; }
  .choice img { width: 100%; height: auto; aspect-ratio: 16 / 9; border-radius: 6px; display: block; }
  /* #3110: fundo ink, não teal — botão cheio em teal reprovava
     contraste AA (~3:1 vs mínimo 4.5:1). Ink+onInk dá ~15:1. */
  .choice button { margin-top: 8px; width: 100%; padding: 10px 12px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 1rem; font-family: ${DS_FONTS.sans}; }
  a { color: ${DS_COLORS.ink}; text-decoration: underline; }
  /* #3113: hint "role pra ver B" — invisível no desktop (as 2 imagens já
     aparecem lado a lado ali, ver .choices acima) e visível só na pilha
     mobile abaixo, onde a imagem A + botão sozinhos já preenchem a tela e
     dava pra votar em A sem nunca ver a imagem B. Elemento HTML real (não
     CSS ::after) — leitor de tela também anuncia. */
  .scroll-hint { display: none; }
  @media (max-width: 600px) {
    .choice { flex-basis: 100%; max-width: 100%; }
    .scroll-hint { display: block; width: 100%; margin: 2px 0 10px; font-size: 0.85rem; font-weight: 600; color: ${DS_COLORS.brand}; }
  }
${renderLightboxStyles()}
${renderBrandShellStyles()}
</style>
</head>
<body>
<p class="kicker">É IA?</p>
<hr class="rule">
<h1>Qual imagem foi gerada por IA?</h1>
<p class="sub">Edição de ${dateLabel}${leaderboardYearNote} — vale ponto no ranking anual de ${htmlEscape(year)}.</p>
<form action="/vote" method="GET">
  <input type="hidden" name="edition" value="${htmlEscape(edition)}">
  ${brandHidden}
  <div class="email-row">
    <input type="email" name="email" placeholder="seu@email.com" required class="email-input">
  </div>
  <div class="choices">
    <div class="choice"><img src="${imgA}" width="800" height="450" alt="Imagem A" loading="lazy"><button type="submit" name="choice" value="A">Essa é a IA (A)</button></div>
    <p class="scroll-hint">↓ Veja também a Imagem B antes de decidir</p>
    <div class="choice"><img src="${imgB}" width="800" height="450" alt="Imagem B" loading="lazy"><button type="submit" name="choice" value="B">Essa é a IA (B)</button></div>
  </div>
</form>
<p><a href="${archiveHref(brand, year)}">← voltar ao arquivo de ${htmlEscape(year)}</a></p>
${renderLightboxMarkup()}
${lightboxScript()}
${renderBrandFooter(brand)}
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Handler `GET /leaderboard/{YYYY}/arquivo` — lista as edições do ano com
 * gabarito fechado (ver `extractEditionsForYear`/`extractMonthlyEditionsForYear`).
 *
 * #4419: `bEnv` é o env BRANDED da marca — mesmo `bEnv` que o router
 * (index.ts) já passa pra `handleEditions`. Só é consultado pra brand com
 * `leaderboardPeriod === "year"` (hoje só `clarice`), onde a listagem precisa
 * saber quais edições PERTENCEM à marca (via `stats:{edition}` branded) antes
 * de filtrar pelo `correct:` cru compartilhado — ver
 * `extractMonthlyEditionsForYear`. Pra `leaderboardPeriod === "month"`
 * (diária/web), `bEnv` nunca é lido — comportamento idêntico ao pré-#4419 (só
 * `correct:{yy}*` cru).
 *
 * #4435 (achado type-design-analyzer do review pré-merge do #4419):
 * DELIBERADAMENTE SEM default (`bEnv: Env`, não `bEnv: Env = env`). O irmão
 * `rawEnv: Env = env` em vote.ts (#4038/#4118) falha SEGURO quando omitido —
 * lê o gabarito cru compartilhado, que é correto mesmo sem brand. Aqui um
 * default `= env` falharia PERIGOSO: se um call site futuro chamar com
 * `brand="clarice"` e esquecer `bEnv`, o branch `leaderboardPeriod === "year"`
 * abaixo passaria a enumerar `stats:` CRU (as stats da marca `diaria`, sem
 * prefixo) em vez do namespace branded da clarice — reintroduzindo em
 * silêncio o exato sintoma do #4419 (edições diárias vazando pro arquivo da
 * clarice) que este handler existe pra corrigir. Tornar `bEnv` obrigatório
 * transforma esse call site esquecido num erro de compilação, não num bug
 * latente em produção.
 */
export async function handleLeaderboardArchive(
  yearStr: string,
  env: Env,
  brand: Brand,
  bEnv: Env,
): Promise<Response> {
  const year = parseInt(yearStr, 10);
  if (!/^\d{4}$/.test(yearStr) || year < 2000 || year > 2099) {
    return new Response(votePageHtml("Ano inválido. Use formato YYYY (ex: 2026).", false, null, null, null, brand), {
      status: 404, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }
  const yy = yearStr.slice(2);
  const correctKeys: string[] = [];
  for await (const k of listAllKeys(env, `correct:${yy}`)) correctKeys.push(k);

  if (BRAND_INFO[brand].leaderboardPeriod === "year") {
    // #4419: marca com leaderboard ANUAL — arquivo lista só ciclos mensais,
    // nunca as edições diárias que também vivem em `correct:{yy}*` (bug raiz
    // da issue). `stats:` branded é a única fonte que sabe com certeza "esta
    // edição é da clarice" — mesmo padrão de `handleEditions` (vote.ts).
    const statsEditions: string[] = [];
    for await (const k of listAllKeys(bEnv, "stats:")) statsEditions.push(k.slice("stats:".length));
    const editions = extractMonthlyEditionsForYear(statsEditions, correctKeys, yearStr);
    return renderArchiveListHtml(editions, yearStr, brand);
  }

  const editions = extractEditionsForYear(correctKeys, yearStr);
  return renderArchiveListHtml(editions, yearStr, brand);
}

/** Handler `GET /leaderboard/{YYYY}/arquivo/{AAMMDD|YYMM-MM}` — página de
 * voto de 1 edição arquivada. 404 se a edição não pertence ao ano da URL, ou
 * se ainda não tem gabarito fechado (nunca foi publicada / poll não fechado).
 *
 * #4419: `edition` aceita os 2 formatos (`isValidVoteEditionFormat`, não mais
 * só `AAMMDD_RE`) — a listagem (`handleLeaderboardArchive`) agora gera hrefs
 * em formato de ciclo (`YYMM-MM`) pra brand com leaderboard anual.
 */
export async function handleArchiveVotePage(
  yearStr: string,
  edition: string,
  env: Env,
  brand: Brand = "diaria",
): Promise<Response> {
  if (
    !/^\d{4}$/.test(yearStr) ||
    !isValidVoteEditionFormat(edition) ||
    edition.slice(0, 2) !== yearStr.slice(2) ||
    // #4435 (achado pr-test-analyzer do review pré-merge do #4419, espelha o
    // guard de escrita #4157 em handleAdminCorrect/index.ts): `isValidVoteEditionFormat`
    // só valida FORMATO (AAMMDD|ciclo), nunca FORMATO×MARCA — sem este guard,
    // um `edition` em formato de ciclo (`YYMM-MM`, #4419) é aceito por
    // QUALQUER brand, mesmo os com `leaderboardPeriod !== "year"` (hoje:
    // diaria/web), que não têm noção de ciclo mensal. Verificado ao vivo pelo
    // revisor: `handleArchiveVotePage("2026", "2605-06", env, "diaria")`
    // respondia 200, renderizando a página de voto com branding "diar.ia.br" mas
    // descrevendo "leaderboard anual" (que a diaria não tem — o período dela
    // é "month"). O caminho inverso (AAMMDD pra brand anual — marcador
    // legado, ver `legacyMonthlyEditionForCycle`) continua aceito de
    // propósito, só o de ciclo-pra-brand-mensal é bloqueado aqui.
    (CYCLE_EDITION_RE.test(edition) && BRAND_INFO[brand].leaderboardPeriod !== "year")
  ) {
    return new Response(votePageHtml("Link inválido.", false, null, null, null, brand), {
      status: 404, headers: { "Content-Type": "text/html;charset=utf-8" }
    });
  }
  // #4419: um ciclo mensal pode ter o gabarito gravado sob a chave NOVA
  // (`correct:{ciclo}`) OU a chave LEGADA (`correct:{AAMMDD}`, pré-#2115
  // cutover) — checa as duas antes de decidir "sem gabarito ainda" (mesmo
  // racional de `extractMonthlyEditionsForYear` acima). AAMMDD genuíno
  // (diária) não tem marcador equivalente — `legacyMarker` fica `null`.
  //
  // #4435 (achado silent-failure-hunter do review pré-merge do #4419, MEDIUM,
  // risco residual ACEITO — mesma colisão já nomeada em `scripts/close-poll.ts`,
  // comentário do #2006, e documentada em detalhe no docblock de
  // `extractMonthlyEditionsForYear` acima): `correct:{legacyMarker}` é
  // sintaticamente INDISTINGUÍVEL de uma edição DIÁRIA real publicada no
  // mesmo dia — `correctRaw` abaixo trata "existe valor sob essa chave" como
  // prova de que o gabarito do CICLO fechou, sem confirmar que quem escreveu
  // foi de fato um `close-poll.ts --brand clarice`. Bounded: só ciclos
  // legados pré-cutover têm essa ambiguidade.
  const legacyMarker = CYCLE_EDITION_RE.test(edition) ? legacyMonthlyEditionForCycle(edition) : null;
  const correctRaw =
    (await env.POLL.get(`correct:${edition}`)) ??
    (legacyMarker !== null ? await env.POLL.get(`correct:${legacyMarker}`) : null);
  // #3113 (item 9): "edição futura" só é um conceito coerente pra AAMMDD (dia
  // real de calendário) — sem ela, a página de voto do arquivo continuaria
  // acessível via URL direta (mesmo AAMMDD, adivinhado ou incrementado a
  // partir de uma edição já pública) mesmo depois da LISTA parar de mostrar a
  // edição futura. Um ciclo `YYMM-MM` (#4419) não representa um dia — a
  // intersecção com `correct:` (linhas acima) já é o gate real de "já
  // aconteceu" pra esse formato. Mesma mensagem do "sem gabarito" em ambos os
  // casos — o assinante não precisa saber o motivo específico.
  const isFutureAammdd = AAMMDD_RE.test(edition) && edition > todayAammddBrt(new Date());
  if (!correctRaw || isFutureAammdd) {
    return new Response(
      votePageHtml("Essa edição não está disponível para votação retroativa.", false, null, null, null, brand),
      { status: 404, headers: { "Content-Type": "text/html;charset=utf-8" } },
    );
  }
  return renderArchiveVoteHtml(edition, yearStr, brand);
}
