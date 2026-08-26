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
  requireKind,
  listSafeBackupFiles,
  mergeSessionRecords,
  planSessionGc,
  garbageCollectSessions,
  GC_CONSERVATIVE_MAX_AGE_MS,
  MAX_SESSION_AGE_MS,
  SOFT_STALE_MS,
  MERGE_LOCK_TTL_MS,
  CLOCK_SKEW_TOLERANCE_MS,
  type MergeLockIo,
  type SessionRecord,
} from "../scripts/lib/session-registry.ts";

/** Struct local — `MergeLockRecord` não é exportado, só o formato JSON no disco. */
type MergeLockRecord = { heldBy: string; acquiredAt: string };

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

  // ─── #5797 — endSession distingue "removeu de fato" de "não havia nada" ──

  it("endSession retorna true quando removeu um registro que existia", () => {
    const root = freshRoot();
    registerSession(root, "develop", "sess-5797a", { tag: "host-a" });
    const removed = endSession(root, "develop", "sess-5797a", "host-a");
    assert.equal(removed, true);
    assert.equal(existsSync(sessionFilePath(root, "develop", "host-a", "sess-5797a")), false);
  });

  it("endSession retorna false (não finge sucesso) quando não havia registro pra remover", () => {
    const root = freshRoot();
    const removed = endSession(root, "develop", "sess-inexistente", "host-a");
    assert.equal(removed, false);
  });

  it("endSession com --tag de OUTRA máquina remove o registro dessa máquina de fato (#5797 Defeito 4)", () => {
    const root = freshRoot();
    // Registro "de outra máquina" (Neo) — arquivo em disco carrega a tag Neo.
    registerSession(root, "develop", "sess-cross-machine", { tag: "Neo" });
    const path = sessionFilePath(root, "develop", "Neo", "sess-cross-machine");
    assert.ok(existsSync(path));

    // Sem --tag, o default é machineTag() LOCAL ("helios" aqui) — nunca
    // encontra o registro de "Neo": reproduz o bug relatado na issue.
    const removedWithoutTag = endSession(root, "develop", "sess-cross-machine", "helios");
    assert.equal(removedWithoutTag, false, "sem o tag certo, nada é removido");
    assert.ok(existsSync(path), "registro de outra máquina continua intacto");

    // Com --tag explícito da máquina certa, o CLI consegue encerrar de fato.
    const removedWithTag = endSession(root, "develop", "sess-cross-machine", "Neo");
    assert.equal(removedWithTag, true);
    assert.equal(existsSync(path), false);
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

  it("erro de I/O real (não ENOENT/JSON malformado) lendo um arquivo de sessão é logado, não silencioso (#5161 item 3)", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-ok", { tag: "host-a", startedAt: new Date(NOW - ONE_HOUR_MS).toISOString() });
    // Um DIRETÓRIO no lugar de um arquivo de sessão força readFileSync a
    // lançar EISDIR — uma falha de I/O real, distinta de "arquivo ausente"
    // (ENOENT) ou "JSON inválido" — o tipo de erro que EBUSY/EPERM da
    // sincronização do OneDrive também produziria.
    mkdirSync(join(sessionsDir(root), "develop-host-a-e-um-diretorio.json"), { recursive: true });

    let stderrOutput = "";
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any, ...args: any[]) => {
      stderrOutput += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let sessions: ReturnType<typeof listActiveSessions>;
    try {
      sessions = listActiveSessions(root, NOW);
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(sessions.length, 1, "a falha de I/O não derruba a listagem inteira (fail-soft preservado)");
    assert.equal(sessions[0].sessionId, "sess-ok");
    assert.match(stderrOutput, /falha de I\/O/i, "a falha de I/O real fica visível em stderr, não silenciosa");
  });

  it("ignora cópia de conflito do OneDrive com sufixo -safeBackup- (#5427)", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-ok", { tag: "host-a", startedAt: new Date(NOW - ONE_HOUR_MS).toISOString() });
    mkdirSync(sessionsDir(root), { recursive: true });
    // Simula a cópia de conflito que o OneDrive gera para uma sessão já
    // encerrada (o arquivo real já foi removido por endSession, mas a cópia
    // de conflito continua no disco) — nunca deve contar como sessão ativa.
    writeFileSync(
      join(sessionsDir(root), "develop-host-a-sess-encerrada-safeBackup-1.json"),
      JSON.stringify({
        kind: "develop",
        machineTag: "host-a",
        sessionId: "sess-encerrada",
        startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
        lastHeartbeat: new Date(NOW - ONE_HOUR_MS).toISOString(),
        claimed_issues: [],
      }),
      "utf8",
    );

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

// ─── stale (#5474) — sinal de liveness prático distinto do teto absoluto ──

describe("listActiveSessions / isIssueClaimedByOther — stale (#5474)", () => {
  const NOW = Date.parse("2026-08-16T12:00:00.000Z");
  const ONE_MIN_MS = 60 * 1000;

  it("heartbeat < SOFT_STALE_MS (90min) → listado com stale:false, claim BLOQUEIA outra sessão", () => {
    const root = freshRoot();
    registerSession(root, "develop", "sess-fresh", { tag: "host-a", startedAt: new Date(NOW - 30 * ONE_MIN_MS).toISOString() });
    claimIssue(root, "develop", "sess-fresh", 5474, "host-a", new Date(NOW - 30 * ONE_MIN_MS).toISOString());

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].stale, false);

    const owner = isIssueClaimedByOther(root, 5474, "sess-outra", NOW);
    assert.ok(owner !== null, "sessão com heartbeat fresco deve bloquear o claim");
    assert.equal(owner.sessionId, "sess-fresh");
  });

  it("heartbeat > SOFT_STALE_MS mas < MAX_SESSION_AGE_MS → aparece em list-active com stale:true, mas NÃO bloqueia claim", () => {
    const root = freshRoot();
    // 3h10 stale — mesmo cenário concreto da issue (#5474, sessão develop-Neo).
    const staleHeartbeat = new Date(NOW - 3 * 60 * ONE_MIN_MS - 10 * ONE_MIN_MS).toISOString();
    registerSession(root, "develop", "sess-morta", { tag: "host-a", startedAt: staleHeartbeat });
    claimIssue(root, "develop", "sess-morta", 5416, "host-a", staleHeartbeat);

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 1, "sessão stale continua VISÍVEL em list-active, só marcada");
    assert.equal(sessions[0].stale, true);
    assert.equal(sessions[0].sessionId, "sess-morta");

    const owner = isIssueClaimedByOther(root, 5416, "sess-outra", NOW);
    assert.equal(owner, null, "claim de sessão stale não bloqueia outra sessão de reivindicar a issue");
  });

  it("heartbeat > MAX_SESSION_AGE_MS (24h) → comportamento antigo: nem aparece em list-active", () => {
    const root = freshRoot();
    const veryOldHeartbeat = new Date(NOW - 25 * 60 * ONE_MIN_MS).toISOString();
    registerSession(root, "develop", "sess-abandonada", { tag: "host-a", startedAt: veryOldHeartbeat });
    claimIssue(root, "develop", "sess-abandonada", 1, "host-a", veryOldHeartbeat);

    assert.deepEqual(listActiveSessions(root, NOW), []);
    assert.equal(isIssueClaimedByOther(root, 1, "sess-outra", NOW), null);
  });

  it("boundary exato: heartbeat == SOFT_STALE_MS não é stale (só > é stale)", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-boundary", { tag: "host-a", startedAt: new Date(NOW - SOFT_STALE_MS).toISOString() });

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].stale, false);
  });
});

