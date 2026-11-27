/**
 * scripts/lib/poll-reconcile-identified-scores.ts (#14222)
 *
 * Lógica PURA da reconciliação dos scores do É IA? (`/jogar`, brand `web`)
 * inflados pelo re-sync silencioso de `/jogar/identify`. Antes da #14225,
 * `performIdentifyMerge` (workers/poll/src/identify.ts) somava o score
 * anônimo INTEIRO em `score:{email}` e em `score-by-month:{M}:{email}` a cada
 * `sync()` do cliente (1, 3, 6, 10 em vez de 1, 2, 3, 4). A #14225 passou a
 * somar só o delta, com os marcadores `identify-migrated:{email}:{anon}` e
 * `identify-migrated-month:{M}:{email}:{anon}`; esta lib calcula o valor que
 * as chaves deveriam ter e os marcadores que faltam. Quem lê e grava o KV é
 * `scripts/poll-reconcile-identified-scores.ts`.
 *
 * ## Fontes de verdade (todas no namespace `web:` do KV POLL; aqui sem o prefixo)
 *   - `vote:{edition}:{identity}` = `{ choice, ts, correct }`, sem TTL: um por
 *     voto. Para um e-mail real, são os votos DIRETOS (identidade da sessão
 *     do gate, #4054). `correct` é reavaliado por `/admin/correct`. Voto com
 *     edição sem mês válido conta no global e não no mensal, como no Worker
 *     (`updateScoreByMonth` pula slug nulo).
 *   - `identify-linked:{email}:{anon}`: o par vinculado. Gravado a cada merge
 *     desde a #3996 (sem TTL). É a única prova de vínculo e-mail↔anônimo.
 *   - `score:{anon}` e `score-by-month:{M}:{anon}`: o score anônimo, nunca
 *     apagado pelo merge.
 *
 * ## Reconstrução (o "teto" de cada campo é o valor reconstruído)
 *   reconstruído(score:{email})              = votos diretos do e-mail
 *                                              + Σ score:{anon} de cada anônimo vinculado, UMA vez
 *   reconstruído(score-by-month:{M}:{email}) = votos diretos do e-mail no mês M
 *                                              + Σ score-by-month:{M}:{anon}
 *   esperado = min(atual, reconstruído), campo a campo (nunca sobe um valor).
 *   Marcador `identify-migrated*` = a parte do anônimo que o score (já
 *   reduzido) contém: `anônimo − (reconstruído − esperado)`, ≥ 0, campo a
 *   campo, por escopo (global e cada mês). O Worker soma `anônimo − marcador`
 *   no próximo sync, então o que falta ainda entra (e-mail 2, anônimo 5 ⇒
 *   marcador 2, o sync soma 3). Com vários anônimos num escopo abaixo do
 *   reconstruído a divisão é ambígua: nada é gravado e o marcador existente
 *   fica (listado em `ambiguousMarkers`). E-mail não reduzido nunca tem
 *   marcador existente sobrescrito (`markerConflicts`). Mês só recebe
 *   marcador com prova de que o Worker migrou aquele anônimo naquele mês (ver
 *   o laço mensal). Mês sem `score-by-month:{M}:{email}` nunca foi migrado:
 *   sem marcador, o próximo sync migra uma vez.
 *
 * ## Fonte incompleta nunca reduz
 *   Chave listada que não voltou na leitura, JSON ilegível, contador
 *   não-numérico/negativo/não-inteiro em `score:*`/`score-by-month:*`,
 *   `vote:*` que não é objeto, marcador ilegível, anônimo vinculado sem
 *   `score:{anon}` ou sufixo de `identify-linked` que não é identidade
 *   anônima: a chave entra em `unreadableKeys` e todo e-mail que depende dela
 *   fica `fonte-ilegivel`, sem nenhuma escrita (nem score nem marcador).
 *
 * ## Limites (o que NÃO é reconstruível)
 *   1. Pontos de par vinculado ANTES da #3996 que nunca mais sincronizou: o
 *      par não tem `identify-linked`, e esses pontos são indistinguíveis de
 *      inflação. Daí:
 *        - e-mail sem vínculo e sem voto direto → `sem-fonte`, intocado;
 *        - e-mail sem vínculo e COM voto direto → `so-votos-diretos`, intocado
 *          e marcado para conferência manual (o bug só infla via merge, e todo
 *          merge desde a #3996 grava o vínculo; excesso aqui só pode vir de
 *          par antigo, legítimo ou não);
 *        - e-mail com vínculo registrado E um par antigo sem registro perderia
 *          os pontos do par antigo. Risco residual aceito: o sync roda a cada
 *          rodada, então quem jogou depois da #3996 tem o par registrado. E-mail
 *          com voto direto que é reduzido sai com `conferenciaManual`.
 *   2. Reconstruído acima do atual (merge de mês que nunca rodou, espelho do
 *      DO ScoreCounter que sobrescreveu um merge) fica como está:
 *      `abaixo-do-reconstruido` (ou `misto`, se outro escopo reduz).
 *   3. O DO ScoreCounter (`web:{email}`) guarda cópia própria do score de quem
 *      vota direto; o próximo voto direto regrava o KV a partir dela. Por isso
 *      o `--apply` purga o DO dos e-mails com voto direto que mudaram (o DO
 *      volta a semear do KV já corrigido). Ver `needsDoPurge`.
 *   4. Campos que não são contador (`streak`, `last_edition`, `nickname`,
 *      `last_vote_ts`) ficam como estão.
 *   5. Cache: o único cache em KV do ranking é `leaderboard-snapshot:{M}`
 *      (TTL 24h); o anual/arquivo é montado desses snapshots mensais
 *      (workers/poll/src/leaderboard-routes.ts). As páginas têm Cache-Control
 *      HTTP de até 5 min, que não dá para invalidar daqui.
 */
