/**
 * #12547 — `data/sessions` "ausente" porque nunca existiu (clone fresco,
 * sessão cloud) é diferente de "`data/` é junction cujo alvo sumiu" (Drive for
 * desktop fechado no Neo: a unidade `I:` desaparece e o junction fica
 * pendente). Antes, `existsSync` devolvia `false` nos dois casos e o guard de
 * merge lia o segundo como "nenhuma rodada ativa", fail-open silencioso.
 *
 * Os testes de sonda pura injetam `fs`, então rodam em qualquer plataforma.
 * O link real é coberto por dois testes com skip explícito: junction (só
 * win32, o caso do Neo) e symlink (fora do win32).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeSessionsDir } from "../scripts/lib/sessions-dir-probe.mjs";
import { checkSessionsScanHealth } from "../scripts/lib/session-registry.ts";
// @ts-expect-error -- hook .mjs sem .d.mts (TS7016), mesmo padrão dos demais testes de hooks.
import { buildBlockReason, classifyMergeBlockCause, readActiveCoordinatorScan } from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";

const ROOT = join("R:", "repo");
const DATA = join(ROOT, "data");
const SESSIONS = join(DATA, "sessions");

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** `fs` falso: `entries` mapeia path → "dir" | "link-ok" | "link-broken" | código de erro do lstat. */
function fakeFs(entries: Record<string, string>, statErr: Record<string, string> = {}) {
  return {
    lstatSync(p: string) {
      const e = entries[p];
      if (e === undefined) throw errno("ENOENT");
      if (e !== "dir" && e !== "link-ok" && e !== "link-broken") throw errno(e);
      return { isSymbolicLink: () => e !== "dir" };
    },
    statSync(p: string) {
      if (statErr[p]) throw errno(statErr[p]);
      // stat segue link: qualquer link pendente no caminho derruba o stat.
      for (const [path, kind] of Object.entries(entries)) {
        if (kind === "link-broken" && (p === path || p.startsWith(path + "\\") || p.startsWith(path + "/"))) {
          throw errno("ENOENT");
        }
      }
      if (entries[p] === undefined) throw errno("ENOENT");
      return {};
    },
  };
}

describe("probeSessionsDir (#12547) — fs injetado", () => {
  it("diretório presente → present", () => {
    const p = probeSessionsDir(ROOT, fakeFs({ [DATA]: "dir", [SESSIONS]: "dir" }));
    assert.deepEqual(p, { state: "present", degraded: false });
  });

  it("nada existe (clone fresco) → absent, sem degradação", () => {
    assert.deepEqual(probeSessionsDir(ROOT, fakeFs({})), { state: "absent", degraded: false });
  });

  it("data/ real sem sessions/ → absent", () => {
    assert.deepEqual(probeSessionsDir(ROOT, fakeFs({ [DATA]: "dir" })), { state: "absent", degraded: false });
  });

  it("data/ link que resolve, sem sessions/ → absent", () => {
    assert.deepEqual(probeSessionsDir(ROOT, fakeFs({ [DATA]: "link-ok" })), { state: "absent", degraded: false });
  });

  it("data/ junction pendente (Drive fechado) → broken-link, mensagem com causa e ação", () => {
    const p = probeSessionsDir(ROOT, fakeFs({ [DATA]: "link-broken" }));
    assert.equal(p.state, "broken-link");
    assert.equal(p.degraded, true);
    if (p.degraded) {
      assert.equal(p.path, DATA);
      assert.match(p.message, /data\/ aponta para um alvo indisponível/);
      assert.match(p.message, /Drive for desktop fechado\?/);
      assert.match(p.message, /abra o Google Drive/i);
    }
  });

  it("data/sessions ele mesmo como link pendente → broken-link no próprio sessions", () => {
    const p = probeSessionsDir(ROOT, fakeFs({ [DATA]: "dir", [SESSIONS]: "link-broken" }));
    assert.equal(p.state, "broken-link");
    if (p.degraded) assert.equal(p.path, SESSIONS);
  });

  it("lstat com erro que não é ENOENT → unreadable (degradado, nunca 'ausente')", () => {
    const p = probeSessionsDir(ROOT, fakeFs({ [DATA]: "EACCES" }));
    assert.equal(p.state, "unreadable");
    assert.equal(p.degraded, true);
  });

  it("sessions/ real com stat falhando por EPERM → unreadable", () => {
    const p = probeSessionsDir(ROOT, fakeFs({ [DATA]: "dir", [SESSIONS]: "dir" }, { [SESSIONS]: "EPERM" }));
    assert.equal(p.state, "unreadable");
    if (p.degraded) assert.equal(p.code, "EPERM");
  });

  it("nunca lança, nem com fs que lança coisa estranha", () => {
    const weird = {
      lstatSync: () => {
        throw "string-thrown";
      },
      statSync: () => {
        throw undefined;
      },
    };
    const p = probeSessionsDir(ROOT, weird as never);
    assert.equal(p.degraded, true);
  });
});

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "sessions-probe-12547-"));
}