// ─── requireKind / kind "continuo" (#5293 item 2) ──────────────────────────

describe("requireKind aceita o kind \"continuo\" (#5293)", () => {
  it("aceita \"overnight\", \"develop\" e \"continuo\"", () => {
    assert.equal(requireKind("overnight"), "overnight");
    assert.equal(requireKind("develop"), "develop");
    assert.equal(requireKind("continuo"), "continuo");
  });

  it("rejeita valor inválido/ausente com mensagem citando os 3 kinds válidos", () => {
    assert.throws(() => requireKind("bogus"), /--kind deve ser "overnight", "develop" ou "continuo"/);
    assert.throws(() => requireKind(undefined), /--kind deve ser "overnight", "develop" ou "continuo"/);
  });
});

describe("registro de sessão end-to-end com kind \"continuo\" (#5293)", () => {
  it("registerSession/heartbeat/claimIssue/endSession funcionam para kind \"continuo\" como para overnight/develop", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "sess-continuo-1", { tag: "host-a", startedAt: "2026-08-14T10:00:00.000Z" });

    const path = sessionFilePath(root, "continuo", "host-a", "sess-continuo-1");
    assert.ok(existsSync(path));
    const content = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(content.kind, "continuo");

    assert.equal(claimIssue(root, "continuo", "sess-continuo-1", 5293, "host-a", "2026-08-14T10:00:00.000Z"), true);
    const claimed = isIssueClaimedByOther(root, 5293, "sess-outra", Date.parse("2026-08-14T10:05:00.000Z"));
    assert.ok(claimed !== null);
    assert.equal(claimed.sessionId, "sess-continuo-1");

    endSession(root, "continuo", "sess-continuo-1", "host-a");
    assert.equal(existsSync(path), false);
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

// ─── acquireMergeLock: atomicidade sob concorrência (#5161 fleet review item 1) ──

describe("acquireMergeLock — atomicidade sob concorrência (#5161 item 1)", () => {
  const NOW = Date.parse("2026-08-12T12:00:00.000Z");

  it(
    "fast path (lock ausente): 2 tentativas concorrentes intercaladas contra o MESMO " +
      '"disco" compartilhado — no máximo UMA pode obter a criação exclusiva',
    () => {
      const root = freshRoot();
      const path = mergeLockPath(root);
      // "Disco" compartilhado entre as duas sessões — simula 2 processos reais
      // disputando o MESMO path ausente. A garantia de exclusividade mútua
      // real (que protege contra processos DIFERENTES, não só chamadas deste
      // teste) vem inteiramente do SO via O_EXCL no `tryCreateExclusive` real
      // — aqui reproduzimos a MESMA semântica ("lança/retorna false se o path
      // já existe no disco compartilhado") pra provar que o código de
      // `acquireMergeLock` delega corretamente a essa primitiva, sem
      // introduzir nenhum passo não-atômico ANTES dela.
      const disk = new Map<string, string>();
      const io: MergeLockIo = {
        tryCreateExclusive: (p, data) => {
          if (disk.has(p)) return false;
          disk.set(p, data);
          return true;
        },
        readCurrent: (p) => (disk.has(p) ? (JSON.parse(disk.get(p)!) as MergeLockRecord) : null),
        overwrite: (p, data) => disk.set(p, data),
      };

      const resultA = acquireMergeLock(root, "sess-a", NOW, MERGE_LOCK_TTL_MS, io);
      const resultB = acquireMergeLock(root, "sess-b", NOW, MERGE_LOCK_TTL_MS, io);

      assert.equal([resultA, resultB].filter(Boolean).length, 1, "no máximo uma das duas pode vencer a criação exclusiva");
      assert.equal(resultA, true, "a primeira a chegar no disco compartilhado vence");
      assert.equal(resultB, false, "a segunda encontra o path já ocupado — nunca finge que também venceu");
    },
  );

  it("fast path: erro de I/O inesperado (não-EEXIST) nunca é tratado como lock adquirido", () => {
    const root = freshRoot();
    const io: MergeLockIo = {
      tryCreateExclusive: () => {
        throw new Error("EACCES: permissão negada (simulado)");
      },
      readCurrent: () => null,
      overwrite: () => {
        throw new Error("nunca deveria ser chamado neste caminho");
      },
    };
    assert.equal(acquireMergeLock(root, "sess-a", NOW, MERGE_LOCK_TTL_MS, io), false);
  });

  it(
    "contest de lock STALE: quando a escrita de OUTRA sessão se intercala entre a nossa " +
      "própria escrita e a nossa própria releitura de verificação, nunca acreditamos que vencemos",
    () => {
      const root = freshRoot();
      const path = mergeLockPath(root);
      const disk = new Map<string, string>();
      // Lock antigo, já expirado — simula um coordenador que crashou segurando-o.
      disk.set(
        path,
        JSON.stringify({ heldBy: "sess-old", acquiredAt: new Date(NOW - MERGE_LOCK_TTL_MS - 5_000).toISOString() }),
      );
      const dataB = JSON.stringify({ heldBy: "sess-b", acquiredAt: new Date(NOW).toISOString() } satisfies MergeLockRecord);

      const io: MergeLockIo = {
        tryCreateExclusive: () => false, // lock (stale) já existe — nunca é o caminho "ausente"
        readCurrent: (p) => (disk.has(p) ? (JSON.parse(disk.get(p)!) as MergeLockRecord) : null),
        overwrite: (p, data) => {
          // Simula a Sessão B — que também leu o MESMO lock stale e decidiu
          // contestar em paralelo — gravando o PRÓPRIO lock bem no meio da
          // gravação de A: depois que A grava, mas ANTES de A conseguir se
          // reler pra verificar quem venceu.
          disk.set(p, data);
          disk.set(p, dataB);
        },
      };

      const resultA = acquireMergeLock(root, "sess-a", NOW, MERGE_LOCK_TTL_MS, io);

      assert.equal(resultA, false, "A é sobrescrita por B antes de conseguir se verificar — não pode achar que venceu");
      assert.equal(JSON.parse(disk.get(path)!).heldBy, "sess-b", "o disco reflete quem de fato escreveu por último");
    },
  );

  it("contest de lock STALE: quando NINGUÉM sobrescreve depois da nossa escrita, a verificação confirma que vencemos", () => {
    const root = freshRoot();
    const path = mergeLockPath(root);
    const disk = new Map<string, string>();
    disk.set(
      path,
      JSON.stringify({ heldBy: "sess-old", acquiredAt: new Date(NOW - MERGE_LOCK_TTL_MS - 5_000).toISOString() }),
    );
    const io: MergeLockIo = {
      tryCreateExclusive: () => false,
      readCurrent: (p) => (disk.has(p) ? (JSON.parse(disk.get(p)!) as MergeLockRecord) : null),
      overwrite: (p, data) => disk.set(p, data), // ninguém mais escreve no meio
    };

    assert.equal(acquireMergeLock(root, "sess-a", NOW, MERGE_LOCK_TTL_MS, io), true);
    assert.equal(JSON.parse(disk.get(path)!).heldBy, "sess-a");
  });

  // #6182 — entre máquinas via OneDrive, cada inode vê o arquivo como
  // ausente; ambas as sessões podem receber `true` do `tryCreateExclusive`.
  // Este é o comportamento ADVISORY documentado no #6182 — não uma falha
  // no mecanismo, mas uma limitação real quando o mesmo path lógico vive
  // em dois inodes distintos (junction OneDrive, não filesystem local).
  it("advisory cross-machine (#6182): dois MergeLockIo independentes sobre o MESMO path lógico — cada um vê o arquivo como ausente, ambos adquirem (não é garantia de exclusão entre máquinas)", () => {
    const root = freshRoot();
    const path = mergeLockPath(root);
    // Simula cada máquina com seu PRÓPRIO inode/disco: mesmo path lógico,
    // mas o arquivo NÃO é visível entre os dois — exatamente o que acontece
    // quando `data/` é um junction OneDrive sincronizado entre `helios` e
    // `Neo`: cada máquina lê do inode que o OneDrive sincronizou localmente,
    // não do inode único de um filesystem compartilhado real.
    const diskA = new Map<string, string>();
    const diskB = new Map<string, string>();
    const ioA: MergeLockIo = {
      tryCreateExclusive: (p, data) => {
        if (!diskA.has(p)) {
          diskA.set(p, data);
          return true; // inode A: arquivo criado com sucesso
        }
        return false;
      },
      readCurrent: (p) => (diskA.has(p) ? (JSON.parse(diskA.get(p)!) as MergeLockRecord) : null),
      overwrite: (p, data) => diskA.set(p, data),
    };
    const ioB: MergeLockIo = {
      tryCreateExclusive: (p, data) => {
        // Inode B: NÃO vê o arquivo criado por A — o OneDrive ainda não
        // sincronizou, ou sincronizou numa cópia que B ainda não tem.
        // Mesmo path lógico, inode completamente independente.
        if (!diskB.has(p)) {
          diskB.set(p, data);
          return true; // B também recebe `true` — não há exclusão entre inodes
        }
        return false;
      },
      readCurrent: (p) => (diskB.has(p) ? (JSON.parse(diskB.get(p)!) as MergeLockRecord) : null),
      overwrite: (p, data) => diskB.set(p, data),
    };
    const resultA = acquireMergeLock(root, "sess-helios", NOW, MERGE_LOCK_TTL_MS, ioA);
    const resultB = acquireMergeLock(root, "sess-neo", NOW, MERGE_LOCK_TTL_MS, ioB);
    assert.equal(resultA, true, "A (helios) vê path ausente no seu inode e recebe `true`");
    assert.equal(resultB, true, "B (neo) vê path ausente no SEU inode e também recebe `true` — a limitação advisory do #6182");
  });
});

// ─── clock skew (#5161 fleet review item 2) ────────────────────────────────

describe("clock skew — listActiveSessions/acquireMergeLock nunca escondem/roubam estado ativo silenciosamente (#5161 item 2)", () => {
  const NOW = Date.parse("2026-08-12T12:00:00.000Z");

  it("listActiveSessions: idade no futuro DENTRO da tolerância ainda conta como ativa (jitter normal entre máquinas)", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-skew-pequeno", {
      tag: "host-a",
      startedAt: new Date(NOW + CLOCK_SKEW_TOLERANCE_MS / 2).toISOString(),
    });
    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 1, "skew pequeno (dentro da tolerância) não deve excluir a sessão");
  });

  it("listActiveSessions: idade no futuro ALÉM da tolerância ainda é excluída (nunca finge que está ativa)", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-skew-grande", {
      tag: "host-a",
      startedAt: new Date(NOW + CLOCK_SKEW_TOLERANCE_MS * 10).toISOString(),
    });
    assert.deepEqual(listActiveSessions(root, NOW), []);
  });

  it("listActiveSessions: exclusão por idade negativa ALÉM da tolerância é logada em stderr, nunca silenciosa", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-skew-logado", {
      tag: "host-a",
      startedAt: new Date(NOW + CLOCK_SKEW_TOLERANCE_MS * 10).toISOString(),
    });
    let stderrOutput = "";
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any, ...args: any[]) => {
      stderrOutput += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      listActiveSessions(root, NOW);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.match(stderrOutput, /clock skew/i);
    assert.match(stderrOutput, /sess-skew-logado/);
  });

  it("acquireMergeLock: lock EXISTENTE com acquiredAt no futuro (skew) nunca é tratado como abandonado/roubável", () => {
    const root = freshRoot();
    const path = mergeLockPath(root);
    mkdirSync(sessionsDir(root), { recursive: true });
    // Lock genuinamente fresco escrito por uma máquina com relógio adiantado —
    // pro nosso relógio (atrasado), parece estar "no futuro".
    writeFileSync(
      path,
      JSON.stringify({ heldBy: "sess-a", acquiredAt: new Date(NOW + CLOCK_SKEW_TOLERANCE_MS * 10).toISOString() }),
      "utf8",
    );
    assert.equal(
      acquireMergeLock(root, "sess-b", NOW),
      false,
      "nunca tratar um lock 'do futuro' como abandonado, mesmo com skew grande",
    );
    const content = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(content.heldBy, "sess-a", "o lock original nunca é sobrescrito por engano");
  });

  it("acquireMergeLock: skew pequeno (dentro da tolerância) não gera warning; skew grande gera", () => {
    const root = freshRoot();
    const path = mergeLockPath(root);
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ heldBy: "sess-a", acquiredAt: new Date(NOW + CLOCK_SKEW_TOLERANCE_MS * 10).toISOString() }),
      "utf8",
    );
    let stderrOutput = "";
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any, ...args: any[]) => {
      stderrOutput += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      acquireMergeLock(root, "sess-b", NOW);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.match(stderrOutput, /clock skew/i);
    assert.match(stderrOutput, /sess-a/);
  });
});