import { createHash } from "node:crypto";

// Cópias locais de `isAnonymousWebIdentity`/`editionToMonthSlug`
// (workers/poll/src/lib.ts): scripts/ não importa código de Worker (#13994,
// test/lib-boundary.test.ts regra 7). Paridade travada em
// test/poll-reconcile-identified-scores-14222.test.ts.
const WEB_TOKEN_DOMAIN = "web.eia.diaria.local";

export function isAnonymousWebIdentity(email: string): boolean {
  const at = email.indexOf("@");
  if (at < 0) return false;
  return email.slice(at + 1).toLowerCase() === WEB_TOKEN_DOMAIN;
}

export function editionToMonthSlug(edition: string): string | null {
  if (!/^\d{4}-\d{2}$/.test(edition) && !/^\d{6}$/.test(edition)) return null;
  const mm = parseInt(edition.slice(2, 4), 10);
  if (mm < 1 || mm > 12) return null;
  return `20${edition.slice(0, 2)}-${edition.slice(2, 4)}`;
}

export interface Counts {
  total: number;
  correct: number;
}

export type ReconcileStatus =
  | "ok" // nada a gravar
  | "so-marcadores" // score certo; só faltam marcadores
  | "inflado" // atual > reconstruído: reduz
  | "abaixo-do-reconstruido" // atual < reconstruído: fica (nunca sobe)
  | "misto" // algum escopo/campo reduz e outro está abaixo
  | "sem-fonte" // sem vínculo registrado e sem voto direto: não tocado
  | "so-votos-diretos" // sem vínculo, com voto direto: não tocado, conferência manual
  | "fonte-ilegivel"; // depende de chave ausente/ilegível: não tocado

export type UnreadableReason = "ausente" | "json-ilegivel" | "contador-invalido" | "identidade-invalida" | "score-anonimo-ausente";

export interface UnreadableKey {
  key: string;
  reason: UnreadableReason;
}

export interface MonthLine {
  month: string;
  current: Counts;
  reconstructed: Counts;
  expected: Counts;
}

export interface EmailLine {
  email: string;
  status: ReconcileStatus;
  linkedAnons: number;
  ownVotes: number;
  current: Counts;
  reconstructed: Counts;
  expected: Counts;
  /** current.total - expected.total (pontos de "total" a remover). */
  diffTotal: number;
  diffCorrect: number;
  months: MonthLine[];
  missingMarkers: number;
  /** Marcadores que não dá para calcular (vários anônimos num escopo abaixo do reconstruído): o existente fica. */
  ambiguousMarkers: string[];
  /** Marcador existente diferente do calculado num e-mail NÃO reduzido: não sobrescrito. */
  markerConflicts: string[];
  needsDoPurge: boolean;
  /** Redução com voto direto, ou só votos diretos: conferir à mão. */
  conferenciaManual: boolean;
}

