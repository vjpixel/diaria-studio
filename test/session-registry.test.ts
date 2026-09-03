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
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync, spawn } from "node:child_process";
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
  claimIssueAutoRegistering,
  unclaimIssue,
  isIssueClaimedByOther,
  findActiveSessionsOfKind,
  findStaleSessionsOfKind,
  hasActiveSessionOfKind,
  checkSessionsScanHealth,
  acquireMergeLock,
  releaseMergeLock,
  renewMergeLock,
  requireKind,
  requireCoordinatorKind,
  parseSessionFileName,
  ALL_SESSION_KINDS,
  mergeSessionRecords,
  isMergeGrantLive,
  findLiveMergeGrant,
  grantMergeWindow,
  consumeMergeGrant,
  machineTag,
  planSessionGc,
  garbageCollectSessions,
  resolveRepoRoot,
  checkRepoTreeClean,
  evaluateEndGuard,
  GC_CONSERVATIVE_MAX_AGE_MS,
  GC_ORPHAN_LIVENESS_MARGIN,
  MAX_SESSION_AGE_MS,
  SOFT_STALE_MS,
  INTERACTIVE_SOFT_STALE_MS,
  CLAIM_RELEASE_MS,
  claimReleaseMsForKind,
  MERGE_LOCK_TTL_MS,
  CLOCK_SKEW_TOLERANCE_MS,
  assessCrossMachineSyncFreshness,
  CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS,
  type MergeLockIo,
  type SessionRecord,
  type MergeGrant,
  type PromotionRemoveIo,
  type ActiveSessionRecord,
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

// ─── resolveRepoRoot (#6372) ────────────────────────────────────────────────
//
// Reproduz o cenário real da issue: `session-registry.ts` rodando com o cwd
// dentro de um `git worktree` vinculado (não o checkout principal) — antes
// do #6372, `main()` resolvia `repoRoot = process.cwd()` e passava a
// operar, em silêncio, sobre um `data/sessions/` fantasma criado dentro do
// próprio worktree. `resolveRepoRoot()` precisa devolver a raiz do checkout
// PRINCIPAL mesmo quando chamado com `cwd` apontando para dentro do
// worktree.

/** `true` só se o `git` do sistema aceitar `--path-format` (>= 2.31) — mesmo
 * guard fail-soft que `resolveRepoRoot`/`resolveSharedLockPath` já assumem
 * em produção. Evita falso-negativo em runners com git muito antigo. */
function gitSupportsPathFormat(): boolean {
  const res = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: tmpdir(),
    encoding: "utf8",
  });
  // Fora de um repo git, o comando ainda deve reconhecer a flag (falha com
  // "not a git repository", não com "unknown option") — status !== 0 aqui é
  // esperado; o que importa é que stderr não reclame da FLAG em si.
  return !/unrecognized|unknown option/i.test(res.stderr ?? "");
}

/** Monta um repo git real em tmpdir + 1 worktree vinculado dele. Retorna os
 * dois paths absolutos (resolvidos via `git rev-parse`, não `join`/`resolve`
 * puro, pra já vir normalizado contra qualquer symlink de `tmpdir()` no SO —
 * mesma preocupação que motivou este teste em primeiro lugar). */
function makeRepoWithWorktree(): { mainRoot: string; worktreeRoot: string } {
  const mainRoot = freshRoot();
  mkdirSync(mainRoot, { recursive: true });
  const run = (args: string[], cwd: string) => {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(res.status, 0, `git ${args.join(" ")} falhou: ${res.stderr}`);
    return res.stdout;
  };
  run(["init", "-q", "-b", "main"], mainRoot);
  run(["config", "user.email", "test@example.com"], mainRoot);
  run(["config", "user.name", "Test"], mainRoot);
  run(["commit", "-q", "--allow-empty", "-m", "init"], mainRoot);
  const resolvedMainRoot = run(
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    mainRoot,
  ).trim();

  const worktreeRoot = join(tmpdir(), `session-registry-test-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(worktreeRoot);
  run(["worktree", "add", "-q", worktreeRoot, "-b", "wt-branch"], mainRoot);

  return { mainRoot: resolvedMainRoot, worktreeRoot };
}

describe("resolveRepoRoot — resolve o checkout PRINCIPAL, nunca o worktree/cwd (#6372)", { skip: !gitSupportsPathFormat() }, () => {
  it("a partir do checkout principal, devolve o próprio checkout principal", () => {
    const { mainRoot } = makeRepoWithWorktree();
    assert.equal(resolveRepoRoot(mainRoot), mainRoot);
  });

  it("a partir de um worktree vinculado, devolve o checkout PRINCIPAL — não o worktree (regressão #6372)", () => {
    const { mainRoot, worktreeRoot } = makeRepoWithWorktree();
    const resolved = resolveRepoRoot(worktreeRoot);
    assert.equal(resolved, mainRoot);
    assert.notEqual(
      resolved,
      worktreeRoot,
      "resolveRepoRoot não pode devolver o worktree — é exatamente o bug do #6372 " +
        "(data/sessions/ fantasma criado dentro do worktree)",
    );
  });

  it("fail-soft: fora de qualquer repo git, cai pro próprio cwd passado", () => {
    const notARepo = join(tmpdir(), `session-registry-test-not-a-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(notARepo, { recursive: true });
    roots.push(notARepo);
    assert.equal(resolveRepoRoot(notARepo), notARepo);
  });
});

// ─── checkRepoTreeClean / evaluateEndGuard (#6922) ─────────────────────────
//
// Regressão: um tick de `/diaria-continuo` reportou "concluído" (26/08) e de
// novo em 01/09 (#6952, 498 linhas) com trabalho não commitado solto no
// checkout compartilhado — o `end` do tick não encontrou nenhum obstáculo
// mecânico, só a prosa do SKILL.md pedindo pra checar `git status` antes de
// encerrar. Estes testes travam que, a partir de agora, uma árvore suja é
// detectada e bloqueia o `end` por padrão.

function initGitRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  const run = (args: string[]) => {
    const res = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(res.status, 0, `git ${args.join(" ")} falhou: ${res.stderr}`);
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["commit", "-q", "--allow-empty", "-m", "init"]);
}

