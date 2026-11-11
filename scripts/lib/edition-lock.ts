/**
 * edition-lock.ts (#10309) — trava por edição entre sessões do Claude Code.
 *
 * Achado na edição 261016: o gate do Stage 4 rodou em duas sessões ao mesmo
 * tempo (a original e um fork). As duas editaram `02-reviewed.md`/`03-social.md`,
 * republicaram os Artifacts e re-selaram o humanizador; nada no pipeline acusou
 * que outra sessão estava no mesmo `{EDITION_DIR}`.
 *
 * Mecanismo: um arquivo `{EDITION_DIR}/_internal/edition-lock.json` com o
 * `session_id` de quem detém a edição e um `heartbeat_at` renovado a cada
 * `acquire` da própria sessão. Outra sessão que chame `acquire` enquanto o
 * heartbeat está dentro do TTL recebe `held_by_other` (CLI: exit 3) e o
 * playbook para antes de escrever qualquer arquivo da edição.
 *
 * Identidade = `session_id` do harness, injetado em `--session-id` pelo hook
 * `.claude/hooks/inject-session-id.mjs` (a sessão rodando não conhece o
 * próprio id, ver docblock do hook). Um fork de sessão (`--fork-session`,
 * `/branch`) ganha `session_id` novo, que é o caso do achado. Limite honesto:
 * um subagente dentro da MESMA sessão compartilha o `session_id` do pai e não
 * é distinguido por esta trava (não é o caso da issue; o gate não roda em
 * subagente).
 *
 * Por que arquivo na edição e não `data/sessions/` (session-registry): a
 * trava é sobre UM diretório de edição, e o registro de sessões é indexado
 * por sessão/kind (overnight/develop/continuo/interactive), com GC e janelas
 * de liveness próprias. Um arquivo ao lado dos outputs da edição é lido por
 * quem já está naquele diretório, some junto com ele, e não precisa de kind
 * novo no registry (6.9k linhas, consumidores externos — ver CLAUDE.md sobre
 * o kind `continuo`).
 *
 * TTL: o heartbeat vence em `EDITION_LOCK_TTL_MS` (45 min). Sessão que morreu
 * sem `release` libera a edição sozinha depois disso (`took_stale`). Se a
 * sessão original só estava ociosa e outra pegou a trava vencida, o próximo
 * `acquire` da original devolve `held_by_other` — o conflito aparece nos dois
 * sentidos, no primeiro passo de escrita de cada uma.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type D1Client, d1AcquireLock, d1FallbackWarning, d1ReleaseLock, editionLockD1Name } from "./d1-locks.ts";

export const EDITION_LOCK_TTL_MS = 45 * 60 * 1000;
export const EDITION_LOCK_FILE = "edition-lock.json";

export interface EditionLockRecord {
  session_id: string;
  host: string;
  stage: number;
  acquired_at: string;
  heartbeat_at: string;
  /**
   * Tombstone de conclusão (#11690): o release de uma aprovação NORMAL não
   * apaga o arquivo, regrava-o com estes campos. Apagar deixava "sem trava e
   * sem sentinel" indistinguível de "nunca rodou" quando o sync da remoção
   * chegava antes do `.step-N-done.json`. Como é o MESMO arquivo, o sync
   * entrega o tombstone no lugar da trava, nunca um vazio. Para `acquire`
   * conta como ausente; só o `stale-edition-guard` o lê.
   */
  released_at?: string;
  completed_stage?: number;
  /**
   * Tombstone de release SIMPLES (#11713): `editar`, `abortar` e halt do gate
   * soltam a trava sem concluir o stage. Até o #11713 esse release apagava o
   * arquivo, e a remoção podia sincronizar antes do `02-reviewed.md` editado:
   * no outro host o guard via "sem trava e sem sentinel" e dava ok. Agora o
   * release regrava o arquivo com o stage que estava em andamento aqui. Para
   * `acquire` conta como ausente (igual ao de conclusão); o guard o lê como
   * "stage em andamento em outro host" por `INTERRUPTED_TOMBSTONE_WINDOW_MS`.
   */
  interrupted_stage?: number;
}

