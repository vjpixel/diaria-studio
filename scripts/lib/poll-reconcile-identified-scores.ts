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
 *     do gate, #4054). `correct` é reavaliado por `/admin/correct`.
 *   - `identify-linked:{email}:{anon}`: o par vinculado. Gravado a cada merge
 *     desde a #3996 (sem TTL). É a única prova de vínculo e-mail↔anônimo.
 *   - `score:{anon}` e `score-by-month:{M}:{anon}`: o score anônimo, nunca
 *     apagado pelo merge.
 *
 * ## Reconstrução
 *   esperado(score:{email})            = votos diretos do e-mail
 *                                        + Σ score:{anon} de cada anônimo vinculado, UMA vez
 *   esperado(score-by-month:{M}:{email}) = votos diretos do e-mail no mês M
 *                                        + Σ score-by-month:{M}:{anon}
 *   marcador identify-migrated:{email}:{anon}         = {total, correct} de score:{anon}
 *   marcador identify-migrated-month:{M}:{email}:{anon} = {total, correct} de score-by-month:{M}:{anon},
 *     só quando `score-by-month:{M}:{email}` já existe (sem a entrada mensal do
 *     e-mail, o mês nunca foi migrado; sem marcador, o próximo sync migra uma vez).
 *
 * ## Limites (o que NÃO é reconstruível) e o teto seguro
 *   1. Par vinculado ANTES da #3996 que nunca mais sincronizou não tem
 *      `identify-linked`: os pontos dele no e-mail são indistinguíveis de
 *      inflação. E-mail sem nenhum vínculo registrado e sem voto direto fica
 *      `sem-fonte` e NÃO é tocado. E-mail com vínculo registrado e também um
 *      par antigo sem registro perderia os pontos do par antigo: é o risco
 *      residual, aceito porque o sync roda a cada rodada (todo jogador que
 *      voltou a jogar depois da #3996 tem o par registrado).
 *   2. A reconciliação NUNCA sobe um valor: aplica `min(atual, reconstruído)`
 *      campo a campo (o teto é a soma dos votos registrados). Reconstruído
 *      acima do atual (merge de mês que nunca rodou, espelho do DO
 *      ScoreCounter que sobrescreveu um merge) entra no relatório como
 *      `abaixo-do-reconstruido` e fica como está.
 *   3. O DO ScoreCounter (`web:{email}`) guarda cópia própria do score de quem
 *      vota direto; o próximo voto direto regrava o KV a partir dela. Por isso
 *      o `--apply` purga o DO dos e-mails com voto direto que mudaram (o DO
 *      volta a semear do KV já corrigido). Ver `needsDoPurge`.
 *   4. Campos que não são contador (`streak`, `last_edition`, `nickname`,
 *      `last_vote_ts`) ficam como estão.
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
  | "ok" // atual == reconstruído
  | "inflado" // atual > reconstruído: reduz
  | "abaixo-do-reconstruido" // atual < reconstruído: fica (nunca sobe)
  | "misto" // um campo/mês reduz e outro está abaixo
  | "sem-fonte"; // sem vínculo registrado e sem voto direto: não tocado

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
  needsDoPurge: boolean;
}

export type WriteKind = "score" | "score-by-month" | "identify-migrated" | "identify-migrated-month";

export interface PlannedWrite {
  key: string;
  kind: WriteKind;
  /** valor atual (null = chave ausente) — vai para o backup antes de gravar. */
  old: string | null;
  new: string;
}

export interface ReconcileReport {
  issue: 14222;
  emails: EmailLine[];
  writes: PlannedWrite[];
  /** e-mails cujo DO ScoreCounter precisa de purge depois da escrita. */
  doPurgeEmails: string[];
  /** meses cujo `leaderboard-snapshot:{M}` invalidar depois da escrita. */
  snapshotMonths: string[];
  totals: {
    identifiedEmails: number;
    affectedEmails: number;
    semFonteEmails: number;
    abaixoEmails: number;
    pointsTotalToRemove: number;
    pointsCorrectToRemove: number;
    monthPointsTotalToRemove: number;
    monthPointsCorrectToRemove: number;
    missingMarkers: number;
    scoreWrites: number;
    monthWrites: number;
  };
  /** sha256 do plano de escrita canônico — exigido por `--apply`. */
  hash: string;
}

