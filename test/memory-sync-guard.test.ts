/**
 * test/memory-sync-guard.test.ts (#7759 item 2)
 *
 * Cobre a lógica PURA de `scripts/lib/memory-sync-guard.ts` — a decisão por
 * trás do hook `SessionStart` `session-start-memory-sync-guard.mjs`.
 *
 * Teste de regressão exigido pelo dispatch (#633): os 4 cenários exatos
 * listados na issue —
 *   1. diretório com `_index.json` + `.git` -> `"ok"`
 *   2. faltando `.git` -> detecta (`"not-connected"`)
 *   3. faltando `_index.json` -> detecta (`"not-connected"`)
 *   4. diretório ausente/ilegível -> `"cannot-verify"`, nunca `"ok"` nem
 *      falso alarme (`"not-connected"`)
 *
 * O cenário "ilegível" é exercitado via injeção de `stat` que lança um erro
 * com `code` diferente de `ENOENT` (mesmo contrato de `fs.statSync`) — não
 * via `chmod` real, que é frágil rodando como root em sandbox (raiz sempre
 * consegue ler, `chmod 000` não necessariamente nega leitura).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateMemorySyncGuard,
  probeMemoryDirState,
  checkMemorySyncGuardOnDisk,
  buildMemorySyncGuardWarning,
  resolveMemoryDir,
  type MemorySyncGuardStatFns,
} from "../scripts/lib/memory-sync-guard.ts";

describe("evaluateMemorySyncGuard — decisão pura", () => {
  it("dirState=present, .git + _index.json presentes -> ok, missing vazio", () => {
    const result = evaluateMemorySyncGuard({ dirState: "present", hasGitDir: true, hasIndexJson: true });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.missing, []);
  });

  it("dirState=present, falta só .git -> not-connected, missing=['.git']", () => {
    const result = evaluateMemorySyncGuard({ dirState: "present", hasGitDir: false, hasIndexJson: true });
    assert.equal(result.status, "not-connected");
    assert.deepEqual(result.missing, [".git"]);
  });

  it("dirState=present, falta só _index.json -> not-connected, missing=['_index.json']", () => {
    const result = evaluateMemorySyncGuard({ dirState: "present", hasGitDir: true, hasIndexJson: false });
    assert.equal(result.status, "not-connected");
    assert.deepEqual(result.missing, ["_index.json"]);
  });

  it("dirState=present, faltam os dois -> not-connected, missing com os dois", () => {
    const result = evaluateMemorySyncGuard({ dirState: "present", hasGitDir: false, hasIndexJson: false });
    assert.equal(result.status, "not-connected");
    assert.deepEqual(result.missing, [".git", "_index.json"]);
  });

  it("dirState=missing -> cannot-verify, nunca ok nem not-connected", () => {
    const result = evaluateMemorySyncGuard({ dirState: "missing", hasGitDir: true, hasIndexJson: true });
    assert.equal(result.status, "cannot-verify");
    assert.deepEqual(result.missing, []);
  });

  it("dirState=unreadable -> cannot-verify, nunca ok nem not-connected", () => {
    const result = evaluateMemorySyncGuard({ dirState: "unreadable", hasGitDir: true, hasIndexJson: true });
    assert.equal(result.status, "cannot-verify");
    assert.deepEqual(result.missing, []);
  });

  it("nunca lança para nenhuma combinação de input", () => {
    for (const dirState of ["missing", "unreadable", "present"] as const) {
      for (const hasGitDir of [true, false]) {
        for (const hasIndexJson of [true, false]) {
          assert.doesNotThrow(() => evaluateMemorySyncGuard({ dirState, hasGitDir, hasIndexJson }));
        }
      }
    }
  });
});

describe("probeMemoryDirState", () => {
  it("ENOENT vira missing", () => {
    const fns: MemorySyncGuardStatFns = {
      stat: () => {
        const err = new Error("no such file") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
      exists: () => false,
    };
    assert.equal(probeMemoryDirState("/nao/existe", fns), "missing");
  });

  it("qualquer outro código de erro (EACCES etc) vira unreadable — nunca missing", () => {
    const fns: MemorySyncGuardStatFns = {
      stat: () => {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
      exists: () => false,
    };
    assert.equal(probeMemoryDirState("/sem/permissao", fns), "unreadable");
  });

  it("erro sem code definido também vira unreadable (fail-safe: nunca assume missing por padrão)", () => {
    const fns: MemorySyncGuardStatFns = {
      stat: () => {
        throw new Error("erro genérico sem code");
      },
      exists: () => false,
    };
    assert.equal(probeMemoryDirState("/qualquer", fns), "unreadable");
  });

  it("stat aponta pra um arquivo (não diretório) -> missing, não present", () => {
    const fns: MemorySyncGuardStatFns = {
      stat: () => ({ isDirectory: () => false }) as Stats,
      exists: () => false,
    };
    assert.equal(probeMemoryDirState("/arquivo-solto", fns), "missing");
  });

  it("stat resolve normalmente pra diretório -> present", () => {
    const fns: MemorySyncGuardStatFns = {
      stat: () => ({ isDirectory: () => true }) as Stats,
      exists: () => false,
    };
    assert.equal(probeMemoryDirState("/dir/real", fns), "present");
  });
});

describe("checkMemorySyncGuardOnDisk — os 4 cenários de regressão da issue #7759", () => {
  let tmpRoot: string;

  function makeTmpDir(): string {
    tmpRoot = mkdtempSync(join(tmpdir(), "memory-sync-guard-test-"));
    return tmpRoot;
  }

  function cleanup() {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* nada a fazer se já sumiu */
    }
  }

  it("1. diretório com _index.json + .git -> ok", () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, "_index.json"), "{}");
      const result = checkMemorySyncGuardOnDisk(dir);
      assert.equal(result.status, "ok");
    } finally {
      cleanup();
    }
  });

  it("2. faltando .git -> detecta (not-connected, missing inclui .git)", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "_index.json"), "{}");
      const result = checkMemorySyncGuardOnDisk(dir);
      assert.equal(result.status, "not-connected");
      assert.ok(result.missing.includes(".git"));
    } finally {
      cleanup();
    }
  });

  it("3. faltando _index.json -> detecta (not-connected, missing inclui _index.json)", () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, ".git"));
      const result = checkMemorySyncGuardOnDisk(dir);
      assert.equal(result.status, "not-connected");
      assert.ok(result.missing.includes("_index.json"));
    } finally {
      cleanup();
    }
  });

  it("4a. diretório ausente -> cannot-verify, nunca ok nem falso alarme", () => {
    const dir = join(tmpdir(), "memory-sync-guard-test-ausente-nao-existe-de-verdade");
    const result = checkMemorySyncGuardOnDisk(dir);
    assert.equal(result.status, "cannot-verify");
    assert.notEqual(result.status, "ok");
    assert.notEqual(result.status, "not-connected");
  });

  it("4b. diretório ilegível (stat lança EACCES) -> cannot-verify, nunca ok nem falso alarme", () => {
    const fns: MemorySyncGuardStatFns = {
      stat: () => {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
      exists: () => false,
    };
    const result = checkMemorySyncGuardOnDisk("/algum/dir/sem/permissao", fns);
    assert.equal(result.status, "cannot-verify");
    assert.notEqual(result.status, "ok");
    assert.notEqual(result.status, "not-connected");
  });
});