export type WriteKind = "score" | "score-by-month" | "identify-migrated" | "identify-migrated-month";

export interface PlannedWrite {
  key: string;
  kind: WriteKind;
  /** e-mail a que a escrita pertence (para o purge do DO após gravar `score:`). */
  email: string;
  /** valor atual (null = chave ausente) — vai para o backup antes de gravar. */
  old: string | null;
  new: string;
}

export interface ReconcileReport {
  issue: 14222;
  emails: EmailLine[];
  writes: PlannedWrite[];
  unreadableKeys: UnreadableKey[];
  /** e-mails cujo DO ScoreCounter precisa de purge depois da escrita. */
  doPurgeEmails: string[];
  /** meses cujo `leaderboard-snapshot:{M}` invalidar depois da escrita. */
  snapshotMonths: string[];
  totals: {
    identifiedEmails: number;
    affectedEmails: number;
    semFonteEmails: number;
    soVotosDiretosEmails: number;
    fonteIlegivelEmails: number;
    soMarcadoresEmails: number;
    abaixoEmails: number;
    conferenciaManualEmails: number;
    unreadableKeys: number;
    missingKeys: number;
    pointsTotalToRemove: number;
    pointsCorrectToRemove: number;
    monthPointsTotalToRemove: number;
    monthPointsCorrectToRemove: number;
    missingMarkers: number;
    ambiguousMarkers: number;
    markerConflicts: number;
    scoreWrites: number;
    monthWrites: number;
  };
  /** 16 hex do sha256 das escritas planejadas (chave, antigo, novo) — exigido por `--apply`. */
  hash: string;
}

/** Leitura do KV já carregada (chaves SEM o prefixo `web:`). */
export type KvView = ReadonlyMap<string, string>;

export interface ReconcileOptions {
  /** Chaves listadas no KV: as que não estiverem em `kv` são `ausente`. */
  listedKeys?: Iterable<string>;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: UnreadableReason };

function parseObject(raw: string): Parsed<Record<string, unknown>> {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "json-ilegivel" };
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "json-ilegivel" };
  }
}

const isCount = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;

function parseCounts(raw: string): Parsed<Counts> {
  const o = parseObject(raw);
  if (!o.ok) return o;
  const { total, correct } = o.value;
  if (!isCount(total) || !isCount(correct)) return { ok: false, reason: "contador-invalido" };
  return { ok: true, value: { total, correct } };
}

const add = (a: Counts, b: Counts): Counts => ({ total: a.total + b.total, correct: a.correct + b.correct });
const ZERO: Counts = { total: 0, correct: 0 };
const eq = (a: Counts, b: Counts) => a.total === b.total && a.correct === b.correct;
const covers = (cur: Counts, rec: Counts) => cur.total >= rec.total && cur.correct >= rec.correct;

function capped(current: Counts, reconstructed: Counts): Counts {
  const total = Math.min(current.total, reconstructed.total);
  const correct = Math.min(current.correct, reconstructed.correct, total);
  return { total, correct };
}

/** `{a}:{b}` com `b` sem `:` (identidade anônima) → [a, b]. */
function splitLast(rest: string): [string, string] | null {
  const i = rest.lastIndexOf(":");
  if (i <= 0 || i === rest.length - 1) return null;
  return [rest.slice(0, i), rest.slice(i + 1)];
}

/** `{a}:{b}` com `a` sem `:` (edição, mês) → [a, b]. */
function splitFirst(rest: string): [string, string] | null {
  const i = rest.indexOf(":");
  if (i <= 0 || i === rest.length - 1) return null;
  return [rest.slice(0, i), rest.slice(i + 1)];
}

function withCounts(raw: string, c: Counts): string {
  const o = parseObject(raw);
  return JSON.stringify({ ...(o.ok ? o.value : {}), total: c.total, correct: c.correct });
}

const markerValue = (c: Counts) => JSON.stringify({ total: c.total, correct: c.correct });

