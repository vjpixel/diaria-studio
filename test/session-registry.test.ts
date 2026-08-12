/**
 * test/session-registry.test.ts (#5156)
 *
 * Cobre `scripts/lib/session-registry.ts` — registro compartilhado de sessões
 * `/diaria-overnight`/`/diaria-develop` ativas: register/heartbeat/end,
 * listActiveSessions (com staleness), claimIssue/isIssueClaimedByOther, e o
 * merge lock (acquire/release com TTL). Tudo isolado em tmpdir — nunca toca
 * `data/` real do repo.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sessionFilePath,
  sessionsDir,
  mergeLockPath,
  registerSession,
  heartbeat,
  endSession,
  listActiveSessions,
  claimIssue,
  isIssueClaimedByOther,
  acquireMergeLock,
  releaseMergeLock,
  MAX_SESSION_AGE_MS,
  MERGE_LOCK_TTL_MS,
} from "../scripts/lib/session-registry.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = join(tmpdir(), `session-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  return root;
}

// ─── sessionFilePath / sessionsDir / mergeLockPath ─────────────────────────

describe("sessionFilePath / sessionsDir / mergeLockPath", () => {
  it("monta o path esperado sob data/sessions/", () => {
    assert.equal(
      sessionFilePath("/repo", "overnight", "my-host", "sess-123"),
      join("/repo", "data", "sessions", "overnight-my-host-sess-123.json"),
    );
  });

  it("sessionsDir e mergeLockPath compartilham o mesmo diretório", () => {
    assert.equal(mergeLockPath("/repo"), join(sessionsDir("/repo"), ".merge-lock.json"));
  });
});

// ─── registerSession / heartbeat / endSession ──────────────────────────────

describe("registerSession / heartbeat / endSession", () => {
  it("registerSession cria data/sessions/ se não existir, e grava o registro", () => {
    const root = freshRoot();
    assert.equal(existsSync(sessionsDir(root)), false);

    const record = registerSession(root, "overnight", "sess-1", { tag: "host-a", startedAt: "2026-08-12T02:00:00.000Z" });

    const path = sessionFilePath(root, "overnight", "host-a", "sess-1");
    assert.ok(existsSync(path));
    const content = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(content.kind, "overnight");
    assert.equal(content.machineTag, "host-a");
    assert.equal(content.sessionId, "sess-1");
    assert.equal(content.startedAt, "2026-08-12T02:00:00.000Z");
    assert.equal(content.lastHeartbeat, "2026-08-12T02:00:00.000Z");
    assert.deepEqual(content.claimed_issues, []);
    assert.equal(record.sessionId, "sess-1");
  });

  it("registerSession grava pid quando fornecido", () => {
    const root = freshRoot();
    registerSession(root, "develop", "sess-2", { tag: "host-a", pid: 4242 });
    const content = JSON.parse(readFileSync(sessionFilePath(root, "develop", "host-a", "sess-2"), "utf8"));
    assert.equal(content.pid, 4242);
  });

  it("heartbeat atualiza lastHeartbeat e aceita patch de phase/active_worktrees", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-3", { tag: "host-a", startedAt: "2026-08-12T02:00:00.000Z" });

    const ok = heartbeat(
      root,
      "overnight",
      "sess-3",
      { phase: "autonomous", active_worktrees: 3 },
      "host-a",
      "2026-08-12T05:00:00.000Z",
    );

    assert.equal(ok, true);
    const content = JSON.parse(readFileSync(sessionFilePath(root, "overnight", "host-a", "sess-3"), "utf8"));
    assert.equal(content.lastHeartbeat, "2026-08-12T05:00:00.000Z");
    assert.equal(content.phase, "autonomous");
    assert.equal(content.active_worktrees, 3);
    assert.equal(content.startedAt, "2026-08-12T02:00:00.000Z", "startedAt preservado");
  });

  it("heartbeat retorna false, sem lançar, quando a sessão não existe", () => {
    const root = freshRoot();
    assert.doesNotThrow(() => {
      const ok = heartbeat(root, "overnight", "sess-inexistente", {}, "host-a");
      assert.equal(ok, false);
    });
  });

  it("endSession remove o registro; idempotente (no-op se já ausente)", () => {
    const root = freshRoot();
    registerSession(root, "develop", "sess-4", { tag: "host-a" });
    const path = sessionFilePath(root, "develop", "host-a", "sess-4");
    assert.ok(existsSync(path));

    endSession(root, "develop", "sess-4", "host-a");
    assert.equal(existsSync(path), false);

    assert.doesNotThrow(() => endSession(root, "develop", "sess-4", "host-a"));
  });
});

// ─── listActiveSessions ─────────────────────────────────────────────────────

describe("listActiveSessions", () => {
  const NOW = Date.parse("2026-08-12T12:00:00.000Z");
  const ONE_HOUR_MS = 60 * 60 * 1000;

  it("diretório ausente → array vazio, nunca lança", () => {
    assert.deepEqual(listActiveSessions(freshRoot(), NOW), []);
  });

  it("lista sessões frescas de ambos os kinds", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-o1", { tag: "host-a", startedAt: new Date(NOW - ONE_HOUR_MS).toISOString() });
    registerSession(root, "develop", "sess-d1", { tag: "host-a", startedAt: new Date(NOW - ONE_HOUR_MS).toISOString() });

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 2);
    const kinds = sessions.map((s) => s.kind).sort();
    assert.deepEqual(kinds, ["develop", "overnight"]);
  });

  it("ignora .merge-lock.json e outros dotfiles", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-o1", { tag: "host-a", startedAt: new Date(NOW - ONE_HOUR_MS).toISOString() });
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(mergeLockPath(root), JSON.stringify({ heldBy: "x", acquiredAt: new Date(NOW).toISOString() }), "utf8");

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, "sess-o1");
  });

  it("sessão mais velha que MAX_SESSION_AGE_MS (24h) → excluída (abandonada não fica ativa pra sempre)", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-old", {
      tag: "host-a",
      startedAt: new Date(NOW - 25 * ONE_HOUR_MS).toISOString(),
    });
    assert.deepEqual(listActiveSessions(root, NOW), []);
  });

  it("lastHeartbeat mais recente que startedAt estende a janela de atividade", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-refreshed", {
      tag: "host-a",
      startedAt: new Date(NOW - 30 * ONE_HOUR_MS).toISOString(), // startedAt sozinho já seria stale
    });
    heartbeat(root, "overnight", "sess-refreshed", {}, "host-a", new Date(NOW - ONE_HOUR_MS).toISOString());

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 1, "heartbeat recente deve manter a sessão ativa mesmo com startedAt velho");
  });

  it("heartbeat no FUTURO (clock skew) → nunca conta como ativa", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-future", {
      tag: "host-a",
      startedAt: new Date(NOW + 10 * ONE_HOUR_MS).toISOString(),
    });
    assert.deepEqual(listActiveSessions(root, NOW), []);
  });

  it("JSON malformado num arquivo de sessão é ignorado, não derruba a listagem inteira", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-ok", { tag: "host-a", startedAt: new Date(NOW - ONE_HOUR_MS).toISOString() });
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), "develop-host-a-corrompido.json"), "{not valid json", "utf8");

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, "sess-ok");
  });

  it("maxAgeMs customizável — janela menor exclui sessões que passariam no default de 24h", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-2h-old", {
      tag: "host-a",
      startedAt: new Date(NOW - 2 * ONE_HOUR_MS).toISOString(),
    });
    assert.equal(listActiveSessions(root, NOW, MAX_SESSION_AGE_MS).length, 1);
    assert.equal(listActiveSessions(root, NOW, ONE_HOUR_MS).length, 0);
  });
});

// ─── claimIssue / isIssueClaimedByOther ────────────────────────────────────

describe("claimIssue / isIssueClaimedByOther (item 3 do #5156)", () => {
  const NOW = Date.parse("2026-08-12T12:00:00.000Z");
  const ONE_HOUR_MS = 60 * 60 * 1000;

  it("claimIssue adiciona a issue a claimed_issues; retorna false se a sessão não existe", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-1", { tag: "host-a", startedAt: new Date(NOW).toISOString() });

    assert.equal(claimIssue(root, "overnight", "sess-1", 4321, "host-a"), true);
    const content = JSON.parse(readFileSync(sessionFilePath(root, "overnight", "host-a", "sess-1"), "utf8"));
    assert.deepEqual(content.claimed_issues, [4321]);

    assert.equal(claimIssue(root, "overnight", "sess-inexistente", 1, "host-a"), false);
  });

  it("claimIssue é idempotente — reivindicar a mesma issue duas vezes não duplica", () => {
    const root = freshRoot();
    registerSession(root, "develop", "sess-1", { tag: "host-a", startedAt: new Date(NOW).toISOString() });
    claimIssue(root, "develop", "sess-1", 100, "host-a");
    claimIssue(root, "develop", "sess-1", 100, "host-a");
    const content = JSON.parse(readFileSync(sessionFilePath(root, "develop", "host-a", "sess-1"), "utf8"));
    assert.deepEqual(content.claimed_issues, [100]);
  });

  it("isIssueClaimedByOther retorna a sessão dona quando OUTRA sessão ativa reivindicou a issue", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-overnight", { tag: "host-a", startedAt: new Date(NOW - ONE_HOUR_MS).toISOString() });
    claimIssue(root, "overnight", "sess-overnight", 5156, "host-a", new Date(NOW - ONE_HOUR_MS).toISOString());

    const owner = isIssueClaimedByOther(root, 5156, "sess-develop", NOW);
    assert.ok(owner !== null);
    assert.equal(owner.sessionId, "sess-overnight");
  });

  it("isIssueClaimedByOther retorna null quando a própria sessão (excludeSessionId) é a dona", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-a", { tag: "host-a", startedAt: new Date(NOW - ONE_HOUR_MS).toISOString() });
    claimIssue(root, "overnight", "sess-a", 42, "host-a", new Date(NOW - ONE_HOUR_MS).toISOString());

    assert.equal(isIssueClaimedByOther(root, 42, "sess-a", NOW), null);
  });

  it("isIssueClaimedByOther retorna null quando a issue não foi reivindicada por ninguém", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-a", { tag: "host-a", startedAt: new Date(NOW - ONE_HOUR_MS).toISOString() });
    assert.equal(isIssueClaimedByOther(root, 999, "sess-b", NOW), null);
  });

  it("isIssueClaimedByOther ignora claim de sessão STALE (não conta como ativa)", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-old", { tag: "host-a", startedAt: new Date(NOW - 25 * ONE_HOUR_MS).toISOString() });
    claimIssue(root, "overnight", "sess-old", 7, "host-a");

    assert.equal(isIssueClaimedByOther(root, 7, "sess-b", NOW), null);
  });
});

// ─── acquireMergeLock / releaseMergeLock ────────────────────────────────────

describe("acquireMergeLock / releaseMergeLock (item 4 do #5156)", () => {
  const NOW = Date.parse("2026-08-12T12:00:00.000Z");

  it("primeira aquisição sempre sucede e grava heldBy/acquiredAt", () => {
    const root = freshRoot();
    assert.equal(acquireMergeLock(root, "sess-a", NOW), true);
    const content = JSON.parse(readFileSync(mergeLockPath(root), "utf8"));
    assert.equal(content.heldBy, "sess-a");
    assert.equal(content.acquiredAt, new Date(NOW).toISOString());
  });

  it("segunda sessão não consegue adquirir enquanto o lock da primeira está dentro do TTL", () => {
    const root = freshRoot();
    acquireMergeLock(root, "sess-a", NOW);
    assert.equal(acquireMergeLock(root, "sess-b", NOW + 30_000), false);
  });

  it("a MESMA sessão pode readquirir seu próprio lock (reentrante/idempotente)", () => {
    const root = freshRoot();
    acquireMergeLock(root, "sess-a", NOW);
    assert.equal(acquireMergeLock(root, "sess-a", NOW + 30_000), true);
  });

  it("lock mais velho que o TTL é tratado como abandonado — outra sessão pode adquirir", () => {
    const root = freshRoot();
    acquireMergeLock(root, "sess-a", NOW);
    const afterTtl = NOW + MERGE_LOCK_TTL_MS + 1_000;
    assert.equal(acquireMergeLock(root, "sess-b", afterTtl), true);
    const content = JSON.parse(readFileSync(mergeLockPath(root), "utf8"));
    assert.equal(content.heldBy, "sess-b");
  });

  it("releaseMergeLock remove o lock quando a sessão dona libera", () => {
    const root = freshRoot();
    acquireMergeLock(root, "sess-a", NOW);
    assert.equal(releaseMergeLock(root, "sess-a"), true);
    assert.equal(existsSync(mergeLockPath(root)), false);
  });

  it("releaseMergeLock retorna true (no-op) quando o lock já está livre", () => {
    const root = freshRoot();
    assert.equal(releaseMergeLock(root, "sess-a"), true);
  });

  it("releaseMergeLock recusa liberar lock de OUTRA sessão (nunca libera lock alheio)", () => {
    const root = freshRoot();
    acquireMergeLock(root, "sess-a", NOW);
    assert.equal(releaseMergeLock(root, "sess-b"), false);
    assert.ok(existsSync(mergeLockPath(root)), "lock de sess-a deve continuar no disco");
  });
});
