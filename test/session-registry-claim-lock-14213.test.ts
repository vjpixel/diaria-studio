/**
 * test/session-registry-claim-lock-14213.test.ts (#14213)
 *
 * `claimIssueCheckAndSet` lia os arquivos das OUTRAS sessões sem lock e
 * gravava a claim travando só o arquivo da própria sessão. Duas sessões na
 * mesma máquina (overnight + continuo) reivindicando as mesmas issues ao mesmo
 * tempo ganhavam as duas: num teste com 2 processos e 40 issues, 40/40 ficaram
 * com as duas sessões. O fix serializa checagem + escrita com um lock de claims
 * por máquina (`claimsLockPath`, `withFileLock` + `breakStaleLock`).
 *
 * Cobre:
 *   - o cenário da issue: 2 processos, 40 issues, claim individual — cada issue
 *     é ganha por exatamente UMA sessão; o mesmo com o claim em lote (`--issues`);
 *   - lock órfão (PID morto desta máquina) não trava o claim;
 *   - lock vivo de outro processo: o claim lança erro claro e não grava nada;
 *     no CLI, exit 1;
 *   - claim sequencial continua igual (A `claimed`, B `blocked-by-other`) e o
 *     lock é solto ao fim.
 *
 * Tudo em root temporário; nunca toca o `data/` real.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { lockHostId } from "../scripts/lib/file-lock.ts";
import { claimIssueCheckAndSet, claimIssuesCheckAndSet, registerSession, sessionFilePath } from "../scripts/lib/session-registry.ts";
import { claimsLockPath } from "../scripts/lib/sessions/claims.ts";

const TAG = "300";
const REGISTRY = fileURLToPath(new URL("../scripts/lib/session-registry.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))).href;

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "registry-14213-"));
  roots.push(root);
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "diaria-studio" }));
  return root;
}

function claimed(root: string, kind: "overnight" | "continuo", sessionId: string): number[] {
  return JSON.parse(readFileSync(sessionFilePath(root, kind, TAG, sessionId), "utf8")).claimed_issues ?? [];
}

/** Processo filho que espera o mesmo instante de largada e reivindica 1..n. */
function childScript(root: string): string {
  const path = join(root, "claim-child.mjs");
  writeFileSync(
    path,
    [
      `import { claimIssueCheckAndSet, claimIssuesCheckAndSet } from ${JSON.stringify(pathToFileURL(REGISTRY).href)};`,
      "const [root, kind, sid, mode, startAt, n] = process.argv.slice(2);",
      "while (Date.now() < Number(startAt)) { /* largada comum */ }",
      "const issues = Array.from({ length: Number(n) }, (_, i) => i + 1);",
      "const out = {};",
      "if (mode === 'single') {",
      `  for (const i of issues) out[i] = claimIssueCheckAndSet(root, kind, sid, i, ${JSON.stringify(TAG)}).reason;`,
      "} else {",
      `  for (const e of claimIssuesCheckAndSet(root, kind, sid, issues, ${JSON.stringify(TAG)}).entries) out[e.issue] = e.reason;`,
      "}",
      "process.stdout.write(JSON.stringify(out));",
    ].join("\n"),
  );
  return path;
}