/** Leitura do KV já carregado (chaves SEM o prefixo `web:`). */
export type KvView = ReadonlyMap<string, string>;

function parseJson<T>(raw: string | undefined | null): T | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

function countsOf(raw: string | undefined | null): Counts | null {
  const o = parseJson<{ total?: unknown; correct?: unknown }>(raw);
  if (!o) return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return { total: n(o.total), correct: n(o.correct) };
}

const add = (a: Counts, b: Counts): Counts => ({ total: a.total + b.total, correct: a.correct + b.correct });
const ZERO: Counts = { total: 0, correct: 0 };

function capped(current: Counts, reconstructed: Counts): Counts {
  const total = Math.min(current.total, reconstructed.total);
  const correct = Math.min(current.correct, reconstructed.correct, total);
  return { total, correct };
}

const eq = (a: Counts, b: Counts) => a.total === b.total && a.correct === b.correct;

/** `{prefix}{a}:{b}` com `b` sem `:` (identidade anônima) → [a, b]. */
function splitLast(rest: string): [string, string] | null {
  const i = rest.lastIndexOf(":");
  if (i <= 0 || i === rest.length - 1) return null;
  return [rest.slice(0, i), rest.slice(i + 1)];
}

/** `{prefix}{a}:{b}` com `a` sem `:` (edição, mês) → [a, b]. */
function splitFirst(rest: string): [string, string] | null {
  const i = rest.indexOf(":");
  if (i <= 0 || i === rest.length - 1) return null;
  return [rest.slice(0, i), rest.slice(i + 1)];
}

function withCounts(raw: string, c: Counts): string {
  const o = parseJson<Record<string, unknown>>(raw) ?? {};
  return JSON.stringify({ ...o, total: c.total, correct: c.correct });
}

const markerValue = (c: Counts) => JSON.stringify({ total: c.total, correct: c.correct });

export function identifyMigratedKey(email: string, anon: string, month?: string): string {
  // Mesmo formato de `identifyMigratedKey` em workers/poll/src/identify.ts.
  return month ? `identify-migrated-month:${month}:${email}:${anon}` : `identify-migrated:${email}:${anon}`;
}

/** sha256 do plano de escrita, em ordem de chave: muda se o KV mudou. */
export function planHash(writes: readonly PlannedWrite[]): string {
  const canon = [...writes]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((w) => [w.key, w.old, w.new]);
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
}