// ─── #6130 — união de claims de backups do OneDrive (defeito 2 da issue) ───

/** Escreve um arquivo de sessão bruto sob `data/sessions/{name}` — usado pra
 * simular cópias de conflito do OneDrive (`-safeBackup-NNNN`), que nunca são
 * produzidas por `registerSession`/`claimIssue` (essas sempre escrevem o
 * nome "real"). */
function writeRawSessionFile(root: string, name: string, record: Partial<SessionRecord>): void {
  mkdirSync(sessionsDir(root), { recursive: true });
  writeFileSync(join(sessionsDir(root), name), JSON.stringify(record), "utf8");
}

describe("mergeSessionRecords (#6130)", () => {
  it("une claimed_issues de todos os registros e usa o de heartbeat mais recente como base", () => {
    const older: SessionRecord = {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s1",
      startedAt: "2026-08-18T04:00:00.000Z",
      lastHeartbeat: "2026-08-18T14:26:00.000Z",
      claimed_issues: [1, 2],
      phase: "implementando",
    };
    const newer: SessionRecord = {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s1",
      startedAt: "2026-08-18T04:00:00.000Z",
      lastHeartbeat: "2026-08-18T15:32:00.000Z",
      claimed_issues: [1, 2, 3],
      phase: "pausado-edicao",
    };
    const merged = mergeSessionRecords([older, newer]);
    assert.deepEqual(merged.claimed_issues, [1, 2, 3]);
    assert.equal(merged.lastHeartbeat, "2026-08-18T15:32:00.000Z", "campos não-claim vêm do registro mais recente");
    assert.equal(merged.phase, "pausado-edicao");
  });

  it("une um claim que existe SÓ no registro mais antigo (o cenário real do #6130 — claim desaparece do 'atual')", () => {
    const older: SessionRecord = {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s1",
      startedAt: "2026-08-18T04:00:00.000Z",
      lastHeartbeat: "2026-08-18T15:16:00.000Z",
      claimed_issues: [5657], // presente só aqui — divergência real medida na issue
    };
    const newerSemClaim: SessionRecord = {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s1",
      startedAt: "2026-08-18T04:00:00.000Z",
      lastHeartbeat: "2026-08-18T15:32:00.000Z",
      claimed_issues: [],
    };
    const merged = mergeSessionRecords([older, newerSemClaim]);
    assert.deepEqual(merged.claimed_issues, [5657], "fail-safe: claim de QUALQUER registro do grupo sobrevive na união");
  });
});

