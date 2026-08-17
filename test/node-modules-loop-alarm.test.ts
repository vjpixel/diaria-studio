/**
 * test/node-modules-loop-alarm.test.ts (#5571)
 *
 * Regressão pura pra `scripts/lib/node-modules-loop-alarm.ts` (detector de
 * symlink auto-referente + idempotência do alarme) e I/O de
 * `scripts/node-modules-loop-alarm.ts` (`inspectNodeModules`,
 * `loadState`/`saveState`, `toAlarmFinding`). Nenhum teste cria symlinks
 * reais no filesystem (Windows exige privilégio elevado pra symlink — ver
 * memória `dev-mode-ligado-nao-basta-symlink`) — `inspectNodeModules` é
 * testado com um path que não existe (branch fail-soft) e o detector puro
 * é testado inteiramente via `SymlinkLoopInput` construído à mão, mesma
 * disciplina de `test/robots-txt-drift-check.test.ts` (resultado do I/O já
 * resolvido entra como fixture, nunca a chamada real).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, resolve, sep } from "node:path";

import {
  evaluateNodeModulesSymlink,
  emptyNodeModulesLoopAlarmState,
  advanceNodeModulesLoopAlarmState,
  shouldAlarmNodeModulesLoop,
  isNodeModulesLoopPending,
  nodeModulesLoopFindingKey,
  buildNodeModulesLoopAlarmEmail,
  type SymlinkLoopInput,
  type SymlinkLoopEvaluation,
} from "../scripts/lib/node-modules-loop-alarm.ts";
import {
  loadState,
  saveState,
  inspectNodeModules,
  toAlarmFinding,
  type NodeModulesFsOps,
} from "../scripts/node-modules-loop-alarm.ts";

const isWindows = platform() === "win32";

// Fixture de checkout construída via path.resolve (não uma string POSIX
// hardcoded) de propósito — em produção esta checagem roda no servidor
// Linux (predator, ver #5571), mas os testes rodam em qualquer plataforma
// (incl. Windows, onde `path.resolve`/`.normalize` tratam um path
// "/home/..." cru de forma inconsistente entre si por causa da letra de
// unidade). Usar `resolve()` pra CONSTRUIR a fixture garante que ela já
// nasce no formato canônico da plataforma atual, coerente com o que o
// próprio módulo produz internamente (`normalize`).
const CHECKOUT_ROOT = resolve(tmpdir(), "diaria-studio-fixture-5571");
const NODE_MODULES = join(CHECKOUT_ROOT, "node_modules");

function input(overrides: Partial<SymlinkLoopInput> = {}): SymlinkLoopInput {
  return { nodeModulesPath: NODE_MODULES, isSymlink: false, linkTarget: null, ...overrides };
}

describe("evaluateNodeModulesSymlink (#5571) — detector puro", () => {
  it("não é symlink -> status ok, resolvedTarget null", () => {
    const r = evaluateNodeModulesSymlink(input({ isSymlink: false, linkTarget: null }));
    assert.equal(r.status, "ok");
    assert.equal(r.resolvedTarget, null);
  });

  it("symlink com alvo ABSOLUTO igual ao próprio path -> loop (o caso real do achado #5571)", () => {
    const r = evaluateNodeModulesSymlink(input({ isSymlink: true, linkTarget: NODE_MODULES }));
    assert.equal(r.status, "loop");
    assert.equal(r.resolvedTarget, NODE_MODULES);
    assert.match(r.message, /AUTO-REFERENTE/);
  });

  it("symlink com alvo RELATIVO que resolve pro próprio path -> loop", () => {
    // node_modules -> . (relativo ao próprio diretório-pai) resolve pro
    // mesmo path — mesma condição, sintaxe diferente do alvo cru.
    const r = evaluateNodeModulesSymlink(input({ isSymlink: true, linkTarget: "node_modules" }));
    assert.equal(r.status, "loop");
  });

  it("symlink apontando pra OUTRO diretório -> ok, não é loop", () => {
    const elsewhere = join(CHECKOUT_ROOT, ".claude", "worktrees", "abc123", "node_modules");
    const r = evaluateNodeModulesSymlink(input({ isSymlink: true, linkTarget: elsewhere }));
    assert.equal(r.status, "ok");
    assert.equal(r.resolvedTarget, elsewhere);
  });

  it("symlink sem alvo legível (readlink falhou) -> unresolved, nunca lança", () => {
    const r = evaluateNodeModulesSymlink(input({ isSymlink: true, linkTarget: null }));
    assert.equal(r.status, "unresolved");
    assert.equal(r.resolvedTarget, null);
  });

  it("nodeModulesPath é normalizado antes da comparação (segmentos redundantes não escondem o loop)", () => {
    // Construído sem path.join de propósito — path.join já normaliza ".."
    // sozinho, o que mascararia a checagem que este teste quer exercitar
    // (normalize() DENTRO de evaluateNodeModulesSymlink, não a conveniência
    // do helper de teste).
    const messy = `${CHECKOUT_ROOT}${sep}sub${sep}..${sep}node_modules`;
    const r = evaluateNodeModulesSymlink({ nodeModulesPath: messy, isSymlink: true, linkTarget: NODE_MODULES });
    assert.equal(r.status, "loop");
  });

  it("tolera um separador final redundante no alvo lido (achado do self-review #5571 — junction do Windows)", () => {
    // Alguns mecanismos de symlink/junction podem devolver o alvo com um
    // separador a mais no fim — sem a tolerância em sameResolvedPath(),
    // isso mascararia um loop genuíno atrás de uma diferença puramente de
    // formatação, não de destino real.
    const r = evaluateNodeModulesSymlink(input({ isSymlink: true, linkTarget: `${NODE_MODULES}${sep}` }));
    assert.equal(r.status, "loop");
  });
});

describe("isNodeModulesLoopPending (#5571 self-review) — 'unresolved' também é achado", () => {
  it("false pra status ok", () => {
    assert.equal(isNodeModulesLoopPending({ status: "ok" }), false);
  });

  it("true pra status loop", () => {
    assert.equal(isNodeModulesLoopPending({ status: "loop" }), true);
  });

  it("true pra status unresolved (symlink com alvo ilegível já é achado, não só um console.log)", () => {
    assert.equal(isNodeModulesLoopPending({ status: "unresolved" }), true);
  });
});

describe("idempotência do alarme (fingerprint + estado)", () => {
  const loopEval: SymlinkLoopEvaluation = evaluateNodeModulesSymlink(
    input({ isSymlink: true, linkTarget: NODE_MODULES }),
  );
  const okEval: SymlinkLoopEvaluation = evaluateNodeModulesSymlink(input());

  it("shouldAlarmNodeModulesLoop: false quando status !== loop", () => {
    assert.equal(shouldAlarmNodeModulesLoop(emptyNodeModulesLoopAlarmState(), okEval), false);
  });

  it("shouldAlarmNodeModulesLoop: true na 1ª detecção de loop (estado vazio)", () => {
    assert.equal(shouldAlarmNodeModulesLoop(emptyNodeModulesLoopAlarmState(), loopEval), true);
  });

  it("shouldAlarmNodeModulesLoop: false quando o MESMO loop já foi alarmado (fingerprint idêntico)", () => {
    const state = advanceNodeModulesLoopAlarmState(loopEval, new Date("2026-08-17T18:21:00Z"));
    assert.equal(shouldAlarmNodeModulesLoop(state, loopEval), false);
  });

  it("advanceNodeModulesLoopAlarmState: re-arma (fingerprint null) quando o loop desaparece", () => {
    const armed = advanceNodeModulesLoopAlarmState(loopEval, new Date("2026-08-17T18:21:00Z"));
    assert.equal(armed.lastAlarmedFingerprint, nodeModulesLoopFindingKey(loopEval));
    const rearmed = advanceNodeModulesLoopAlarmState(okEval, new Date("2026-08-17T19:00:00Z"));
    assert.equal(rearmed.lastAlarmedFingerprint, null);
  });

  it("nodeModulesLoopFindingKey muda se o alvo resolvido mudar (re-alarma em drift novo)", () => {
    const otherTarget = evaluateNodeModulesSymlink(
      input({ isSymlink: true, linkTarget: join(CHECKOUT_ROOT, "outro", "node_modules") }),
    );
    // "outro/node_modules" não é loop (não bate com o próprio path) — ainda
    // assim o fingerprint precisa diferir de um loop real, garantindo que
    // um estado gravado com o loop antigo não mascare um loop novo/diferente.
    assert.notEqual(nodeModulesLoopFindingKey(loopEval), nodeModulesLoopFindingKey(otherTarget));
  });

  it("shouldAlarmNodeModulesLoop: true pra status unresolved também (#5571 self-review)", () => {
    const unresolvedEval = evaluateNodeModulesSymlink(input({ isSymlink: true, linkTarget: null }));
    assert.equal(unresolvedEval.status, "unresolved");
    assert.equal(shouldAlarmNodeModulesLoop(emptyNodeModulesLoopAlarmState(), unresolvedEval), true);
  });
});

describe("buildNodeModulesLoopAlarmEmail (puro)", () => {
  const loopEval: SymlinkLoopEvaluation = evaluateNodeModulesSymlink(
    input({ isSymlink: true, linkTarget: NODE_MODULES }),
  );

  it("cita o path, a recuperação (rm + npm ci) e a origem provável (npm ci fora de worktree)", () => {
    const { subject, body } = buildNodeModulesLoopAlarmEmail(loopEval, NODE_MODULES, new Date("2026-08-17T18:21:00Z"));
    assert.match(subject, /symlink auto-referente/);
    assert.match(body, /rm .*node_modules.* && npm ci/);
    assert.match(body, /worktree isolado/);
  });

  it("omite a citação de issue quando issueRef é undefined", () => {
    const { body } = buildNodeModulesLoopAlarmEmail(loopEval, NODE_MODULES);
    assert.doesNotMatch(body, /^Issue:/m);
  });

  it("cita a issue quando issueRef foi resolvido", () => {
    const { body } = buildNodeModulesLoopAlarmEmail(loopEval, NODE_MODULES, new Date(), {
      issueNumber: 5571,
      url: "https://github.com/vjpixel/diaria-studio/issues/5571",
      action: "created",
    });
    assert.match(body, /Issue: #5571/);
  });

  it("issueRef.action 'failed' cita o motivo em vez de um número — e-mail nunca perde o achado por falha de gh (#5571 self-review, mesmo padrão de robots-txt-drift-check.test.ts)", () => {
    const { body } = buildNodeModulesLoopAlarmEmail(loopEval, NODE_MODULES, new Date(), {
      issueNumber: null,
      url: null,
      action: "failed",
      error: "gh: not authenticated",
    });
    assert.match(body, /Issue: falha ao criar\/reusar \(gh: not authenticated\)/);
  });

  it("status unresolved gera assunto/corpo diferentes do loop confirmado (não afirma FilesystemLoop sem certeza)", () => {
    const unresolvedEval = evaluateNodeModulesSymlink(input({ isSymlink: true, linkTarget: null }));
    const { subject, body } = buildNodeModulesLoopAlarmEmail(unresolvedEval, NODE_MODULES);
    assert.match(subject, /alvo ilegível/);
    assert.doesNotMatch(subject, /auto-referente/);
    assert.doesNotMatch(body, /FilesystemLoop/);
  });
});

describe("inspectNodeModules (#5571, I/O) — sem symlink real no filesystem", () => {
  it("path inexistente (clone fresco, antes do 1º npm ci) -> não é symlink, nada a alarmar", () => {
    const missing = join(tmpdir(), `node-modules-loop-alarm-nao-existe-${Date.now()}`);
    const result = inspectNodeModules(missing);
    assert.equal(result.isSymlink, false);
    assert.equal(result.linkTarget, null);
    assert.equal(evaluateNodeModulesSymlink(result).status, "ok");
  });

  it("diretório normal (não symlink) -> isSymlink false", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "node-modules-loop-alarm-dir-"));
    try {
      const result = inspectNodeModules(tmpDir);
      assert.equal(result.isSymlink, false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("inspectNodeModules (#5571 self-review) — lstat ENOENT vs outros errno, via fsOps injetado", () => {
  function enoentError(): NodeJS.ErrnoException {
    const e = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    e.code = "ENOENT";
    return e;
  }
  function eaccesError(): NodeJS.ErrnoException {
    const e = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    e.code = "EACCES";
    return e;
  }

  it("lstat lança ENOENT -> não é symlink, nunca propaga (mesmo comportamento fail-soft de antes)", () => {
    const fsOps: NodeModulesFsOps = {
      lstatSync: (() => {
        throw enoentError();
      }) as unknown as NodeModulesFsOps["lstatSync"],
      readlinkSync: (() => "" ) as unknown as NodeModulesFsOps["readlinkSync"],
    };
    const result = inspectNodeModules(NODE_MODULES, fsOps);
    assert.equal(result.isSymlink, false);
    assert.equal(result.linkTarget, null);
  });

  it("lstat lança EACCES (ou outro errno != ENOENT) -> PROPAGA, nunca reporta 'ok' silenciosamente (#5571 self-review, achado do silent-failure-hunter)", () => {
    const fsOps: NodeModulesFsOps = {
      lstatSync: (() => {
        throw eaccesError();
      }) as unknown as NodeModulesFsOps["lstatSync"],
      readlinkSync: (() => "") as unknown as NodeModulesFsOps["readlinkSync"],
    };
    assert.throws(() => inspectNodeModules(NODE_MODULES, fsOps), /EACCES/);
  });

  it("lstat ok + readlink lança -> linkTarget null (status unresolved), nunca propaga", () => {
    const fsOps: NodeModulesFsOps = {
      lstatSync: (() => ({ isSymbolicLink: () => true })) as unknown as NodeModulesFsOps["lstatSync"],
      readlinkSync: (() => {
        throw new Error("EIO: i/o error");
      }) as unknown as NodeModulesFsOps["readlinkSync"],
    };
    const result = inspectNodeModules(NODE_MODULES, fsOps);
    assert.equal(result.isSymlink, true);
    assert.equal(result.linkTarget, null);
    assert.equal(evaluateNodeModulesSymlink(result).status, "unresolved");
  });

  it("lstat + readlink ok -> isSymlink true, linkTarget preenchido", () => {
    const fsOps: NodeModulesFsOps = {
      lstatSync: (() => ({ isSymbolicLink: () => true })) as unknown as NodeModulesFsOps["lstatSync"],
      readlinkSync: (() => NODE_MODULES) as unknown as NodeModulesFsOps["readlinkSync"],
    };
    const result = inspectNodeModules(NODE_MODULES, fsOps);
    assert.equal(result.isSymlink, true);
    assert.equal(result.linkTarget, NODE_MODULES);
    assert.equal(evaluateNodeModulesSymlink(result).status, "loop");
  });
});

describe("inspectNodeModules (#5571 self-review) — symlink REAL auto-referente no filesystem", () => {
  it("(guardado) detecta um symlink/junction real apontando pra si mesmo — pula sem falhar se a plataforma recusar (privilégio Windows)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "node-modules-loop-alarm-real-"));
    const realNodeModules = join(tmpDir, "node_modules");
    try {
      // Auto-referente de propósito: symlink cujo alvo é ELE MESMO — o
      // sintoma exato do achado #5571. `symlinkSync(target, path)` não
      // exige que `target` já exista, então isso funciona mesmo sem
      // `realNodeModules` nunca ter sido um diretório de verdade.
      symlinkSync(realNodeModules, realNodeModules, isWindows ? "junction" : "dir");
    } catch {
      // Ambiente sem privilégio pra symlink (ex: Windows sem Developer
      // Mode/admin — ver memória `dev-mode-ligado-nao-basta-symlink`) —
      // pula sem falhar, mesmo padrão de test/merge-local-pending.test.ts.
      rmSync(tmpDir, { recursive: true, force: true });
      return;
    }
    try {
      const result = inspectNodeModules(realNodeModules);
      assert.equal(result.isSymlink, true);
      assert.equal(evaluateNodeModulesSymlink(result).status, "loop");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("loadState / saveState (#5571, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "node-modules-loop-alarm-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), emptyNodeModulesLoopAlarmState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state = advanceNodeModulesLoopAlarmState(
      evaluateNodeModulesSymlink(input({ isSymlink: true, linkTarget: NODE_MODULES })),
      new Date("2026-08-17T18:21:00Z"),
    );
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), emptyNodeModulesLoopAlarmState());
  });

  it("lastAlarmedFingerprint null é preservado no roundtrip (loop resolvido/re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state = advanceNodeModulesLoopAlarmState(evaluateNodeModulesSymlink(input()), new Date("2026-08-17T19:00:00Z"));
    saveState(state, path);
    assert.equal(loadState(path).lastAlarmedFingerprint, null);
  });
});

describe("toAlarmFinding — family (#5558/#5553)", () => {
  it("é sempre 'estado' — resolve sozinho assim que rm node_modules && npm ci rodar", () => {
    const evaluation = evaluateNodeModulesSymlink(input({ isSymlink: true, linkTarget: NODE_MODULES }));
    assert.equal(toAlarmFinding(evaluation).family, "estado");
  });

  it("fingerprint do AlarmFinding usa a mesma fórmula de nodeModulesLoopFindingKey", () => {
    const evaluation = evaluateNodeModulesSymlink(input({ isSymlink: true, linkTarget: NODE_MODULES }));
    assert.equal(toAlarmFinding(evaluation).fingerprint, nodeModulesLoopFindingKey(evaluation));
  });

  it("nasce P2 com label bug", () => {
    const evaluation = evaluateNodeModulesSymlink(input({ isSymlink: true, linkTarget: NODE_MODULES }));
    const finding = toAlarmFinding(evaluation);
    assert.equal(finding.priority, "P2");
    assert.deepEqual(finding.labels, ["bug"]);
  });

  it("status unresolved também gera finding com family 'estado' — título diferente do loop confirmado (#5571 self-review)", () => {
    const evaluation = evaluateNodeModulesSymlink(input({ isSymlink: true, linkTarget: null }));
    assert.equal(evaluation.status, "unresolved");
    const finding = toAlarmFinding(evaluation);
    assert.equal(finding.family, "estado");
    assert.match(finding.title, /alvo ilegível/);
    assert.doesNotMatch(finding.title, /auto-referente/);
  });
});