export function reconcileIdentifiedScores(kv: KvView): ReconcileReport {
  // Índices sobre as chaves carregadas.
  const linked = new Map<string, Set<string>>(); // email -> anons
  const ownVotes = new Map<string, { all: Counts; byMonth: Map<string, Counts>; n: number }>();
  const monthKeysByIdentity = new Map<string, Set<string>>(); // identity -> months
  const identifiedEmails: string[] = [];

  for (const [key, raw] of kv) {
    if (key.startsWith("identify-linked:")) {
      const p = splitLast(key.slice("identify-linked:".length));
      if (!p) continue;
      const [email, anon] = p;
      if (!linked.has(email)) linked.set(email, new Set());
      linked.get(email)!.add(anon);
    } else if (key.startsWith("vote:")) {
      const p = splitFirst(key.slice("vote:".length));
      if (!p) continue;
      const [edition, identity] = p;
      if (isAnonymousWebIdentity(identity)) continue;
      const v = parseJson<{ correct?: unknown }>(raw);
      if (!v) continue;
      const c: Counts = { total: 1, correct: v.correct === true ? 1 : 0 };
      const cur = ownVotes.get(identity) ?? { all: ZERO, byMonth: new Map(), n: 0 };
      cur.all = add(cur.all, c);
      cur.n += 1;
      const m = editionToMonthSlug(edition);
      if (m) cur.byMonth.set(m, add(cur.byMonth.get(m) ?? ZERO, c));
      ownVotes.set(identity, cur);
    } else if (key.startsWith("score-by-month:")) {
      const p = splitFirst(key.slice("score-by-month:".length));
      if (!p) continue;
      const [month, identity] = p;
      if (!monthKeysByIdentity.has(identity)) monthKeysByIdentity.set(identity, new Set());
      monthKeysByIdentity.get(identity)!.add(month);
    } else if (key.startsWith("score:")) {
      const identity = key.slice("score:".length);
      if (identity && !isAnonymousWebIdentity(identity)) identifiedEmails.push(identity);
    }
  }
  identifiedEmails.sort();

  const emails: EmailLine[] = [];
  const writes: PlannedWrite[] = [];
  const doPurgeEmails: string[] = [];
  const snapshotMonths = new Set<string>();

  for (const email of identifiedEmails) {
    const scoreKey = `score:${email}`;
    const scoreRaw = kv.get(scoreKey)!;
    const current = countsOf(scoreRaw) ?? ZERO;
    const anons = [...(linked.get(email) ?? [])].sort();
    const own = ownVotes.get(email);

    // Meses que existem para o e-mail.
    const emailMonths = [...(monthKeysByIdentity.get(email) ?? [])].sort();

    if (anons.length === 0 && !own) {
      emails.push({
        email, status: "sem-fonte", linkedAnons: 0, ownVotes: 0,
        current, reconstructed: current, expected: current, diffTotal: 0, diffCorrect: 0,
        months: [], missingMarkers: 0, needsDoPurge: false,
      });
      continue;
    }

    let reconstructed = own?.all ?? ZERO;
    for (const a of anons) reconstructed = add(reconstructed, countsOf(kv.get(`score:${a}`)) ?? ZERO);
    const expected = capped(current, reconstructed);
    let reduced = !eq(expected, current);
    let below = reconstructed.total > current.total || reconstructed.correct > current.correct;

    if (reduced) writes.push({ key: scoreKey, kind: "score", old: scoreRaw, new: withCounts(scoreRaw, expected) });

    const months: MonthLine[] = [];
    for (const m of emailMonths) {
      const mKey = `score-by-month:${m}:${email}`;
      const mRaw = kv.get(mKey)!;
      const mCur = countsOf(mRaw) ?? ZERO;
      let mRec = own?.byMonth.get(m) ?? ZERO;
      for (const a of anons) mRec = add(mRec, countsOf(kv.get(`score-by-month:${m}:${a}`)) ?? ZERO);
      const mExp = capped(mCur, mRec);
      months.push({ month: m, current: mCur, reconstructed: mRec, expected: mExp });
      if (!eq(mExp, mCur)) {
        reduced = true;
        writes.push({ key: mKey, kind: "score-by-month", old: mRaw, new: withCounts(mRaw, mExp) });
        snapshotMonths.add(m);
      }
      if (mRec.total > mCur.total || mRec.correct > mCur.correct) below = true;
    }

    // Marcadores que o worker (#14225) lê no próximo sync.
    let missingMarkers = 0;
    const emailMonthSet = new Set(emailMonths);
    for (const a of anons) {
      const aScore = countsOf(kv.get(`score:${a}`));
      if (aScore) {
        const k = identifyMigratedKey(email, a);
        const want = markerValue(aScore);
        const have = kv.get(k) ?? null;
        if (have === null || !eq(countsOf(have) ?? { total: -1, correct: -1 }, aScore)) {
          missingMarkers += 1;
          writes.push({ key: k, kind: "identify-migrated", old: have, new: want });
        }
      }
      for (const m of [...(monthKeysByIdentity.get(a) ?? [])].sort()) {
        if (!emailMonthSet.has(m)) continue;
        const aMonth = countsOf(kv.get(`score-by-month:${m}:${a}`));
        if (!aMonth) continue;
        const k = identifyMigratedKey(email, a, m);
        const want = markerValue(aMonth);
        const have = kv.get(k) ?? null;
        if (have === null || !eq(countsOf(have) ?? { total: -1, correct: -1 }, aMonth)) {
          missingMarkers += 1;
          writes.push({ key: k, kind: "identify-migrated-month", old: have, new: want });
        }
      }
    }

    const status: ReconcileStatus = reduced && below ? "misto" : reduced ? "inflado" : below ? "abaixo-do-reconstruido" : "ok";
    const needsDoPurge = reduced && !!own;
    if (needsDoPurge) doPurgeEmails.push(email);
    emails.push({
      email, status, linkedAnons: anons.length, ownVotes: own?.n ?? 0,
      current, reconstructed, expected,
      diffTotal: current.total - expected.total, diffCorrect: current.correct - expected.correct,
      months, missingMarkers, needsDoPurge,
    });
  }

  const sum = (f: (e: EmailLine) => number) => emails.reduce((s, e) => s + f(e), 0);
  const monthSum = (f: (m: MonthLine) => number) => sum((e) => e.months.reduce((s, m) => s + f(m), 0));
  return {
    issue: 14222,
    emails,
    writes,
    doPurgeEmails,
    snapshotMonths: [...snapshotMonths].sort(),
    totals: {
      identifiedEmails: emails.length,
      affectedEmails: emails.filter((e) => e.status === "inflado" || e.status === "misto").length,
      semFonteEmails: emails.filter((e) => e.status === "sem-fonte").length,
      abaixoEmails: emails.filter((e) => e.status === "abaixo-do-reconstruido" || e.status === "misto").length,
      pointsTotalToRemove: sum((e) => e.diffTotal),
      pointsCorrectToRemove: sum((e) => e.diffCorrect),
      monthPointsTotalToRemove: monthSum((m) => m.current.total - m.expected.total),
      monthPointsCorrectToRemove: monthSum((m) => m.current.correct - m.expected.correct),
      missingMarkers: sum((e) => e.missingMarkers),
      scoreWrites: writes.filter((w) => w.kind === "score").length,
      monthWrites: writes.filter((w) => w.kind === "score-by-month").length,
    },
    hash: planHash(writes),
  };
}

