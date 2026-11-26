/**
 * #14009 — com `data/` indisponível (Drive for desktop desmontou `I:` no meio
 * da rodada 261125b), o registro de sessões respondia como "nenhuma sessão":
 * `is-claimed` dava `claimed: false` (exit 0), `unclaim-issue` dizia "sessão
 * inexistente", e a rodada podia furar claim e merge lock de outra sessão.
 *
 * Agora os subcomandos que decidem exclusão mútua saem `exit 3` ("não
 * verificável") com mensagem acionável, e `check-pre-dispatch-claim` lê o
 * registro como `cannot-verify`. Registro vazio legível e clone fresco seguem
 * respondendo normal.
 *
 * Tudo em tmpdir: `data/` simulado como symlink pendente (posix) / junction
 * pendente (win32) e como diretório ilegível (chmod 000, só posix e não-root).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REGISTRY_UNVERIFIABLE_EXIT_CODE,
  SESSIONS_DIR_READ_ATTEMPTS,
  SESSIONS_DIR_RETRY_DELAYS_MS,
  sessionsRegistryUnverifiableReason,
  TRANSIENT_SESSIONS_DIR_ERRNOS,
} from "../scripts/lib/session-registry.ts";
import { main as preDispatchMain } from "../scripts/check-pre-dispatch-claim.ts";

const CLI = fileURLToPath(new URL("../scripts/lib/session-registry.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))).href;

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "registry-14009-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "diaria-studio" }));
  return root;
}

/** `{root}/data` aponta para um alvo que não existe (o `I:` desmontado). */
function rootWithDanglingData(): string {
  const root = freshRoot();
  const missing = join(root, "drive-I-desmontado", "diaria-studio-data");
  symlinkSync(missing, join(root, "data"), process.platform === "win32" ? "junction" : "dir");
  return root;
}

function cleanup(root: string): void {
  try {
    chmodSync(join(root, "data", "sessions"), 0o755);
  } catch {
    // não era o caso ilegível
  }
  const data = join(root, "data");
  try {
    // Link pendente: remove o próprio link, sem seguir o alvo.
    if (lstatSync(data).isSymbolicLink()) unlinkSync(data);
  } catch {
    // data/ não existe
  }
  rmSync(root, { recursive: true, force: true });
}

function cli(root: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    // Sem D1: o merge-lock-acquire do caso legítimo cai no arquivo.
    env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", D1_LOCKS_DATABASE_ID: "" },
  });
}

const canUnreadable =
  process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

