/**
 * leaderboard-purge-state.ts (#11311)
 *
 * Estado da purga de votos do editor no leaderboard do "É IA?" (§6h do Stage
 * 6), gravado em `{edition_dir}/_internal/leaderboard-purge.json`.
 *
 * Por que existe: o PR #11310 (#11253) fez o Resumo final do Stage 6 mostrar
 * `⚠ Purga de votos do editor: PENDENTE — {motivo}` quando o pré-check ou o
 * `--execute` falham, mas só em prosa do playbook — o coordenador precisava
 * lembrar de carregar o motivo até o resumo. Agora quem grava é o próprio
 * `scripts/purge-leaderboard.ts` (com `--edition-dir`), e quem monta a linha do
 * resumo é este módulo (`--summary`). Arquivo AUSENTE também vira PENDENTE: é
 * o caso "o §6h nem rodou".
 *
 * Ciclo de um §6h:
 *   1. `purge-leaderboard.ts --check-auth --edition-dir D` → `applyCheckAuth`
 *      ZERA o estado (rodada nova) e grava o resultado do pré-check. Grava
 *      "pendente" ANTES de checar, então um timeout/kill no meio deixa PENDENTE.
 *   2. `purge-leaderboard.ts --email X --execute --edition-dir D` (2×) →
 *      `applyEmailResult` faz upsert do resultado daquele e-mail (de novo:
 *      "não concluiu" antes, resultado real depois).
 *   3. Resumo final: `npx tsx scripts/lib/leaderboard-purge-state.ts
 *      --edition-dir D --summary` imprime a linha obrigatória.
 *
 * `status` gravado no arquivo é derivado na escrita; o leitor recalcula com
 * `derivePurgeStatus` (fonte da verdade), então um arquivo editado à mão ou
 * gravado por versão antiga não engana o resumo.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule, parseArgs } from "./cli-args.ts";

export const LEADERBOARD_PURGE_STATE_RELPATH = "_internal/leaderboard-purge.json";

/** As 2 contas do editor que o §6h purga (mesmas do playbook e de `/diaria-remover-votos-pixel`). */
export const EDITOR_PURGE_EMAILS: readonly string[] = ["pixel@memelab.com.br", "vjpixel@gmail.com"];

export const PURGE_RETRY_HINT = "rodar /diaria-remover-votos-pixel";

export interface PurgeCheckAuthRecord {
  ok: boolean;
  backend: string | null;
  motivo: string | null;
  at: string;
}

export interface PurgeEmailRecord {
  ok: boolean;
  /** Keys apagadas no KV (`0` quando não havia nada). `null` = não concluiu. */
  keys_deleted: number | null;
  motivo: string | null;
  at: string;
}

export interface LeaderboardPurgeState {
  status: "ok" | "pendente";
  backend: string | null;
  motivo: string | null;
  at: string;
  /** Soma das keys apagadas nos e-mails concluídos. */
  keys_deleted: number;
  check_auth: PurgeCheckAuthRecord | null;
  emails: Record<string, PurgeEmailRecord>;
}

export function derivePurgeStatus(
  state: Pick<LeaderboardPurgeState, "check_auth" | "emails">,
  expectedEmails: readonly string[] = EDITOR_PURGE_EMAILS,
): { status: "ok" | "pendente"; motivo: string | null } {
  const ca = state.check_auth;
  if (!ca) return { status: "pendente", motivo: "pré-check --check-auth não registrado" };
  if (!ca.ok) return { status: "pendente", motivo: ca.motivo ?? "pré-check --check-auth falhou" };
  const problems: string[] = [];
  for (const email of expectedEmails) {
    const r = state.emails[email];
    if (!r) problems.push(`purga de ${email} não registrada`);
    else if (!r.ok) problems.push(`${email}: ${r.motivo ?? "falhou"}`);
  }
  if (problems.length > 0) return { status: "pendente", motivo: problems.join("; ") };
  return { status: "ok", motivo: null };
}

function finalize(
  base: Omit<LeaderboardPurgeState, "status" | "motivo" | "keys_deleted" | "backend">,
): LeaderboardPurgeState {
  const { status, motivo } = derivePurgeStatus(base);
  const keys = Object.values(base.emails).reduce((sum, r) => sum + (r.ok && r.keys_deleted ? r.keys_deleted : 0), 0);
  return {
    status,
    backend: base.check_auth?.backend ?? null,
    motivo,
    at: base.at,
    keys_deleted: keys,
    check_auth: base.check_auth,
    emails: base.emails,
  };
}