/**
 * Quais chaves o script precisa ler, dado o nome de todas as chaves das
 * famílias listadas: tudo de `score:`/`identify-linked:`/`identify-migrated*`
 * de e-mails, `vote:` só dos e-mails reais, e score/score-by-month só dos
 * anônimos vinculados (evita ler milhares de chaves de anônimos soltos).
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

/** Relatório sem e-mails (para o terminal): identidade vira `#n`. */
export function redactReport(r: ReconcileReport): Omit<ReconcileReport, "emails" | "writes" | "doPurgeEmails"> & {
  topDiffs: Array<{ rank: number; status: ReconcileStatus; current: number; expected: number; diffTotal: number; linkedAnons: number; ownVotes: number }>;
  doPurgeCount: number;
  writeCount: number;
} {
  const top = [...r.emails]
    .filter((e) => e.diffTotal > 0)
    .sort((a, b) => b.diffTotal - a.diffTotal)
    .slice(0, 10)
    .map((e, i) => ({ rank: i + 1, status: e.status, current: e.current.total, expected: e.expected.total, diffTotal: e.diffTotal, linkedAnons: e.linkedAnons, ownVotes: e.ownVotes }));
  return {
    issue: r.issue,
    snapshotMonths: r.snapshotMonths,
    totals: r.totals,
    hash: r.hash,
    topDiffs: top,
    doPurgeCount: r.doPurgeEmails.length,
    writeCount: r.writes.length,
  };
}