/** Aponta `{root}/data` para um alvo que não existe. */
function linkDataToMissingTarget(root: string, type: "junction" | "dir"): void {
  const missing = join(root, "drive-I-desmontado", "diaria-studio-data");
  symlinkSync(missing, join(root, "data"), type);
}

function assertDanglingDataIsDegraded(root: string): void {
  const probe = probeSessionsDir(root);
  assert.equal(probe.state, "broken-link", "junction pendente não pode se passar por clone fresco");

  const scan = readActiveCoordinatorScan(root, Date.now(), { crossMachine: true });
  assert.equal(scan.degraded, true, "guard de merge: varredura com data/ pendente é degradada");
  assert.equal(scan.ids.size, 0);
  assert.match(String(scan.degradedReason), /Drive for desktop fechado\?/);

  // Sem coordenadora visível e varredura degradada: bloqueia (antes, `null` = liberava).
  const cause = classifyMergeBlockCause(scan.ids, "sessao-qualquer", { scanDegraded: scan.degraded });
  assert.equal(cause, "scan-degraded");
  const reason = buildBlockReason({ blockCause: cause, scanDegradedReason: scan.degradedReason });
  assert.match(reason, /data\/ aponta para um alvo indisponível/);
  assert.match(reason, /abra o Google Drive/i);

  const health = checkSessionsScanHealth(root);
  assert.equal(health.ok, false, "registry: junction pendente não é 'nenhuma sessão'");
  assert.match(String(health.error), /Drive for desktop fechado\?/);
}

describe("readActiveCoordinatorScan + checkSessionsScanHealth — disco real (#12547)", () => {
  it("clone fresco (data/sessions nunca existiu) continua degraded:false / ok:true", () => {
    const root = freshRoot();
    try {
      const scan = readActiveCoordinatorScan(root, Date.now(), { crossMachine: true });
      assert.equal(scan.degraded, false);
      assert.equal(scan.degradedReason, undefined);
      assert.equal(classifyMergeBlockCause(scan.ids, "s", { scanDegraded: scan.degraded }), null);
      assert.deepEqual(checkSessionsScanHealth(root), { ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("data/ real sem sessions/ continua degraded:false / ok:true", () => {
    const root = freshRoot();
    try {
      mkdirSync(join(root, "data"));
      assert.equal(readActiveCoordinatorScan(root).degraded, false);
      assert.deepEqual(checkSessionsScanHealth(root), { ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "win32: data/ como junction para alvo inexistente (Drive for desktop fechado) → degradado",
    { skip: process.platform !== "win32" ? "junction só existe no Windows" : false },
    () => {
      const root = freshRoot();
      try {
        linkDataToMissingTarget(root, "junction");
        assertDanglingDataIsDegraded(root);
      } finally {
        rmSync(join(root, "data"), { force: true });
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "posix: data/ como symlink para alvo inexistente → degradado",
    { skip: process.platform === "win32" ? "symlink de diretório no Windows exige privilégio; o junction acima cobre" : false },
    () => {
      const root = freshRoot();
      try {
        linkDataToMissingTarget(root, "dir");
        assertDanglingDataIsDegraded(root);
      } finally {
        rmSync(join(root, "data"), { force: true });
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