describe("sessionsRegistryUnverifiableReason (#14009)", () => {
  it("clone fresco (data/ nunca existiu) → verificável", () => {
    const root = freshRoot();
    try {
      assert.equal(sessionsRegistryUnverifiableReason(root), null);
    } finally {
      cleanup(root);
    }
  });

  it("data/sessions/ existe e está vazio → verificável (nenhuma sessão é resposta honesta)", () => {
    const root = freshRoot();
    try {
      mkdirSync(join(root, "data", "sessions"), { recursive: true });
      assert.equal(sessionsRegistryUnverifiableReason(root), null);
    } finally {
      cleanup(root);
    }
  });

  it("data/ como link pendente → não verificável, com causa e ação", () => {
    const root = rootWithDanglingData();
    try {
      const reason = sessionsRegistryUnverifiableReason(root);
      assert.ok(reason);
      assert.match(reason, /NÃO VERIFICÁVEL \(#14009\)/);
      assert.match(reason, /data\/ aponta para um alvo indisponível/);
      assert.match(reason, /halt banner/);
    } finally {
      cleanup(root);
    }
  });

  it("data/sessions/ ilegível (EACCES) → não verificável, nomeando o caminho", { skip: !canUnreadable }, () => {
    const root = freshRoot();
    try {
      const dir = join(root, "data", "sessions");
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o000);
      const reason = sessionsRegistryUnverifiableReason(root);
      assert.ok(reason);
      assert.match(reason, /EACCES/);
      assert.ok(reason.includes(dir));
    } finally {
      cleanup(root);
    }
  });
});

describe("erro transitório do sync no readdir de data/sessions/ ganha retry (#14009, review PR #14153)", () => {
  function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: simulado`), { code });
  }

  /** readdir que falha `failures` vezes com `code` e depois lê. */
  function flakyIo(code: string, failures: number) {
    const sleeps: number[] = [];
    let calls = 0;
    return {
      sleeps,
      calls: () => calls,
      io: {
        readdir: () => {
          calls++;
          if (calls <= failures) throw errno(code);
          return [];
        },
        sleep: (ms: number) => {
          sleeps.push(ms);
        },
      },
    };
  }

  function rootWithSessionsDir(): string {
    const root = freshRoot();
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
    return root;
  }

  it("EBUSY 2x e depois lê → verificável, sem exit 3, com backoff 100/300", () => {
    const root = rootWithSessionsDir();
    try {
      const f = flakyIo("EBUSY", 2);
      assert.equal(sessionsRegistryUnverifiableReason(root, { io: f.io }), null);
      assert.equal(f.calls(), 3);
      assert.deepEqual(f.sleeps, [...SESSIONS_DIR_RETRY_DELAYS_MS]);
    } finally {
      cleanup(root);
    }
  });

  for (const code of TRANSIENT_SESSIONS_DIR_ERRNOS) {
    it(`${code} em todas as tentativas → não verificável, citando as tentativas`, () => {
      const root = rootWithSessionsDir();
      try {
        const f = flakyIo(code, 99);
        const reason = sessionsRegistryUnverifiableReason(root, { io: f.io });
        assert.ok(reason, "esgotar os retries tem de recusar (exit 3 no CLI)");
        assert.match(reason, /NÃO VERIFICÁVEL/);
        assert.ok(reason.includes(`${code} em ${SESSIONS_DIR_READ_ATTEMPTS} tentativas`), reason);
        assert.equal(f.calls(), SESSIONS_DIR_READ_ATTEMPTS);
      } finally {
        cleanup(root);
      }
    });
  }

  for (const code of ["ENOENT", "ENOTDIR"]) {
    it(`${code} no readdir → não verificável de imediato, sem retry`, () => {
      const root = rootWithSessionsDir();
      try {
        const f = flakyIo(code, 99);
        const reason = sessionsRegistryUnverifiableReason(root, { io: f.io });
        assert.ok(reason);
        assert.match(reason, new RegExp(code));
        assert.doesNotMatch(reason, /tentativas/);
        assert.equal(f.calls(), 1);
        assert.deepEqual(f.sleeps, []);
      } finally {
        cleanup(root);
      }
    });
  }

  it("data/ como link pendente (ENOENT) → não verificável de imediato, readdir nem chamado", () => {
    const root = rootWithDanglingData();
    try {
      const f = flakyIo("EBUSY", 99);
      const reason = sessionsRegistryUnverifiableReason(root, { io: f.io });
      assert.ok(reason);
      assert.match(reason, /data\/ aponta para um alvo indisponível/);
      assert.equal(f.calls(), 0);
      assert.deepEqual(f.sleeps, []);
    } finally {
      cleanup(root);
    }
  });
});

describe("CLI com data/ indisponível sai exit 3 (#14009)", () => {
  it("is-claimed: exit 3 e JSON fail-closed (antes: claimed:false, exit 0)", () => {
    const root = rootWithDanglingData();
    try {
      const r = cli(root, ["is-claimed", "--issue", "13981", "--session-id", "s1"]);
      assert.equal(r.status, REGISTRY_UNVERIFIABLE_EXIT_CODE, r.stderr);
      const out = JSON.parse(r.stdout.trim());
      assert.equal(out.claimed, true);
      assert.equal(out.unverifiable, true);
      assert.match(r.stderr, /NÃO VERIFICÁVEL/);
      assert.doesNotMatch(r.stderr, /Tratando como nenhuma sessão registrada/);
    } finally {
      cleanup(root);
    }
  });

  it("unclaim-issue: exit 3 (antes: 'no-op (sessão inexistente)')", () => {
    const root = rootWithDanglingData();
    try {
      const r = cli(root, ["unclaim-issue", "--kind", "overnight", "--session-id", "s1", "--issues", "13981"]);
      assert.equal(r.status, REGISTRY_UNVERIFIABLE_EXIT_CODE, r.stderr + r.stdout);
      assert.doesNotMatch(r.stdout, /sessão inexistente/);
      assert.match(r.stderr, /NÃO VERIFICÁVEL/);
    } finally {
      cleanup(root);
    }
  });

  it("claim-issue: exit 3, sem auto-registrar", () => {
    const root = rootWithDanglingData();
    try {
      const r = cli(root, ["claim-issue", "--kind", "overnight", "--session-id", "s1", "--issues", "13981"]);
      assert.equal(r.status, REGISTRY_UNVERIFIABLE_EXIT_CODE, r.stderr + r.stdout);
      assert.doesNotMatch(r.stdout, /auto-registrada/);
    } finally {
      cleanup(root);
    }
  });

  it("merge-lock-acquire: exit 3", () => {
    const root = rootWithDanglingData();
    try {
      const r = cli(root, ["merge-lock-acquire", "--pr", "1", "--session-id", "s1"]);
      assert.equal(r.status, REGISTRY_UNVERIFIABLE_EXIT_CODE, r.stderr + r.stdout);
      assert.doesNotMatch(r.stdout, /merge-lock-acquire acquired/);
    } finally {
      cleanup(root);
    }
  });

  it("is-claimed com data/sessions/ ilegível: exit 3", { skip: !canUnreadable }, () => {
    const root = freshRoot();
    try {
      const dir = join(root, "data", "sessions");
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o000);
      const r = cli(root, ["is-claimed", "--issue", "13981", "--session-id", "s1"]);
      assert.equal(r.status, REGISTRY_UNVERIFIABLE_EXIT_CODE, r.stderr);
    } finally {
      cleanup(root);
    }
  });
});

describe("CLI com registro vazio legível segue normal (#14009)", () => {
  it("is-claimed em data/sessions/ vazio: exit 0, claimed:false", () => {
    const root = freshRoot();
    try {
      mkdirSync(join(root, "data", "sessions"), { recursive: true });
      const r = cli(root, ["is-claimed", "--issue", "13981", "--session-id", "s1"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout.trim()).claimed, false);
    } finally {
      cleanup(root);
    }
  });

  it("claim-issue em clone fresco: exit 0 (auto-registra como antes)", () => {
    const root = freshRoot();
    try {
      const r = cli(root, ["claim-issue", "--kind", "overnight", "--session-id", "s1", "--issues", "13981"]);
      assert.equal(r.status, 0, r.stderr + r.stdout);
    } finally {
      cleanup(root);
    }
  });
});

describe("check-pre-dispatch-claim com data/ indisponível (#14009)", () => {
  it("registro ilegível vira cannot-verify (exit 2), nunca livre", () => {
    const root = rootWithDanglingData();
    try {
      const runner = () => ({ status: 0, stdout: JSON.stringify({ comments: [] }), stderr: "" });
      const code = preDispatchMain(["--issues", "13981", "--session-id", "s1", "--kind", "overnight"], root, {
        runner: runner as never,
        endedSessions: () => new Map(),
      });
      assert.equal(code, 2);
    } finally {
      cleanup(root);
    }
  });
});
