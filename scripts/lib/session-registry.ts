#!/usr/bin/env npx tsx
/**
 * scripts/lib/session-registry.ts (#5156)
 *
 * Registro compartilhado e leve de sessões `/diaria-overnight`/`/diaria-develop`
 * ATIVAS — mecanismo pedido pela "Direção sugerida" do #5156, que audita 11
 * colisões concretas entre as duas skills rodando em paralelo (mesma máquina ou
 * máquinas diferentes sincronizadas pelo mesmo junction OneDrive `data/`).
 *
 * Um arquivo por sessão viva: `data/sessions/{kind}-{machineTag}-{sessionId}.json`.
 * `sessionId` é o `session_id` que o harness do Claude Code injeta no payload de
 * TODO hook `PreToolUse`/`PostToolUse` (confirmado contra a doc oficial,
 * `code.claude.com/docs/en/hooks`, ao desenhar este PR) — nunca exposto
 * diretamente à sessão rodando (não há env var `CLAUDE_SESSION_ID`, também
 * confirmado contra a doc). Por isso a ESCRITA deste registro nunca é feita
 * pelo coordenador "sabendo" o próprio session_id: o coordenador chama este CLI
 * SEM `--session-id`, e `.claude/hooks/inject-session-id.mjs` (novo, PreToolUse
 * sobre `Bash`) injeta `--session-id {payload.session_id}` no comando ANTES da
 * execução (`updatedInput.command`) — o mesmo mecanismo, aplicado também a
 * `scripts/overnight-session-marker.ts --start`/`--phase` (ver docblock de lá).
 *
 * **Coexistência deliberada com `data/overnight/.active-session-{tag}.json`
 * (item 10 do #5156):** o marker antigo, por-máquina, especializado no guard
 * de `AskUserQuestion` (#4450) e no desconto de effort do `/code-review`
 * (#3322), CONTINUA existindo e sendo escrito/lido exatamente como antes —
 * ver `scripts/overnight-session-marker.ts` e os dois hooks que o consomem.
 * Migrar esses dois mecanismos pra dentro deste registro foi avaliado e
 * descartado: a rodada `/diaria-overnight` que estava genuinamente ativa em
 * OUTRA máquina (`predator`) no momento em que este PR foi escrito usa o
 * formato antigo (sem `session_id`) — qualquer migração que exigisse reescrever
 * esse marker quebraria a rodada em voo. Este registro é aditivo: cobre os
 * itens 3/4/6/7/9 do #5156 (claim de issue, merge lock, teto de concorrência,
 * herança de plano em voo, cleanup de worktree), que não têm mecanismo prévio
 * nenhum — não substitui nada que já funcionava.
 *
 * **Staleness:** mesma janela de 24h usada por `isOvernightRoundActive`
 * (`pr-create-review.mjs`) e `shouldBlockAskUserQuestion`
 * (`block-askuserquestion-overnight-autonomous.mjs`) — uma rodada
 * crashada/abandonada não deve aparecer como "ativa" pra sempre.
 * `listActiveSessions` filtra por `lastHeartbeat` (ou `startedAt` se nunca
 * houve heartbeat) dentro de `[0, maxAgeMs]` — mesmo guard de clock-skew dos
 * dois hooks (idade negativa, ex: relógio adiantado gravando no futuro, nunca
 * conta como "ativa").
 *
 * **Merge lock (item 4):** `data/sessions/.merge-lock.json`, TTL curto (2 min —
 * a janela real é só `gh pr merge` + `git pull`, nunca deveria levar mais que
 * isso). Lock mais velho que o TTL é tratado como abandonado e liberado pro
 * próximo `acquireMergeLock` — nunca trava a máquina pra sempre por um
 * coordenador que crashou segurando o lock.
 *
 * **Claim de issue (item 3):** embutido no próprio registro de sessão
 * (`claimed_issues: number[]`) em vez de um arquivo `claims.jsonl` separado —
 * mais simples (a issue #5156 já sugeria essa opção como preferível), e o
 * dado morre junto com a sessão que fez o claim (staleness compartilhada).
 *
 * Uso CLI (chamado pelas skills — sempre SEM `--session-id`, injetado pelo
 * hook, ver acima):
 *   npx tsx scripts/lib/session-registry.ts register --kind overnight|develop [--pid N]
 *   npx tsx scripts/lib/session-registry.ts heartbeat --kind ... [--phase X] [--active-worktrees N]
 *   npx tsx scripts/lib/session-registry.ts end --kind ...
 *   npx tsx scripts/lib/session-registry.ts claim-issue --kind ... --issue N
 *   npx tsx scripts/lib/session-registry.ts is-claimed --issue N
 *   npx tsx scripts/lib/session-registry.ts list-active
 *   npx tsx scripts/lib/session-registry.ts merge-lock-acquire
 *   npx tsx scripts/lib/session-registry.ts merge-lock-release
 * (`--session-id X` funciona também se passado explicitamente — o hook só
 * injeta quando a flag está AUSENTE, nunca sobrescreve um valor já presente.)
 */