function runChild(script: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, script, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

async function raceTwoSessions(mode: "single" | "batch", n: number) {
  const root = freshRoot();
  registerSession(root, "overnight", "sess-a", { tag: TAG });
  registerSession(root, "continuo", "sess-b", { tag: TAG });
  const script = childScript(root);
  // Largada 4s à frente: cobre o boot do tsx nos dois filhos.
  const startAt = String(Date.now() + 4000);
  const [a, b] = await Promise.all([
    runChild(script, [root, "overnight", "sess-a", mode, startAt, String(n)]),
    runChild(script, [root, "continuo", "sess-b", mode, startAt, String(n)]),
  ]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  return { root, a: JSON.parse(a.stdout) as Record<string, string>, b: JSON.parse(b.stdout) as Record<string, string> };
}

function assertExactlyOneWinner(
  root: string,
  a: Record<string, string>,
  b: Record<string, string>,
  n: number,
): void {
  const heldA = new Set(claimed(root, "overnight", "sess-a"));
  const heldB = new Set(claimed(root, "continuo", "sess-b"));
  const both: number[] = [];
  for (let i = 1; i <= n; i++) {
    const wins = [a[i], b[i]].filter((r) => r === "claimed").length;
    assert.equal(wins, 1, `issue #${i}: esperado 1 vencedor, A=${a[i]} B=${b[i]}`);
    assert.ok([a[i], b[i]].includes("blocked-by-other"), `issue #${i}: o perdedor recebe blocked-by-other`);
    if (heldA.has(i) && heldB.has(i)) both.push(i);
    assert.ok(heldA.has(i) || heldB.has(i), `issue #${i}: alguém tem de segurá-la no disco`);
  }
  assert.deepEqual(both, [], "nenhuma issue gravada nas duas âncoras");
  assert.equal(existsSync(claimsLockPath(root)), false, "o lock de claims é solto ao fim");
}

describe("claim-issue: 2 sessões da mesma máquina em paralelo (#14213)", () => {
  it("claim individual, 40 issues: cada issue é ganha por exatamente UMA sessão", async () => {
    const { root, a, b } = await raceTwoSessions("single", 40);
    assertExactlyOneWinner(root, a, b, 40);
  });

  it("claim em lote (--issues), 40 issues: cada issue é ganha por exatamente UMA sessão", async () => {
    const { root, a, b } = await raceTwoSessions("batch", 40);
    assertExactlyOneWinner(root, a, b, 40);
  });
});

describe("lock de claims: órfão, ocupado e caminho sequencial (#14213)", () => {
  it("lock órfão (PID morto desta máquina) não trava o claim", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-orf", { tag: TAG });
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const deadPid = Number(dead.stdout);
    assert.ok(deadPid > 0);
    const lockPath = claimsLockPath(root);
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, host: lockHostId(), ts: Date.now(), token: "orfao" }));

    const t0 = Date.now();
    const res = claimIssueCheckAndSet(root, "overnight", "sess-orf", 501, TAG, undefined, { lockTimeoutMs: 2000 });
    assert.equal(res.reason, "claimed");
    assert.ok(Date.now() - t0 < 2000, "quebra o órfão sem esperar o timeout");
    assert.deepEqual(claimed(root, "overnight", "sess-orf"), [501]);
    assert.equal(existsSync(lockPath), false);
  });

  it("lock vivo de outro processo: lança erro claro e não grava a claim", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-busy", { tag: TAG });
    const lockPath = claimsLockPath(root);
    // Dono vivo: o próprio processo do teste (PID existe, mesmo host).
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: lockHostId(), ts: Date.now(), token: "vivo" }));

    assert.throws(
      () => claimIssueCheckAndSet(root, "overnight", "sess-busy", 502, TAG, undefined, { lockTimeoutMs: 300 }),
      /lock de claims ocupado.*nenhuma claim gravada.*#14213/s,
    );
    assert.throws(
      () => claimIssuesCheckAndSet(root, "overnight", "sess-busy", [503, 504], TAG, undefined, { lockTimeoutMs: 300 }),
      /lock de claims ocupado/,
    );
    assert.deepEqual(claimed(root, "overnight", "sess-busy"), []);
    assert.equal(existsSync(lockPath), true, "o lock alheio fica intacto");
  });

  it("CLI: lock de claims ocupado sai com exit 1, nunca 'claim ok'", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "sess-cli"); // tag = machineTag(), o mesmo do CLI
    writeFileSync(claimsLockPath(root), JSON.stringify({ pid: process.pid, host: lockHostId(), ts: Date.now(), token: "vivo" }));
    const res = spawnSync(
      process.execPath,
      ["--import", TSX_LOADER, REGISTRY, "claim-issue", "--kind", "overnight", "--session-id", "sess-cli", "--issue", "601"],
      { cwd: root, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /lock de claims ocupado/);
    assert.doesNotMatch(res.stdout, /claim-issue ok/);
  });

  it("claim sequencial continua igual: A claimed, B blocked-by-other, lock solto", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "seq-a", { tag: TAG });
    registerSession(root, "continuo", "seq-b", { tag: TAG });
    assert.equal(claimIssueCheckAndSet(root, "overnight", "seq-a", 701, TAG).reason, "claimed");
    const b = claimIssueCheckAndSet(root, "continuo", "seq-b", 701, TAG);
    assert.equal(b.reason, "blocked-by-other");
    assert.equal(b.blockedBy?.sessionId, "seq-a");
    assert.equal(claimIssueCheckAndSet(root, "overnight", "seq-a", 701, TAG).reason, "already-own");
    assert.equal(
      claimIssueCheckAndSet(root, "continuo", "seq-b", 701, TAG, undefined, { force: true }).reason,
      "forced-override",
    );
    assert.equal(existsSync(claimsLockPath(root)), false);
  });
});