export function identifyMigratedKey(email: string, anon: string, month?: string): string {
  // Mesmo formato de `identifyMigratedKey` em workers/poll/src/identify.ts.
  return month ? `identify-migrated-month:${month}:${email}:${anon}` : `identify-migrated:${email}:${anon}`;
}

/** 16 hex do sha256 das escritas planejadas, em ordem de chave: muda se o KV mudou. */
export function planHash(writes: readonly PlannedWrite[]): string {
  const canon = [...writes]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((w) => [w.key, w.old, w.new]);
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
}

export function reconcileIdentifiedScores(kv: KvView, opts: ReconcileOptions = {}): ReconcileReport {
  const bad = new Map<string, UnreadableReason>();
  for (const k of opts.listedKeys ?? []) if (!kv.has(k)) bad.set(k, "ausente");

  const counts = new Map<string, Counts>(); // score:* e score-by-month:* válidos
  const linked = new Map<string, Set<string>>(); // email -> anons
  const linkedKeys = new Map<string, string[]>(); // email -> chaves identify-linked (para dependência)
  const ownVotes = new Map<string, { all: Counts; byMonth: Map<string, Counts>; n: number; keys: string[] }>();
  const monthKeysByIdentity = new Map<string, Set<string>>();
  const markers = new Map<string, Counts>();
  const identifiedEmails = new Set<string>();

  const allKeys = new Set<string>([...kv.keys(), ...bad.keys()]);
  for (const key of allKeys) {
    const raw = kv.get(key);
    if (key.startsWith("identify-linked:")) {
      const p = splitLast(key.slice("identify-linked:".length));
      if (!p) continue;
      const [email, anon] = p;
      if (!linkedKeys.has(email)) linkedKeys.set(email, []);
      linkedKeys.get(email)!.push(key);
      if (!isAnonymousWebIdentity(anon)) {
        bad.set(key, "identidade-invalida");
        continue;
      }
      if (!linked.has(email)) linked.set(email, new Set());
      linked.get(email)!.add(anon);
    } else if (key.startsWith("identify-migrated")) {
      if (raw === undefined) continue;
      const c = parseCounts(raw);
      if (c.ok) markers.set(key, c.value);
      else bad.set(key, c.reason);
    } else if (key.startsWith("vote:")) {
      const p = splitFirst(key.slice("vote:".length));
      if (!p) continue;
      const [edition, identity] = p;
      if (isAnonymousWebIdentity(identity)) continue;
      const cur = ownVotes.get(identity) ?? { all: ZERO, byMonth: new Map<string, Counts>(), n: 0, keys: [] as string[] };
      cur.keys.push(key);
      ownVotes.set(identity, cur);
      if (raw === undefined) continue;
      const v = parseObject(raw);
      if (!v.ok) {
        bad.set(key, v.reason);
        continue;
      }
      const c: Counts = { total: 1, correct: v.value.correct === true ? 1 : 0 };
      cur.all = add(cur.all, c);
      cur.n += 1;
      const m = editionToMonthSlug(edition);
      if (m) cur.byMonth.set(m, add(cur.byMonth.get(m) ?? ZERO, c));
    } else if (key.startsWith("score-by-month:")) {
      const p = splitFirst(key.slice("score-by-month:".length));
      if (!p) continue;
      const [month, identity] = p;
      if (!monthKeysByIdentity.has(identity)) monthKeysByIdentity.set(identity, new Set());
      monthKeysByIdentity.get(identity)!.add(month);
      if (raw === undefined) continue;
      const c = parseCounts(raw);
      if (c.ok) counts.set(key, c.value);
      else bad.set(key, c.reason);
    } else if (key.startsWith("score:")) {
      const identity = key.slice("score:".length);
      if (identity && !isAnonymousWebIdentity(identity)) identifiedEmails.add(identity);
      if (raw === undefined) continue;
      const c = parseCounts(raw);
      if (c.ok) counts.set(key, c.value);
      else bad.set(key, c.reason);
    }
  }

  const emails: EmailLine[] = [];
  const writes: PlannedWrite[] = [];
  const doPurgeEmails: string[] = [];
  const snapshotMonths = new Set<string>();

  for (const email of [...identifiedEmails].sort()) {
    const scoreKey = `score:${email}`;
    const anons = [...(linked.get(email) ?? [])].sort();
    const own = ownVotes.get(email);
    const emailMonths = [...(monthKeysByIdentity.get(email) ?? [])].sort();

    // Dependências: qualquer chave ruim (ou score anônimo ausente) → intocado.
    const deps: string[] = [scoreKey, ...emailMonths.map((m) => `score-by-month:${m}:${email}`), ...(own?.keys ?? []), ...(linkedKeys.get(email) ?? [])];
    for (const a of anons) {
      const aKey = `score:${a}`;
      if (!counts.has(aKey) && !bad.has(aKey)) bad.set(aKey, "score-anonimo-ausente");
      deps.push(aKey, identifyMigratedKey(email, a));
      for (const m of monthKeysByIdentity.get(a) ?? []) deps.push(`score-by-month:${m}:${a}`, identifyMigratedKey(email, a, m));
    }
    const base = {
      email, linkedAnons: anons.length, ownVotes: own?.n ?? 0, months: [] as MonthLine[], missingMarkers: 0,
      ambiguousMarkers: [] as string[], markerConflicts: [] as string[], needsDoPurge: false,
    };
    const current = counts.get(scoreKey) ?? ZERO;
    const untouched = (status: ReconcileStatus, conferenciaManual = false): EmailLine => ({
      ...base, status, current, reconstructed: current, expected: current, diffTotal: 0, diffCorrect: 0, conferenciaManual,
    });

    if (deps.some((k) => bad.has(k))) {
      emails.push(untouched("fonte-ilegivel"));
      continue;
    }
    if (anons.length === 0) {
      emails.push(own ? untouched("so-votos-diretos", true) : untouched("sem-fonte"));
      continue;
    }

    const scoreRaw = kv.get(scoreKey)!;
    let reconstructed = own?.all ?? ZERO;
    for (const a of anons) reconstructed = add(reconstructed, counts.get(`score:${a}`)!);
    const expected = capped(current, reconstructed);
    let reduced = !eq(expected, current);
    let below = !covers(current, reconstructed);
    const scoreWrites: PlannedWrite[] = [];
    if (reduced) scoreWrites.push({ key: scoreKey, kind: "score", email, old: scoreRaw, new: withCounts(scoreRaw, expected) });

    const months: MonthLine[] = [];
    const monthScopes: Array<{ m: string; cur: Counts; own: Counts; rec: Counts; exp: Counts }> = [];
    for (const m of emailMonths) {
      const mKey = `score-by-month:${m}:${email}`;
      const mRaw = kv.get(mKey)!;
      const mCur = counts.get(mKey)!;
      const mOwn = own?.byMonth.get(m) ?? ZERO;
      let mRec = mOwn;
      for (const a of anons) mRec = add(mRec, counts.get(`score-by-month:${m}:${a}`) ?? ZERO);
      const mExp = capped(mCur, mRec);
      months.push({ month: m, current: mCur, reconstructed: mRec, expected: mExp });
      monthScopes.push({ m, cur: mCur, own: mOwn, rec: mRec, exp: mExp });
      if (!eq(mExp, mCur)) {
        reduced = true;
        scoreWrites.push({ key: mKey, kind: "score-by-month", email, old: mRaw, new: withCounts(mRaw, mExp) });
        snapshotMonths.add(m);
      }
      if (!covers(mCur, mRec)) below = true;
    }

    // Marcadores (#14225). O Worker soma `anônimo − marcador` no próximo sync,
    // então o marcador certo é a parte do anônimo que o score (já reduzido)
    // contém: `anônimo − (reconstruído − esperado)`, ≥ 0, campo a campo. Com
    // um anônimo no escopo a divisão é exata; com vários, só quando nada falta
    // (cada marcador = anônimo inteiro). Senão: ambíguo, o existente fica.
    // E-mail NÃO reduzido nunca tem marcador existente sobrescrito.
    let missingMarkers = 0;
    const ambiguousMarkers: string[] = [];
    const markerConflicts: string[] = [];
    const markerWrites: PlannedWrite[] = [];
    const wantMarker = (k: string, value: Counts, kind: WriteKind) => {
      const have = markers.get(k);
      if (have && eq(have, value)) return;
      if (have && !reduced) {
        markerConflicts.push(k);
        return;
      }
      missingMarkers += 1;
      markerWrites.push({ key: k, kind, email, old: kv.get(k) ?? null, new: markerValue(value) });
    };
    const present = (anon: Counts, rec: Counts, exp: Counts): Counts => ({
      total: Math.max(0, anon.total - (rec.total - exp.total)),
      correct: Math.max(0, anon.correct - (rec.correct - exp.correct)),
    });
    // Escopo global: todo anônimo vinculado foi migrado ao menos uma vez.
    if (anons.length === 1) {
      const a = anons[0];
      wantMarker(identifyMigratedKey(email, a), present(counts.get(`score:${a}`)!, reconstructed, expected), "identify-migrated");
    } else if (covers(current, reconstructed)) {
      for (const a of anons) wantMarker(identifyMigratedKey(email, a), counts.get(`score:${a}`)!, "identify-migrated");
    } else {
      for (const a of anons) ambiguousMarkers.push(identifyMigratedKey(email, a));
    }
    // Escopo mensal: o Worker só migra o mês da edição que o cliente manda no
    // sync (`performIdentifyMerge`), então o mês M conta como migrado de um
    // anônimo só com prova: marcador mensal existente, ou (anônimo único no
    // mês) a entrada do e-mail acima dos votos diretos dele no mês.
    for (const s of monthScopes) {
      const withMonth = anons.filter((a) => counts.has(`score-by-month:${s.m}:${a}`));
      if (withMonth.length === 0) continue;
      const anonM = (a: string) => counts.get(`score-by-month:${s.m}:${a}`)!;
      if (withMonth.length === 1) {
        const a = withMonth[0];
        const k = identifyMigratedKey(email, a, s.m);
        const migrated = markers.has(k) || s.cur.total > s.own.total || s.cur.correct > s.own.correct;
        if (migrated) wantMarker(k, present(anonM(a), s.rec, s.exp), "identify-migrated-month");
      } else if (covers(s.cur, s.rec)) {
        for (const a of withMonth) wantMarker(identifyMigratedKey(email, a, s.m), anonM(a), "identify-migrated-month");
      } else {
        for (const a of withMonth) ambiguousMarkers.push(identifyMigratedKey(email, a, s.m));
      }
    }
    // Ordem de gravação por e-mail: marcadores, depois score e mensal.
    writes.push(...markerWrites, ...scoreWrites);

    const status: ReconcileStatus = reduced && below ? "misto" : reduced ? "inflado" : below ? "abaixo-do-reconstruido" : missingMarkers > 0 ? "so-marcadores" : "ok";
    // Purga do DO planejada SEMPRE para quem vota direto (idempotente: o DO
    // volta a semear do KV); cobre também uma aplicação anterior que gravou o
    // KV e não purgou.
    const needsDoPurge = !!own;
    if (needsDoPurge) doPurgeEmails.push(email);
    emails.push({
      ...base, status, current, reconstructed, expected,
      diffTotal: current.total - expected.total, diffCorrect: current.correct - expected.correct,
      months, missingMarkers, ambiguousMarkers, markerConflicts, needsDoPurge, conferenciaManual: reduced && !!own,
    });
  }

  const sum = (f: (e: EmailLine) => number) => emails.reduce((s, e) => s + f(e), 0);
  const monthSum = (f: (m: MonthLine) => number) => sum((e) => e.months.reduce((s, m) => s + f(m), 0));
  const count = (...st: ReconcileStatus[]) => emails.filter((e) => st.includes(e.status)).length;
  const unreadableKeys = [...bad].map(([key, reason]) => ({ key, reason })).sort((a, b) => (a.key < b.key ? -1 : 1));
  return {
    issue: 14222,
    emails,
    writes,
    unreadableKeys,
    doPurgeEmails,
    snapshotMonths: [...snapshotMonths].sort(),
    totals: {
      identifiedEmails: emails.length,
      affectedEmails: count("inflado", "misto"),
      semFonteEmails: count("sem-fonte"),
      soVotosDiretosEmails: count("so-votos-diretos"),
      fonteIlegivelEmails: count("fonte-ilegivel"),
      soMarcadoresEmails: count("so-marcadores"),
      abaixoEmails: count("abaixo-do-reconstruido", "misto"),
      conferenciaManualEmails: emails.filter((e) => e.conferenciaManual).length,
      unreadableKeys: unreadableKeys.length,
      missingKeys: unreadableKeys.filter((u) => u.reason === "ausente").length,
      pointsTotalToRemove: sum((e) => e.diffTotal),
      pointsCorrectToRemove: sum((e) => e.diffCorrect),
      monthPointsTotalToRemove: monthSum((m) => m.current.total - m.expected.total),
      monthPointsCorrectToRemove: monthSum((m) => m.current.correct - m.expected.correct),
      missingMarkers: sum((e) => e.missingMarkers),
      ambiguousMarkers: sum((e) => e.ambiguousMarkers.length),
      markerConflicts: sum((e) => e.markerConflicts.length),
      scoreWrites: writes.filter((w) => w.kind === "score").length,
      monthWrites: writes.filter((w) => w.kind === "score-by-month").length,
    },
    hash: planHash(writes),
  };
}

