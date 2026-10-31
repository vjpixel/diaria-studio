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
import { dirname, join } from "node:path";

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
 * Remove a trava só se for desta sessão (ou com `force`). Com `completedStage`
 * (aprovação normal do stage, #11690) regrava o arquivo como tombstone em vez
 * de apagar — ver `released_at`. Sem trava legível e com `completedStage`,
 * grava o tombstone mesmo assim (resultado segue `not_held`).
 */
export function releaseEditionLock(
  editionDir: string,
  opts: { sessionId: string; force?: boolean; completedStage?: number; now?: number; host?: string },
): EditionLockReleaseResult {
  const existing = readEditionLock(editionDir);
  const p = editionLockPath(editionDir);
  const tombstone = (base: EditionLockRecord | null): void => {
    const nowIso = new Date(opts.now ?? Date.now()).toISOString();
    const rec: EditionLockRecord = {
      session_id: base?.session_id || opts.sessionId,
      host: opts.host ?? hostname(),
      stage: opts.completedStage as number,
      acquired_at: base?.acquired_at ?? nowIso,
      heartbeat_at: nowIso,
      released_at: nowIso,
      completed_stage: opts.completedStage,
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
  if (wantsTombstone) tombstone(existing);
  else unlinkSync(p);
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