describe("buildMemorySyncGuardWarning", () => {
  it("status not-connected -> mensagem não-nula citando as peças faltando", () => {
    const result = evaluateMemorySyncGuard({ dirState: "present", hasGitDir: false, hasIndexJson: true });
    const warning = buildMemorySyncGuardWarning(result, "/algum/dir/memory");
    assert.ok(warning !== null);
    assert.match(warning as string, /\.git/);
    assert.match(warning as string, /algum\/dir\/memory/);
  });

  it("status ok -> null (sem aviso, mecanismo completo)", () => {
    const result = evaluateMemorySyncGuard({ dirState: "present", hasGitDir: true, hasIndexJson: true });
    assert.equal(buildMemorySyncGuardWarning(result, "/algum/dir/memory"), null);
  });

  it("status cannot-verify -> null (silencioso de propósito — ver docstring do módulo)", () => {
    const result = evaluateMemorySyncGuard({ dirState: "missing", hasGitDir: false, hasIndexJson: false });
    assert.equal(buildMemorySyncGuardWarning(result, "/algum/dir/memory"), null);
  });
});

describe("resolveMemoryDir", () => {
  it("junta claudeProjectsDir(home) + encodeProjectDirName(cwd) + 'memory'", () => {
    const result = resolveMemoryDir("/home/user/diaria-studio", "/home/user");
    assert.equal(result, join("/home/user", ".claude", "projects", "-home-user-diaria-studio", "memory"));
  });

  it("cwd do Windows (com : e \\) codifica os separadores certos", () => {
    const result = resolveMemoryDir("C:\\Users\\x\\diaria-studio", "C:\\Users\\x");
    assert.equal(result, join("C:\\Users\\x", ".claude", "projects", "C--Users-x-diaria-studio", "memory"));
  });
});