/**
 * Das chaves listadas, as que a reconciliação precisa LER: tudo de
 * `identify-linked:`/`identify-migrated*`; `score:`/`score-by-month:` de
 * e-mails reais e dos anônimos vinculados; `vote:` só de e-mails reais.
 * Deixa de fora os anônimos soltos (a maioria das chaves). O mesmo conjunto
 * vai como `listedKeys` para `reconcileIdentifiedScores` detectar o que não
 * voltou na leitura.
 */
export function selectKeysToRead(names: readonly string[]): string[] {
  const linkedAnons = new Set<string>();
  const identified = new Set<string>();
  for (const k of names) {
    if (k.startsWith("identify-linked:")) {
      const p = splitLast(k.slice("identify-linked:".length));
      if (p) linkedAnons.add(p[1]);
    } else if (k.startsWith("score:")) {
      const id = k.slice("score:".length);
      if (id && !isAnonymousWebIdentity(id)) identified.add(id);
    }
  }
  const out: string[] = [];
  for (const k of names) {
    if (k.startsWith("identify-linked:") || k.startsWith("identify-migrated")) out.push(k);
    else if (k.startsWith("score:")) {
      const id = k.slice("score:".length);
      if (identified.has(id) || linkedAnons.has(id)) out.push(k);
    } else if (k.startsWith("score-by-month:")) {
      const p = splitFirst(k.slice("score-by-month:".length));
      if (p && (identified.has(p[1]) || linkedAnons.has(p[1]))) out.push(k);
    } else if (k.startsWith("vote:")) {
      const p = splitFirst(k.slice("vote:".length));
      if (p && identified.has(p[1])) out.push(k);
    }
  }
  return out;
}