export type EditionLockAction =
  /** Não havia trava: esta sessão passa a deter a edição. */
  | "acquired"
  /** A trava já era desta sessão: heartbeat renovado. */
  | "refreshed"
  /** Havia trava de outra sessão, vencida (heartbeat > TTL): assumida. */
  | "took_stale"
  /** Havia trava viva de outra sessão e `force` foi passado: assumida. */
  | "taken_over"
  /**
   * Trava vencida mas de OUTRO host (#11690): heartbeat velho pode ser só
   * `data/` defasado (OneDrive) — o outro host pode estar à frente. Nada
   * gravado; `force` assume.
   */
  | "stale_other_host"
  /** Trava viva de outra sessão, sem `force`: nada gravado. */
  | "held_by_other";

export interface EditionLockDecision {
  action: EditionLockAction;
  /** Registro a gravar (ausente em `held_by_other`). */
  record?: EditionLockRecord;
  /** Detentor anterior, quando havia trava de outra sessão. */
  previous?: EditionLockRecord;
  /** Idade do heartbeat do detentor anterior, em ms. */
  previous_age_ms?: number;
}

export function editionLockPath(editionDir: string): string {
  return join(editionDir, "_internal", EDITION_LOCK_FILE);
}

function isRecord(v: unknown): v is EditionLockRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.session_id === "string" && r.session_id !== "" && typeof r.heartbeat_at === "string";
}

/**
 * Decisão pura (sem I/O). `existing` corrompido/ilegível chega aqui como
 * `null` — tratado como ausente: uma trava que ninguém consegue ler não pode
 * bloquear a edição para sempre.
 */
export function decideEditionLock(
  existing: EditionLockRecord | null,
  opts: { sessionId: string; stage: number; now: number; host?: string; force?: boolean; ttlMs?: number },
): EditionLockDecision {
  const ttl = opts.ttlMs ?? EDITION_LOCK_TTL_MS;
  const nowIso = new Date(opts.now).toISOString();
  const host = opts.host ?? hostname();
  const fresh = (acquiredAt: string): EditionLockRecord => ({
    session_id: opts.sessionId,
    host,
    stage: opts.stage,
    acquired_at: acquiredAt,
    heartbeat_at: nowIso,
  });

  if (!existing || existing.released_at) return { action: "acquired", record: fresh(nowIso) };
  if (existing.session_id === opts.sessionId) {
    return { action: "refreshed", record: fresh(existing.acquired_at || nowIso) };
  }
  const hb = Date.parse(existing.heartbeat_at);
  // Heartbeat ilegível conta como vencido; heartbeat no futuro (relógio
  // adiantado de outra máquina) conta como vivo — erra pro lado de avisar.
  const age = Number.isFinite(hb) ? opts.now - hb : Number.POSITIVE_INFINITY;
  const base = { previous: existing, previous_age_ms: age };
  if (age > ttl) {
    // Host ausente/ilegível conta como OUTRO host (fail-closed, #11690).
    if (existing.host !== host && !opts.force) return { action: "stale_other_host", ...base };
    return { action: "took_stale", record: fresh(nowIso), ...base };
  }
  if (opts.force) return { action: "taken_over", record: fresh(nowIso), ...base };
  return { action: "held_by_other", ...base };
}

export function readEditionLock(editionDir: string): EditionLockRecord | null {
  const p = editionLockPath(editionDir);
  if (!existsSync(p)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!isRecord(parsed)) return null;
    // host/stage malformados não derrubam a leitura (a trava segue valendo),
    // mas viram "" / NaN pra o guard tratá-los como desconhecidos, não como
    // ausentes (#11690: antes um host não-string fazia o guard ignorar a trava).
    const r = parsed as unknown as Record<string, unknown>;
    return {
      ...parsed,
      host: typeof r.host === "string" ? r.host : "",
      stage: typeof r.stage === "number" && Number.isFinite(r.stage) ? r.stage : Number.NaN,
      completed_stage:
        typeof r.completed_stage === "number" && Number.isFinite(r.completed_stage) ? r.completed_stage : undefined,
      released_at: typeof r.released_at === "string" ? r.released_at : undefined,
      // Presente mas ilegível vira NaN (o guard trata como "à frente", fail-closed).
      interrupted_stage:
        r.interrupted_stage === undefined
          ? undefined
          : typeof r.interrupted_stage === "number" && Number.isFinite(r.interrupted_stage)
            ? r.interrupted_stage
            : Number.NaN,
    };
  } catch {
    return null;
  }
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export function acquireEditionLock(
  editionDir: string,
  opts: { sessionId: string; stage: number; now?: number; force?: boolean; ttlMs?: number; host?: string },
): EditionLockDecision {
  const decision = decideEditionLock(readEditionLock(editionDir), { ...opts, now: opts.now ?? Date.now() });
  if (decision.record) writeAtomic(editionLockPath(editionDir), JSON.stringify(decision.record, null, 2) + "\n");
  return decision;
}

