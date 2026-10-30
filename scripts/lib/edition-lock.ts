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

  if (!existing) return { action: "acquired", record: fresh(nowIso) };
  if (existing.session_id === opts.sessionId) {
    return { action: "refreshed", record: fresh(existing.acquired_at || nowIso) };
  }
  const hb = Date.parse(existing.heartbeat_at);
  // Heartbeat ilegível conta como vencido; heartbeat no futuro (relógio
  // adiantado de outra máquina) conta como vivo — erra pro lado de avisar.
  const age = Number.isFinite(hb) ? opts.now - hb : Number.POSITIVE_INFINITY;
  const base = { previous: existing, previous_age_ms: age };
  if (age > ttl) {
    if (existing.host && existing.host !== host && !opts.force) return { action: "stale_other_host", ...base };
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
    return isRecord(parsed) ? parsed : null;
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

export type EditionLockReleaseResult = "released" | "not_held" | "held_by_other";

/** Remove a trava só se for desta sessão (ou com `force`). */
export function releaseEditionLock(
  editionDir: string,
  opts: { sessionId: string; force?: boolean },
): EditionLockReleaseResult {
  const existing = readEditionLock(editionDir);
  const p = editionLockPath(editionDir);
  if (!existing) {
    if (existsSync(p)) unlinkSync(p); // arquivo corrompido: limpar
    return "not_held";
  }
  if (existing.session_id !== opts.sessionId && !opts.force) return "held_by_other";
  unlinkSync(p);
  return "released";
}