/** Famílias de chave (sem o prefixo do brand) que o script lista. */
export const RECONCILE_KEY_PREFIXES = ["score:", "score-by-month:", "identify-linked:", "identify-migrated", "vote:"] as const;

/** Relatório sem e-mails nem chaves (para o terminal): o e-mail vira `rank` na lista de maiores diferenças. */
export function redactReport(r: ReconcileReport) {
  const top = [...r.emails]
    .filter((e) => e.diffTotal > 0)
    .sort((a, b) => b.diffTotal - a.diffTotal)
    .slice(0, 10)
    .map((e, i) => ({
      rank: i + 1, status: e.status, current: e.current.total, expected: e.expected.total, diffTotal: e.diffTotal,
      linkedAnons: e.linkedAnons, ownVotes: e.ownVotes, conferenciaManual: e.conferenciaManual,
    }));
  const unreadableByReason: Record<string, number> = {};
  for (const u of r.unreadableKeys) unreadableByReason[u.reason] = (unreadableByReason[u.reason] ?? 0) + 1;
  return {
    issue: r.issue,
    snapshotMonths: r.snapshotMonths,
    totals: r.totals,
    unreadableByReason,
    hash: r.hash,
    topDiffs: top,
    doPurgeCount: r.doPurgeEmails.length,
    writeCount: r.writes.length,
  };
}