/** Pré-check: começa uma rodada nova (descarta e-mails de rodadas anteriores). */
export function applyCheckAuth(
  result: { ok: boolean; backend: string | null; motivo: string | null },
  now: Date,
): LeaderboardPurgeState {
  const at = now.toISOString();
  return finalize({ at, check_auth: { ...result, at }, emails: {} });
}

/** Upsert do resultado da purga de um e-mail sobre o estado da rodada. */
export function applyEmailResult(
  prev: LeaderboardPurgeState | null,
  email: string,
  result: { ok: boolean; keys_deleted: number | null; motivo: string | null },
  now: Date,
): LeaderboardPurgeState {
  const at = now.toISOString();
  return finalize({
    at,
    check_auth: prev?.check_auth ?? null,
    emails: { ...(prev?.emails ?? {}), [email.toLowerCase()]: { ...result, at } },
  });
}

export type PurgeStateRead =
  | { kind: "absent" }
  | { kind: "invalid"; error: string }
  | { kind: "ok"; state: LeaderboardPurgeState };

function statePath(editionDir: string): string {
  return resolve(editionDir, LEADERBOARD_PURGE_STATE_RELPATH);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Fail-soft: nunca lança. Ausente e ilegível são distinguidos (os dois viram PENDENTE no resumo). */
export function readLeaderboardPurgeState(editionDir: string): PurgeStateRead {
  const p = statePath(editionDir);
  let raw: string;
  try {
    if (!existsSync(p)) return { kind: "absent" };
    raw = readFileSync(p, "utf8");
  } catch (e) {
    return { kind: "invalid", error: (e as Error).message };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.emails)) {
      return { kind: "invalid", error: "shape inesperado (sem objeto `emails`)" };
    }
    return { kind: "ok", state: parsed as unknown as LeaderboardPurgeState };
  } catch (e) {
    return { kind: "invalid", error: `JSON inválido: ${(e as Error).message}` };
  }
}

/** Escrita atômica (tmp + rename). Propaga erro de FS — quem chama decide se é fail-soft. */
export function writeLeaderboardPurgeState(editionDir: string, state: LeaderboardPurgeState): void {
  const p = statePath(editionDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
}

/** Lê o estado atual só pra fazer upsert: ausente/ilegível → `null` (rodada sem pré-check registrado). */
export function readStateForUpsert(editionDir: string): LeaderboardPurgeState | null {
  const r = readLeaderboardPurgeState(editionDir);
  return r.kind === "ok" ? r.state : null;
}

/** Linha OBRIGATÓRIA do Resumo final do Stage 6. Ausente/ilegível/pendente → `⚠ ... PENDENTE`. */
export function formatPurgeSummaryLine(read: PurgeStateRead): string {
  if (read.kind === "absent") {
    return `⚠ Purga de votos do editor: PENDENTE — o §6h não gravou ${LEADERBOARD_PURGE_STATE_RELPATH} (${PURGE_RETRY_HINT})`;
  }
  if (read.kind === "invalid") {
    return `⚠ Purga de votos do editor: PENDENTE — ${LEADERBOARD_PURGE_STATE_RELPATH} ilegível: ${read.error} (${PURGE_RETRY_HINT})`;
  }
  const { status, motivo } = derivePurgeStatus(read.state);
  if (status === "pendente") {
    return `⚠ Purga de votos do editor: PENDENTE — ${motivo} (${PURGE_RETRY_HINT})`;
  }
  const keys = Object.values(read.state.emails).reduce((s, r) => s + (r.ok && r.keys_deleted ? r.keys_deleted : 0), 0);
  const backend = read.state.check_auth?.backend ?? "backend desconhecido";
  return `Purga de votos do editor: ${keys} keys apagadas (${backend})`;
}

// CLI:
//   npx tsx scripts/lib/leaderboard-purge-state.ts --edition-dir <dir> --summary
// Imprime a linha do Resumo final. Sempre exit 0 com --summary (a linha É o
// sinal; o Stage 6 nunca bloqueia por causa da purga). Exit 1 = uso errado.
if (isMainModule(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  const editionDir = parsed.values["edition-dir"];
  if (!editionDir || !parsed.flags.has("summary")) {
    console.error("uso: leaderboard-purge-state.ts --edition-dir <dir> --summary");
    process.exit(1);
  }
  console.log(formatPurgeSummaryLine(readLeaderboardPurgeState(editionDir)));
}