import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { parseArgs, isMainModule } from "./cli-args.ts";

export type SessionKind = "overnight" | "develop";

export interface SessionRecord {
  kind: SessionKind;
  machineTag: string;
  sessionId: string;
  startedAt: string;
  lastHeartbeat: string;
  phase?: string;
  pid?: number;
  active_worktrees?: number;
  claimed_issues?: number[];
  [key: string]: unknown;
}

interface MergeLockRecord {
  heldBy: string;
  acquiredAt: string;
}

/** Mesma janela de staleness dos dois hooks irmãos (#3322/#4450) — ver docblock do topo. */
export const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/** TTL do merge lock (item 4) — merge + pull não deveria levar mais que isso. */
export const MERGE_LOCK_TTL_MS = 2 * 60 * 1000;

/** Sanitiza o hostname pra um nome de arquivo seguro. Nunca lança — "unknown" em falha. */
export function machineTag(): string {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

export function sessionsDir(repoRoot: string): string {
  return join(repoRoot, "data", "sessions");
}

export function sessionFilePath(repoRoot: string, kind: SessionKind, tag: string, sessionId: string): string {
  return join(sessionsDir(repoRoot), `${kind}-${tag}-${sessionId}.json`);
}

export function mergeLockPath(repoRoot: string): string {
  return join(sessionsDir(repoRoot), ".merge-lock.json");
}

function readJsonSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonSafe(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

/**
 * Registra uma sessão ativa. Idempotente — chamar de novo com o mesmo
 * kind/tag/sessionId sobrescreve o registro (mesmo padrão de `startSession` em
 * `overnight-session-marker.ts`).
 */
export function registerSession(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  meta: { pid?: number; tag?: string; startedAt?: string } = {},
): SessionRecord {
  const tag = meta.tag ?? machineTag();
  const now = meta.startedAt ?? new Date().toISOString();
  const record: SessionRecord = {
    kind,
    machineTag: tag,
    sessionId,
    startedAt: now,
    lastHeartbeat: now,
    claimed_issues: [],
  };
  if (meta.pid !== undefined) record.pid = meta.pid;
  writeJsonSafe(sessionFilePath(repoRoot, kind, tag, sessionId), record);
  return record;
}

/**
 * Atualiza `lastHeartbeat` (+ um patch opcional de `phase`/`active_worktrees`)
 * de uma sessão já registrada. Retorna `false`, nunca lança, quando não há
 * sessão pra atualizar (nunca registrada, já encerrada, ou JSON corrompido).
 */
export function heartbeat(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  patch: Partial<Pick<SessionRecord, "phase" | "active_worktrees">> = {},
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
): boolean {
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  const current = readJsonSafe<SessionRecord>(path);
  if (!current) return false;
  writeJsonSafe(path, { ...current, ...patch, lastHeartbeat: now });
  return true;
}

/** Remove o registro de uma sessão. Idempotente — no-op se já ausente. */
export function endSession(repoRoot: string, kind: SessionKind, sessionId: string, tag: string = machineTag()): void {
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  if (existsSync(path)) rmSync(path);
}

/**
 * Lista as sessões ativas (não-stale) de `data/sessions/`. Ignora
 * `.merge-lock.json` e qualquer arquivo dotfile (prefixo `.`) — só registros
 * de sessão de verdade. Fail-soft: diretório ausente ou erro de leitura →
 * array vazio, nunca lança.
 */
export function listActiveSessions(
  repoRoot: string,
  now: number = Date.now(),
  maxAgeMs: number = MAX_SESSION_AGE_MS,
): SessionRecord[] {
  const dir = sessionsDir(repoRoot);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const record = readJsonSafe<SessionRecord>(join(dir, name));
    if (!record || !record.sessionId || !record.kind) continue;
    const heartbeatIso = record.lastHeartbeat ?? record.startedAt;
    const heartbeatMs = Date.parse(heartbeatIso ?? "");
    if (!Number.isFinite(heartbeatMs)) continue;
    const ageMs = now - heartbeatMs;
    if (ageMs < 0 || ageMs > maxAgeMs) continue;
    out.push(record);
  }
  return out;
}

/**
 * Adiciona `issueNumber` a `claimed_issues` da sessão (item 3 do #5156).
 * Retorna `false` sem lançar quando a sessão não existe (nunca registrada,
 * encerrada, corrompida) — mesmo contrato de `heartbeat`.
 */
export function claimIssue(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issueNumber: number,
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
): boolean {
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  const current = readJsonSafe<SessionRecord>(path);
  if (!current) return false;
  const claimed = new Set(current.claimed_issues ?? []);
  claimed.add(issueNumber);
  writeJsonSafe(path, {
    ...current,
    claimed_issues: [...claimed].sort((a, b) => a - b),
    lastHeartbeat: now,
  });
  return true;
}

/**
 * Retorna o registro da sessão ATIVA e DIFERENTE de `excludeSessionId` que já
 * reivindicou `issueNumber` — ou `null` se nenhuma outra sessão ativa a
 * reivindicou. Usado pelo coordenador antes de dispatchar um implementador
 * pra uma issue (item 3): "essa issue já está sendo trabalhada por outra
 * sessão ativa agora?".
 */
export function isIssueClaimedByOther(
  repoRoot: string,
  issueNumber: number,
  excludeSessionId: string,
  now: number = Date.now(),
): SessionRecord | null {
  for (const session of listActiveSessions(repoRoot, now)) {
    if (session.sessionId === excludeSessionId) continue;
    if ((session.claimed_issues ?? []).includes(issueNumber)) return session;
  }
  return null;
}

/**
 * Adquire o lock global de merge (item 4 do #5156) — serializa `gh pr merge` +
 * `git pull` entre sessões concorrentes (mesma máquina ou não, `data/` é
 * OneDrive compartilhado). TTL curto: um lock mais velho que
 * `MERGE_LOCK_TTL_MS` é tratado como abandonado (coordenador crashou
 * segurando o lock) e liberado automaticamente pro próximo adquirente —
 * nunca trava a máquina pra sempre.
 *
 * Retorna `true` quando o lock foi adquirido (ou já era desta mesma sessão —
 * reentrante, idempotente), `false` quando outra sessão o segura e ainda
 * está dentro do TTL.
 */
export function acquireMergeLock(
  repoRoot: string,
  sessionId: string,
  now: number = Date.now(),
  ttlMs: number = MERGE_LOCK_TTL_MS,
): boolean {
  const path = mergeLockPath(repoRoot);
  const current = readJsonSafe<MergeLockRecord>(path);
  if (current && current.heldBy !== sessionId) {
    const acquiredMs = Date.parse(current.acquiredAt);
    const stillFresh = Number.isFinite(acquiredMs) && now - acquiredMs >= 0 && now - acquiredMs <= ttlMs;
    if (stillFresh) return false; // outra sessão segura o lock, dentro do TTL
  }
  writeJsonSafe(path, { heldBy: sessionId, acquiredAt: new Date(now).toISOString() } satisfies MergeLockRecord);
  return true;
}

/**
 * Libera o lock de merge. Retorna `true` quando já estava livre ou foi
 * liberado por quem o segurava; `false` quando outra sessão é a dona atual
 * (nunca libera lock alheio por engano).
 */
export function releaseMergeLock(repoRoot: string, sessionId: string): boolean {
  const path = mergeLockPath(repoRoot);
  const current = readJsonSafe<MergeLockRecord>(path);
  if (!current) return true;
  if (current.heldBy !== sessionId) return false;
  if (existsSync(path)) rmSync(path);
  return true;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function requireKind(value: string | undefined): SessionKind {
  if (value !== "overnight" && value !== "develop") {
    throw new Error(`--kind deve ser "overnight" ou "develop", recebido "${value}"`);
  }
  return value;
}

function requireSessionId(values: Record<string, string>): string {
  const sessionId = values["session-id"];
  if (!sessionId) {
    throw new Error(
      "--session-id ausente — normalmente injetado automaticamente por " +
        ".claude/hooks/inject-session-id.mjs a partir do payload do hook PreToolUse. " +
        "Se você está chamando este script fora do harness do Claude Code, passe --session-id explicitamente.",
    );
  }
  return sessionId;
}

function main(): void {
  const argv = process.argv.slice(2);
  const { positional, values } = parseArgs(argv);
  const command = positional[0];
  const repoRoot = process.cwd();

  try {
    switch (command) {
      case "register": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        const pid = values.pid ? Number(values.pid) : undefined;
        const record = registerSession(repoRoot, kind, sessionId, { pid });
        process.stdout.write(`session-registry: registered ${sessionFilePath(repoRoot, kind, record.machineTag, sessionId)}\n`);
        break;
      }
      case "heartbeat": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        const patch: Partial<Pick<SessionRecord, "phase" | "active_worktrees">> = {};
        if (values.phase) patch.phase = values.phase;
        if (values["active-worktrees"]) patch.active_worktrees = Number(values["active-worktrees"]);
        const ok = heartbeat(repoRoot, kind, sessionId, patch);
        process.stdout.write(`session-registry: heartbeat ${ok ? "ok" : "no-op (sessão inexistente)"}\n`);
        if (!ok) process.exitCode = 1;
        break;
      }
      case "end": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        endSession(repoRoot, kind, sessionId);
        process.stdout.write("session-registry: ended\n");
        break;
      }
      case "claim-issue": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        const issue = Number(values.issue);
        if (!Number.isInteger(issue)) throw new Error("--issue deve ser um inteiro");
        const ok = claimIssue(repoRoot, kind, sessionId, issue);
        process.stdout.write(`session-registry: claim-issue ${ok ? "ok" : "no-op (sessão inexistente)"}\n`);
        if (!ok) process.exitCode = 1;
        break;
      }
      case "is-claimed": {
        const issue = Number(values.issue);
        if (!Number.isInteger(issue)) throw new Error("--issue deve ser um inteiro");
        const excludeSessionId = values["session-id"] ?? "";
        const owner = isIssueClaimedByOther(repoRoot, issue, excludeSessionId);
        process.stdout.write(JSON.stringify({ claimed: owner !== null, by: owner }) + "\n");
        break;
      }
      case "list-active": {
        const sessions = listActiveSessions(repoRoot);
        process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
        break;
      }
      case "merge-lock-acquire": {
        const sessionId = requireSessionId(values);
        const ok = acquireMergeLock(repoRoot, sessionId);
        process.stdout.write(`session-registry: merge-lock-acquire ${ok ? "ok" : "denied (held by another session)"}\n`);
        if (!ok) process.exitCode = 1;
        break;
      }
      case "merge-lock-release": {
        const sessionId = requireSessionId(values);
        const ok = releaseMergeLock(repoRoot, sessionId);
        process.stdout.write(`session-registry: merge-lock-release ${ok ? "ok" : "denied (held by another session)"}\n`);
        if (!ok) process.exitCode = 1;
        break;
      }
      default:
        process.stderr.write(
          "uso: npx tsx scripts/lib/session-registry.ts <register|heartbeat|end|claim-issue|is-claimed|list-active|merge-lock-acquire|merge-lock-release> [--kind overnight|develop] [--session-id X] ...\n",
        );
        process.exitCode = 1;
    }
  } catch (e) {
    process.stderr.write(`session-registry: erro — ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
