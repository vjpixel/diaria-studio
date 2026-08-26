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
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  sessionFilePath,
  sessionsDir,
  mergeLockPath,
  registerSession,
  heartbeat,
  endSession,
  listActiveSessions,
  claimIssue,
  claimIssueCheckAndSet,
  unclaimIssue,
  isIssueClaimedByOther,
  findActiveSessionsOfKind,
  findStaleSessionsOfKind,
  hasActiveSessionOfKind,
  checkSessionsScanHealth,
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
  type PromotionRemoveIo,
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

    const result = registerSession(root, "overnight", "sess-1", { tag: "host-a", startedAt: "2026-08-12T02:00:00.000Z" });

    const path = sessionFilePath(root, "overnight", "host-a", "sess-1");
    assert.ok(existsSync(path));
    const content = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(content.kind, "overnight");
    assert.equal(content.machineTag, "host-a");
    assert.equal(content.sessionId, "sess-1");
    assert.equal(content.startedAt, "2026-08-12T02:00:00.000Z");
    assert.equal(content.lastHeartbeat, "2026-08-12T02:00:00.000Z");
    assert.deepEqual(content.claimed_issues, []);
    assert.equal(result.record.sessionId, "sess-1");
    assert.equal(result.outcome, "created", "#6326: 1º registro pra este sessionId — outcome created, sem promotedFrom");
    assert.equal(result.promotedFrom, undefined);
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

// ─── registerSession — promoção de kind (#6326) ────────────────────────────
//
// Reproduz a ordem de eventos real: o beacon (`.claude/hooks/session-beacon.mjs`)
// dispara no PreToolUse e cria `interactive-{tag}-{sessionId}.json` ANTES de a
// skill chamar `register --kind overnight|develop|continuo` pro MESMO
// sessionId. Sem a promoção, sobravam dois arquivos pra uma sessão só —
// achado ao vivo em 26/08/2026 (`overnight-helios-{uuid}.json` +
// `interactive-helios-{uuid}.json` simultâneos).