describe("listSafeBackupFiles (#6130)", () => {
  it("diretório ausente → array vazio", () => {
    assert.deepEqual(listSafeBackupFiles(freshRoot()), []);
  });

  it("lista só arquivos com sufixo -safeBackup-, ordenados", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "sess-1", { tag: "predator" });
    writeRawSessionFile(root, "continuo-predator-sess-1-predator-safeBackup-0002.json", { kind: "continuo" });
    writeRawSessionFile(root, "continuo-predator-sess-1-predator-safeBackup-0001.json", { kind: "continuo" });

    assert.deepEqual(listSafeBackupFiles(root), [
      "continuo-predator-sess-1-predator-safeBackup-0001.json",
      "continuo-predator-sess-1-predator-safeBackup-0002.json",
    ]);
  });
});

describe("listActiveSessions / isIssueClaimedByOther — união de claims de backup do MESMO sessionId (#6130)", () => {
  const NOW = Date.parse("2026-08-18T16:00:00.000Z");

  it("is-claimed enxerga um claim presente SÓ num backup, ausente do arquivo real 'atual'", () => {
    const root = freshRoot();
    // Arquivo real — claim 5657 já foi removido/nunca chegou aqui (conflito de sync).
    registerSession(root, "continuo", "s1", { tag: "predator", startedAt: "2026-08-18T15:00:00.000Z" });
    claimIssue(root, "continuo", "s1", 5518, "predator", "2026-08-18T15:32:00.000Z");
    // Backup do MESMO sessionId carrega um claim que o arquivo real não tem.
    writeRawSessionFile(root, "continuo-predator-s1-predator-safeBackup-0001.json", {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s1",
      startedAt: "2026-08-18T15:00:00.000Z",
      lastHeartbeat: "2026-08-18T15:16:00.000Z",
      claimed_issues: [5518, 5657],
    });

    const owner = isIssueClaimedByOther(root, 5657, "sess-outra", NOW);
    assert.ok(owner !== null, "claim que só existe no backup ainda bloqueia outra sessão (fail-safe)");
    assert.equal(owner.sessionId, "s1");
    assert.deepEqual(owner.claimed_issues, [5518, 5657]);
  });

  it("heartbeat mais recente do GRUPO (não só do arquivo real) decide staleness", () => {
    const root = freshRoot();
    // Arquivo real com heartbeat velho (>90min) — sozinho já seria stale.
    const staleHb = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    registerSession(root, "continuo", "s2", { tag: "predator", startedAt: staleHb });
    heartbeat(root, "continuo", "s2", {}, "predator", staleHb);
    claimIssue(root, "continuo", "s2", 42, "predator", staleHb);
    // Backup com heartbeat FRESCO (o sync gravou uma versão mais nova como
    // cópia de conflito em vez de sobrescrever o arquivo real).
    const freshHb = new Date(NOW - 5 * 60 * 1000).toISOString();
    writeRawSessionFile(root, "continuo-predator-s2-predator-safeBackup-0001.json", {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s2",
      startedAt: staleHb,
      lastHeartbeat: freshHb,
      claimed_issues: [42],
    });

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].stale, false, "heartbeat fresco do backup mantém o grupo não-stale");
    assert.ok(isIssueClaimedByOther(root, 42, "sess-outra", NOW) !== null, "não-stale => claim ainda bloqueia");
  });

  it("backup ÓRFÃO (sem arquivo real correspondente) continua NUNCA ressuscitando claim (#5427 preservado)", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "continuo-predator-s-encerrada-predator-safeBackup-0001.json", {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s-encerrada",
      startedAt: new Date(NOW - 60 * 1000).toISOString(),
      lastHeartbeat: new Date(NOW - 60 * 1000).toISOString(),
      claimed_issues: [999],
    });

    assert.deepEqual(listActiveSessions(root, NOW), []);
    assert.equal(isIssueClaimedByOther(root, 999, "sess-outra", NOW), null, "backup órfão não reivindica nada");
  });
});

