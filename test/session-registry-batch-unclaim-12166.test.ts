/**
 * test/session-registry-batch-unclaim-12166.test.ts (#12166)
 *
 * Rodada overnight 261104b: soltar as claims de 19 issues já mergeadas exigia
 * 19 `unclaim-issue --issue N` standalone (o hook de `--session-id` não aceita
 * comando encadeado), cada um um rename na âncora sincronizada pelo OneDrive —
 * o padrão de rajada que o `claim-issue --issues` (#12010) existe para evitar.
 * A rodada deixou as claims caírem no `end`. O fix é `unclaim-issue --issues
 * A,B,C`, simétrico ao claim em lote: a onda numa escrita só.
 *
 * Cobre:
 *   - lote solta todas as issues numa escrita (`writes: 1`);
 *   - issue não reivindicada no lote não derruba as demais (exit 1 no CLI);
 *   - lote sem nada a soltar não escreve (`writes: 0`);
 *   - `-safeBackup-*` do grupo também perde as issues (#6567, agora em lote);
 *   - sessão ausente/ilegível vale para o lote inteiro;
 *   - `unclaimIssue` (individual) segue com os mesmos desfechos;
 *   - CLI `--issues` (saída por issue, exit code) e o cenário da issue antes
 *     do fix: `--issues` era recusado com "--issue deve ser um inteiro".
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  claimIssuesCheckAndSet,
  registerSession,
  sessionFilePath,
  sessionsDir,
  unclaimIssue,
  unclaimIssues,
} from "../scripts/lib/session-registry.ts";

const NOW = Date.parse("2026-11-04T03:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const TAG = "300";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "registry-12166-"));
  roots.push(root);
  return root;
}

function readAnchor(root: string, sessionId: string) {
  return JSON.parse(readFileSync(sessionFilePath(root, "overnight", TAG, sessionId), "utf8"));
}

function coordWith(root: string, issues: number[]): void {
  registerSession(root, "overnight", "coord", { tag: TAG, startedAt: iso(NOW - 60_000) });
  claimIssuesCheckAndSet(root, "overnight", "coord", issues, TAG, iso(NOW - 30_000));
}

describe("unclaimIssues — a onda inteira numa escrita da âncora (#12166)", () => {
  it("solta todas as issues do lote com UMA escrita, preservando as outras claims", () => {
    const root = freshRoot();
    coordWith(root, [101, 102, 103, 104]);

    const result = unclaimIssues(root, "overnight", "coord", [101, 102, 103], TAG, iso(NOW));

    assert.equal(result.ok, true);
    assert.equal(result.writes, 1);
    assert.deepEqual(
      result.entries.map((e) => [e.label, e.reason]),
      [
        ["#101", "unclaimed"],
        ["#102", "unclaimed"],
        ["#103", "unclaimed"],
      ],
    );
    const anchor = readAnchor(root, "coord");
    assert.deepEqual(anchor.claimed_issues, [104]);
    assert.deepEqual(Object.keys(anchor.claimed_issues_at ?? {}), ["104"], "timestamps das soltas saem junto (#6453)");
    assert.equal(anchor.lastHeartbeat, iso(NOW));
  });

  it("issue não reivindicada no lote não impede as outras; repetida conta uma vez", () => {
    const root = freshRoot();
    coordWith(root, [201, 203]);

    const result = unclaimIssues(root, "overnight", "coord", [201, 202, 203, 203], TAG, iso(NOW));

    assert.equal(result.ok, false);
    assert.equal(result.writes, 1);
    assert.deepEqual(
      result.entries.map((e) => [e.label, e.reason]),
      [
        ["#201", "unclaimed"],
        ["#202", "no-op-not-claimed"],
        ["#203", "unclaimed"],
      ],
    );
    assert.deepEqual(readAnchor(root, "coord").claimed_issues, []);
  });

  it("nada a soltar: zero escritas na âncora", () => {
    const root = freshRoot();
    coordWith(root, [301]);
    const before = readAnchor(root, "coord");

    const result = unclaimIssues(root, "overnight", "coord", [302, 303], TAG, iso(NOW));

    assert.equal(result.ok, false);
    assert.equal(result.writes, 0);
    assert.deepEqual(readAnchor(root, "coord"), before, "âncora intocada");
  });

  it("propaga a remoção do lote a cada -safeBackup-* do grupo (#6567)", () => {
    const root = freshRoot();
    coordWith(root, [401, 402]);
    const backup = join(sessionsDir(root), `overnight-${TAG}-coord-${TAG}-safeBackup-0001.json`);
    writeFileSync(
      backup,
      JSON.stringify({
        kind: "overnight",
        machineTag: TAG,
        sessionId: "coord",
        startedAt: iso(NOW - 60_000),
        lastHeartbeat: iso(NOW - 20_000),
        claimed_issues: [401, 402, 403],
      }),
    );

    const result = unclaimIssues(root, "overnight", "coord", [401, 402, 403], TAG, iso(NOW));

    assert.equal(result.ok, true, "403 só existia no backup e conta como reivindicada (#6481)");
    assert.deepEqual(readAnchor(root, "coord").claimed_issues, []);
    assert.deepEqual(JSON.parse(readFileSync(backup, "utf8")).claimed_issues, []);
  });

  it("sessão ausente vale para o lote inteiro, sem escrever", () => {
    const root = freshRoot();
    const result = unclaimIssues(root, "overnight", "ninguem", [1, 2], TAG, iso(NOW));
    assert.equal(result.ok, false);
    assert.equal(result.writes, 0);
    assert.ok(result.entries.every((e) => e.reason === "no-op-session-missing"));
  });

  it("âncora ilegível: no-op-unreadable por issue, nunca 'sessão inexistente'", () => {
    const root = freshRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(sessionFilePath(root, "overnight", TAG, "coord"), "{ parcial");
    const originalWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let result;
    try {
      result = unclaimIssues(root, "overnight", "coord", [1, 2], TAG, iso(NOW));
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.ok(result.entries.every((e) => e.reason === "no-op-unreadable"));
  });

  it("lista vazia é erro, não lote vazio de sucesso", () => {
    const root = freshRoot();
    coordWith(root, [1]);
    assert.throws(() => unclaimIssues(root, "overnight", "coord", [], TAG, iso(NOW)), /vazia/);
  });

  it("unclaimIssue individual mantém os desfechos de sempre", () => {
    const root = freshRoot();
    coordWith(root, [501]);
    assert.deepEqual(unclaimIssue(root, "overnight", "coord", 501, TAG, iso(NOW)), { ok: true, reason: "unclaimed" });
    assert.deepEqual(unclaimIssue(root, "overnight", "coord", 501, TAG, iso(NOW)), {
      ok: false,
      reason: "no-op-not-claimed",
    });
    assert.deepEqual(unclaimIssue(root, "overnight", "outra", 501, TAG, iso(NOW)), {
      ok: false,
      reason: "no-op-session-missing",
    });
  });
});

// ─── CLI ──────────────────────────────────────────────────────────────────

const CLI = fileURLToPath(new URL("../scripts/lib/session-registry.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))).href;

function freshCliRoot(): string {
  const root = freshRoot();
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "diaria-studio" }));
  return root;
}

function cli(root: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
}

function anchorRecord(root: string, sessionId: string) {
  const dir = join(root, "data", "sessions");
  const name = readdirSync(dir).find((n) => n.endsWith(`-${sessionId}.json`) && !n.includes("safeBackup"));
  assert.ok(name, `âncora de ${sessionId} deveria existir`);
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

describe("CLI unclaim-issue --issues (#12166)", () => {
  it("cenário da issue: --issues solta o lote (antes: '--issue deve ser um inteiro')", () => {
    const root = freshCliRoot();
    assert.equal(cli(root, ["register", "--kind", "overnight", "--session-id", "c1"]).status, 0);
    const claim = cli(root, ["claim-issue", "--kind", "overnight", "--session-id", "c1", "--issues", "12040,12092,12100"]);
    assert.equal(claim.status, 0, claim.stderr);

    const res = cli(root, ["unclaim-issue", "--kind", "overnight", "--session-id", "c1", "--issues", "12040,12092,12100"]);

    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /deve ser um inteiro/);
    assert.match(res.stdout, /unclaim-issue #12040 ok \(liberada\)/);
    assert.match(res.stdout, /unclaim-issue #12100 ok \(liberada\)/);
    assert.match(res.stdout, /3\/3 ok, 1 escrita\(s\) na âncora/);
    assert.deepEqual(anchorRecord(root, "c1").claimed_issues, []);
  });

  it("issue não reivindicada no lote: as outras saem e o exit é 1", () => {
    const root = freshCliRoot();
    assert.equal(cli(root, ["register", "--kind", "overnight", "--session-id", "c2"]).status, 0);
    assert.equal(cli(root, ["claim-issue", "--kind", "overnight", "--session-id", "c2", "--issues", "601,603"]).status, 0);

    const res = cli(root, ["unclaim-issue", "--kind", "overnight", "--session-id", "c2", "--issues", "601,602,603"]);

    assert.equal(res.status, 1);
    assert.match(res.stdout, /#602 no-op \(não estava reivindicada/);
    assert.match(res.stdout, /2\/3 ok/);
    assert.deepEqual(anchorRecord(root, "c2").claimed_issues, []);
  });

  it("--issue e --issues juntos: recusa sem soltar nada", () => {
    const root = freshCliRoot();
    assert.equal(cli(root, ["register", "--kind", "overnight", "--session-id", "c3"]).status, 0);
    assert.equal(cli(root, ["claim-issue", "--kind", "overnight", "--session-id", "c3", "--issues", "1,2"]).status, 0);
    const res = cli(root, ["unclaim-issue", "--kind", "overnight", "--session-id", "c3", "--issue", "1", "--issues", "2"]);
    assert.notEqual(res.status, 0);
    assert.deepEqual(anchorRecord(root, "c3").claimed_issues, [1, 2]);
  });
});