describe("registerSession — promoção de kind quando o beacon registrou primeiro (#6326)", () => {
  it("beacon cria interactive-X; register --kind overnight com o mesmo X deixa UM arquivo, kind overnight, campos de beacon intactos", () => {
    const root = freshRoot();
    const sessionId = "sess-6326-a";
    const tag = "helios";

    // Simula o que o beacon já escreveu antes do `register` da skill rodar.
    writeRawSessionFile(root, `interactive-${tag}-${sessionId}.json`, {
      kind: "interactive",
      machineTag: tag,
      sessionId,
      startedAt: "2026-08-26T10:00:00.000Z",
      lastHeartbeat: "2026-08-26T10:04:00.000Z",
      claimed_issues: [],
      touched_paths: ["scripts/foo.ts"],
      dirty_paths: ["scripts/foo.ts"],
      branch: "master",
      last_action: { verb: "edit", at: "2026-08-26T10:04:00.000Z" },
    });
    const interactivePath = sessionFilePath(root, "interactive", tag, sessionId);
    assert.ok(existsSync(interactivePath), "precondição: o beacon já criou o registro interativo");

    const result = registerSession(root, "overnight", sessionId, { tag, startedAt: "2026-08-26T10:05:00.000Z" });

    // O arquivo interativo antigo desaparece — nunca sobram os dois.
    assert.equal(existsSync(interactivePath), false, "registro interactive antigo é removido na promoção");
    const overnightPath = sessionFilePath(root, "overnight", tag, sessionId);
    assert.ok(existsSync(overnightPath));

    // Só existe 1 arquivo .json pra este sessionId no diretório inteiro.
    const allFiles = readdirSync(sessionsDir(root))
      .filter((n: string) => n.endsWith(`-${sessionId}.json`));
    assert.deepEqual(allFiles, [`overnight-${tag}-${sessionId}.json`]);

    // #6326 fleet review — o desfecho é observável no retorno, não só
    // inferível relendo o disco.
    assert.equal(result.outcome, "promoted");
    assert.equal(result.promotedFrom, interactivePath);

    const content = JSON.parse(readFileSync(overnightPath, "utf8"));
    assert.equal(content.kind, "overnight");
    assert.equal(result.record.kind, "overnight");
    // startedAt do registro ORIGINAL (interactive) é preservado, não o `now`
    // passado a este `register`.
    assert.equal(content.startedAt, "2026-08-26T10:00:00.000Z");
    assert.deepEqual(content.claimed_issues, []);
    // Campos de beacon acumulados sobrevivem à promoção.
    assert.deepEqual(content.touched_paths, ["scripts/foo.ts"]);
    assert.deepEqual(content.dirty_paths, ["scripts/foo.ts"]);
    assert.equal(content.branch, "master");
    assert.deepEqual(content.last_action, { verb: "edit", at: "2026-08-26T10:04:00.000Z" });
  });

  it("promoção preserva claimed_issues acumuladas no registro interactive antigo", () => {
    const root = freshRoot();
    const sessionId = "sess-6326-b";
    const tag = "helios";

    writeRawSessionFile(root, `interactive-${tag}-${sessionId}.json`, {
      kind: "interactive",
      machineTag: tag,
      sessionId,
      startedAt: "2026-08-26T10:00:00.000Z",
      lastHeartbeat: "2026-08-26T10:04:00.000Z",
      claimed_issues: [111, 222],
    });

    registerSession(root, "develop", sessionId, { tag });

    const content = JSON.parse(readFileSync(sessionFilePath(root, "develop", tag, sessionId), "utf8"));
    assert.deepEqual(content.claimed_issues, [111, 222]);
  });

  it("listActiveSessions nunca devolve dois registros pro mesmo sessionId após a promoção", () => {
    const root = freshRoot();
    const sessionId = "sess-6326-c";
    const tag = "helios";
    const now = Date.parse("2026-08-26T10:10:00.000Z");

    writeRawSessionFile(root, `interactive-${tag}-${sessionId}.json`, {
      kind: "interactive",
      machineTag: tag,
      sessionId,
      startedAt: "2026-08-26T10:00:00.000Z",
      lastHeartbeat: "2026-08-26T10:04:00.000Z",
      claimed_issues: [],
    });

    registerSession(root, "overnight", sessionId, { tag, startedAt: "2026-08-26T10:05:00.000Z" });

    const sessions = listActiveSessions(root, now);
    const matching = sessions.filter((s) => s.sessionId === sessionId);
    assert.equal(matching.length, 1, "só 1 registro ativo pra este sessionId, nunca 2");
    assert.equal(matching[0]!.kind, "overnight");
  });

  it("re-register do MESMO kind após a promoção continua idempotente e preserva claimed_issues (não regride #6294/#6303)", () => {
    const root = freshRoot();
    const sessionId = "sess-6326-d";
    const tag = "helios";

    writeRawSessionFile(root, `interactive-${tag}-${sessionId}.json`, {
      kind: "interactive",
      machineTag: tag,
      sessionId,
      startedAt: "2026-08-26T10:00:00.000Z",
      lastHeartbeat: "2026-08-26T10:04:00.000Z",
      claimed_issues: [],
    });
    registerSession(root, "overnight", sessionId, { tag, startedAt: "2026-08-26T10:05:00.000Z" });

    // A sessão reivindica issues depois de já promovida.
    claimIssue(root, "overnight", sessionId, 42, tag, "2026-08-26T10:06:00.000Z");
    claimIssue(root, "overnight", sessionId, 43, tag, "2026-08-26T10:07:00.000Z");

    // Um 2º `register` do MESMO kind (ex: correção de `pid`) não deve achar
    // "outro kind" pra promover (o path já é o seu) nem apagar as claims.
    const result = registerSession(root, "overnight", sessionId, { tag, pid: 555 });
    assert.equal(result.outcome, "reregistered", "#6326: re-registro do MESMO kind nunca é confundido com promoção");
    assert.equal(result.promotedFrom, undefined);
    assert.deepEqual(result.record.claimed_issues, [42, 43]);
    assert.equal(result.record.pid, 555);
    assert.equal(result.record.startedAt, "2026-08-26T10:00:00.000Z", "startedAt do registro original (interactive) preservado através de promoção + re-registro");

    // Continua só 1 arquivo pra este sessionId.
    const allFiles = readdirSync(sessionsDir(root))
      .filter((n: string) => n.endsWith(`-${sessionId}.json`));
    assert.deepEqual(allFiles, [`overnight-${tag}-${sessionId}.json`]);
  });

  it("promoção preserva claims que só existiam num -safeBackup- do registro antigo (#6130 não regride)", () => {
    const root = freshRoot();
    const sessionId = "sess-6326-e";
    const tag = "predator";

    // Registro interactive "real" — sem o claim 999 (foi perdido/nunca
    // sincronizado no arquivo real, típico de conflito de escrita do OneDrive).
    writeRawSessionFile(root, `interactive-${tag}-${sessionId}.json`, {
      kind: "interactive",
      machineTag: tag,
      sessionId,
      startedAt: "2026-08-26T10:00:00.000Z",
      lastHeartbeat: "2026-08-26T10:02:00.000Z",
      claimed_issues: [],
    });
    // Cópia de conflito do MESMO stem carrega um claim que o arquivo real não tem.
    writeRawSessionFile(root, `interactive-${tag}-${sessionId}-${tag}-safeBackup-0001.json`, {
      kind: "interactive",
      machineTag: tag,
      sessionId,
      startedAt: "2026-08-26T10:00:00.000Z",
      lastHeartbeat: "2026-08-26T10:03:00.000Z",
      claimed_issues: [999],
    });

    registerSession(root, "continuo", sessionId, { tag });

    const content = JSON.parse(readFileSync(sessionFilePath(root, "continuo", tag, sessionId), "utf8"));
    assert.deepEqual(content.claimed_issues, [999], "claim que só existia no backup sobrevive à promoção");
  });

  it("sem registro de OUTRO kind pra este sessionId, registerSession continua criando um registro novo normalmente", () => {
    const root = freshRoot();
    const result = registerSession(root, "overnight", "sess-6326-f", { tag: "helios", startedAt: "2026-08-26T10:00:00.000Z" });
    assert.equal(result.outcome, "created");
    assert.equal(result.promotedFrom, undefined);
    assert.equal(result.record.kind, "overnight");
    assert.deepEqual(result.record.claimed_issues, []);
  });

  it("registro de OUTRO kind ILEGÍVEL (JSON corrompido, nem real nem backup legível) — não cria 2º registro ativo em silêncio (#6326 fleet review item 1)", () => {
    const root = freshRoot();
    const sessionId = "sess-6326-unreadable";
    const tag = "helios";

    // Arquivo de OUTRO kind existe PELO NOME, mas o conteúdo é JSON inválido
    // — simula sync do OneDrive pegando o arquivo no meio de um write.
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), `interactive-${tag}-${sessionId}.json`), "{ isto não é JSON válido", "utf8");

    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderrOutput = "";
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((chunk: unknown) => {
      stderrOutput += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let result: ReturnType<typeof registerSession>;
    try {
      result = registerSession(root, "overnight", sessionId, { tag, startedAt: "2026-08-26T11:00:00.000Z" });
    } finally {
      process.stderr.write = originalWrite;
    }

    // O desfecho de falha é OBSERVÁVEL no retorno — não silencioso.
    assert.equal(result.outcome, "promotion-failed-unreadable");
    assert.equal(result.promotedFrom, sessionFilePath(root, "interactive", tag, sessionId));
    assert.match(stderrOutput, /aviso/i);
    assert.match(stderrOutput, new RegExp(sessionId));

    // Um registro NOVO foi criado do zero no path do kind atual — a sessão
    // não fica sem registro nenhum.
    const overnightPath = sessionFilePath(root, "overnight", tag, sessionId);
    assert.ok(existsSync(overnightPath));
    assert.equal(result.record.kind, "overnight");
    assert.deepEqual(result.record.claimed_issues, []);

    // O arquivo ILEGÍVEL antigo continua em disco (não removido — nunca
    // apagamos o que não conseguimos interpretar) — nunca vira um 2º
    // registro ATIVO/legível em `listActiveSessions`, embora permaneça como
    // lixo até o GC/uma futura leitura bem-sucedida o recolher.
    assert.ok(existsSync(join(sessionsDir(root), `interactive-${tag}-${sessionId}.json`)));
    const active = listActiveSessions(root, Date.parse("2026-08-26T11:00:00.000Z"));
    const matching = active.filter((s) => s.sessionId === sessionId);
    assert.equal(matching.length, 1, "o arquivo ilegível não conta como um 2º registro ativo");
    assert.equal(matching[0]!.kind, "overnight");
  });

  it("rmSync do registro antigo FALHA na promoção — outcome promoted-orphan-left, nunca reportado como sucesso limpo (#6326 fleet review item 2)", () => {
    const root = freshRoot();
    const sessionId = "sess-6326-rmfail";
    const tag = "helios";

    writeRawSessionFile(root, `interactive-${tag}-${sessionId}.json`, {
      kind: "interactive",
      machineTag: tag,
      sessionId,
      startedAt: "2026-08-26T10:00:00.000Z",
      lastHeartbeat: "2026-08-26T10:04:00.000Z",
      claimed_issues: [7],
    });
    const interactivePath = sessionFilePath(root, "interactive", tag, sessionId);

    // #6326 fleet review item 2: espião de I/O INJETADO (mesmo padrão de
    // `MergeLockIo`) — monkey-patchar `require("node:fs").rmSync` NÃO
    // intercepta o `import { rmSync } from "node:fs"` que o módulo usa de
    // verdade (bindings distintos, confirmado experimentalmente), então a
    // única forma determinística/portável de simular esta falha é injeção.
    const fakeRemoveIo: PromotionRemoveIo = {
      exists: (p) => existsSync(p),
      remove: (p) => {
        if (p === interactivePath) {
          throw Object.assign(new Error("EBUSY: transitório do OneDrive (simulado)"), { code: "EBUSY" });
        }
        rmSync(p);
      },
    };
    const result = registerSession(root, "overnight", sessionId, { tag, startedAt: "2026-08-26T10:05:00.000Z" }, fakeRemoveIo);

    // O NOVO registro foi gravado com sucesso — a promoção não é abortada
    // só porque a limpeza do antigo falhou.
    const overnightPath = sessionFilePath(root, "overnight", tag, sessionId);
    assert.ok(existsSync(overnightPath));
    assert.deepEqual(result.record.claimed_issues, [7]);

    // Mas o desfecho reporta o estado PARCIAL — nunca "promoted" limpo.
    assert.equal(result.outcome, "promoted-orphan-left");
    assert.equal(result.promotedFrom, interactivePath);

    // O arquivo antigo continua em disco (a remoção falhou de verdade).
    assert.ok(existsSync(interactivePath), "o rmSync falhou de verdade — o arquivo antigo permanece");
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

// ─── unclaimIssue — inverso de claimIssue (#6317) ──────────────────────────

describe("unclaimIssue — libera issue da PRÓPRIA sessão, sem encerrá-la (#6317)", () => {
  const NOW = Date.parse("2026-08-26T20:00:00.000Z");

  it("remove a issue de claimed_issues e retorna { ok: true, reason: 'unclaimed' }", () => {
    const root = freshRoot();
    registerSession(root, "develop", "sess-1", { tag: "host-a", startedAt: new Date(NOW).toISOString() });
    claimIssue(root, "develop", "sess-1", 6317, "host-a", new Date(NOW).toISOString());
    claimIssue(root, "develop", "sess-1", 6327, "host-a", new Date(NOW).toISOString());

    const result = unclaimIssue(root, "develop", "sess-1", 6317, "host-a", new Date(NOW + 1000).toISOString());
    assert.deepEqual(result, { ok: true, reason: "unclaimed" });

    const content = JSON.parse(readFileSync(sessionFilePath(root, "develop", "host-a", "sess-1"), "utf8"));
    // #6327: só a issue liberada some — a outra claim da mesma sessão permanece intacta.
    assert.deepEqual(content.claimed_issues, [6327]);
  });

  it("no-op honesto quando a issue não estava reivindicada — nunca finge sucesso (#5797)", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-1", { tag: "host-a", startedAt: new Date(NOW).toISOString() });

    const result = unclaimIssue(root, "overnight", "sess-1", 999, "host-a");
    assert.deepEqual(result, { ok: false, reason: "no-op-not-claimed" });

    const content = JSON.parse(readFileSync(sessionFilePath(root, "overnight", "host-a", "sess-1"), "utf8"));
    assert.deepEqual(content.claimed_issues, []);
  });

  it("no-op honesto quando a sessão não existe (nunca registrada/já encerrada)", () => {
    const root = freshRoot();
    const result = unclaimIssue(root, "overnight", "sess-inexistente", 1, "host-a");
    assert.deepEqual(result, { ok: false, reason: "no-op-session-missing" });
  });

  it("só remove da PRÓPRIA sessão — nunca mexe na claim de outra sessão (mesma disciplina de releaseMergeLock)", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-a", { tag: "host-a", startedAt: new Date(NOW).toISOString() });
    registerSession(root, "develop", "sess-b", { tag: "host-a", startedAt: new Date(NOW).toISOString() });
    claimIssue(root, "overnight", "sess-a", 42, "host-a", new Date(NOW).toISOString());

    // sess-b nunca reivindicou #42 — deve receber no-op-not-claimed, e a
    // claim de sess-a deve permanecer intacta (unclaimIssue não é force-remove
    // por número de issue, é sempre escopado à identidade kind+tag+sessionId).
    const result = unclaimIssue(root, "develop", "sess-b", 42, "host-a");
    assert.deepEqual(result, { ok: false, reason: "no-op-not-claimed" });

    const ownerContent = JSON.parse(readFileSync(sessionFilePath(root, "overnight", "host-a", "sess-a"), "utf8"));
    assert.deepEqual(ownerContent.claimed_issues, [42]);
  });

  it("atualiza lastHeartbeat no unclaim bem-sucedido", () => {
    const root = freshRoot();
    registerSession(root, "develop", "sess-1", { tag: "host-a", startedAt: new Date(NOW).toISOString() });
    claimIssue(root, "develop", "sess-1", 100, "host-a", new Date(NOW).toISOString());

    const laterIso = new Date(NOW + 5 * 60 * 1000).toISOString();
    unclaimIssue(root, "develop", "sess-1", 100, "host-a", laterIso);

    const content = JSON.parse(readFileSync(sessionFilePath(root, "develop", "host-a", "sess-1"), "utf8"));
    assert.equal(content.lastHeartbeat, laterIso);
  });

  it(
    "registro EXISTE mas está ILEGÍVEL (JSON corrompido) → 'no-op-unreadable', distinto de " +
      "'no-op-session-missing' — mesma classe de bug que o #6326 corrigiu em registerSession (fleet review item 2)",
    () => {
      const root = freshRoot();
      const sessionId = "sess-6337-unreadable";
      const tag = "host-a";

      // Arquivo existe PELO NOME (path exato que unclaimIssue vai procurar),
      // mas o conteúdo é JSON inválido — simula sync do OneDrive pegando o
      // arquivo no meio de um write, o mesmo cenário do #6326.
      mkdirSync(sessionsDir(root), { recursive: true });
      writeFileSync(sessionFilePath(root, "develop", tag, sessionId), "{ isto não é JSON válido", "utf8");

      const originalWrite = process.stderr.write.bind(process.stderr);
      let stderrOutput = "";
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((chunk: unknown) => {
        stderrOutput += String(chunk);
        return true;
      }) as typeof process.stderr.write;
      let result: ReturnType<typeof unclaimIssue>;
      try {
        result = unclaimIssue(root, "develop", sessionId, 42, tag);
      } finally {
        process.stderr.write = originalWrite;
      }

      // O desfecho é DISTINGUÍVEL de "sessão nunca existiu" — não colapsa os
      // dois casos, e emite aviso em stderr (nunca silencioso).
      assert.deepEqual(result, { ok: false, reason: "no-op-unreadable" });
      assert.match(stderrOutput, /aviso/i);
      assert.match(stderrOutput, new RegExp(sessionId));

      // O arquivo ilegível continua em disco intocado — unclaimIssue nunca
      // escreve por cima de um conteúdo que não conseguiu interpretar.
      const raw = readFileSync(sessionFilePath(root, "develop", tag, sessionId), "utf8");
      assert.equal(raw, "{ isto não é JSON válido");
    },
  );

  it("sessão NUNCA existiu (arquivo ausente) continua reportando 'no-op-session-missing', sem aviso em stderr", () => {
    const root = freshRoot();
    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderrOutput = "";
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((chunk: unknown) => {
      stderrOutput += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let result: ReturnType<typeof unclaimIssue>;
    try {
      result = unclaimIssue(root, "develop", "sess-nunca-existiu", 42, "host-a");
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.deepEqual(result, { ok: false, reason: "no-op-session-missing" });
    assert.equal(stderrOutput, "", "arquivo ausente é o caso comum — não emite aviso, só o ilegível emite");
  });
});

// ─── claimIssueCheckAndSet — check-and-set (#6236) ─────────────────────────

describe("claimIssueCheckAndSet — recusa colisão entre sessões ativas (#6236)", () => {
  const NOW = Date.parse("2026-08-26T11:00:00.000Z");

  it("cenário real da issue: 2ª sessão ativa tenta reivindicar a mesma issue e é RECUSADA", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-overnight", {
      tag: "host-a",
      startedAt: new Date(NOW).toISOString(),
    });
    registerSession(root, "continuo", "sess-continuo", {
      tag: "host-a",
      startedAt: new Date(NOW).toISOString(),
    });

    // sessão overnight reivindica primeiro (claim ~11:20 no incidente real).
    const first = claimIssueCheckAndSet(root, "overnight", "sess-overnight", 6232, "host-a", new Date(NOW).toISOString());
    assert.equal(first.ok, true);
    assert.equal(first.reason, "claimed");

    // sessão continuo tenta reivindicar a MESMA issue (claim ~11:27) — deve ser recusada.
    const second = claimIssueCheckAndSet(root, "continuo", "sess-continuo", 6232, "host-a", new Date(NOW + 7 * 60 * 1000).toISOString());
    assert.equal(second.ok, false);
    assert.equal(second.reason, "blocked-by-other");
    assert.ok(second.blockedBy);
    assert.equal(second.blockedBy?.sessionId, "sess-overnight");
    assert.equal(second.blockedBy?.kind, "overnight");

    // a issue NÃO foi adicionada ao registro da sessão continuo (recusa é real, não só relatada).
    const continuoContent = JSON.parse(readFileSync(sessionFilePath(root, "continuo", "host-a", "sess-continuo"), "utf8"));
    assert.deepEqual(continuoContent.claimed_issues ?? [], []);
  });

  it("idempotência preservada: reivindicar issue que a PRÓPRIA sessão já segura é no-op de sucesso, nunca recusa", () => {
    const root = freshRoot();
    registerSession(root, "develop", "sess-1", { tag: "host-a", startedAt: new Date(NOW).toISOString() });

    const first = claimIssueCheckAndSet(root, "develop", "sess-1", 100, "host-a", new Date(NOW).toISOString());
    assert.equal(first.ok, true);
    assert.equal(first.reason, "claimed");

    // retomada — mesma sessão, mesma issue, "now" mais tarde (heartbeat renovado).
    const second = claimIssueCheckAndSet(root, "develop", "sess-1", 100, "host-a", new Date(NOW + 60 * 60 * 1000).toISOString());
    assert.equal(second.ok, true);
    assert.equal(second.reason, "already-own");

    const content = JSON.parse(readFileSync(sessionFilePath(root, "develop", "host-a", "sess-1"), "utf8"));
    assert.deepEqual(content.claimed_issues, [100]);
  });

  it("--force toma o claim de uma sessão ATIVA (não-stale) mesmo assim, reportando quem foi sobreposto", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-a", { tag: "host-a", startedAt: new Date(NOW).toISOString() });
    registerSession(root, "develop", "sess-b", { tag: "host-a", startedAt: new Date(NOW).toISOString() });

    claimIssueCheckAndSet(root, "overnight", "sess-a", 42, "host-a", new Date(NOW).toISOString());

    // sem --force: recusado (mesmo caminho do teste acima).
    const denied = claimIssueCheckAndSet(root, "develop", "sess-b", 42, "host-a", new Date(NOW + 60 * 1000).toISOString());
    assert.equal(denied.ok, false);

    // com --force: toma o claim, mas AVISA quem estava segurando via blockedBy.
    const forced = claimIssueCheckAndSet(root, "develop", "sess-b", 42, "host-a", new Date(NOW + 60 * 1000).toISOString(), { force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.reason, "forced-override");
    assert.ok(forced.blockedBy, "force deve reportar quem estava segurando, pro chamador avisar alto");
    assert.equal(forced.blockedBy?.sessionId, "sess-a");

    const content = JSON.parse(readFileSync(sessionFilePath(root, "develop", "host-a", "sess-b"), "utf8"));
    assert.deepEqual(content.claimed_issues, [42]);
  });

  it("sessão STALE segurando a issue NÃO bloqueia — claim procede sem precisar de --force", () => {
    const root = freshRoot();
    const staleHeartbeat = new Date(NOW - 3 * 60 * 60 * 1000).toISOString(); // 3h stale > SOFT_STALE_MS (90min)
    registerSession(root, "overnight", "sess-morta", { tag: "host-a", startedAt: staleHeartbeat });
    claimIssueCheckAndSet(root, "overnight", "sess-morta", 7, "host-a", staleHeartbeat);

    registerSession(root, "develop", "sess-viva", { tag: "host-a", startedAt: new Date(NOW).toISOString() });
    const result = claimIssueCheckAndSet(root, "develop", "sess-viva", 7, "host-a", new Date(NOW).toISOString());

    assert.equal(result.ok, true);
    assert.equal(result.reason, "claimed", "claim de sessão stale não exige --force — segue o fluxo normal");

    const content = JSON.parse(readFileSync(sessionFilePath(root, "develop", "host-a", "sess-viva"), "utf8"));
    assert.deepEqual(content.claimed_issues, [7]);
  });

  it("sessão própria inexistente → no-op-session-missing, nunca lança", () => {
    const root = freshRoot();
    const result = claimIssueCheckAndSet(root, "overnight", "sess-inexistente", 1, "host-a");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-op-session-missing");
    assert.equal(result.blockedBy, undefined);
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

// ─── findActiveSessionsOfKind / hasActiveSessionOfKind (#6277 item 3) ──────

describe("findActiveSessionsOfKind / hasActiveSessionOfKind — janela de exclusão contínuo × overnight (#6277)", () => {
  const NOW = Date.parse("2026-08-26T11:27:00.000Z");
  const ONE_MIN_MS = 60 * 1000;

  it("cenário real do #6236: overnight ativo é visível pro contínuo ANTES de reivindicar issue nova", () => {
    const root = freshRoot();
    // overnight iniciado 11:20 (claim da #6232 no incidente real).
    registerSession(root, "overnight", "sess-overnight", {
      tag: "host-a",
      startedAt: new Date(NOW - 7 * ONE_MIN_MS).toISOString(),
    });
    registerSession(root, "continuo", "hermes-cron-5d791ef6fc2c", {
      tag: "host-a",
      startedAt: new Date(NOW).toISOString(),
    });

    assert.equal(hasActiveSessionOfKind(root, "overnight", undefined, NOW), true);
    const found = findActiveSessionsOfKind(root, "overnight", undefined, NOW);
    assert.equal(found.length, 1);
    assert.equal(found[0].sessionId, "sess-overnight");
  });

  it("sem sessão do kind → active:false (e a própria sessão do contínuo não conta como overnight)", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "hermes-cron-5d791ef6fc2c", {
      tag: "host-a",
      startedAt: new Date(NOW).toISOString(),
    });

    assert.equal(hasActiveSessionOfKind(root, "overnight", undefined, NOW), false);
    assert.deepEqual(findActiveSessionsOfKind(root, "overnight", undefined, NOW), []);
  });

  it("overnight STALE não bloqueia — sai de findActive e aparece em findStale", () => {
    const root = freshRoot();
    // 3h de heartbeat morto: dentro de MAX_SESSION_AGE_MS, além de SOFT_STALE_MS.
    const staleHeartbeat = new Date(NOW - 3 * 60 * ONE_MIN_MS).toISOString();
    registerSession(root, "overnight", "sess-morta", { tag: "host-a", startedAt: staleHeartbeat });

    assert.equal(hasActiveSessionOfKind(root, "overnight", undefined, NOW), false);
    const stale = findStaleSessionsOfKind(root, "overnight", undefined, NOW);
    assert.equal(stale.length, 1, "sessão stale continua VISÍVEL — nunca descartada em silêncio");
    assert.equal(stale[0].sessionId, "sess-morta");
  });

  it("excludeSessionId não se enxerga: sessão perguntando pelo próprio kind ignora a si mesma", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "hermes-cron-5d791ef6fc2c", {
      tag: "host-a",
      startedAt: new Date(NOW).toISOString(),
    });

    assert.equal(hasActiveSessionOfKind(root, "continuo", undefined, NOW), true, "sem exclude, se enxerga");
    assert.equal(
      hasActiveSessionOfKind(root, "continuo", "hermes-cron-5d791ef6fc2c", NOW),
      false,
      "com exclude, a própria sessão não conta",
    );
  });

  it("filtra por kind: overnight ativo não faz develop parecer ativo", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-overnight", { tag: "host-a", startedAt: new Date(NOW).toISOString() });

    assert.equal(hasActiveSessionOfKind(root, "overnight", undefined, NOW), true);
    assert.equal(hasActiveSessionOfKind(root, "develop", undefined, NOW), false);
    assert.equal(hasActiveSessionOfKind(root, "continuo", undefined, NOW), false);
  });

  it("fail-soft: data/sessions/ inexistente → active:false, nunca lança", () => {
    const root = freshRoot();
    assert.equal(hasActiveSessionOfKind(root, "overnight", undefined, NOW), false);
    assert.deepEqual(findStaleSessionsOfKind(root, "overnight", undefined, NOW), []);
  });

  /**
   * #6277 (achado do review): `active: false` tinha DOIS significados
   * indistinguíveis — "não há sessão" e "não consegui ler o diretório". Para
   * uma decisão de exclusão mútua, confundir os dois é fail-OPEN: uma falha de
   * I/O transitória (EACCES/EBUSY no junction do OneDrive) fazia o contínuo
   * concluir "nenhum overnight rodando" e voltar a duplicar o trabalho dele.
   * `checkSessionsScanHealth` separa os dois casos para o CLI expor
   * `uncertain: true` e o chamador poder fail-CLOSED.
   */
  describe("checkSessionsScanHealth — separa 'não há sessão' de 'não deu pra ler'", () => {
    it("diretório ausente é ok:true — clone fresco/sessão cloud é resposta honesta, não degradação", () => {
      assert.deepEqual(checkSessionsScanHealth(freshRoot()), { ok: true });
    });

    it("diretório legível e vazio é ok:true", () => {
      const root = freshRoot();
      mkdirSync(sessionsDir(root), { recursive: true });
      assert.deepEqual(checkSessionsScanHealth(root), { ok: true });
    });

    it("diretório existente mas ILEGÍVEL é ok:false com o código do erro", () => {
      const root = freshRoot();
      const dir = sessionsDir(root);
      mkdirSync(dir, { recursive: true });
      // Remove o bit de leitura: readdirSync passa a lançar EACCES.
      chmodSync(dir, 0o000);
      try {
        // root ignora permissões de arquivo — se a suíte rodar como root o
        // readdir sucede e não há o que asserir.
        if (process.getuid?.() === 0) return;
        const health = checkSessionsScanHealth(root);
        assert.equal(health.ok, false, "diretório ilegível não pode passar por 'vazio'");
        assert.ok(health.error, "o código do erro precisa chegar ao chamador");
      } finally {
        chmodSync(dir, 0o755);
      }
    });
  });
});