// ─── #6130 — GC de registros encerrados ────────────────────────────────────

describe("planSessionGc / garbageCollectSessions (#6130)", () => {
  const NOW = Date.parse("2026-08-25T12:00:00.000Z");
  const ONE_MIN_MS = 60 * 1000;
  const ONE_DAY_MS = 24 * 60 * ONE_MIN_MS;

  it("#6130 fleet review (P2): conservativeMaxAgeMs não-positivo/NaN lança, nunca degrada em silêncio a janela conservadora", () => {
    const root = freshRoot();
    registerSession(root, "develop", "s1", { tag: "Neo", startedAt: new Date(NOW - 5 * ONE_MIN_MS).toISOString() });

    for (const bad of [0, -1, NaN, Infinity]) {
      assert.throws(
        () => planSessionGc(root, { now: NOW, conservativeMaxAgeMs: bad }),
        /conservativeMaxAgeMs precisa ser finito e positivo/,
        `deveria lançar para conservativeMaxAgeMs=${bad}`,
      );
    }
  });

  it("sessão com heartbeat recente (dentro de SOFT_STALE_MS) é sempre mantida", () => {
    const root = freshRoot();
    registerSession(root, "develop", "s1", { tag: "Neo", startedAt: new Date(NOW - 5 * ONE_MIN_MS).toISOString() });

    const plan = planSessionGc(root, { now: NOW });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "kept");
  });

  it("ressalva #6130: heartbeat MUITO stale mas pid confirmado VIVO na máquina local — NUNCA remove", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "s-viva", {
      tag: "helios",
      pid: 4242,
      startedAt: new Date(NOW - 10 * ONE_DAY_MS).toISOString(), // além até da janela conservadora
    });

    const plan = planSessionGc(root, { now: NOW, localMachineTag: "helios", isPidAlive: (pid) => pid === 4242 });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "kept", "processo vivo protege o registro mesmo com heartbeat morto há 10 dias");
    assert.match(plan[0].reason, /VIVO/);
  });

  it("mesma máquina, pid confirmado MORTO, heartbeat além de SOFT_STALE_MS — remove (não precisa esperar a janela conservadora)", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "s-morta", {
      tag: "helios",
      pid: 9999,
      startedAt: new Date(NOW - 2 * 60 * ONE_MIN_MS).toISOString(), // 2h — stale mas bem aquém de 7 dias
    });

    const plan = planSessionGc(root, { now: NOW, localMachineTag: "helios", isPidAlive: () => false });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "removed");
    assert.match(plan[0].reason, /MORTO/);
  });

  it("máquina DIFERENTE (sem como checar pid) — mantém até a janela conservadora, remove depois", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "s-remota", {
      tag: "helios",
      pid: 111,
      startedAt: new Date(NOW - 2 * ONE_DAY_MS).toISOString(), // stale, mas < 7 dias
    });

    const keptPlan = planSessionGc(root, { now: NOW, localMachineTag: "Neo", isPidAlive: () => true });
    assert.equal(keptPlan[0].action, "kept", "sem sinal de processo verificável NESTA máquina, ainda dentro da janela conservadora");

    const removedPlan = planSessionGc(root, {
      now: NOW + 6 * ONE_DAY_MS, // agora 8 dias de idade total — além dos 7 dias default
      localMachineTag: "Neo",
      isPidAlive: () => true,
    });
    assert.equal(removedPlan[0].action, "removed", "além da janela conservadora, sem sinal de processo — GC remove");
  });

  it("sem pid registrado (registro antigo) — mesmo tratamento de 'sem sinal verificável'", () => {
    const root = freshRoot();
    registerSession(root, "develop", "s-sem-pid", { tag: "Neo", startedAt: new Date(NOW - 10 * ONE_DAY_MS).toISOString() });

    const plan = planSessionGc(root, { now: NOW, localMachineTag: "Neo", isPidAlive: () => true });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "removed", "10 dias > janela conservadora de 7 dias, sem pid pra checar");
  });

  it("respeita conservativeMaxAgeMs customizado", () => {
    const root = freshRoot();
    registerSession(root, "develop", "s-custom", { tag: "Neo", startedAt: new Date(NOW - 3 * ONE_DAY_MS).toISOString() });

    const kept = planSessionGc(root, { now: NOW, conservativeMaxAgeMs: 5 * ONE_DAY_MS });
    assert.equal(kept[0].action, "kept");
    const removed = planSessionGc(root, { now: NOW, conservativeMaxAgeMs: 2 * ONE_DAY_MS });
    assert.equal(removed[0].action, "removed");
  });

  it("planSessionGc é PURO — nunca toca disco, mesmo quando decide 'removed'", () => {
    const root = freshRoot();
    registerSession(root, "develop", "s-old", { tag: "Neo", startedAt: new Date(NOW - 10 * ONE_DAY_MS).toISOString() });
    const path = sessionFilePath(root, "develop", "Neo", "s-old");

    const plan = planSessionGc(root, { now: NOW });
    assert.equal(plan[0].action, "removed");
    assert.ok(existsSync(path), "plan sozinho nunca remove nada do disco");
  });

  it("garbageCollectSessions aplica a remoção de fato (best-effort rmSync)", () => {
    const root = freshRoot();
    registerSession(root, "develop", "s-old", { tag: "Neo", startedAt: new Date(NOW - 10 * ONE_DAY_MS).toISOString() });
    const path = sessionFilePath(root, "develop", "Neo", "s-old");
    assert.ok(existsSync(path));

    const plan = garbageCollectSessions(root, { now: NOW });
    assert.equal(plan[0].action, "removed");
    assert.equal(existsSync(path), false);
  });

  it("garbageCollectSessions remove o GRUPO inteiro (real + backups) junto", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "s-grupo", { tag: "predator", startedAt: new Date(NOW - 10 * ONE_DAY_MS).toISOString() });
    const realPath = sessionFilePath(root, "continuo", "predator", "s-grupo");
    writeRawSessionFile(root, "continuo-predator-s-grupo-predator-safeBackup-0001.json", {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s-grupo",
      startedAt: new Date(NOW - 10 * ONE_DAY_MS).toISOString(),
      lastHeartbeat: new Date(NOW - 10 * ONE_DAY_MS).toISOString(),
      claimed_issues: [],
    });
    const backupPath = join(sessionsDir(root), "continuo-predator-s-grupo-predator-safeBackup-0001.json");
    assert.ok(existsSync(realPath));
    assert.ok(existsSync(backupPath));

    const plan = garbageCollectSessions(root, { now: NOW });
    assert.equal(plan.length, 1, "real + backup avaliados como 1 grupo/1 decisão");
    assert.equal(plan[0].action, "removed");
    assert.equal(existsSync(realPath), false);
    assert.equal(existsSync(backupPath), false, "backup do grupo removido junto");
  });

  it("backup ÓRFÃO velho (sem arquivo real — sessão já encerrada) é removido pelo GC — é o caso canônico do item 1", () => {
    const root = freshRoot();
    const backupPath = join(sessionsDir(root), "develop-Neo-s-encerrada-Neo-safeBackup-0001.json");
    writeRawSessionFile(root, "develop-Neo-s-encerrada-Neo-safeBackup-0001.json", {
      kind: "develop",
      machineTag: "Neo",
      sessionId: "s-encerrada",
      startedAt: new Date(NOW - 10 * ONE_DAY_MS).toISOString(),
      lastHeartbeat: new Date(NOW - 10 * ONE_DAY_MS).toISOString(),
      claimed_issues: [],
    });

    const plan = garbageCollectSessions(root, { now: NOW, localMachineTag: "Neo" });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].identity, "orphan-backup:develop-Neo-s-encerrada-Neo-safeBackup-0001.json");
    assert.equal(plan[0].action, "removed");
    assert.equal(existsSync(backupPath), false);
  });

  it("arquivo ilegível/corrompido nunca é removido pelo GC", () => {
    const root = freshRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), "develop-Neo-corrompido.json"), "{not valid json", "utf8");

    const plan = planSessionGc(root, { now: NOW });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "kept");
    assert.match(plan[0].reason, /ilegível/);
  });

  it("diretório ausente → plano vazio, nunca lança", () => {
    assert.deepEqual(planSessionGc(freshRoot(), { now: NOW }), []);
  });

  it("GC_CONSERVATIVE_MAX_AGE_MS é o default quando conservativeMaxAgeMs não é passado (7 dias)", () => {
    assert.equal(GC_CONSERVATIVE_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  });
});