describe("checkRepoTreeClean — #6922", { skip: !gitSupportsPathFormat() }, () => {
  it("árvore limpa logo após o init: clean: true, files vazio", () => {
    const root = freshRoot();
    initGitRepo(root);
    assert.deepEqual(checkRepoTreeClean(root), { clean: true, files: [] });
  });

  it("arquivo não rastreado deixa a árvore suja: clean: false, files não-vazio", () => {
    const root = freshRoot();
    initGitRepo(root);
    writeFileSync(join(root, "trabalho-nao-commitado.txt"), "498 linhas soltas\n");
    const result = checkRepoTreeClean(root);
    assert.equal(result.clean, false);
    assert.equal(result.files.length, 1);
    assert.match(result.files[0], /trabalho-nao-commitado\.txt/);
  });

  it("fail-soft: fora de repo git nenhum, devolve clean: true (nunca bloqueia por checagem que não rodou)", () => {
    const notARepo = join(tmpdir(), `session-registry-test-tree-not-a-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(notARepo, { recursive: true });
    roots.push(notARepo);
    assert.deepEqual(checkRepoTreeClean(notARepo), { clean: true, files: [] });
  });
});

describe("evaluateEndGuard — #6922", { skip: !gitSupportsPathFormat() }, () => {
  it("árvore limpa: ok: true, sem mensagem", () => {
    const root = freshRoot();
    initGitRepo(root);
    assert.deepEqual(evaluateEndGuard(root, false), { ok: true });
  });

  it("árvore suja + allowDirty: false + arquivo sujo EM touched_paths/dirty_paths — recusa e nomeia o(s) arquivo(s)", () => {
    const root = freshRoot();
    initGitRepo(root);
    writeFileSync(join(root, "trabalho-nao-commitado.txt"), "conteúdo\n");
    const result = evaluateEndGuard(root, false, ["trabalho-nao-commitado.txt"]);
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /RECUSADO/);
    assert.match(result.message ?? "", /trabalho-nao-commitado\.txt/);
  });

  it("árvore suja + allowDirty: true (--allow-dirty explícito) — bypassa, ok: true mesmo com ownPaths casando", () => {
    const root = freshRoot();
    initGitRepo(root);
    writeFileSync(join(root, "trabalho-nao-commitado.txt"), "conteúdo\n");
    assert.deepEqual(evaluateEndGuard(root, true, ["trabalho-nao-commitado.txt"]), { ok: true });
  });

  // Regressão (finding do review do coordenador em #6997/#6922): a sujeira
  // do checkout compartilhado quase nunca é da sessão que está encerrando
  // (#6168 é a norma, não a exceção) — recusar por sujeira ALHEIA agrava
  // #6623/#6624 (claims presas sem quem digite --allow-dirty). O `end` só
  // pode recusar quando a sujeira intersecta touched_paths/dirty_paths da
  // PRÓPRIA sessão.
  it("árvore suja SÓ com arquivo fora de touched_paths/dirty_paths da sessão — prossegue (ok: true) com aviso", () => {
    const root = freshRoot();
    initGitRepo(root);
    writeFileSync(join(root, "arquivo-de-outra-sessao.txt"), "sujeira alheia\n");
    const result = evaluateEndGuard(root, false, ["scripts/lib/algo-que-esta-sessao-tocou.ts"]);
    assert.equal(result.ok, true);
    assert.match(result.warning ?? "", /arquivo-de-outra-sessao\.txt/);
    assert.match(result.warning ?? "", /OUTRA sessão/);
  });

  it("sem ownPaths (registro sem beacon, ou nenhum passado) — nunca atribui a si, sempre prossegue avisando", () => {
    const root = freshRoot();
    initGitRepo(root);
    writeFileSync(join(root, "trabalho-nao-commitado.txt"), "conteúdo\n");
    const result = evaluateEndGuard(root, false);
    assert.equal(result.ok, true);
    assert.ok(result.warning);
  });

  it("sujeira mista (própria + alheia) — recusa citando só a própria, mas menciona a contagem de alheia", () => {
    const root = freshRoot();
    initGitRepo(root);
    writeFileSync(join(root, "meu-arquivo.txt"), "meu trabalho\n");
    writeFileSync(join(root, "arquivo-de-outra-sessao.txt"), "sujeira alheia\n");
    const result = evaluateEndGuard(root, false, ["meu-arquivo.txt"]);
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /meu-arquivo\.txt/);
    assert.doesNotMatch(result.message ?? "", /arquivo-de-outra-sessao\.txt/);
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

// ─── #6624 — instrumentação do ciclo de vida de sessão coordenadora ────────
// Investigação: "sessões coordenadoras terminam sem chamar `end` com que
// frequência?". `endSession`/`garbageCollectSessions` gravam eventos em
// `data/session-lifecycle.jsonl` — este bloco cobre a ESCRITA (o miolo de
// leitura/agregação está em test/session-lifecycle-report.test.ts).

describe("instrumentação de ciclo de vida (#6624)", () => {
  function lifecycleLogPath(root: string): string {
    return join(root, "data", "session-lifecycle.jsonl");
  }
  function readLifecycleEvents(root: string): Array<Record<string, unknown>> {
    if (!existsSync(lifecycleLogPath(root))) return [];
    return readFileSync(lifecycleLogPath(root), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  it("endSession de sessão COORDENADORA grava evento 'ended'", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-6624a", { tag: "host-a", startedAt: "2026-08-28T10:00:00.000Z" });
    endSession(root, "overnight", "sess-6624a", "host-a");

    const events = readLifecycleEvents(root);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, "ended");
    assert.equal(events[0]!.kind, "overnight");
    assert.equal(events[0]!.sessionId, "sess-6624a");
    assert.ok(typeof events[0]!.ageMs === "number" && (events[0]!.ageMs as number) > 0);
  });

  it("endSession de sessão INTERACTIVE não grava nada — só coordenadora é instrumentada", () => {
    const root = freshRoot();
    registerSession(root, "interactive", "sess-6624b", { tag: "host-a" });
    endSession(root, "interactive", "sess-6624b", "host-a");
    assert.equal(readLifecycleEvents(root).length, 0);
  });

  it("endSession que não remove nada (sessão já ausente) não grava evento", () => {
    const root = freshRoot();
    endSession(root, "develop", "sess-inexistente-6624", "host-a");
    assert.equal(readLifecycleEvents(root).length, 0);
  });

  it("garbageCollectSessions removendo um grupo coordenador VIVO-demais (sem end) grava 'gc-removed-without-end'", () => {
    const root = freshRoot();
    const veryOld = new Date(Date.parse("2026-08-28T12:00:00.000Z") - GC_CONSERVATIVE_MAX_AGE_MS - 1000).toISOString();
    registerSession(root, "develop", "sess-6624c", { tag: "outra-maquina", startedAt: veryOld });
    // heartbeat também precisa estar velho — registerSession já usa startedAt como heartbeat inicial.

    garbageCollectSessions(root, { now: Date.parse("2026-08-28T12:00:00.000Z"), isPidAlive: () => false });

    const events = readLifecycleEvents(root);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, "gc-removed-without-end");
    assert.equal(events[0]!.kind, "develop");
    assert.equal(events[0]!.sessionId, "sess-6624c");
  });

  it("GC removendo um backup ÓRFÃO (grupo já sem real — sessão que JÁ chamou end) não grava 'gc-removed-without-end'", () => {
    // Distinção central do #6624: um backup órfão é resíduo de uma sessão
    // que já terminou LIMPO (endSession removeu o real; o backup sobrou por
    // conflito do OneDrive) — não é o caso "nunca chamou end".
    const root = freshRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    const veryOld = new Date(Date.parse("2026-08-28T12:00:00.000Z") - GC_CONSERVATIVE_MAX_AGE_MS - 1000).toISOString();
    writeFileSync(
      join(sessionsDir(root), "develop-outra-maquina-sess-orfa-safeBackup-0001.json"),
      JSON.stringify({ kind: "develop", machineTag: "outra-maquina", sessionId: "sess-orfa", startedAt: veryOld, lastHeartbeat: veryOld }),
      "utf8",
    );

    garbageCollectSessions(root, { now: Date.parse("2026-08-28T12:00:00.000Z"), isPidAlive: () => false });

    assert.equal(readLifecycleEvents(root).length, 0, "backup órfão removido não é 'sem end' — já teve um end limpo");
  });

  it("GC de sessão INTERACTIVE removida por staleness não grava evento — só coordenadora é instrumentada", () => {
    const root = freshRoot();
    const veryOld = new Date(Date.parse("2026-08-28T12:00:00.000Z") - GC_CONSERVATIVE_MAX_AGE_MS - 1000).toISOString();
    registerSession(root, "interactive", "sess-6624d", { tag: "outra-maquina", startedAt: veryOld });

    garbageCollectSessions(root, { now: Date.parse("2026-08-28T12:00:00.000Z"), isPidAlive: () => false });

    assert.equal(readLifecycleEvents(root).length, 0);
  });

  it("data/ ausente: endSession/garbageCollectSessions nunca lançam por causa do logger (fail-soft)", () => {
    const root = freshRoot(); // nunca criou data/sessions/ — nada registrado
    assert.doesNotThrow(() => endSession(root, "overnight", "sess-6624e", "host-a"));
    assert.doesNotThrow(() => garbageCollectSessions(root, { now: Date.now() }));
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

  it("#7028: rmSync falha na promoção — o registro antigo órfão é carimbado com endedAt, e listActiveSessions não conta 2 sessões", () => {
    const root = freshRoot();
    const sessionId = "sess-7028-endedat";
    const tag = "helios";

    writeRawSessionFile(root, `overnight-${tag}-${sessionId}.json`, {
      kind: "overnight",
      machineTag: tag,
      sessionId,
      startedAt: "2026-09-01T22:16:11.124Z",
      lastHeartbeat: "2026-09-01T23:28:09.835Z",
      claimed_issues: [6831, 6842],
      merge_grant: { grantedBy: sessionId, grantedTo: "outra-sessao", grantedAt: "2026-09-01T23:00:00.000Z" },
    });
    const overnightPath = sessionFilePath(root, "overnight", tag, sessionId);

    const fakeRemoveIo: PromotionRemoveIo = {
      exists: (p) => existsSync(p),
      remove: (p) => {
        if (p === overnightPath) {
          throw Object.assign(new Error("EBUSY: transitório do OneDrive (simulado)"), { code: "EBUSY" });
        }
        rmSync(p);
      },
    };
    const result = registerSession(
      root,
      "interactive",
      sessionId,
      { tag, startedAt: "2026-09-01T23:28:12.447Z" },
      fakeRemoveIo,
    );

    // Remoção falhou de verdade — mesmo comportamento best-effort de sempre.
    assert.equal(result.outcome, "promoted-orphan-left");
    assert.ok(existsSync(overnightPath), "rmSync falhou — o arquivo antigo permanece em disco");

    // Mas o CONTEÚDO do órfão agora carrega endedAt — a claim/grant continuam
    // no JSON (não apagados), só marcados como não-vivos.
    const orphan = JSON.parse(readFileSync(overnightPath, "utf8")) as SessionRecord;
    assert.equal(typeof orphan.endedAt, "string", "órfão deveria carregar endedAt");
    assert.deepEqual(orphan.claimed_issues, [6831, 6842], "claims do órfão preservadas no disco, não apagadas");

    // listActiveSessions, ~57min depois (dentro de SOFT_STALE_MS mas fora de
    // INTERACTIVE_SOFT_STALE_MS), enxerga só 1 sessão — a interactive VIVA —
    // não o órfão overnight congelado. Antes do #7028, o órfão sem endedAt
    // venceria como base por isCoordinatorKind, mostrando kind=overnight com
    // heartbeat morto e nunca stale (SOFT_STALE_MS=90min ainda não bateu).
    const now = Date.parse("2026-09-02T00:25:00.000Z");
    const sessions = listActiveSessions(root, now).filter((s) => s.sessionId === sessionId);
    assert.equal(sessions.length, 1, "o órfão carimbado não conta como uma 2ª sessão ativa");
    assert.equal(sessions[0]!.kind, "interactive", "a sessão viva de verdade é a interactive, não o órfão overnight");
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
    //
    // #7002: o `endedAt` no fixture não é enfeite — é o que `endSession`
    // passou a carimbar em cada cópia do grupo ANTES de remover o arquivo
    // real, e é o único sinal que distingue "encerrada limpo" (este caso, o
    // do #5427) de "a âncora sumiu com a sessão VIVA" (promovida de volta,
    // ver o describe do #7002 abaixo). As duas produzem a MESMA forma em
    // disco — backup sem arquivo real —, então sem o carimbo o read-path não
    // tem como escolher, e escolher errado é falso-negativo de claim.
    writeFileSync(
      join(sessionsDir(root), "develop-host-a-sess-encerrada-safeBackup-1.json"),
      JSON.stringify({
        kind: "develop",
        machineTag: "host-a",
        sessionId: "sess-encerrada",
        startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
        lastHeartbeat: new Date(NOW - ONE_HOUR_MS).toISOString(),
        endedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
        claimed_issues: [],
      }),
      "utf8",
    );
    // Órfã SEM carimbo, mas com heartbeat fora da janela de liveness do kind
    // (90min pra coordenadora): staleness sozinha continua bastando pra
    // nunca ressuscitar, exatamente como antes do #7002.
    writeFileSync(
      join(sessionsDir(root), "develop-host-a-sess-velha-safeBackup-1.json"),
      JSON.stringify({
        kind: "develop",
        machineTag: "host-a",
        sessionId: "sess-velha",
        startedAt: new Date(NOW - 5 * ONE_HOUR_MS).toISOString(),
        lastHeartbeat: new Date(NOW - 5 * ONE_HOUR_MS).toISOString(),
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

  it(
    "#6481 — claim presente SÓ num backup -safeBackup-N (arquivo real defasado) ainda é encontrada e removida, " +
      "em vez de devolver falso 'no-op-not-claimed'",
    () => {
      const root = freshRoot();
      const tag = "host-a";
      const sessionId = "sess-6481";
      // Arquivo REAL — já foi sobrescrito (ex: heartbeat do beacon) SEM a
      // claim #6431, que só sobreviveu numa cópia de conflito do OneDrive.
      registerSession(root, "overnight", sessionId, { tag, startedAt: new Date(NOW).toISOString() });
      claimIssue(root, "overnight", sessionId, 6459, tag, new Date(NOW).toISOString());
      // Backup do MESMO stem carrega a claim que o arquivo real perdeu.
      writeRawSessionFile(root, `overnight-${tag}-${sessionId}-${tag}-safeBackup-0001.json`, {
        kind: "overnight",
        machineTag: tag,
        sessionId,
        startedAt: new Date(NOW).toISOString(),
        lastHeartbeat: new Date(NOW).toISOString(),
        claimed_issues: [6431, 6459],
      });

      const result = unclaimIssue(root, "overnight", sessionId, 6431, tag, new Date(NOW + 1000).toISOString());
      assert.deepEqual(result, { ok: true, reason: "unclaimed" }, "a claim do backup foi encontrada e removida");

      // O arquivo real é regravado com a UNIÃO (menos a issue liberada) — a
      // outra claim (#6459), presente só no real, permanece intacta.
      const content = JSON.parse(readFileSync(sessionFilePath(root, "overnight", tag, sessionId), "utf8"));
      assert.deepEqual(content.claimed_issues, [6459]);
    },
  );

  it("#6481 — sem nenhum backup, comportamento do caminho feliz é inalterado (regressão de não-regressão)", () => {
    const root = freshRoot();
    registerSession(root, "develop", "sess-sem-backup", { tag: "host-a", startedAt: new Date(NOW).toISOString() });
    claimIssue(root, "develop", "sess-sem-backup", 42, "host-a", new Date(NOW).toISOString());

    const result = unclaimIssue(root, "develop", "sess-sem-backup", 42, "host-a", new Date(NOW + 1000).toISOString());
    assert.deepEqual(result, { ok: true, reason: "unclaimed" });
  });

  it(
    "#6567 — unclaim com issue presente num -safeBackup-N remove a claim de LÁ também, " +
      "não só do arquivo real — is-claimed/list-active param de reportar a issue como reivindicada",
    () => {
      const root = freshRoot();
      const tag = "host-a";
      const sessionId = "sess-6567";
      registerSession(root, "overnight", sessionId, { tag, startedAt: new Date(NOW).toISOString() });
      claimIssue(root, "overnight", sessionId, 6567, tag, new Date(NOW).toISOString());
      // Backup de conflito do OneDrive escrito depois do claim (ex: heartbeat
      // do beacon bifurcando o arquivo) — carrega a MESMA claim.
      writeRawSessionFile(root, `overnight-${tag}-${sessionId}-${tag}-safeBackup-0001.json`, {
        kind: "overnight",
        machineTag: tag,
        sessionId,
        startedAt: new Date(NOW).toISOString(),
        lastHeartbeat: new Date(NOW).toISOString(),
        claimed_issues: [6567],
        claimed_issues_at: { "6567": new Date(NOW).toISOString() },
      });

      const result = unclaimIssue(root, "overnight", sessionId, 6567, tag, new Date(NOW + 1000).toISOString());
      assert.deepEqual(result, { ok: true, reason: "unclaimed" });

      // O bug do #6567: writeJsonSafe tocava só o arquivo real, deixando o
      // backup em disco ainda com a issue — e o read-path faz união
      // real+backups, então a issue continuava "fantasma" reivindicada.
      const backupPath = join(sessionsDir(root), `overnight-${tag}-${sessionId}-${tag}-safeBackup-0001.json`);
      const backupContent = JSON.parse(readFileSync(backupPath, "utf8"));
      assert.deepEqual(
        backupContent.claimed_issues,
        [],
        "o backup também deve perder a issue de claimed_issues — não só o arquivo real",
      );
      assert.deepEqual(backupContent.claimed_issues_at, {}, "claimed_issues_at do backup também é limpo");

      // Cenário fim-a-fim que a issue descreve: is-claimed/list-active NÃO
      // podem mais reportar a issue como reivindicada após o unclaim.
      const active = listActiveSessions(root, NOW + 2000);
      const stillClaimedSomewhere = active.some((s) => (s.claimed_issues ?? []).includes(6567));
      assert.equal(stillClaimedSomewhere, false, "6567 não pode mais aparecer reivindicada em nenhuma sessão ativa");
    },
  );
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

  it("#7227: sessão STALE (mas dentro de CLAIM_RELEASE_MS) segurando a issue AINDA bloqueia — não é mais sinal suficiente para claim livre", () => {
    const root = freshRoot();
    const staleHeartbeat = new Date(NOW - 3 * 60 * 60 * 1000).toISOString(); // 3h stale > SOFT_STALE_MS (90min), << CLAIM_RELEASE_MS (24h)
    registerSession(root, "overnight", "sess-viva-silenciosa", { tag: "host-a", startedAt: staleHeartbeat });
    claimIssueCheckAndSet(root, "overnight", "sess-viva-silenciosa", 7, "host-a", staleHeartbeat);

    registerSession(root, "develop", "sess-outra", { tag: "host-a", startedAt: new Date(NOW).toISOString() });
    const result = claimIssueCheckAndSet(root, "develop", "sess-outra", 7, "host-a", new Date(NOW).toISOString());

    // Antes do #7227 este teste esperava `ok: true, reason: "claimed"` aqui —
    // era o mesmo defeito do incidente #7194: 3h de silêncio de heartbeat não
    // é sinal POSITIVO de morte, e liberar a claim sem --force autorizaria
    // esta 2ª sessão a assumir trabalho de uma sessão possivelmente viva.
    assert.equal(result.ok, false);
    assert.equal(result.reason, "blocked-by-other");
    assert.equal(result.blockedBy?.sessionId, "sess-viva-silenciosa");
  });

  it("sessão além de CLAIM_RELEASE_MS (24h) segurando a issue NÃO bloqueia — claim procede sem precisar de --force", () => {
    const root = freshRoot();
    const veryStaleHeartbeat = new Date(NOW - CLAIM_RELEASE_MS - 60_000).toISOString();
    registerSession(root, "overnight", "sess-morta", { tag: "host-a", startedAt: veryStaleHeartbeat });
    claimIssueCheckAndSet(root, "overnight", "sess-morta", 7, "host-a", veryStaleHeartbeat);

    registerSession(root, "develop", "sess-viva", { tag: "host-a", startedAt: new Date(NOW).toISOString() });
    const result = claimIssueCheckAndSet(root, "develop", "sess-viva", 7, "host-a", new Date(NOW).toISOString());

    assert.equal(result.ok, true);
    assert.equal(result.reason, "claimed", "claim de sessão além de CLAIM_RELEASE_MS não exige --force — segue o fluxo normal");

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

  it("#6436: grava claimed_issues_at na 1ª reivindicação, NUNCA sobrescreve numa re-reivindicação (cenário `continuo`)", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "sess-continuo", { tag: "helios", startedAt: new Date(NOW).toISOString() });

    const firstClaimAt = new Date(NOW).toISOString();
    claimIssueCheckAndSet(root, "continuo", "sess-continuo", 6051, "helios", firstClaimAt);

    const contentAfterFirst = JSON.parse(readFileSync(sessionFilePath(root, "continuo", "helios", "sess-continuo"), "utf8"));
    assert.equal(contentAfterFirst.claimed_issues_at["6051"], firstClaimAt);

    // re-reivindicação 7h depois (o ciclo de 60min da `continuo` repetido várias vezes) — MESMO timestamp preservado.
    const reClaimAt = new Date(NOW + 7 * 60 * 60 * 1000).toISOString();
    const reResult = claimIssueCheckAndSet(root, "continuo", "sess-continuo", 6051, "helios", reClaimAt);
    assert.equal(reResult.reason, "already-own");

    const contentAfterReclaim = JSON.parse(readFileSync(sessionFilePath(root, "continuo", "helios", "sess-continuo"), "utf8"));
    assert.equal(
      contentAfterReclaim.claimed_issues_at["6051"],
      firstClaimAt,
      "re-reivindicação NUNCA deve refrescar claimed_issues_at — senão a claim nunca envelhece (#6436)",
    );
    // heartbeat, por outro lado, SEGUE avançando normalmente.
    assert.equal(contentAfterReclaim.lastHeartbeat, reClaimAt);
  });

  it("#6453: unclaim limpa claimed_issues_at — re-claim posterior não herda o timestamp da 1ª claim", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-1", { tag: "host-a", startedAt: new Date(NOW).toISOString() });

    const firstClaimAt = new Date(NOW).toISOString();
    claimIssueCheckAndSet(root, "overnight", "sess-1", 6453, "host-a", firstClaimAt);
    const afterFirstClaim = JSON.parse(readFileSync(sessionFilePath(root, "overnight", "host-a", "sess-1"), "utf8"));
    assert.equal(afterFirstClaim.claimed_issues_at["6453"], firstClaimAt);

    // Bloqueio qualquer 10 minutos depois: a sessão solta a issue.
    const unclaimAt = new Date(NOW + 10 * 60 * 1000).toISOString();
    const unclaimResult = unclaimIssue(root, "overnight", "sess-1", 6453, "host-a", unclaimAt);
    assert.equal(unclaimResult.ok, true);

    const afterUnclaim = JSON.parse(readFileSync(sessionFilePath(root, "overnight", "host-a", "sess-1"), "utf8"));
    assert.equal(
      "6453" in (afterUnclaim.claimed_issues_at ?? {}),
      false,
      "unclaimIssue deve remover a entrada de claimed_issues_at junto com claimed_issues (#6453)",
    );

    // Re-claim da MESMA issue, pela MESMA sessão, 13h depois da 1ª claim.
    const reClaimAt = new Date(NOW + 13 * 60 * 60 * 1000).toISOString();
    const reResult = claimIssueCheckAndSet(root, "overnight", "sess-1", 6453, "host-a", reClaimAt);
    assert.equal(reResult.reason, "claimed", "sem histórico de claimed_issues_at, a re-reivindicação é tratada como nova claim");

    const afterReclaim = JSON.parse(readFileSync(sessionFilePath(root, "overnight", "host-a", "sess-1"), "utf8"));
    assert.equal(
      afterReclaim.claimed_issues_at["6453"],
      reClaimAt,
      "claimed_issues_at deve refletir o timestamp da 2ª claim, não da 1ª (falso positivo do gate de staleness, #6453)",
    );
  });
});

// ─── claimIssueAutoRegistering — fecha o no-op silencioso do #6369 ────────

describe("claimIssueAutoRegistering — sessão sem registro prévio nunca vira no-op silencioso (#6369)", () => {
  const NOW = Date.parse("2026-08-26T11:00:00.000Z");

  it(
    "cenário real da issue: ciclo continuo chama claim-issue sem ter chamado register antes — " +
      "auto-registra e o claim COLA, em vez de virar no-op que o chamador precisa contornar",
    () => {
      const root = freshRoot();
      // Nenhum registerSession chamado — é exatamente o estado do cron
      // Hermes sem sessão `continuo` registrada, achado ao vivo na issue.
      const result = claimIssueAutoRegistering(root, "continuo", "sess-hermes", 6352, "host-a", new Date(NOW).toISOString());

      assert.equal(result.ok, true);
      assert.equal(result.reason, "claimed");
      assert.equal(result.autoRegistered, true);

      // A sessão agora EXISTE de fato em disco, com a issue reivindicada —
      // não é mais um `.md` órfão que nada consulta.
      const content = JSON.parse(readFileSync(sessionFilePath(root, "continuo", "host-a", "sess-hermes"), "utf8"));
      assert.deepEqual(content.claimed_issues, [6352]);

      // Uma 2ª sessão consultando is-claimed agora VÊ a reivindicação —
      // fechando o buraco de coordenação relatado na issue.
      const other = isIssueClaimedByOther(root, 6352, "sess-outra", NOW);
      assert.ok(other, "outra sessão deveria ver a claim auto-registrada");
      assert.equal(other?.sessionId, "sess-hermes");
    },
  );

  it("sessão JÁ registrada não é tocada por registerSession de novo — autoRegistered: false, comportamento normal", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-viva", { tag: "host-a", startedAt: new Date(NOW).toISOString() });

    const result = claimIssueAutoRegistering(root, "overnight", "sess-viva", 100, "host-a", new Date(NOW).toISOString());

    assert.equal(result.ok, true);
    assert.equal(result.reason, "claimed");
    assert.equal(result.autoRegistered, false);
  });

  it("colisão com outra sessão ATIVA continua recusando mesmo com auto-registro (não força o claim)", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-dona", { tag: "host-a", startedAt: new Date(NOW).toISOString() });
    claimIssueCheckAndSet(root, "overnight", "sess-dona", 42, "host-a", new Date(NOW).toISOString());

    // sess-nova nunca foi registrada — auto-registro acontece, mas a issue
    // já pertence a outra sessão ATIVA, então o claim é recusado do mesmo jeito.
    const result = claimIssueAutoRegistering(root, "develop", "sess-nova", 42, "host-a", new Date(NOW).toISOString());

    assert.equal(result.ok, false);
    assert.equal(result.reason, "blocked-by-other");
    assert.equal(result.autoRegistered, true);
    assert.equal(result.blockedBy?.sessionId, "sess-dona");
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

  it("#7227: heartbeat > SOFT_STALE_MS mas < CLAIM_RELEASE_MS → aparece em list-active com stale:true, mas AINDA bloqueia claim (sessão viva não perde o trabalho por silêncio)", () => {
    const root = freshRoot();
    // 3h10 stale — mesmo cenário concreto do incidente #7194/#7227 (sessão
    // `develop` presa numa sequência MCP + AskUserQuestion, sem emitir
    // heartbeat, mas genuinamente viva). Antes do #7227 este teste esperava
    // `owner === null` aqui — era exatamente o defeito: silêncio de heartbeat
    // sozinho liberava o claim e autorizava outra sessão a tomar o trabalho.
    const staleHeartbeat = new Date(NOW - 3 * 60 * ONE_MIN_MS - 10 * ONE_MIN_MS).toISOString();
    registerSession(root, "develop", "sess-viva-silenciosa", { tag: "host-a", startedAt: staleHeartbeat });
    claimIssue(root, "develop", "sess-viva-silenciosa", 5416, "host-a", staleHeartbeat);

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 1, "sessão stale continua VISÍVEL em list-active, só marcada");
    assert.equal(sessions[0].stale, true, "observável como 'provavelmente ociosa'");
    assert.deepEqual(sessions[0].claimed_issues_effective, [5416], "mas o claim continua valendo — não é sinal POSITIVO de morte");
    assert.equal(sessions[0].sessionId, "sess-viva-silenciosa");

    const owner = isIssueClaimedByOther(root, 5416, "sess-outra", NOW);
    assert.ok(owner !== null, "claim de sessão só stale (dentro de CLAIM_RELEASE_MS) continua bloqueando outra sessão");
    assert.equal(owner?.sessionId, "sess-viva-silenciosa");
  });

  it("#7227: heartbeat > CLAIM_RELEASE_MS (24h) → claim finalmente libera, mesma janela que já tira a sessão de list-active", () => {
    const root = freshRoot();
    const veryStaleHeartbeat = new Date(NOW - CLAIM_RELEASE_MS - 60_000).toISOString();
    registerSession(root, "develop", "sess-abandonada-24h", { tag: "host-a", startedAt: veryStaleHeartbeat });
    claimIssue(root, "develop", "sess-abandonada-24h", 5417, "host-a", veryStaleHeartbeat);

    // > MAX_SESSION_AGE_MS (24h) também — some da lista inteiramente, então
    // nem chega a expor claimed_issues_effective vazio; isIssueClaimedByOther
    // já não a vê de qualquer forma. Cobre a mesma janela por dois caminhos.
    assert.deepEqual(listActiveSessions(root, NOW), []);
    assert.equal(isIssueClaimedByOther(root, 5417, "sess-outra", NOW), null);
  });

  it("#7227: kind `interactive` mantém a janela CURTA de sempre (15min) — não herda a retenção de 24h dos coordenadores", () => {
    const root = freshRoot();
    const staleHeartbeat = new Date(NOW - INTERACTIVE_SOFT_STALE_MS - 60_000).toISOString();
    registerSession(root, "interactive", "sess-interativa-encerrada", { tag: "host-a", startedAt: staleHeartbeat });
    claimIssue(root, "interactive", "sess-interativa-encerrada", 5418, "host-a", staleHeartbeat);

    const [session] = listActiveSessions(root, NOW);
    assert.equal(session.stale, true);
    assert.deepEqual(session.claimed_issues_effective, [], "interactive libera em 15min, não em 24h — evita claim órfã de conversa encerrada");
    assert.equal(isIssueClaimedByOther(root, 5418, "sess-outra", NOW), null);
  });

  it("#7227: claimReleaseMsForKind — interactive usa a janela curta, coordenadores usam CLAIM_RELEASE_MS (24h)", () => {
    assert.equal(claimReleaseMsForKind("interactive"), INTERACTIVE_SOFT_STALE_MS);
    for (const kind of ["overnight", "develop", "continuo"]) {
      assert.equal(claimReleaseMsForKind(kind), CLAIM_RELEASE_MS);
    }
    assert.equal(CLAIM_RELEASE_MS, MAX_SESSION_AGE_MS, "reusa o teto absoluto existente — nenhum número mágico novo");
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

// ─── claimed_issues_effective (#6623) ──────────────────────────────────────
// list-active expunha claimed_issues de sessão STALE sem marcar que os claims
// já venceram — leitura ingênua de claimed_issues escondia issues elegíveis.

describe("listActiveSessions — claimed_issues_effective (#6623)", () => {
  const NOW = Date.parse("2026-08-28T18:00:00.000Z");
  const ONE_MIN_MS = 60 * 1000;

  it("sessão VIVA (não-stale): claimed_issues_effective == claimed_issues bruto", () => {
    const root = freshRoot();
    registerSession(root, "develop", "sess-viva", { tag: "host-a", startedAt: new Date(NOW - 30 * ONE_MIN_MS).toISOString() });
    claimIssue(root, "develop", "sess-viva", 100, "host-a", new Date(NOW - 30 * ONE_MIN_MS).toISOString());
    claimIssue(root, "develop", "sess-viva", 101, "host-a", new Date(NOW - 30 * ONE_MIN_MS).toISOString());

    const [session] = listActiveSessions(root, NOW);
    assert.equal(session.stale, false);
    assert.deepEqual(session.claimed_issues_effective, [100, 101]);
    assert.deepEqual(session.claimed_issues, [100, 101]);
  });

  it("#7227: sessão STALE (heartbeat > SOFT_STALE_MS, mas < CLAIM_RELEASE_MS): claimed_issues_effective CONTINUA com a claim — stale não é mais o gate de liberação", () => {
    const root = freshRoot();
    const staleHeartbeat = new Date(NOW - 3 * 60 * ONE_MIN_MS - 10 * ONE_MIN_MS).toISOString(); // 3h10, > SOFT_STALE_MS mas << CLAIM_RELEASE_MS (24h)
    registerSession(root, "develop", "sess-viva-silenciosa", { tag: "host-a", startedAt: staleHeartbeat });
    claimIssue(root, "develop", "sess-viva-silenciosa", 5998, "host-a", staleHeartbeat);

    const [session] = listActiveSessions(root, NOW);
    assert.equal(session.stale, true, "observável como 'provavelmente ociosa'");
    // Antes do #7227 este teste esperava `[]` aqui — era o próprio defeito
    // que a #7227 corrige: `stale` sozinho (heartbeat silencioso) liberava o
    // claim sem nenhum sinal POSITIVO de morte, autorizando terceiro a tomar
    // trabalho de sessão viva (incidente #7194).
    assert.deepEqual(session.claimed_issues_effective, [5998]);
    assert.deepEqual(session.claimed_issues, [5998]);
  });

  it("#7227: interactive além da janela curta (15min): claimed_issues_effective é VAZIO enquanto ainda VISÍVEL em list-active, claimed_issues bruto preservado (#6623 — diagnóstico/histórico)", () => {
    const root = freshRoot();
    // interactive é o único kind onde CLAIM_RELEASE_MS != MAX_SESSION_AGE_MS —
    // por isso é o único caso que demonstra `claimed_issues_effective: []`
    // com a sessão AINDA visível na lista (coordenadores só esvaziam quando
    // já saíram da lista de qualquer forma, ver teste acima).
    const staleHeartbeat = new Date(NOW - INTERACTIVE_SOFT_STALE_MS - 60_000).toISOString();
    registerSession(root, "interactive", "sess-interativa-6623", { tag: "host-a", startedAt: staleHeartbeat });
    claimIssue(root, "interactive", "sess-interativa-6623", 5999, "host-a", staleHeartbeat);

    const [session] = listActiveSessions(root, NOW);
    assert.equal(session.stale, true);
    assert.deepEqual(session.claimed_issues_effective, []);
    assert.deepEqual(session.claimed_issues, [5999], "o campo bruto continua no record para diagnóstico/histórico");
  });

  it("sessão sem claims: claimed_issues_effective é [] tanto viva quanto stale", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-sem-claims", { tag: "host-a", startedAt: new Date(NOW - 30 * ONE_MIN_MS).toISOString() });

    const [session] = listActiveSessions(root, NOW);
    assert.deepEqual(session.claimed_issues_effective, []);
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
        // O chmod POSIX só morde de fato em filesystems que o respeitam. Em
        // vez de enumerar plataformas (root ignora permissão de arquivo; o
        // NTFS do Windows não mapeia bits POSIX pra ACL e chmod 000 vira
        // no-op pra diretórios, #6306), sonda o EFEITO: se o próprio
        // readdirSync ainda suceder depois do chmod, a precondição do teste
        // (diretório de fato ilegível) nunca se estabeleceu — não há o que
        // asserir, então retorna. Cobre root, Windows/NTFS, e qualquer
        // filesystem montado sem permissões (ex: alguns casos de WSL/rede)
        // sem precisar prever cada ambiente.
        try {
          readdirSync(dir);
          return;
        } catch {
          // readdir lançou como esperado — chmod mordeu, segue pro assert.
        }
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

  it("aceita também \"continuo-review\" desde o #6934 — hermes/scripts/continuo-pr-review.sh", () => {
    assert.equal(requireKind("continuo-review"), "continuo-review");
  });

  it("rejeita valor inválido/ausente com mensagem citando os 5 kinds válidos", () => {
    assert.throws(
      () => requireKind("bogus"),
      /--kind deve ser "overnight", "develop", "continuo", "interactive" ou "continuo-review"/,
    );
    assert.throws(
      () => requireKind(undefined),
      /--kind deve ser "overnight", "develop", "continuo", "interactive" ou "continuo-review"/,
    );
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

// ─── assessCrossMachineSyncFreshness (#7169 — guard de frescor) ────────────

describe("assessCrossMachineSyncFreshness (#7169) — sinaliza registro de OUTRA máquina desatualizado", () => {
  const NOW = Date.parse("2026-09-02T21:37:45.000Z"); // hora do heartbeat "fresco" citado na issue
  const record = (overrides: Partial<ActiveSessionRecord>): ActiveSessionRecord => ({
    kind: "overnight",
    machineTag: "helios",
    sessionId: "b73bdec9",
    startedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    lastHeartbeat: new Date(NOW).toISOString(),
    stale: false,
    claimed_issues_effective: [],
    ...overrides,
  });

  it("reprodução do incidente: registro de OUTRA máquina com heartbeat de 73min (< 90min de SOFT_STALE_MS, > 10min do limiar de sync) → sinaliza", () => {
    const stale73min = record({ lastHeartbeat: new Date(NOW - 73 * 60 * 1000).toISOString() });
    const result = assessCrossMachineSyncFreshness([stale73min], NOW, "neo");
    assert.equal(result.stale, true);
    assert.equal(result.staleSessions.length, 1);
    assert.equal(result.staleSessions[0].sessionId, "b73bdec9");
  });

  it("mesma sessão, mas lida da PRÓPRIA máquina (machineTag bate) → nunca sinaliza — leitura local não tem sync no caminho", () => {
    const stale73min = record({ lastHeartbeat: new Date(NOW - 73 * 60 * 1000).toISOString() });
    const result = assessCrossMachineSyncFreshness([stale73min], NOW, "helios");
    assert.equal(result.stale, false);
    assert.deepEqual(result.staleSessions, []);
  });

  it("heartbeat fresco (dentro do limiar de 10min) de outra máquina → não sinaliza", () => {
    const fresh = record({ lastHeartbeat: new Date(NOW - 2 * 60 * 1000).toISOString() });
    const result = assessCrossMachineSyncFreshness([fresh], NOW, "neo");
    assert.equal(result.stale, false);
  });

  it("registro já marcado stale (>90min, GC-eligible) → não duplica o sinal — é outro caminho quem já cobre isso", () => {
    const alreadyStale = record({ lastHeartbeat: new Date(NOW - 91 * 60 * 1000).toISOString(), stale: true });
    const result = assessCrossMachineSyncFreshness([alreadyStale], NOW, "neo");
    assert.equal(result.stale, false);
  });

  it("kind não-coordenador (interactive) de outra máquina desatualizado → não sinaliza (só coordenadora concede/detém lock)", () => {
    const interactiveStale = record({ kind: "interactive", lastHeartbeat: new Date(NOW - 73 * 60 * 1000).toISOString() });
    const result = assessCrossMachineSyncFreshness([interactiveStale], NOW, "neo");
    assert.equal(result.stale, false);
  });

  it("heartbeat 'no futuro' (clock skew, não sync degradado) → não sinaliza por esta função", () => {
    const future = record({ lastHeartbeat: new Date(NOW + 5 * 60 * 1000).toISOString() });
    const result = assessCrossMachineSyncFreshness([future], NOW, "neo");
    assert.equal(result.stale, false);
  });

  it("exatamente no limiar (CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS) → ainda NÃO sinaliza (estrito >, não >=)", () => {
    const atThreshold = record({ lastHeartbeat: new Date(NOW - CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS).toISOString() });
    assert.equal(assessCrossMachineSyncFreshness([atThreshold], NOW, "neo").stale, false);
  });

  it("nenhuma sessão → não sinaliza", () => {
    assert.equal(assessCrossMachineSyncFreshness([], NOW, "neo").stale, false);
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

  it("#6334 — 2ª aquisição CONCORRENTE da MESMA sessão, sem release entre elas, é NEGADA (não é mais reentrante)", () => {
    // Regressão do #6334: com o fan-out em onda do #6299, a mesma sessão
    // overnight pode ter 2-3 unidades chegando em "pronto pra mergear" ao
    // mesmo tempo. Antes desta correção, a 2ª chamada de acquireMergeLock
    // pela mesma sessionId — mesmo sem nenhum release entre as duas —
    // renovava o TTL e retornava `true` na hora, deixando 2 merges do MESMO
    // turno passarem sem serialização real. Agora a 2ª chamada é tratada
    // como qualquer outra aquisição concorrente: nega enquanto o hold da 1ª
    // ainda está dentro do TTL, mesmo sendo a mesma sessão.
    const root = freshRoot();
    assert.equal(acquireMergeLock(root, "sess-a", NOW), true, "1ª aquisição sucede");
    assert.equal(
      acquireMergeLock(root, "sess-a", NOW + 30_000),
      false,
      "2ª aquisição da MESMA sessão, sem release entre elas, precisa ser negada",
    );
    const content = JSON.parse(readFileSync(mergeLockPath(root), "utf8"));
    assert.equal(content.heldBy, "sess-a", "o lock continua sendo o da 1ª aquisição — a 2ª não o sobrescreveu");
    assert.equal(content.acquiredAt, new Date(NOW).toISOString(), "acquiredAt NÃO foi renovado pela 2ª chamada negada");
  });

  it("#6334 — depois de releaseMergeLock, a MESMA sessão pode adquirir de novo normalmente (fluxo sequencial não regride)", () => {
    // O caso que a reentrância antiga existia pra servir de fato: uma
    // sessão que faz acquire → merge → release → (próxima unidade) acquire
    // de novo. Sem release entre as duas chamadas, isso é o cenário do
    // teste acima (negado); COM release, continua funcionando como sempre.
    const root = freshRoot();
    assert.equal(acquireMergeLock(root, "sess-a", NOW), true);
    assert.equal(releaseMergeLock(root, "sess-a"), true);
    assert.equal(acquireMergeLock(root, "sess-a", NOW + 30_000), true, "após release, a mesma sessão readquire normalmente");
  });

  it("#6334 — renewMergeLock estende o TTL de um hold que a PRÓPRIA sessão já detém (renovação legítima ✅)", () => {
    // Caminho correto pra "operação mais longa que o TTL, mesmo hold, nunca
    // liberado" — o cenário que a reentrância de acquireMergeLock cobria
    // incorretamente antes do #6334 (ver teste acima). renewMergeLock só
    // renova o que a sessão chamadora já segura; nunca concede um hold novo.
    const root = freshRoot();
    assert.equal(acquireMergeLock(root, "sess-a", NOW), true);
    const nearExpiry = NOW + MERGE_LOCK_TTL_MS - 1_000; // quase expirando, ainda não expirou
    assert.equal(renewMergeLock(root, "sess-a", nearExpiry), true);
    const content = JSON.parse(readFileSync(mergeLockPath(root), "utf8"));
    assert.equal(content.heldBy, "sess-a");
    assert.equal(content.acquiredAt, new Date(nearExpiry).toISOString(), "acquiredAt foi de fato renovado");

    // Prova que a renovação teve efeito real: sem ela, o lock teria expirado
    // e outra sessão conseguiria adquirir; com a renovação, o TTL reconta a
    // partir de `nearExpiry`, então outra sessão ainda é negada logo depois.
    assert.equal(acquireMergeLock(root, "sess-b", nearExpiry + 1_000), false, "renovado — ainda dentro do novo TTL");
  });

  it("#6334 — renewMergeLock nega renovar lock de OUTRA sessão (nunca rouba hold alheio)", () => {
    const root = freshRoot();
    acquireMergeLock(root, "sess-a", NOW);
    assert.equal(renewMergeLock(root, "sess-b", NOW + 30_000), false);
    const content = JSON.parse(readFileSync(mergeLockPath(root), "utf8"));
    assert.equal(content.heldBy, "sess-a", "renovação negada de outra sessão não altera o lock");
  });

  it("#6334 — renewMergeLock nega renovar quando não há lock nenhum", () => {
    const root = freshRoot();
    assert.equal(renewMergeLock(root, "sess-a", NOW), false);
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

  it("#6436: une claimed_issues_at mantendo o timestamp MAIS ANTIGO por issue entre cópias", () => {
    const older: SessionRecord = {
      kind: "continuo",
      machineTag: "helios",
      sessionId: "s1",
      startedAt: "2026-08-18T04:00:00.000Z",
      lastHeartbeat: "2026-08-18T14:26:00.000Z",
      claimed_issues: [6051],
      claimed_issues_at: { "6051": "2026-08-18T04:00:00.000Z" },
    };
    const newer: SessionRecord = {
      kind: "continuo",
      machineTag: "helios",
      sessionId: "s1",
      startedAt: "2026-08-18T04:00:00.000Z",
      lastHeartbeat: "2026-08-18T15:32:00.000Z",
      claimed_issues: [6051],
      // cópia de conflito com timestamp mais recente (ex: escrita numa
      // reivindicação subsequente ainda não deduplicada) — a claim de
      // verdade começou na cópia MAIS ANTIGA.
      claimed_issues_at: { "6051": "2026-08-18T10:00:00.000Z" },
    };
    const merged = mergeSessionRecords([older, newer]);
    assert.deepEqual(merged.claimed_issues_at, { "6051": "2026-08-18T04:00:00.000Z" });
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

  it("backup ÓRFÃO de sessão ENCERRADA (carimbo endedAt) continua NUNCA ressuscitando claim (#5427 preservado)", () => {
    const root = freshRoot();
    // #7002: `endSession` carimba `endedAt` em cada cópia do grupo antes de
    // remover o arquivo real — é esse carimbo (e não a mera ausência do
    // real) que autoriza descartar o grupo, agora que "backup órfão vivo"
    // passou a ser um estado real e distinto.
    writeRawSessionFile(root, "continuo-predator-s-encerrada-predator-safeBackup-0001.json", {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s-encerrada",
      startedAt: new Date(NOW - 60 * 1000).toISOString(),
      lastHeartbeat: new Date(NOW - 60 * 1000).toISOString(),
      endedAt: new Date(NOW - 30 * 1000).toISOString(),
      claimed_issues: [999],
    });

    assert.deepEqual(listActiveSessions(root, NOW), []);
    assert.equal(isIssueClaimedByOther(root, 999, "sess-outra", NOW), null, "backup órfão não reivindica nada");
  });

  it("backup ÓRFÃO STALE (sem carimbo, heartbeat fora da janela de liveness) também nunca ressuscita claim", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "continuo-predator-s-morta-predator-safeBackup-0001.json", {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s-morta",
      startedAt: new Date(NOW - 10 * 60 * 60 * 1000).toISOString(),
      lastHeartbeat: new Date(NOW - SOFT_STALE_MS - 60 * 1000).toISOString(),
      claimed_issues: [999],
    });

    assert.deepEqual(listActiveSessions(root, NOW), []);
    assert.equal(isIssueClaimedByOther(root, 999, "sess-outra", NOW), null, "órfão stale não reivindica nada");
  });
});

// ─── #6481 — read-path deduplica registro overnight/interactive do MESMO sessionId ─

describe("listActiveSessions — deduplica registros de kinds diferentes do MESMO sessionId (#6481)", () => {
  const NOW = Date.parse("2026-08-28T12:00:00.000Z");

  it("registro overnight (com claimed_issues) e interactive (vazio) do mesmo sessionId → 1 sessão só, kind overnight, claims preservadas", () => {
    const root = freshRoot();
    const startedAt = new Date(NOW - 60 * 60 * 1000).toISOString();
    // Simula a corrida do #6326: o beacon já escreveu interactive-*, e a
    // promoção pra overnight FALHOU em remover o arquivo antigo
    // (outcome: "promoted-orphan-left") — os dois coexistem no disco.
    writeRawSessionFile(root, "overnight-host-a-sess-1.json", {
      kind: "overnight",
      machineTag: "host-a",
      sessionId: "sess-1",
      startedAt,
      lastHeartbeat: new Date(NOW - 5 * 60 * 1000).toISOString(),
      claimed_issues: [6431, 6459],
    });
    writeRawSessionFile(root, "interactive-host-a-sess-1.json", {
      kind: "interactive",
      machineTag: "host-a",
      sessionId: "sess-1",
      startedAt,
      lastHeartbeat: new Date(NOW - 1 * 60 * 1000).toISOString(),
      claimed_issues: [],
    });

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 1, "os 2 arquivos do mesmo sessionId contam como 1 sessão só");
    assert.equal(sessions[0].kind, "overnight", "kind coordenador vence sobre interactive");
    assert.deepEqual(sessions[0].claimed_issues, [6431, 6459], "claims do registro overnight não desaparecem");
  });

  it("is-claimed enxerga a claim do registro overnight mesmo com um interactive paralelo do mesmo sessionId", () => {
    const root = freshRoot();
    const startedAt = new Date(NOW - 60 * 60 * 1000).toISOString();
    writeRawSessionFile(root, "overnight-host-a-sess-2.json", {
      kind: "overnight",
      machineTag: "host-a",
      sessionId: "sess-2",
      startedAt,
      lastHeartbeat: startedAt,
      claimed_issues: [6481],
    });
    writeRawSessionFile(root, "interactive-host-a-sess-2.json", {
      kind: "interactive",
      machineTag: "host-a",
      sessionId: "sess-2",
      startedAt,
      lastHeartbeat: new Date(NOW - 30 * 1000).toISOString(),
      claimed_issues: [],
    });

    const owner = isIssueClaimedByOther(root, 6481, "sess-outra", NOW);
    assert.ok(owner !== null, "claim do registro coordenador não pode desaparecer atrás do registro interactive");
    assert.equal(owner.sessionId, "sess-2");
  });

  it("claim que só existe no registro interactive (nunca deveria acontecer, mas fail-safe) ainda aparece na união", () => {
    const root = freshRoot();
    const startedAt = new Date(NOW - 60 * 60 * 1000).toISOString();
    writeRawSessionFile(root, "develop-host-a-sess-3.json", {
      kind: "develop",
      machineTag: "host-a",
      sessionId: "sess-3",
      startedAt,
      lastHeartbeat: startedAt,
      claimed_issues: [100],
    });
    writeRawSessionFile(root, "interactive-host-a-sess-3.json", {
      kind: "interactive",
      machineTag: "host-a",
      sessionId: "sess-3",
      startedAt,
      lastHeartbeat: startedAt,
      claimed_issues: [200],
    });

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].kind, "develop");
    assert.deepEqual(sessions[0].claimed_issues, [100, 200], "união de claims, mesmo as que só existem no lado interactive");
  });

  it("dois sessionId DIFERENTES (1 overnight, 1 interactive de outra sessão) nunca são fundidos entre si", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-a", { tag: "host-a", startedAt: new Date(NOW).toISOString() });
    registerSession(root, "interactive", "sess-b", { tag: "host-a", startedAt: new Date(NOW).toISOString() });

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 2, "sessionIds distintos continuam sessões distintas");
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

  it("#6294: mesma máquina, pid reportado MORTO, heartbeat além de SOFT_STALE_MS mas dentro da janela conservadora — MANTÉM (pid morto deixou de remover na hora)", () => {
    // Antes do #6294 este cenário removia imediatamente (branch 3 tratava
    // "pid morto" como sinal positivo). A fonte do pid (process.ppid, via
    // hook/beacon) foi medida gravando o pid de um processo efêmero, não o
    // da sessão real — "morto" não é mais confiável o bastante pra pular a
    // janela conservadora. Ver docstring de decideSessionGc.
    const root = freshRoot();
    registerSession(root, "continuo", "s-morta", {
      tag: "helios",
      pid: 9999,
      startedAt: new Date(NOW - 2 * 60 * ONE_MIN_MS).toISOString(), // 2h — stale mas bem aquém de 7 dias
    });

    const plan = planSessionGc(root, { now: NOW, localMachineTag: "helios", isPidAlive: () => false });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "kept", "pid morto cai pra janela conservadora, não remove na hora");
    assert.doesNotMatch(plan[0].reason, /\bMORTO\b/);
  });

  it("#6294: mesma máquina, pid reportado MORTO, heartbeat ALÉM da janela conservadora — remove (mesmo caminho de 'sem pid')", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "s-morta-velha", {
      tag: "helios",
      pid: 9999,
      startedAt: new Date(NOW - 10 * ONE_DAY_MS).toISOString(), // 10 dias > janela conservadora de 7
    });

    const plan = planSessionGc(root, { now: NOW, localMachineTag: "helios", isPidAlive: () => false });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "removed", "além da janela conservadora, remove independente do pid reportar morto");
  });

  it("#6294: pid VIVO continua protegendo incondicionalmente, sem mudança de comportamento", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "s-viva-2", {
      tag: "helios",
      pid: 4242,
      startedAt: new Date(NOW - 10 * ONE_DAY_MS).toISOString(),
    });

    const plan = planSessionGc(root, { now: NOW, localMachineTag: "helios", isPidAlive: (pid) => pid === 4242 });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "kept");
    assert.match(plan[0].reason, /VIVO/);
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

  // ─── #6595: órfão sem arquivo real usa janela do KIND × margem, não os 7 dias ──

  it("#6595: órfão ALÉM de 4× a janela de liveness do kind é removível, mesmo bem aquém dos 7 dias conservadores", () => {
    const root = freshRoot();
    // overnight: softStaleMs = SOFT_STALE_MS (90min) × 4 = 6h. 6,5h fica além.
    const ageMs = 6.5 * 60 * 60 * 1000;
    writeRawSessionFile(root, "overnight-helios-s-orfa-helios-safeBackup-0001.json", {
      kind: "overnight",
      machineTag: "helios",
      sessionId: "s-orfa",
      startedAt: new Date(NOW - ageMs).toISOString(),
      lastHeartbeat: new Date(NOW - ageMs).toISOString(),
      claimed_issues: [111, 222],
    });

    const plan = planSessionGc(root, { now: NOW, localMachineTag: "helios", isPidAlive: () => false });
    assert.equal(plan.length, 1);
    assert.equal(
      plan[0].action,
      "removed",
      "órfão overnight além de 4×90min=6h é removível, muito antes dos 7 dias conservadores",
    );
    assert.match(plan[0].reason, /#6595/);
    assert.match(plan[0].reason, /#111, #222/, "reason nomeia os claims liberados pela remoção do órfão");
  });

  it("#6595: órfão DENTRO da janela de liveness × margem é mantido", () => {
    const root = freshRoot();
    // overnight: janela efetiva = 90min × 4 = 6h. 3h fica dentro.
    const ageMs = 3 * 60 * 60 * 1000;
    writeRawSessionFile(root, "overnight-helios-s-recente-helios-safeBackup-0001.json", {
      kind: "overnight",
      machineTag: "helios",
      sessionId: "s-recente",
      startedAt: new Date(NOW - ageMs).toISOString(),
      lastHeartbeat: new Date(NOW - ageMs).toISOString(),
      claimed_issues: [],
    });

    const plan = planSessionGc(root, { now: NOW, localMachineTag: "helios", isPidAlive: () => false });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "kept", "3h < 4×90min=6h — ainda dentro da janela, GC não remove cedo demais");
  });

  it("#6595: órfão SEM timestamp legível é mantido (fail-safe), independente da janela do kind", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "overnight-helios-s-sem-ts-helios-safeBackup-0001.json", {
      kind: "overnight",
      machineTag: "helios",
      sessionId: "s-sem-ts",
      startedAt: "não-é-uma-data",
      lastHeartbeat: "também-não",
      claimed_issues: [999],
    });

    const plan = planSessionGc(root, { now: NOW, localMachineTag: "helios", isPidAlive: () => false });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "kept", "timestamp ilegível nunca é removido, nem no caminho de órfão");
    assert.match(plan[0].reason, /ilegível/);
  });

  it("#6595 (fleet review): órfão com `kind` AUSENTE/desconhecido cai na janela CONSERVADORA de 7 dias, nunca na janela curta do órfão", () => {
    // Achado do review do #6595: sem esta guarda, `softStaleMsForKind(\"\")`
    // resolve pro default de 90min e a janela do órfão (4×90min=6h) seria
    // aplicada a um registro que este módulo não conseguiu classificar —
    // o oposto do "kind ausente/desconhecido cai nos valores conservadores"
    // que a mesma função já garante pra sessão ancorada em arquivo real.
    const root = freshRoot();
    const ageMs = 10 * 60 * 60 * 1000; // 10h — além das 6h do órfão overnight, mas bem aquém dos 7 dias
    writeRawSessionFile(root, "overnight-helios-s-kind-vazio-helios-safeBackup-0001.json", {
      // `kind` omitido de propósito — simula registro corrompido/legado.
      machineTag: "helios",
      sessionId: "s-kind-vazio",
      startedAt: new Date(NOW - ageMs).toISOString(),
      lastHeartbeat: new Date(NOW - ageMs).toISOString(),
      claimed_issues: [],
    } as Partial<SessionRecord>);

    const plan = planSessionGc(root, { now: NOW, localMachineTag: "helios", isPidAlive: () => false });
    assert.equal(plan.length, 1);
    assert.equal(
      plan[0].action,
      "kept",
      "10h > 4×90min=6h (janela do órfão) mas < 7 dias (janela conservadora) — kind desconhecido usa a conservadora",
    );
  });

  it("#6595: sessão COM arquivo real e heartbeat de 3 dias segue mantida — os 7 dias NÃO regrediram", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "s-real-3d", {
      tag: "helios",
      startedAt: new Date(NOW - 3 * ONE_DAY_MS).toISOString(),
    });

    const plan = planSessionGc(root, { now: NOW, localMachineTag: "helios", isPidAlive: () => false });
    assert.equal(plan.length, 1);
    assert.equal(
      plan[0].action,
      "kept",
      "sessão ancorada em arquivo real usa a janela conservadora de 7 dias, não a janela do órfão (3 dias < 6h × algo não se aplica aqui)",
    );
  });

  it("#6595: kinds diferentes usam janelas de liveness diferentes pro caminho de órfão — overnight 90min vs interactive 15min", () => {
    const root = freshRoot();
    // 90min de idade: overnight ainda está dentro de SOFT_STALE_MS (90min) —
    // nem chega no branch de janela-de-órfão. interactive (15min) já está
    // muito além de 4×15min=60min também, então ambos os kinds precisam de
    // janelas efetivamente distintas pra este teste discriminar.
    const ageMs = 65 * 60 * 1000; // 65min

    writeRawSessionFile(root, "overnight-helios-s-ov-helios-safeBackup-0001.json", {
      kind: "overnight",
      machineTag: "helios",
      sessionId: "s-ov",
      startedAt: new Date(NOW - ageMs).toISOString(),
      lastHeartbeat: new Date(NOW - ageMs).toISOString(),
      claimed_issues: [],
    });
    writeRawSessionFile(root, "interactive-helios-s-int-helios-safeBackup-0001.json", {
      kind: "interactive",
      machineTag: "helios",
      sessionId: "s-int",
      startedAt: new Date(NOW - ageMs).toISOString(),
      lastHeartbeat: new Date(NOW - ageMs).toISOString(),
      claimed_issues: [],
    });

    const plan = planSessionGc(root, { now: NOW, localMachineTag: "helios", isPidAlive: () => false });
    const overnightEntry = plan.find((e) => e.identity.includes("s-ov"));
    const interactiveEntry = plan.find((e) => e.identity.includes("s-int"));
    assert.ok(overnightEntry && interactiveEntry);
    // overnight: 65min < 4×90min=360min → mantém.
    assert.equal(overnightEntry!.action, "kept", "65min ainda dentro de 4×90min pro kind overnight");
    // interactive: 65min > 4×15min=60min → remove.
    assert.equal(interactiveEntry!.action, "removed", "65min além de 4×15min pro kind interactive");
  });

  it("GC_ORPHAN_LIVENESS_MARGIN é 4× por padrão", () => {
    assert.equal(GC_ORPHAN_LIVENESS_MARGIN, 4);
    assert.equal(SOFT_STALE_MS, 90 * 60 * 1000);
    assert.equal(INTERACTIVE_SOFT_STALE_MS, 15 * 60 * 1000);
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

// ─── parseSessionFileName (#6338) ──────────────────────────────────────────

describe("parseSessionFileName valida o prefixo contra os 5 SessionKind conhecidos (#6338, #6934)", () => {
  it("parseia os 5 kinds válidos com tag/sessionId simples (sem hífen)", () => {
    for (const kind of ALL_SESSION_KINDS) {
      assert.deepEqual(parseSessionFileName(`${kind}-hostA-sess1.json`), {
        kind,
        tag: "hostA",
        sessionId: "sess1",
      });
    }
  });

  it("aceita sessionId com hífens (UUID) — o corte fica logo após a tag", () => {
    assert.deepEqual(parseSessionFileName("overnight-helios-abc-123-def-456.json"), {
      kind: "overnight",
      tag: "helios",
      sessionId: "abc-123-def-456",
    });
  });

  it("retorna null quando o prefixo não é um SessionKind conhecido (achado #6326/#6338)", () => {
    // Este é o defeito concreto que a issue documenta: antes desta função,
    // `findExistingSessionFileAnyKind` casava isto só pelo SUFIXO
    // `-sess1.json`, sem checar o prefixo "bogus".
    assert.equal(parseSessionFileName("bogus-hostA-sess1.json"), null);
  });

  it("retorna null para prefixo vazio, sem extensão .json, ou sem tag/sessionId separáveis", () => {
    assert.equal(parseSessionFileName("overnight.json"), null);
    assert.equal(parseSessionFileName("overnight-hostA-sess1.txt"), null);
    assert.equal(parseSessionFileName("overnight-hostA.json"), null); // falta o sessionId
    assert.equal(parseSessionFileName("overnight-.json"), null);
  });

  it("não confunde kind por substring truncado (ex: nome começando por outro prefixo)", () => {
    // O guard de shape precisa recusar um nome que não bate com NENHUM dos
    // 5 kinds, mesmo que "pareça" um kind truncado.
    assert.equal(parseSessionFileName("overnigh-hostA-sess1.json"), null);
  });

  it("#6934 — \"continuo\" É prefixo verdadeiro de \"continuo-review\": resolve pro kind MAIS ESPECÍFICO (mais longo), não pelo primeiro match da ordem de ALL_SESSION_KINDS", () => {
    // Diferente do caso acima ("overnigh" não é NENHUM kind), aqui
    // "continuo-review-tag-sess1.json" genuinamente COMEÇA com "continuo-" —
    // um `.find()` ingênuo na ordem de declaração de `ALL_SESSION_KINDS`
    // (onde "continuo" vem antes de "continuo-review") devolveria
    // {kind: "continuo", tag: "review", sessionId: "tag-sess1"}, errado em
    // silêncio. `parseSessionFileName` precisa desempatar pelo prefixo mais
    // longo (mesma técnica de `groupBackupsByRealStem`), não pela ordem do
    // array.
    assert.deepEqual(parseSessionFileName("continuo-review-helios-sess1.json"), {
      kind: "continuo-review",
      tag: "helios",
      sessionId: "sess1",
    });
    // Um registro "continuo" de verdade (sem o sufixo "-review") continua
    // resolvendo pro kind certo — a correção não quebra o caso comum.
    assert.deepEqual(parseSessionFileName("continuo-helios-sess1.json"), {
      kind: "continuo",
      tag: "helios",
      sessionId: "sess1",
    });
  });

  it(".merge-lock.json (arquivo de sistema, não registro de sessão) não é um SessionKind válido", () => {
    assert.equal(parseSessionFileName(".merge-lock.json"), null);
  });
});

describe("findExistingSessionFileAnyKind ignora arquivo com prefixo de kind desconhecido (#6338)", () => {
  it("um arquivo `bogus-{tag}-{sessionId}.json` não é encontrado por registerSession/heartbeat", () => {
    const root = freshRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    // Arquivo com o MESMO sufixo -{sessionId}.json que um registro real
    // usaria, mas prefixo de kind inválido — simula corrupção/nome externo.
    writeFileSync(
      join(sessionsDir(root), "bogus-hostA-sess-shared.json"),
      JSON.stringify({ kind: "bogus", sessionId: "sess-shared" }),
      "utf8",
    );

    // registerSession chama findExistingSessionFileAnyKind internamente
    // (via a busca de "promoção" #6326) — com o arquivo bogus ignorado, ele
    // registra um registro NOVO em vez de tentar promover/enriquecer o
    // arquivo de prefixo desconhecido.
    const result = registerSession(root, "interactive", "sess-shared");
    assert.equal(result.outcome, "created");
    assert.equal(
      existsSync(sessionFilePath(root, "interactive", result.record.machineTag, "sess-shared")),
      true,
    );
  });
});

// ─── grant-merge: --kind obrigatório, mensagem nomeia o referente (#6331) ──

describe("requireCoordinatorKind (#6331 caminho de erro)", () => {
  it("aceita as 3 coordenadoras", () => {
    assert.equal(requireCoordinatorKind("overnight"), "overnight");
    assert.equal(requireCoordinatorKind("develop"), "develop");
    assert.equal(requireCoordinatorKind("continuo"), "continuo");
  });

  it("recusa \"interactive\" — só coordenadora concede janela de merge", () => {
    assert.throws(() => requireCoordinatorKind("interactive"), /não é uma sessão coordenadora/);
  });
});

describe("CLI grant-merge: --kind ausente dá erro nomeando o referente (#6331)", () => {
  const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lib", "session-registry.ts");

  function runGrantMergeCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "grant-merge", ...args], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("sem --kind: erro diz que é o kind da CONCEDENTE, nunca da beneficiária, e cita --granted-to", () => {
    const res = runGrantMergeCli(["--session-id", "s1", "--granted-to", "s2"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--kind ausente/);
    assert.match(res.stderr, /CONCEDENTE/);
    assert.match(res.stderr, /nunca da beneficiária/);
    assert.match(res.stderr, /--granted-to/);
  });

  it("--kind inválido (não-coordenadora) continua recusado por requireCoordinatorKind", () => {
    const res = runGrantMergeCli(["--kind", "interactive", "--session-id", "s1", "--granted-to", "s2"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /não é uma sessão coordenadora/);
  });

  it("--help (comando desconhecido) documenta --kind como parte da invocação real do grant-merge (#6331)", () => {
    const res = runGrantMergeCli(["--this-flag-does-not-exist"]);
    // A invocação acima ainda entra no case "grant-merge" (falha antes, no
    // --kind ausente) — para ver o texto de ajuda completo, rodamos o CLI
    // sem nenhum subcomando reconhecido.
    const helpRes = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT, "--this-command-does-not-exist"],
      { cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8", timeout: 30_000 },
    );
    assert.match(helpRes.stderr, /grant-merge --kind \{overnight\|develop\|continuo\} --granted-to X/);
    assert.match(helpRes.stderr, /CONCEDENTE \(a sua, obrigatório, #6331\)/);
    void res;
  });
});

// ─── #6952 — lost update no registro de sessão ──────────────────────────────
//
// Medido ao vivo (01/09): uma coordenadora concedeu `merge_grant`, a
// beneficiária confirmou `granted: true`, adquiriu o merge lock, e no
// `gh pr merge` já era `granted: false, grant: null`. Ninguém consumiu o
// grant — ele foi APAGADO.
//
// A causa não é do `merge_grant`: é do padrão de escrita. Todo escritor do
// registro fazia read-modify-write com spread (`writeJsonSafe(path, {
// ...current, ... })`). `writeJsonSafe` torna a ESCRITA atômica, mas
// atomicidade de escrita não é exclusão mútua de leitura-escrita:
//
//   t0  o beacon lê current            (sem merge_grant)
//   t1  grant-merge lê e grava         current + merge_grant
//   t2  o beacon grava o SEU current   (de t0)   <- grant perdido
//
// Como o beacon dispara em toda chamada de ferramenta, o registro de uma
// sessão ATIVA é reescrito o tempo todo — e o concedente é, por definição,
// uma sessão ativa. `claimed_issues` e `touched_paths` correm o mesmo risco.
//
// A correção é `writeJsonSafeWithCas`: o read-modify-write inteiro passa a
// rodar sob `withFileLock` na MESMA lock file que o beacon usa, relendo o
// estado fresco dentro do lock.
//
// COMO ESTES TESTES EVITAM SER VACUOSOS: a janela t0→t2 é de microssegundos,
// então um teste cronometrado por `setTimeout` acerta o meio dela quase
// nunca e passa igual com e sem a correção (foi medido: a primeira versão
// destes testes passava contra o código SEM conserto). O que fecha a corrida
// é a exclusão mútua, então é ela que se testa: com o lock retido por outro
// escritor, o escritor do registro TEM que esperar. Um escritor que grava com
// o lock retido é exatamente o escritor que apaga o grant.
describe("#6952 — escrita concorrente sob o lock do registro de sessão", () => {
  const CLI = fileURLToPath(new URL("../scripts/lib/session-registry.ts", import.meta.url));
  // `--import tsx` resolve pelo CWD, e aqui o CWD é a raiz temporária (é ela
  // que `resolveRepoRoot` precisa devolver) — então o specifier tem que ser o
  // caminho ABSOLUTO do loader, não o nome do pacote.
  const TSX_LOADER = pathToFileURL(
    fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
  ).href;
  const casRoots: string[] = [];

  after(() => {
    for (const r of casRoots) rmSync(r, { recursive: true, force: true });
  });

  function makeRoot(): string {
    // Sem `.git`: `resolveRepoRoot` cai no fallback do cwd quando o `git
    // rev-parse` falha, que é o que queremos — raiz isolada e previsível.
    const root = mkdtempSync(join(tmpdir(), "registry-6952-"));
    casRoots.push(root);
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
    return root;
  }

  function cliSync(root: string, args: string[]) {
    return spawnSync(process.execPath, ["--import", TSX_LOADER, CLI, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  function cliAsync(root: string, args: string[]) {
    return spawn(process.execPath, ["--import", TSX_LOADER, CLI, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function acquire(lockPath: string): void {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { closeSync(openSync(lockPath, "wx")); return; } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockPath}`);
        const end = Date.now() + 10;
        while (Date.now() < end) { /* busy wait */ }
      }
    }
  }

  const GRANT = {
    grantedTo: "benef-6952",
    grantedBy: "coord-6952",
    grantedAt: "2026-09-01T12:00:00.000Z",
    pr: 6952,
  };

  it("heartbeat espera o lock e NÃO apaga o merge_grant gravado nesse meio-tempo (#6952)", async () => {
    const root = makeRoot();
    const sessionsDir = join(root, "data", "sessions");

    const reg = cliSync(root, ["register", "--kind", "overnight", "--session-id", "coord-6952"]);
    assert.equal(reg.status, 0, `register falhou: ${reg.stderr}`);
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, `esperava 1 registro, achou ${JSON.stringify(files)}`);
    const recordPath = join(sessionsDir, files[0]!);
    const before = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(before.merge_grant, undefined, "sanity: ainda não há grant");

    // Outro escritor entra na seção crítica e segura o lock (ainda sem gravar).
    const lockPath = `${recordPath}.lock`;
    acquire(lockPath);

    // A sessão bate heartbeat no meio disso.
    const child = cliAsync(root, ["heartbeat", "--kind", "overnight", "--session-id", "coord-6952"]);

    // A asserção que separa o código corrigido do defeituoso: com o lock
    // retido, o heartbeat corrigido está bloqueado e não escreveu nada. O
    // heartbeat sem correção já leu um `current` sem grant e já gravou.
    await new Promise((r) => setTimeout(r, 1500));
    const midFlight = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(
      midFlight.lastHeartbeat,
      before.lastHeartbeat,
      "o heartbeat escreveu com o lock retido por outro escritor — é assim que o merge_grant do #6952 é apagado",
    );

    // O outro escritor grava o grant e solta o lock.
    const tmp = `${recordPath}.tmp-other`;
    writeFileSync(tmp, JSON.stringify({ ...midFlight, merge_grant: GRANT }), "utf8");
    renameSync(tmp, recordPath);
    unlinkSync(lockPath);

    const status: number = await new Promise((r) => child.on("close", (c) => r(c ?? 0)));
    assert.equal(status, 0, "o heartbeat deve suceder depois de esperar");

    const after = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.deepEqual(after.merge_grant, GRANT, "o merge_grant foi apagado pelo heartbeat — #6952");
    assert.notEqual(
      after.lastHeartbeat,
      before.lastHeartbeat,
      "o heartbeat precisa ter feito o trabalho dele depois de esperar, não desistido",
    );
  });

  it("claim-issue espera o lock e NÃO apaga o merge_grant gravado nesse meio-tempo (#6952)", async () => {
    const root = makeRoot();
    const sessionsDir = join(root, "data", "sessions");

    assert.equal(
      cliSync(root, ["register", "--kind", "overnight", "--session-id", "coord-6952"]).status,
      0,
    );
    const recordPath = join(
      sessionsDir,
      readdirSync(sessionsDir).filter((f) => f.endsWith(".json"))[0]!,
    );
    const before = JSON.parse(readFileSync(recordPath, "utf8"));

    const lockPath = `${recordPath}.lock`;
    acquire(lockPath);

    const child = cliAsync(root, [
      "claim-issue", "--issue", "6952", "--kind", "overnight", "--session-id", "coord-6952",
    ]);

    await new Promise((r) => setTimeout(r, 1500));
    const midFlight = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.deepEqual(
      midFlight.claimed_issues ?? [],
      before.claimed_issues ?? [],
      "o claim-issue escreveu com o lock retido por outro escritor — mesma classe do #6952",
    );

    const tmp = `${recordPath}.tmp-other`;
    writeFileSync(tmp, JSON.stringify({ ...midFlight, merge_grant: GRANT }), "utf8");
    renameSync(tmp, recordPath);
    unlinkSync(lockPath);

    await new Promise((r) => child.on("close", r));

    const after = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.deepEqual(
      after.merge_grant,
      GRANT,
      "o merge_grant foi apagado pelo claim-issue — a classe inteira, não só o grant-merge",
    );
    assert.ok(
      (after.claimed_issues ?? []).includes(6952),
      "e a claim precisa ter sido gravada depois da espera",
    );
  });

  it("nenhum escritor deixa a lock file pra trás (senão o próximo trava até o timeout)", () => {
    const root = makeRoot();
    const sessionsDir = join(root, "data", "sessions");
    assert.equal(
      cliSync(root, ["register", "--kind", "overnight", "--session-id", "coord-6952"]).status,
      0,
    );
    assert.equal(
      cliSync(root, ["heartbeat", "--kind", "overnight", "--session-id", "coord-6952"]).status,
      0,
    );
    assert.equal(
      cliSync(root, ["claim-issue", "--issue", "6952", "--kind", "overnight", "--session-id", "coord-6952"]).status,
      0,
    );
    assert.deepEqual(
      readdirSync(sessionsDir).filter((f) => f.endsWith(".lock")),
      [],
      "lock vazada: todo escritor seguinte (registry E beacon) ficaria bloqueado",
    );
  });
});

// ─── #6952, 2ª metade — o grant descartado na LEITURA ───────────────────────
//
// A 1ª metade (acima) é lost update na ESCRITA, fechada por CAS sob lock.
// Esta é independente e o CAS não a resolve: mesmo com toda escrita
// serializada, `mergeSessionRecords` montava o resultado com `...primary` e
// só unia `claimed_issues`/`claimed_issues_at`. `primary` é o record de
// heartbeat mais recente — então um `merge_grant` que estivesse na OUTRA
// cópia do grupo (a cópia de conflito do OneDrive, que é a razão de esta
// função existir) era descartado em silêncio ao ler.
//
// É essa assimetria que explica o sintoma medido: a claim sobrevivia porque o
// #6130/#6436 a uniram; o grant sumia porque ninguém uniu.
//
// O ambiente não é hipotético: `data/sessions/` do helios tinha 15 arquivos
// `-safeBackup-` no dia em que isto foi escrito.
describe("#6952 (2ª metade) — merge_grant sobrevive à união de cópias de conflito", () => {
  const BASE = {
    kind: "overnight" as const,
    machineTag: "helios",
    sessionId: "coord-6952",
    startedAt: "2026-09-01T10:00:00.000Z",
  };
  const GRANT = {
    grantedTo: "benef-6952",
    grantedBy: "coord-6952",
    grantedAt: "2026-09-01T12:00:00.000Z",
    pr: 6952,
  };

  it("grant na cópia com heartbeat MAIS ANTIGO não é descartado pelo primary", () => {
    // O arquivo real recebeu o grant; a cópia de conflito do OneDrive tem
    // heartbeat mais novo (o beacon continuou escrevendo nela) e nenhum grant.
    const comGrant: SessionRecord = {
      ...BASE,
      lastHeartbeat: "2026-09-01T12:00:00.000Z",
      claimed_issues: [],
      merge_grant: GRANT,
    };
    const semGrantMaisNovo: SessionRecord = {
      ...BASE,
      lastHeartbeat: "2026-09-01T12:05:00.000Z",
      claimed_issues: [],
    };

    const merged = mergeSessionRecords([comGrant, semGrantMaisNovo]);
    assert.deepEqual(
      merged.merge_grant,
      GRANT,
      "o grant foi descartado por estar fora do primary — é o #6952 na leitura",
    );
    assert.equal(
      merged.lastHeartbeat,
      "2026-09-01T12:05:00.000Z",
      "sanity: os demais campos continuam vindo do heartbeat mais recente",
    );
  });

  it("a ordem dos records não muda o resultado (o grant não depende de quem vem primeiro)", () => {
    const comGrant: SessionRecord = {
      ...BASE,
      lastHeartbeat: "2026-09-01T12:00:00.000Z",
      claimed_issues: [],
      merge_grant: GRANT,
    };
    const semGrantMaisNovo: SessionRecord = {
      ...BASE,
      lastHeartbeat: "2026-09-01T12:05:00.000Z",
      claimed_issues: [],
    };
    assert.deepEqual(mergeSessionRecords([semGrantMaisNovo, comGrant]).merge_grant, GRANT);
  });

  it("entre duas concessões diferentes vence a de grantedAt mais recente, não a do primary", () => {
    const velha = { ...GRANT, grantedAt: "2026-09-01T11:00:00.000Z", pr: 1111 };
    const nova = { ...GRANT, grantedAt: "2026-09-01T12:30:00.000Z", pr: 2222 };
    // A concessão NOVA está no record de heartbeat mais ANTIGO de propósito:
    // sem a união, `primary` entregaria a velha.
    const a: SessionRecord = {
      ...BASE,
      lastHeartbeat: "2026-09-01T12:30:00.000Z",
      claimed_issues: [],
      merge_grant: nova,
    };
    const b: SessionRecord = {
      ...BASE,
      lastHeartbeat: "2026-09-01T12:40:00.000Z",
      claimed_issues: [],
      merge_grant: velha,
    };
    assert.deepEqual(mergeSessionRecords([a, b]).merge_grant, nova);
  });

  it("consumedAt PROPAGA — uma cópia velha sem ele não ressuscita grant já usado (uso duplo)", () => {
    // Este é o cuidado que a união exige. Sem ele, consertar a perda cria um
    // dano PIOR: a beneficiária consome o grant (o `consumedAt` é gravado num
    // arquivo do grupo), e a cópia sem `consumedAt` — com heartbeat mais novo
    // — devolve o grant vivo, autorizando um SEGUNDO merge.
    const consumido: SessionRecord = {
      ...BASE,
      lastHeartbeat: "2026-09-01T12:10:00.000Z",
      claimed_issues: [],
      merge_grant: { ...GRANT, consumedAt: "2026-09-01T12:09:00.000Z" },
    };
    const naoConsumidoMaisNovo: SessionRecord = {
      ...BASE,
      lastHeartbeat: "2026-09-01T12:20:00.000Z",
      claimed_issues: [],
      merge_grant: { ...GRANT },
    };

    const merged = mergeSessionRecords([consumido, naoConsumidoMaisNovo]);
    assert.equal(
      merged.merge_grant?.consumedAt,
      "2026-09-01T12:09:00.000Z",
      "grant já consumido ressuscitou pela cópia sem consumedAt — uso duplo, pior que a perda",
    );
    // E, consumido, ele não pode mais ser lido como vivo.
    assert.equal(
      isMergeGrantLive(merged.merge_grant, "benef-6952", Date.parse("2026-09-01T12:11:00.000Z")),
      false,
      "um grant consumido nunca é 'vivo'",
    );
  });

  it("com múltiplos consumedAt, vence o MAIS ANTIGO (a primeira consumação é a real)", () => {
    const a: SessionRecord = {
      ...BASE,
      lastHeartbeat: "2026-09-01T12:10:00.000Z",
      claimed_issues: [],
      merge_grant: { ...GRANT, consumedAt: "2026-09-01T12:09:00.000Z" },
    };
    const b: SessionRecord = {
      ...BASE,
      lastHeartbeat: "2026-09-01T12:20:00.000Z",
      claimed_issues: [],
      merge_grant: { ...GRANT, consumedAt: "2026-09-01T12:15:00.000Z" },
    };
    assert.equal(mergeSessionRecords([a, b]).merge_grant?.consumedAt, "2026-09-01T12:09:00.000Z");
  });

  it("consumedAt de OUTRA concessão não contamina a vencedora", () => {
    // Identidade é (grantedBy, grantedTo, grantedAt). Um grant antigo já
    // consumido não pode marcar como consumida uma concessão NOVA e legítima —
    // senão a correção do uso duplo vira uma nova forma de perder o grant.
    const antigoConsumido = {
      ...GRANT,
      grantedAt: "2026-09-01T11:00:00.000Z",
      consumedAt: "2026-09-01T11:05:00.000Z",
    };
    // Tipado explicitamente: `assert.deepEqual` é uma assertion function
    // (`asserts actual is T`), então sem isto ela ESTREITA
    // `merged.merge_grant` pro tipo do literal — que não tem `consumedAt` — e
    // a asserção seguinte não compila no `tsconfig.test.json`.
    const novoVivo: MergeGrant = { ...GRANT, grantedAt: "2026-09-01T12:30:00.000Z" };
    const a: SessionRecord = {
      ...BASE,
      lastHeartbeat: "2026-09-01T12:30:00.000Z",
      claimed_issues: [],
      merge_grant: novoVivo,
    };
    const b: SessionRecord = {
      ...BASE,
      lastHeartbeat: "2026-09-01T12:40:00.000Z",
      claimed_issues: [],
      merge_grant: antigoConsumido,
    };
    const merged = mergeSessionRecords([a, b]);
    assert.deepEqual(merged.merge_grant, novoVivo);
    assert.equal(merged.merge_grant?.consumedAt, undefined);
  });

  it("grupo sem nenhum grant continua sem grant (a união não inventa campo)", () => {
    const a: SessionRecord = { ...BASE, lastHeartbeat: "2026-09-01T12:00:00.000Z", claimed_issues: [] };
    const b: SessionRecord = { ...BASE, lastHeartbeat: "2026-09-01T12:05:00.000Z", claimed_issues: [] };
    assert.equal("merge_grant" in mergeSessionRecords([a, b]), false);
  });

  it("consumir um grant que só existe no -safeBackup- de fato o MATA (#6952)", () => {
    // O teste irmão abaixo afirma que a leitura ACHA o grant no backup — e
    // parava aí. Meia jornada: consertar a leitura sem consertar a escrita
    // produz um estado NOVO e pior que o bug original — um grant
    // **encontrável e inconsumível**, vivo pelo TTL inteiro, porque o
    // `consumedAt` era gravado só no arquivo real, que neste cenário nem
    // carrega o grant. Achado pelo review independente e reproduzido ao vivo:
    // `findLiveMergeGrant` achava, `consumeMergeGrant` devolvia false, e a
    // leitura seguinte continuava achando.
    const root = freshRoot();
    const sessionsDir = join(root, "data", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const now = Date.parse("2026-09-01T12:01:00.000Z");

    // Arquivo REAL: heartbeat mais novo, SEM o grant.
    writeFileSync(
      join(sessionsDir, "overnight-helios-coord-6952.json"),
      JSON.stringify({ ...BASE, lastHeartbeat: "2026-09-01T12:00:30.000Z", claimed_issues: [] }),
      "utf8",
    );
    // Cópia de conflito: heartbeat mais antigo, COM o grant.
    writeFileSync(
      join(sessionsDir, "overnight-helios-coord-6952-safeBackup-0001.json"),
      JSON.stringify({
        ...BASE,
        lastHeartbeat: "2026-09-01T12:00:00.000Z",
        claimed_issues: [],
        merge_grant: GRANT,
      }),
      "utf8",
    );

    assert.ok(findLiveMergeGrant(root, "benef-6952", now), "sanity: a leitura acha o grant");

    assert.equal(
      consumeMergeGrant(root, "benef-6952", now),
      true,
      "consumir devolveu false para um grant que a leitura acha — encontrável e inconsumível",
    );
    assert.equal(
      findLiveMergeGrant(root, "benef-6952", now + 1),
      null,
      "o grant continua VIVO depois de consumido — janela aberta pelo TTL inteiro, uso duplo",
    );
    // E o `consumedAt` foi parar no arquivo que de fato carrega a concessão.
    const backup = JSON.parse(
      readFileSync(join(sessionsDir, "overnight-helios-coord-6952-safeBackup-0001.json"), "utf8"),
    );
    assert.ok(backup.merge_grant?.consumedAt, "o consumedAt precisa ter sido gravado no backup");
  });

  it("consumir marca TODAS as cópias que carregam a concessão, não só uma (#6952)", () => {
    const root = freshRoot();
    const sessionsDir = join(root, "data", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const now = Date.parse("2026-09-01T12:01:00.000Z");

    for (const [name, hb] of [
      ["overnight-helios-coord-6952.json", "2026-09-01T12:00:30.000Z"],
      ["overnight-helios-coord-6952-safeBackup-0001.json", "2026-09-01T12:00:00.000Z"],
      ["overnight-helios-coord-6952-safeBackup-0002.json", "2026-09-01T11:59:00.000Z"],
    ] as const) {
      writeFileSync(
        join(sessionsDir, name),
        JSON.stringify({ ...BASE, lastHeartbeat: hb, claimed_issues: [], merge_grant: GRANT }),
        "utf8",
      );
    }

    assert.equal(consumeMergeGrant(root, "benef-6952", now), true);
    for (const name of readdirSync(sessionsDir)) {
      const rec = JSON.parse(readFileSync(join(sessionsDir, name), "utf8"));
      assert.ok(
        rec.merge_grant?.consumedAt,
        `${name} ficou com a concessão NÃO consumida — uma cópia viva basta pra ressuscitar a janela`,
      );
    }
    assert.equal(findLiveMergeGrant(root, "benef-6952", now + 1), null);
  });

  it("fim a fim: findLiveMergeGrant acha o grant que só existe no -safeBackup- (#6952)", () => {
    const root = freshRoot();
    const sessionsDir = join(root, "data", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const now = Date.parse("2026-09-01T12:01:00.000Z");

    // Arquivo REAL: heartbeat mais novo, SEM grant (o beacon reescreveu).
    writeFileSync(
      join(sessionsDir, "overnight-helios-coord-6952.json"),
      JSON.stringify({
        ...BASE,
        lastHeartbeat: "2026-09-01T12:00:30.000Z",
        claimed_issues: [],
      }),
      "utf8",
    );
    // Cópia de conflito do OneDrive: heartbeat mais antigo, COM o grant.
    writeFileSync(
      join(sessionsDir, "overnight-helios-coord-6952-safeBackup-0001.json"),
      JSON.stringify({
        ...BASE,
        lastHeartbeat: "2026-09-01T12:00:00.000Z",
        claimed_issues: [],
        merge_grant: GRANT,
      }),
      "utf8",
    );

    const found = findLiveMergeGrant(root, "benef-6952", now);
    assert.ok(
      found,
      "o grant existe em disco mas a leitura o descartou por estar fora do primary — #6952",
    );
    assert.equal(found!.grant.pr, 6952);
    assert.equal(found!.grantedBy.sessionId, "coord-6952");
  });
});

// ─── #6952 — consumir a concessão ERRADA por troca durante a espera do lock ──
//
// Achado do 3º review independente (fio: identidade cross-máquina). O
// `consumeMergeGrant` confere a identidade `(grantedBy, grantedTo, grantedAt)`
// ANTES de pedir o lock, e o `merge` do CAS só checava `if (!current
// ?.merge_grant) throw` — nunca RECOMPARAVA a identidade contra a concessão
// que veio consumir. Entre a conferência e a aquisição do lock, o grant pode
// ter sido trocado por OUTRO, vivo e legítimo, de outro beneficiário; o
// consumidor carimbava esse.
//
// Efeito: mata a janela viva de terceiro em silêncio, devolvendo `ok`. É o
// mesmo sintoma que esta PR existe pra eliminar, por outra porta.
//
// A lacuna existe no `master` também, mas era praticamente inalcançável: lá a
// escrita vinha logo após a leitura, janela de microssegundos — a mesma classe
// que os testes acima argumentam não ser atingível por tempo. É ESTA PR que
// roteia a escrita por um laço de lock-and-wait, tornando a janela alcançável
// por contenção ordinária — contenção que a PR introduz de propósito, já que o
// beacon passa a pegar o mesmo lock a cada chamada de ferramenta. Não é bug
// escrito aqui; é bug que passou a ser alcançável aqui, e por isso se fecha
// aqui.
//
// O molde do conserto já existia no repo: `consumeOneUnderLock`, no
// `.claude/hooks/consume-merge-grant-on-merge.mjs`, já refaz a conferência
// fresca dentro do lock. O caminho quente estava certo; o CLI em TS não.
describe("#6952 — troca de concessão durante a espera do lock", () => {
  const CLI = fileURLToPath(new URL("../scripts/lib/session-registry.ts", import.meta.url));
  const TSX = pathToFileURL(
    fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
  ).href;
  const roots: string[] = [];
  after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

  it("NÃO carimba a concessão de OUTRO beneficiário trocada enquanto esperava o lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "swap-6952-"));
    roots.push(root);
    const sessionsDir = join(root, "data", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const nowIso = new Date().toISOString();
    const recordPath = join(sessionsDir, `overnight-${machineTag()}-coord-6952.json`);
    const base = {
      kind: "overnight",
      machineTag: machineTag(),
      sessionId: "coord-6952",
      startedAt: nowIso,
      lastHeartbeat: nowIso,
      claimed_issues: [],
    };
    const grantBenef1 = {
      grantedTo: "benef-1",
      grantedBy: "coord-6952",
      grantedAt: nowIso,
      pr: 1111,
    };
    writeFileSync(recordPath, JSON.stringify({ ...base, merge_grant: grantBenef1 }), "utf8");

    // Segura o lock por fora — mesma técnica dos testes acima: não corre
    // contra o relógio, força a ordem.
    const lockPath = `${recordPath}.lock`;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { closeSync(openSync(lockPath, "wx")); break; } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockPath}`);
        const end = Date.now() + 10;
        while (Date.now() < end) { /* busy wait */ }
      }
    }

    // benef-1 tenta consumir a SUA concessão — e fica bloqueado no lock.
    const child = spawn(
      process.execPath,
      ["--import", TSX, CLI, "consume-merge-grant", "--session-id", "benef-1"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += String(c)));

    await new Promise((r) => setTimeout(r, 1200));

    // Com ele parado, a coordenadora troca a concessão por uma NOVA, de outro
    // beneficiário, viva e legítima. (Na prática: a janela de benef-1 expirou
    // ou foi revogada, e a coordenadora concedeu a outra sessão.)
    const grantBenef2 = {
      grantedTo: "benef-2",
      grantedBy: "coord-6952",
      grantedAt: new Date(Date.now() + 1000).toISOString(),
      pr: 2222,
    };
    const tmp = `${recordPath}.tmp-swap`;
    writeFileSync(tmp, JSON.stringify({ ...base, merge_grant: grantBenef2 }), "utf8");
    renameSync(tmp, recordPath);
    unlinkSync(lockPath);

    await new Promise((r) => child.on("close", r));

    const after = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(
      after.merge_grant?.grantedTo,
      "benef-2",
      "sanity: a concessão no disco é a de benef-2",
    );
    assert.equal(
      after.merge_grant?.consumedAt,
      undefined,
      "o consumidor de benef-1 carimbou a concessão VIVA de benef-2 — matou janela alheia em silêncio",
    );
    assert.match(
      stdout,
      /no-op \(nenhuma janela viva\)/,
      `o consumo devia recusar, não reportar sucesso — stdout: ${stdout}`,
    );
  });
});

// ─── #6952 — a fronteira de MÁQUINA no dedupe ───────────────────────────────
//
// Achado do 3º review independente. `dedupeBySessionId` agrupava por
// `sessionId` puro, ignorando `machineTag`. O propósito dele é intra-máquina
// (uma sessão promovida de `interactive` pra coordenadora mantém o
// `sessionId` e troca o `kind`, no MESMO host) — então dois registros com o
// mesmo `sessionId` e tags diferentes não são a mesma sessão, e fundi-los
// mistura duas.
//
// Antes desta PR quase não tinha consequência: só `claimed_issues` era unido
// e o resto vinha do `primary`, então um `merge_grant` só cruzava a fronteira
// de máquina por coincidência de heartbeat. Com o `merge_grant` na união, o
// vazamento passaria a ser sistemático. `data/sessions/` é compartilhado via
// OneDrive entre as máquinas — a fronteira é real, não teórica.
//
// Dormente (nada num fluxo normal produz o mesmo `sessionId` sob duas tags),
// então o que se entrega é a chave + este teste, não mecanismo novo.
describe("#6952 — dedupe respeita a fronteira de máquina", () => {
  const roots: string[] = [];
  after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

  it("mesmo sessionId em máquinas DIFERENTES não vira um record só (grant não vaza)", () => {
    const root = mkdtempSync(join(tmpdir(), "crossmachine-6952-"));
    roots.push(root);
    const sessionsDir = join(root, "data", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const now = Date.now();
    const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

    const shared = {
      kind: "develop" as const,
      sessionId: "sess-colisao",
      startedAt: iso(-60_000),
      claimed_issues: [],
    };
    // Neo: concedeu uma janela.
    writeFileSync(
      join(sessionsDir, "develop-Neo-sess-colisao.json"),
      JSON.stringify({
        ...shared,
        machineTag: "Neo",
        lastHeartbeat: iso(-1000),
        merge_grant: {
          grantedTo: "benef-6952",
          grantedBy: "sess-colisao",
          grantedAt: iso(-2000),
          pr: 6952,
        },
      }),
      "utf8",
    );
    // helios: MESMO sessionId (colisão), sem concessão nenhuma.
    writeFileSync(
      join(sessionsDir, "develop-helios-sess-colisao.json"),
      JSON.stringify({ ...shared, machineTag: "helios", lastHeartbeat: iso(0) }),
      "utf8",
    );

    const active = listActiveSessions(root, now);
    const colisao = active.filter((r) => r.sessionId === "sess-colisao");
    assert.equal(
      colisao.length,
      2,
      "os dois registros viraram um só — duas sessões de máquinas diferentes fundidas",
    );

    const neo = colisao.find((r) => r.machineTag === "Neo");
    const helios = colisao.find((r) => r.machineTag === "helios");
    assert.ok(neo && helios, "as duas tags precisam sobreviver ao dedupe");
    assert.ok(neo!.merge_grant, "a concessão do Neo tem que continuar no registro do Neo");
    assert.equal(
      helios!.merge_grant,
      undefined,
      "a concessão do Neo vazou pro registro do helios — grant cruzando a fronteira de máquina",
    );
  });
});

// ─── #6952 — endSession e o lock órfão ──────────────────────────────────────
//
// Achado do 4º review independente, reproduzido. A rodada 2 desta PR fez o
// `endSession` envolver a remoção em `withFileLock` — certo, fecha a corrida
// em que um CAS concorrente RECRIA o registro recém-encerrado. Mas, diferente
// do `writeJsonSafeWithCas` (que chama `breakStaleLock` antes de CADA
// tentativa), o `endSession` chamava `withFileLock` uma vez, sem quebrar
// órfão: com um `.lock` deixado por um processo que morreu segurando-o, o
// `end` gastava o timeout inteiro (10s) e LANÇAVA, e o registro sobrevivia.
//
// Ou seja: o modo de falha que o `breakStaleLock` existe pra eliminar,
// reaberto num call site que esta mesma PR criou.
//
// É P1 e não P2 por uma razão específica: `end` é a ÚLTIMA operação sobre o
// arquivo. Os outros escritores se autocurariam na escrita seguinte — aqui
// não há escrita seguinte. E `end` é o passo final obrigatório de toda rodada
// overnight/develop/contínuo.
describe("#6952 — endSession quebra lock órfão antes de adquirir", () => {
  const roots: string[] = [];
  after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

  function makeSession(): { root: string; path: string } {
    const root = mkdtempSync(join(tmpdir(), "endorphan-6952-"));
    roots.push(root);
    const dir = join(root, "data", "sessions");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `develop-${machineTag()}-orphan-6952.json`);
    const now = new Date().toISOString();
    writeFileSync(
      path,
      JSON.stringify({
        kind: "develop",
        machineTag: machineTag(),
        sessionId: "orphan-6952",
        startedAt: now,
        lastHeartbeat: now,
        claimed_issues: [],
      }),
      "utf8",
    );
    return { root, path };
  }

  it("lock ÓRFÃO não impede encerrar a sessão (era 10s + throw, com o registro sobrevivendo)", () => {
    const { root, path } = makeSession();
    const lockPath = `${path}.lock`;
    closeSync(openSync(lockPath, "wx"));
    // Envelhece além do STALE_LOCK_MS: é o que sobra de um processo morto com
    // SIGKILL/OOM, ou do binário quebrando no meio (9× num único dia).
    const old = new Date(Date.now() - 150_000);
    utimesSync(lockPath, old, old);

    const started = Date.now();
    const removed = endSession(root, "develop", "orphan-6952", machineTag());
    const elapsed = Date.now() - started;

    assert.equal(removed, true, "o end recusou por causa de um lock que ninguém segura");
    assert.equal(existsSync(path), false, "o registro sobreviveu ao end — sessão encerrada que nunca sai");
    assert.ok(
      elapsed < 5_000,
      `o end gastou ${elapsed}ms esperando um lock órfão (o timeout é 10s) em vez de quebrá-lo`,
    );
  });

  it("lock VIVO (recém-criado) continua sendo respeitado — não sai quebrando tudo", () => {
    const { root, path } = makeSession();
    const lockPath = `${path}.lock`;
    closeSync(openSync(lockPath, "wx")); // recém-criado: outro escritor está na seção crítica

    assert.throws(
      // Timeout curto: o ponto é PROVAR que espera e falha, não gastar os 10s
      // de produção fazendo isso (ver o parâmetro no `endSession`).
      () => endSession(root, "develop", "orphan-6952", machineTag(), 300),
      /lock timeout/,
      "o end quebrou um lock VIVO — a quebra é só por IDADE, nunca incondicional",
    );
    assert.equal(existsSync(path), true, "o registro não pode sumir enquanto outro escritor tem o lock");
    unlinkSync(lockPath);
  });
});

// ─── #7002/#7003/#6999/#6972 — a âncora some, a sessão continua VIVA ───────
//
// Os quatro modos deste bloco nasceram da MESMA janela de evidência (rodada
// `/diaria-overnight` 260901b/c, helios, 01-02/09/2026): o arquivo REAL de uma
// coordenadora ATIVA desapareceu de `data/sessions/` sob escrita concorrente no
// junction OneDrive, e sobraram só cópias `-safeBackup-` com as 10 claims e um
// `merge_grant` íntegros. Todo o read-path as descartou, porque "backup sem
// arquivo real" era tratado como sinônimo de "sessão encerrada" — e as duas
// causas produzem a MESMA forma em disco.

const CLI_7002 = fileURLToPath(new URL("../scripts/lib/session-registry.ts", import.meta.url));
const TSX_LOADER_7002 = pathToFileURL(
  fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
).href;

/** Raiz isolada (sem `.git`, pra `resolveRepoRoot` cair no cwd) já com `data/sessions/`. */
function freshCliRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "registry-7002-"));
  roots.push(root);
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  return root;
}

function cli7002(root: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER_7002, CLI_7002, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
}

/** Captura o stderr do processo durante `fn` (os avisos altos deste bloco). */
function captureStderr(fn: () => void): string {
  let out = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

describe("#7002 — grupo de backups ÓRFÃO mas VIVO volta a contar como sessão ativa", () => {
  const NOW = Date.parse("2026-09-02T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();

  it("cenário da issue: o real da coordenadora sumiu, as cópias vivas guardam as claims → a sessão volta a aparecer COM elas", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "overnight-helios-coord-7002-helios-safeBackup-0001.json", {
      kind: "overnight",
      machineTag: "helios",
      sessionId: "coord-7002",
      startedAt: iso(NOW - 2 * 60 * 60 * 1000),
      lastHeartbeat: iso(NOW - 60 * 1000),
      claimed_issues: [6947, 6970],
    });
    writeRawSessionFile(root, "overnight-helios-coord-7002-helios-safeBackup-0002.json", {
      kind: "overnight",
      machineTag: "helios",
      sessionId: "coord-7002",
      startedAt: iso(NOW - 2 * 60 * 60 * 1000),
      lastHeartbeat: iso(NOW - 2 * 60 * 1000),
      claimed_issues: [6972],
    });
    // Nenhum arquivo real — é literalmente o estado medido em 01/09.

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 1, "grupo órfão VIVO não pode continuar invisível ao read-path");
    assert.equal(sessions[0].kind, "overnight");
    assert.equal(sessions[0].stale, false);
    assert.deepEqual(
      sessions[0].claimed_issues,
      [6947, 6970, 6972],
      "união de TODAS as cópias, não só a de heartbeat mais novo",
    );
    assert.ok(
      isIssueClaimedByOther(root, 6972, "outra-sessao", NOW),
      "falso-negativo de claim (issue reivindicada aparecendo livre) é o dano central da #7002",
    );
  });

  it("o beacon recriando um interactive VAZIO não apaga as claims dos backups órfãos", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "overnight-helios-coord-7002b-helios-safeBackup-0001.json", {
      kind: "overnight",
      machineTag: "helios",
      sessionId: "coord-7002b",
      startedAt: iso(NOW - 2 * 60 * 60 * 1000),
      lastHeartbeat: iso(NOW - 5 * 60 * 1000),
      claimed_issues: [6947, 6970, 6972],
    });
    // O beacon recria `interactive-{tag}-{sessionId}.json` com heartbeat MAIS
    // NOVO e sem claim nenhuma — foi ele que "venceu" a leitura na issue.
    writeRawSessionFile(root, "interactive-helios-coord-7002b.json", {
      kind: "interactive",
      machineTag: "helios",
      sessionId: "coord-7002b",
      startedAt: iso(NOW - 60 * 1000),
      lastHeartbeat: iso(NOW - 10 * 1000),
      claimed_issues: [],
    });

    const sessions = listActiveSessions(root, NOW);
    assert.equal(sessions.length, 1, "mesmo sessionId nunca vira duas sessões");
    assert.equal(sessions[0].kind, "overnight", "coordenadora vence interactive como base (#6481)");
    assert.deepEqual(sessions[0].claimed_issues, [6947, 6970, 6972]);
  });

  it("endSession carimba endedAt em TODAS as cópias do grupo — encerrar continua encerrando", () => {
    const root = freshRoot();
    const tag = "helios";
    registerSession(root, "develop", "sess-fim-7002", { tag, startedAt: iso(NOW - 30 * 60 * 1000) });
    claimIssueCheckAndSet(root, "develop", "sess-fim-7002", 4242, tag, iso(NOW - 20 * 60 * 1000));
    const backupName = `develop-${tag}-sess-fim-7002-${tag}-safeBackup-0001.json`;
    writeRawSessionFile(root, backupName, {
      kind: "develop",
      machineTag: tag,
      sessionId: "sess-fim-7002",
      startedAt: iso(NOW - 30 * 60 * 1000),
      lastHeartbeat: iso(NOW - 60 * 1000),
      claimed_issues: [4242],
    });

    assert.equal(endSession(root, "develop", "sess-fim-7002", tag), true);

    const backup = JSON.parse(readFileSync(join(sessionsDir(root), backupName), "utf8"));
    assert.ok(backup.endedAt, "sem o carimbo, toda sessão encerrada com cópia de conflito ressuscitaria por 90min");
    assert.deepEqual(listActiveSessions(root, NOW), [], "sessão encerrada não volta pelo caminho do #7002");
    assert.equal(isIssueClaimedByOther(root, 4242, "outra-sessao", NOW), null);
  });

  it("merge_grant que vive só no grupo órfão VIVO volta a ser encontrável — e sai marcado como cópia de conflito (#6972)", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "overnight-helios-coord-7002c-helios-safeBackup-0001.json", {
      kind: "overnight",
      machineTag: "helios",
      sessionId: "coord-7002c",
      startedAt: iso(NOW - 60 * 60 * 1000),
      lastHeartbeat: iso(NOW - 60 * 1000),
      claimed_issues: [],
      merge_grant: { grantedTo: "interativa", grantedBy: "coord-7002c", grantedAt: iso(NOW - 60 * 1000), pr: 7002 },
    });

    const found = findLiveMergeGrant(root, "interativa", NOW);
    assert.ok(found, "grant vivo num grupo órfão vivo não pode sumir do read-path");
    assert.equal(found?.source, "backup");
  });
});

describe("#7003 — claim-issue nunca recria o registro ZERADO quando a âncora some com a sessão viva", () => {
  const NOW = Date.parse("2026-09-02T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const TAG = "helios";
  const PREVIAS = [6947, 6952, 6955, 6960, 6962, 6966, 6968, 6970, 6971, 6972];

  function orphanComAsDezClaims(root: string, sessionId: string): void {
    writeRawSessionFile(root, `overnight-${TAG}-${sessionId}-${TAG}-safeBackup-0001.json`, {
      kind: "overnight",
      machineTag: TAG,
      sessionId,
      startedAt: iso(NOW - 3 * 60 * 60 * 1000),
      lastHeartbeat: iso(NOW - 60 * 1000),
      claimed_issues: PREVIAS,
      claimed_issues_at: { "6947": iso(NOW - 3 * 60 * 60 * 1000) },
    });
  }

  it("reprodução da issue: as 10 claims anteriores SOBREVIVEM ao re-claim, em vez de virar 'as 3 últimas'", () => {
    const root = freshRoot();
    orphanComAsDezClaims(root, "coord-7003");

    const result = claimIssueAutoRegistering(root, "overnight", "coord-7003", 7003, TAG, iso(NOW));

    assert.equal(result.ok, true);
    assert.equal(result.autoRegistered, true);
    assert.equal(
      result.autoRegisterMode,
      "recovered-from-orphan-backups",
      "'sessão nova' e 'âncora sumiu com a sessão viva' não podem mais sair pelo mesmo caminho",
    );
    assert.deepEqual(result.recoveredClaims, PREVIAS);
    assert.equal(result.recoveredFromFiles, 1);

    const onDisk = JSON.parse(readFileSync(sessionFilePath(root, "overnight", TAG, "coord-7003"), "utf8"));
    assert.deepEqual(
      onDisk.claimed_issues,
      [...PREVIAS, 7003].sort((a, b) => a - b),
      "a âncora reconstruída carrega as claims antigas + a nova, nunca só a nova",
    );
    assert.equal(
      onDisk.claimed_issues_at["6947"],
      iso(NOW - 3 * 60 * 60 * 1000),
      "claimed_issues_at preservado (idade de claim não rejuvenesce na reconstrução)",
    );
  });

  it("a reconstrução é RUIDOSA: stderr diz que a âncora sumiu com a sessão viva, não que nasceu uma sessão nova", () => {
    const root = freshRoot();
    orphanComAsDezClaims(root, "coord-7003b");

    const stderr = captureStderr(() => {
      claimIssueAutoRegistering(root, "overnight", "coord-7003b", 7003, TAG, iso(NOW));
    });

    assert.match(stderr, /ATENÇÃO/);
    assert.match(stderr, /NÃO é uma sessão nova/i);
    assert.match(stderr, /#7002\/#7003/);
  });

  it("sessão genuinamente NOVA (nenhuma cópia em disco) continua no caminho 'fresh' do #6369", () => {
    const root = freshRoot();

    const result = claimIssueAutoRegistering(root, "continuo", "sess-nova-7003", 6352, TAG, iso(NOW));

    assert.equal(result.ok, true);
    assert.equal(result.autoRegistered, true);
    assert.equal(result.autoRegisterMode, "fresh");
    assert.equal(result.recoveredClaims, undefined);
  });

  it("grupo órfão CARIMBADO (sessão encerrada limpo) NÃO é recuperado — o re-claim nasce limpo", () => {
    const root = freshRoot();
    writeRawSessionFile(root, `overnight-${TAG}-coord-7003c-${TAG}-safeBackup-0001.json`, {
      kind: "overnight",
      machineTag: TAG,
      sessionId: "coord-7003c",
      startedAt: iso(NOW - 3 * 60 * 60 * 1000),
      lastHeartbeat: iso(NOW - 60 * 1000),
      endedAt: iso(NOW - 30 * 1000),
      claimed_issues: PREVIAS,
    });

    const result = claimIssueAutoRegistering(root, "overnight", "coord-7003c", 7003, TAG, iso(NOW));

    assert.equal(result.autoRegisterMode, "fresh", "sessão encerrada não ressuscita claims por um claim novo");
    const onDisk = JSON.parse(readFileSync(sessionFilePath(root, "overnight", TAG, "coord-7003c"), "utf8"));
    assert.deepEqual(onDisk.claimed_issues, [7003]);
  });

  it("grupo órfão STALE não é recuperado (o sinal de liveness continua sendo o heartbeat)", () => {
    const root = freshRoot();
    writeRawSessionFile(root, `overnight-${TAG}-coord-7003d-${TAG}-safeBackup-0001.json`, {
      kind: "overnight",
      machineTag: TAG,
      sessionId: "coord-7003d",
      startedAt: iso(NOW - 10 * 60 * 60 * 1000),
      lastHeartbeat: iso(NOW - SOFT_STALE_MS - 60 * 1000),
      claimed_issues: PREVIAS,
    });

    const result = claimIssueAutoRegistering(root, "overnight", "coord-7003d", 7003, TAG, iso(NOW));

    assert.equal(result.autoRegisterMode, "fresh");
  });

  it("a reconstrução recupera CLAIM mas nunca merge_grant — promover autorização de cópia de conflito é o que o #6972 recusa", () => {
    const root = freshRoot();
    writeRawSessionFile(root, `overnight-${TAG}-coord-7003e-${TAG}-safeBackup-0001.json`, {
      kind: "overnight",
      machineTag: TAG,
      sessionId: "coord-7003e",
      startedAt: iso(NOW - 60 * 60 * 1000),
      lastHeartbeat: iso(NOW - 60 * 1000),
      claimed_issues: [6947],
      merge_grant: { grantedTo: "interativa", grantedBy: "coord-7003e", grantedAt: iso(NOW - 60 * 1000), pr: 6983 },
    });

    claimIssueAutoRegistering(root, "overnight", "coord-7003e", 7003, TAG, iso(NOW));

    const onDisk = JSON.parse(readFileSync(sessionFilePath(root, "overnight", TAG, "coord-7003e"), "utf8"));
    assert.deepEqual(onDisk.claimed_issues, [6947, 7003], "claim se recupera — a direção segura é 'preferir reivindicada'");
    assert.equal(
      onDisk.merge_grant,
      undefined,
      "grant NÃO se recupera: no arquivo real, o gate do #5716 passaria a honrar uma concessão que só existia em detrito de sync",
    );
    assert.equal(
      findLiveMergeGrant(root, "interativa", NOW)?.source,
      "backup",
      "a concessão continua encontrável e continua marcada como não-honrada — o caminho é pedir reconcessão",
    );
  });

  it("CLI: a mensagem de sucesso grita ALERTA (âncora sumida) em vez do ATENÇÃO rotineiro do #6369", () => {
    const root = freshCliRoot();
    const tag = machineTag();
    const nowMs = Date.now();
    writeFileSync(
      join(root, "data", "sessions", `overnight-${tag}-cli-7003-${tag}-safeBackup-0001.json`),
      JSON.stringify({
        kind: "overnight",
        machineTag: tag,
        sessionId: "cli-7003",
        startedAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
        lastHeartbeat: new Date(nowMs - 60 * 1000).toISOString(),
        claimed_issues: [6947, 6970],
      }),
      "utf8",
    );

    const res = cli7002(root, ["claim-issue", "--kind", "overnight", "--session-id", "cli-7003", "--issue", "7003"]);

    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /ALERTA: a ÂNCORA desta sessão SUMIU/);
    assert.match(res.stdout, /2 claim\(s\) recuperada\(s\)/);
    assert.doesNotMatch(res.stdout, /não tinha registro prévio/, "a mensagem do #6369 descreve a outra causa");
  });
});

describe("#6999 — grant-merge: guard de --session-id e mensagem que nomeia a CONCEDENTE", () => {
  const NOW = Date.parse("2026-09-02T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const TAG = "helios";

  it("fix 1 (implementado em 26/08, travado aqui): sem --session-id o comando falha ALTO, nomeando a flag", () => {
    const root = freshCliRoot();

    const res = cli7002(root, ["grant-merge", "--kind", "overnight", "--granted-to", "benef-6999", "--pr", "6983"]);

    assert.notEqual(res.status, 0);
    assert.match(res.stderr + res.stdout, /--session-id ausente/);
  });

  it("fix 2: concedente cuja âncora sumiu, com cópias órfãs VIVAS, CONCEDE em vez de 'sessão inexistente'", () => {
    const root = freshRoot();
    writeRawSessionFile(root, `overnight-${TAG}-coord-6999-${TAG}-safeBackup-0001.json`, {
      kind: "overnight",
      machineTag: TAG,
      sessionId: "coord-6999",
      startedAt: iso(NOW - 60 * 60 * 1000),
      lastHeartbeat: iso(NOW - 60 * 1000),
      claimed_issues: [6999],
    });

    const result = grantMergeWindow(root, "overnight", "coord-6999", "interativa", {
      pr: 6983,
      tag: TAG,
      now: iso(NOW),
    });

    assert.equal(result.ok, true, `esperava conceder, veio "${result.reason}"`);
    const onDisk = JSON.parse(readFileSync(sessionFilePath(root, "overnight", TAG, "coord-6999"), "utf8"));
    assert.equal(onDisk.merge_grant.grantedTo, "interativa");
    assert.deepEqual(onDisk.claimed_issues, [6999], "a reconstrução preserva o estado, não só cria a casca");
  });

  it("sem âncora E sem cópia viva continua no-op-session-missing (a recusa honesta não some)", () => {
    const root = freshRoot();

    const result = grantMergeWindow(root, "overnight", "coord-inexistente", "interativa", {
      pr: 1,
      tag: TAG,
      now: iso(NOW),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-op-session-missing");
  });

  it("CLI: a mensagem de 'sessão inexistente' nomeia a CONCEDENTE e inocenta --granted-to", () => {
    const root = freshCliRoot();
    // A BENEFICIÁRIA existe e está viva — era exatamente o estado que fechava
    // a porta do diagnóstico correto na issue (o operador conferia o arquivo
    // dela, achava, e concluía que o mecanismo estava quebrado).
    const tag = machineTag();
    writeFileSync(
      join(root, "data", "sessions", `interactive-${tag}-benef-6999.json`),
      JSON.stringify({
        kind: "interactive",
        machineTag: tag,
        sessionId: "benef-6999",
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        claimed_issues: [],
      }),
      "utf8",
    );

    const res = cli7002(root, [
      "grant-merge",
      "--kind",
      "overnight",
      "--session-id",
      "coord-inexistente-6999",
      "--granted-to",
      "benef-6999",
      "--pr",
      "6983",
    ]);

    assert.equal(res.status, 1);
    assert.match(res.stdout, /sessão CONCEDENTE/);
    assert.match(res.stdout, /coord-inexistente-6999/, "imprime o identificador procurado");
    assert.match(res.stdout, /NÃO é o problema aqui/);
  });
});

describe("#6972 — proveniência do grant vencedor (arquivo real × cópia de conflito)", () => {
  const NOW = Date.parse("2026-09-02T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const TAG = "helios";

  function coordenadoraViva(root: string, sessionId: string): void {
    writeRawSessionFile(root, `overnight-${TAG}-${sessionId}.json`, {
      kind: "overnight",
      machineTag: TAG,
      sessionId,
      startedAt: iso(NOW - 60 * 60 * 1000),
      lastHeartbeat: iso(NOW - 30 * 1000),
      claimed_issues: [],
    });
  }

  it("grant no arquivo REAL → source 'real' (o gate enxerga e honra)", () => {
    const root = freshRoot();
    coordenadoraViva(root, "coord-6972a");
    assert.equal(
      grantMergeWindow(root, "overnight", "coord-6972a", "interativa", { pr: 1, tag: TAG, now: iso(NOW) }).ok,
      true,
    );

    const found = findLiveMergeGrant(root, "interativa", NOW);
    assert.equal(found?.source, "real");
  });

  it("grant SÓ em -safeBackup- → source 'backup' (o gate é cego a cópia de conflito, por decisão)", () => {
    const root = freshRoot();
    coordenadoraViva(root, "coord-6972b");
    // A cópia de conflito carrega a concessão; o arquivo real, não — é o
    // estado que fazia `check-merge-grant` dizer `granted: true` pra uma
    // janela que o `gh pr merge` bloqueava.
    writeRawSessionFile(root, `overnight-${TAG}-coord-6972b-${TAG}-safeBackup-0001.json`, {
      kind: "overnight",
      machineTag: TAG,
      sessionId: "coord-6972b",
      startedAt: iso(NOW - 60 * 60 * 1000),
      lastHeartbeat: iso(NOW - 90 * 1000),
      claimed_issues: [],
      merge_grant: { grantedTo: "interativa", grantedBy: "coord-6972b", grantedAt: iso(NOW - 60 * 1000), pr: 6983 },
    });

    const found = findLiveMergeGrant(root, "interativa", NOW);
    assert.ok(found);
    assert.equal(found?.source, "backup");
  });

  it("CLI check-merge-grant: expõe source/visible_to_merge_gate e AVISA em stderr quando o gate não vai honrar", () => {
    const root = freshCliRoot();
    const tag = machineTag();
    const nowMs = Date.now();
    writeFileSync(
      join(root, "data", "sessions", `overnight-${tag}-coord-6972c.json`),
      JSON.stringify({
        kind: "overnight",
        machineTag: tag,
        sessionId: "coord-6972c",
        startedAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
        lastHeartbeat: new Date(nowMs - 30 * 1000).toISOString(),
        claimed_issues: [],
      }),
      "utf8",
    );
    writeFileSync(
      join(root, "data", "sessions", `overnight-${tag}-coord-6972c-${tag}-safeBackup-0001.json`),
      JSON.stringify({
        kind: "overnight",
        machineTag: tag,
        sessionId: "coord-6972c",
        startedAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
        lastHeartbeat: new Date(nowMs - 90 * 1000).toISOString(),
        claimed_issues: [],
        merge_grant: {
          grantedTo: "benef-6972",
          grantedBy: "coord-6972c",
          grantedAt: new Date(nowMs - 60 * 1000).toISOString(),
          pr: 6983,
        },
      }),
      "utf8",
    );

    const res = cli7002(root, ["check-merge-grant", "--session-id", "benef-6972"]);

    assert.equal(res.status, 0, res.stdout + res.stderr);
    const payload = JSON.parse(res.stdout.trim());
    assert.equal(payload.granted, true);
    assert.equal(payload.source, "backup");
    assert.equal(payload.visible_to_merge_gate, false);
    assert.match(res.stderr, /cópia de conflito do OneDrive/);
    assert.match(res.stderr, /RECONCESSÃO/i);
  });
});

// ─── #7169/#7171 — glue de CLI dos dois fixes (review independente, PR #7223) ───
//
// As funções puras (`assessCrossMachineSyncFreshness`) já tinham teste
// unitário; nada exercitava a fiação real dentro dos cases `merge-lock-acquire`
// e `consume-merge-grant` — que ela é chamada com os argumentos certos, que o
// aviso vai pro STDERR (nunca stdout, que scripts leem como payload) e que o
// texto do `--help` foi de fato atualizado.

describe("CLI merge-lock-acquire: aviso de frescor cross-máquina (#7169) vai pro stderr, nunca stdout", () => {
  const OTHER_TAG = "otherhost-7169";

  it("coordenadora de OUTRA máquina com heartbeat > 10min (mas < 90min) dispara aviso em stderr", () => {
    const root = freshCliRoot();
    const nowMs = Date.now();
    writeFileSync(
      join(root, "data", "sessions", `overnight-${OTHER_TAG}-coord-7169.json`),
      JSON.stringify({
        kind: "overnight",
        machineTag: OTHER_TAG,
        sessionId: "coord-7169",
        // 15min: acima de CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS (10min), abaixo
        // de SOFT_STALE_MS (90min) — a janela exata que o #7169 existe pra
        // tornar visível.
        startedAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
        lastHeartbeat: new Date(nowMs - 15 * 60 * 1000).toISOString(),
        claimed_issues: [],
      }),
      "utf8",
    );

    const res = cli7002(root, ["merge-lock-acquire", "--session-id", "acquirer-7169"]);

    assert.equal(res.status, 0, res.stdout + res.stderr);
    // O resultado do lock em si (ok/denied) segue só em stdout — nunca
    // contaminado pelo aviso de frescor.
    assert.match(res.stdout, /merge-lock-acquire ok/);
    assert.doesNotMatch(res.stdout, /ATENÇÃO/);
    assert.match(res.stderr, /ATENÇÃO \(#7169\)/);
    assert.match(res.stderr, new RegExp(`overnight-${OTHER_TAG}-coord-7169 \\(heartbeat de `));
  });

  it("coordenadora de OUTRA máquina com heartbeat recente (<10min) NÃO dispara aviso", () => {
    const root = freshCliRoot();
    const nowMs = Date.now();
    writeFileSync(
      join(root, "data", "sessions", `overnight-${OTHER_TAG}-coord-7169b.json`),
      JSON.stringify({
        kind: "overnight",
        machineTag: OTHER_TAG,
        sessionId: "coord-7169b",
        startedAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
        lastHeartbeat: new Date(nowMs - 30 * 1000).toISOString(),
        claimed_issues: [],
      }),
      "utf8",
    );

    const res = cli7002(root, ["merge-lock-acquire", "--session-id", "acquirer-7169b"]);

    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /merge-lock-acquire ok/);
    assert.doesNotMatch(res.stderr, /ATENÇÃO \(#7169\)/);
  });
});

describe("CLI consume-merge-grant: aviso de uso indevido (#7171) vai pro stderr, nunca stdout", () => {
  it("consumir uma janela viva emite o aviso 'não é passo do beneficiário' em stderr", () => {
    const root = freshCliRoot();
    const tag = machineTag();
    const nowMs = Date.now();
    writeFileSync(
      join(root, "data", "sessions", `overnight-${tag}-coord-7171.json`),
      JSON.stringify({
        kind: "overnight",
        machineTag: tag,
        sessionId: "coord-7171",
        startedAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
        lastHeartbeat: new Date(nowMs - 30 * 1000).toISOString(),
        claimed_issues: [],
        merge_grant: {
          grantedTo: "benef-7171",
          grantedBy: "coord-7171",
          grantedAt: new Date(nowMs - 5 * 1000).toISOString(),
          pr: 7171,
        },
      }),
      "utf8",
    );

    const res = cli7002(root, ["consume-merge-grant", "--session-id", "benef-7171"]);

    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /consume-merge-grant ok \(janela consumida/);
    assert.doesNotMatch(res.stdout, /ATENÇÃO/);
    assert.match(res.stderr, /ATENÇÃO \(#7171\)/);
    assert.match(res.stderr, /caminho feliz nunca inclui `consume-merge-grant` explícito/);
  });

  it("no-op (nenhuma janela viva) também emite o aviso em stderr e sai com exit 1", () => {
    const root = freshCliRoot();

    const res = cli7002(root, ["consume-merge-grant", "--session-id", "sem-janela-7171"]);

    assert.equal(res.status, 1);
    assert.match(res.stdout, /consume-merge-grant no-op \(nenhuma janela viva\)/);
    assert.match(res.stderr, /ATENÇÃO \(#7171\)/);
  });

  it("--help (subcomando desconhecido) documenta que consume-merge-grant não é passo do beneficiário", () => {
    const root = freshCliRoot();

    const res = cli7002(root, ["subcomando-inexistente-7171"]);

    assert.equal(res.status, 1);
    assert.match(res.stderr, /consume-merge-grant NÃO é um passo do beneficiário \(#7171\)/);
    assert.match(
      res.stderr,
      /chamar consume-merge-grant à mão ANTES do merge queima a janela e o merge seguinte é bloqueado/,
    );
  });
});