/**
 * Arquivo de trava existe mas não é legível (JSON truncado pelo sync, sem
 * `session_id`/`heartbeat_at`). `readEditionLock` devolve `null` nesse caso —
 * o `acquire` o trata como ausente —, mas o stale-edition-guard precisa
 * distinguir "ausente" de "ilegível" (#11690, fail-closed).
 */
export function editionLockUnreadable(editionDir: string): boolean {
  return existsSync(editionLockPath(editionDir)) && readEditionLock(editionDir) === null;
}

export type EditionLockReleaseResult = "released" | "not_held" | "held_by_other";

/**
 * Solta a trava só se for desta sessão (ou com `force`). Nunca apaga uma trava
 * detida: regrava o arquivo como tombstone (ver `released_at`). Com
 * `completedStage` (aprovação normal do stage, #11690) o tombstone é de
 * conclusão; sem ele (`editar`, `abortar`, halt — #11713) é de interrupção,
 * com `interrupted_stage` = stage da trava. Sem trava legível e com
 * `completedStage`, grava o tombstone de conclusão mesmo assim (resultado
 * segue `not_held`); sem trava e sem `completedStage`, limpa o arquivo
 * (corrompido ou tombstone do próprio host).
 */
export function releaseEditionLock(
  editionDir: string,
  opts: { sessionId: string; force?: boolean; completedStage?: number; now?: number; host?: string },
): EditionLockReleaseResult {
  const existing = readEditionLock(editionDir);
  const p = editionLockPath(editionDir);
  const tombstone = (base: EditionLockRecord | null): void => {
    const nowIso = new Date(opts.now ?? Date.now()).toISOString();
    const completed = Number.isInteger(opts.completedStage);
    const rec: EditionLockRecord = {
      session_id: base?.session_id || opts.sessionId,
      host: opts.host ?? hostname(),
      stage: completed ? (opts.completedStage as number) : (base?.stage ?? Number.NaN),
      acquired_at: base?.acquired_at ?? nowIso,
      heartbeat_at: nowIso,
      released_at: nowIso,
      ...(completed ? { completed_stage: opts.completedStage } : { interrupted_stage: base?.stage ?? Number.NaN }),
    };
    writeAtomic(p, JSON.stringify(rec, null, 2) + "\n");
  };
  const wantsTombstone = Number.isInteger(opts.completedStage);
  if (existing?.released_at && !wantsTombstone && existing.host !== (opts.host ?? hostname())) {
    // Tombstone de OUTRO host: sinal de que a edição foi aprovada lá; apagá-lo
    // reabriria o clobber (#11690). Só release com completedStage (ou o próprio host) mexe nele.
    return "not_held";
  }
  if (!existing || existing.released_at) {
    if (wantsTombstone) tombstone(null);
    else if (existsSync(p)) unlinkSync(p); // corrompido ou tombstone antigo: limpar
    return "not_held";
  }
  if (existing.session_id !== opts.sessionId && !opts.force) return "held_by_other";
  // Release simples também regrava (tombstone de interrupção, #11713): apagar
  // deixava o outro host sem sinal nenhum se a remoção sincronizasse antes
  // dos arquivos editados.
  tombstone(existing);
  return "released";
}

/** Idade legível: `NaN`/Infinity → "ilegível"; negativa → relógio adiantado; sem arredondar pra 0. */
export function formatLockAge(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "ilegível";
  if (ms < 0) return "no futuro (relógio adiantado de outra máquina)";
  if (ms < 60_000) return "há menos de 1 min";
  if (ms < 2 * 3_600_000) return `há ${Math.floor(ms / 60_000)} min`;
  return `há ${Math.floor(ms / 3_600_000)} h`;
}

// ─── #12842: a mesma trava no D1, que exclui ENTRE máquinas ─────────────────
//
// O arquivo `{EDITION_DIR}/_internal/edition-lock.json` viaja pelo sync de
// `data/`: duas máquinas podem ver "livre" ao mesmo tempo. Com o D1
// provisionado (`scripts/lib/d1-locks.ts`), `acquire`/`release` consultam o
// lock `edition:{AAMMDD}` primeiro: holder vivo de outra sessão no D1 recusa
// já ali (`held_by_other`, sem tocar o arquivo). Se o D1 concede, a decisão do
// arquivo continua valendo (stale_other_host, tombstones, máquina no código
// antigo) e, se ela recusar, o lock recém-tomado no D1 é devolvido. D1 sem
// resposta: só o arquivo, com aviso (`d1Warning`), nunca bloqueia.