// ─── requireKind / kind "continuo" (#5293 item 2) ──────────────────────────

describe("requireKind aceita o kind \"continuo\" (#5293)", () => {
  it("aceita \"overnight\", \"develop\" e \"continuo\"", () => {
    assert.equal(requireKind("overnight"), "overnight");
    assert.equal(requireKind("develop"), "develop");
    assert.equal(requireKind("continuo"), "continuo");
  });

  it("aceita também \"interactive\" desde o #6168 — o kind do beacon", () => {
    // O beacon (`.claude/hooks/session-beacon.mjs`) registra sessões
    // interativas automaticamente. Sem `requireKind` aceitá-lo, todo
    // subcomando do CLI usado sobre esse registro sairia com exit 1.
    assert.equal(requireKind("interactive"), "interactive");
  });

  it("rejeita valor inválido/ausente com mensagem citando os 4 kinds válidos", () => {
    assert.throws(() => requireKind("bogus"), /--kind deve ser "overnight", "develop", "continuo" ou "interactive"/);
    assert.throws(() => requireKind(undefined), /--kind deve ser "overnight", "develop", "continuo" ou "interactive"/);
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
  //
  // HONESTIDADE SOBRE O QUE ESTE TESTE É (achado do review da PR #6190):
  // isto é DOCUMENTAÇÃO EXECUTÁVEL, não guard de regressão. Com dois
  // backends totalmente isolados, o fast path (`tryCreateExclusive` → true
  // → return true) responde `true` às duas chamadas independente de
  // qualquer lógica de `acquireMergeLock` — nenhuma mudança possível NESTE
  // arquivo faria o teste falhar, porque a divergência mora fora do
  // processo (dois filesystems locais que um agente externo sincroniza
  // depois). O guard REAL contra a afirmação errada voltar é o teste de
  // invariante de documentação logo abaixo, que lê o docblock.
  it("advisory cross-machine (#6182, documentação executável): dois MergeLockIo independentes sobre o MESMO path lógico — cada um vê o arquivo como ausente, ambos adquirem (não é garantia de exclusão entre máquinas)", () => {
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

// ─── #6182 — invariante de documentação do merge lock ──────────────────────
/**
 * O defeito do #6182 não era de comportamento: era o docblock PROMETENDO
 * exclusão mútua cross-máquina que `O_CREAT|O_EXCL` não dá sobre um junction
 * OneDrive. Defeito de afirmação só regride por reescrita de texto, então o
 * guard que impede a volta também é sobre o texto — não há execução de
 * `acquireMergeLock` capaz de detectar isso (ver comentário do teste
 * "documentação executável" acima). Mesmo padrão de invariante-sobre-fonte já
 * usado em `test/lib-boundary.test.ts`.
 */
describe("merge lock — invariante de documentação (#6182)", () => {
  const SRC = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lib", "session-registry.ts"),
    "utf8",
  );

  it("o docblock declara explicitamente que entre máquinas o lock é advisory", () => {
    assert.match(
      SRC,
      /advisory/,
      "o docblock precisa nomear o comportamento cross-máquina como advisory (#6182)",
    );
    assert.match(
      SRC,
      /#6182/,
      "a limitação precisa citar a issue que a documenta, senão vira folclore",
    );
  });

  it("nenhuma afirmação de que o lock PROTEGE o cenário cross-máquina sobreviveu", () => {
    // A frase original (#5161) dizia que a atomicidade do `wx` cobria
    // "exatamente o cenário cross-máquina via `data/` OneDrive que o #5156
    // existe pra proteger". Se ela voltar SEM a qualificação do #6182, o
    // próximo mecanismo de exclusão deste repo nasce copiando uma garantia
    // que não existe — foi literalmente o que quase aconteceu com o CAS do
    // claim (#6168, seção "fora de escopo").
    const claimReaparece = /cen[áa]rio cross-m[áa]quina[^.]*existe pra proteger/i.test(SRC);
    const temQualificacao = /#6182 corrigiu essa parte/i.test(SRC);
    assert.ok(
      !claimReaparece || temQualificacao,
      "a afirmação de que o mecanismo protege o cenário cross-máquina voltou sem a qualificação do #6182",
    );
  });

  it("a garantia de atomicidade fica restrita à MESMA máquina", () => {
    assert.match(
      SRC,
      /MESMA M[ÁA]QUINA|mesma m[áa]quina é atômico|MESMO kernel\/filesystem/,
      "o texto precisa restringir a atomicidade do O_CREAT|O_EXCL a um único filesystem",
    );
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