export interface EditionLockD1Info {
  /** `"d1"` = o D1 respondeu; `"local-fallback"` = não respondeu; `"local"` = sem D1. */
  backend: "d1" | "local" | "local-fallback";
  /** Holder vivo no D1 quando a recusa veio de lá. */
  d1Holder?: string;
  d1Warning?: string;
}

export function editionNameFromDir(editionDir: string): string {
  return basename(resolve(editionDir));
}

export async function acquireEditionLockShared(
  editionDir: string,
  opts: { sessionId: string; stage: number; now?: number; force?: boolean; ttlMs?: number; host?: string },
  d1: D1Client | null,
  d1Now?: number,
): Promise<EditionLockDecision & EditionLockD1Info> {
  const ttl = opts.ttlMs ?? EDITION_LOCK_TTL_MS;
  if (!d1) return { ...acquireEditionLock(editionDir, opts), backend: "local" };
  const name = editionLockD1Name(editionNameFromDir(editionDir));
  const d1Opts = d1Now !== undefined ? { now: d1Now } : {};
  const r = await d1AcquireLock(d1, name, opts.sessionId, ttl, {
    reentrant: true,
    force: Boolean(opts.force),
    meta: JSON.stringify({ host: opts.host ?? hostname(), stage: opts.stage }),
    ...d1Opts,
  });
  if (!r.ok) {
    return { ...acquireEditionLock(editionDir, opts), backend: "local-fallback", d1Warning: d1FallbackWarning("edition-lock acquire", r.error) };
  }
  if (!r.value.acquired) {
    const cur = r.value.current;
    const nowMs = opts.now ?? Date.now();
    const meta = await readD1Meta(d1, name);
    const previous: EditionLockRecord = {
      session_id: cur?.holder ?? "(desconhecida)",
      host: typeof meta.host === "string" ? meta.host : "(D1)",
      stage: typeof meta.stage === "number" ? meta.stage : Number.NaN,
      acquired_at: cur ? new Date(cur.acquiredAt).toISOString() : "",
      heartbeat_at: cur ? new Date(cur.expiresAt - ttl).toISOString() : "",
    };
    return {
      action: "held_by_other",
      previous,
      previous_age_ms: cur ? nowMs - (cur.expiresAt - ttl) : undefined,
      backend: "d1",
      ...(cur ? { d1Holder: cur.holder } : {}),
    };
  }
  const decision = acquireEditionLock(editionDir, opts);
  if (!decision.record && !r.value.refreshed) {
    // O arquivo recusou: devolve o lock que acabamos de tomar no D1.
    await d1ReleaseLock(d1, name, opts.sessionId, d1Opts);
  }
  return { ...decision, backend: "d1" };
}

async function readD1Meta(d1: D1Client, name: string): Promise<Record<string, unknown>> {
  try {
    const { results } = await d1.query("SELECT meta FROM locks WHERE name = ?1", [name]);
    const raw = results[0]?.meta;
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function releaseEditionLockShared(
  editionDir: string,
  opts: { sessionId: string; force?: boolean; completedStage?: number; now?: number; host?: string },
  d1: D1Client | null,
  d1Now?: number,
): Promise<{ result: EditionLockReleaseResult } & EditionLockD1Info> {
  if (!d1) return { result: releaseEditionLock(editionDir, opts), backend: "local" };
  const name = editionLockD1Name(editionNameFromDir(editionDir));
  const r = await d1ReleaseLock(d1, name, opts.sessionId, {
    force: Boolean(opts.force),
    ...(d1Now !== undefined ? { now: d1Now } : {}),
  });
  if (!r.ok) {
    return {
      result: releaseEditionLock(editionDir, opts),
      backend: "local-fallback",
      d1Warning: d1FallbackWarning("edition-lock release", r.error),
    };
  }
  // Outra sessão viva segura a edição no D1: não mexe no arquivo.
  if (r.value === "held_by_other") return { result: "held_by_other", backend: "d1" };
  return { result: releaseEditionLock(editionDir, opts), backend: "d1" };
}
