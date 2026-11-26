/**
 * test/worktree-claim-mirror-gc-14214.test.ts (#14214)
 *
 * `claimWorktree` gravava um espelho `worktree_claim` em
 * `continuo-{tag da máquina}-{sessionId}.json` (kind fixo, sem `sessionId`
 * nem `kind` no conteúdo). O GC o via como "ilegível" e nunca o recolhia,
 * enquanto o registro real da sessão (`overnight-m1-sX`) saía.
 *
 * Cobre as duas metades do fix: `claimWorktree` não cria mais arquivo de
 * sessão, e `planSessionGc` recolhe o espelho antigo quando a sessão dona
 * acabou, mantendo-o enquanto ela vive. Isolado em tmpdir, nunca toca o
 * `data/` real.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimWorktree,
  garbageCollectSessions,
  planSessionGc,
  sessionsDir,
  type SessionRecord,
} from "../scripts/lib/session-registry.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = join(tmpdir(), `worktree-claim-mirror-14214-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  mkdirSync(sessionsDir(root), { recursive: true });
  return root;
}

function writeRaw(root: string, name: string, value: unknown): string {
  const p = join(sessionsDir(root), name);
  writeFileSync(p, JSON.stringify(value), "utf8");
  return p;
}

const NOW = Date.parse("2027-11-26T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function overnightRecord(sessionId: string, heartbeatMs: number): SessionRecord {
  return {
    kind: "overnight",
    machineTag: "m1",
    sessionId,
    startedAt: new Date(heartbeatMs - HOUR).toISOString(),
    lastHeartbeat: new Date(heartbeatMs).toISOString(),
  } as SessionRecord;
}

/** Formato exato do espelho que `claimWorktree` gravava antes do #14214. */
function mirror(sessionId: string, expiresAtMs: number) {
  return {
    session_id: sessionId,
    worktree_claim: {
      path: "/tmp/wt-a",
      sessionId,
      claimed_at: new Date(expiresAtMs - 30 * 60 * 1000).toISOString(),
      expires_at: expiresAtMs,
    },
  };
}

const opts = { now: NOW, localMachineTag: "300", isPidAlive: () => false };

describe("#14214 — espelho worktree_claim", () => {
  it("claimWorktree não grava mais arquivo de sessão (só o claim indexado por path)", () => {
    const root = freshRoot();
    assert.strictEqual(claimWorktree(join(root, "wt-a"), "sX", root, "overnight/fix-1"), true);
    const sessionFiles = readdirSync(sessionsDir(root)).filter((n) => n.endsWith(".json"));
    assert.deepStrictEqual(sessionFiles, [], `nenhum arquivo de sessão esperado, achou: ${sessionFiles.join(", ")}`);
    const claimFiles = readdirSync(join(sessionsDir(root), ".worktree-claims")).filter((n) => n.endsWith(".json"));
    assert.strictEqual(claimFiles.length, 1, "o claim autoritativo segue gravado");
  });

  it("cenário da issue: um ano depois, o espelho sai junto com o registro real", () => {
    const root = freshRoot();
    const oldMs = NOW - 365 * 24 * HOUR;
    const realPath = writeRaw(root, "overnight-m1-sX.json", overnightRecord("sX", oldMs));
    const mirrorPath = writeRaw(root, "continuo-300-sX.json", mirror("sX", oldMs + 30 * 60 * 1000));

    const plan = planSessionGc(root, opts);
    const real = plan.find((e) => e.files.includes(realPath));
    const mir = plan.find((e) => e.files.includes(mirrorPath));
    assert.strictEqual(real?.action, "removed");
    assert.strictEqual(mir?.action, "removed", mir?.reason);
    assert.match(mir!.identity, /^worktree-claim-mirror:/);

    garbageCollectSessions(root, opts);
    assert.strictEqual(existsSync(mirrorPath), false, "espelho recolhido do disco");
    assert.strictEqual(existsSync(realPath), false);
  });

  it("espelho órfão (registro da sessão já ausente) com claim vencida sai", () => {
    const root = freshRoot();
    const mirrorPath = writeRaw(root, "continuo-300-sGone.json", mirror("sGone", NOW - 30 * 24 * HOUR));
    const mir = planSessionGc(root, opts).find((e) => e.files.includes(mirrorPath));
    assert.strictEqual(mir?.action, "removed", mir?.reason);
  });

  it("espelho de sessão VIVA fica, mesmo com a claim espelhada vencida", () => {
    const root = freshRoot();
    writeRaw(root, "overnight-m1-sLive.json", overnightRecord("sLive", NOW - 5 * 60 * 1000));
    const mirrorPath = writeRaw(root, "continuo-300-sLive.json", mirror("sLive", NOW - 10 * HOUR));
    const mir = planSessionGc(root, opts).find((e) => e.files.includes(mirrorPath));
    assert.strictEqual(mir?.action, "kept", mir?.reason);

    garbageCollectSessions(root, opts);
    assert.strictEqual(existsSync(mirrorPath), true);
  });

  it("espelho com claim ainda válida fica, mesmo sem registro da sessão", () => {
    const root = freshRoot();
    const mirrorPath = writeRaw(root, "continuo-300-sFresh.json", mirror("sFresh", NOW + 20 * 60 * 1000));
    const mir = planSessionGc(root, opts).find((e) => e.files.includes(mirrorPath));
    assert.strictEqual(mir?.action, "kept", mir?.reason);
  });

  it("GC continua igual para o resto: JSON de outro formato segue 'ilegível' e mantido", () => {
    const root = freshRoot();
    const oddPath = writeRaw(root, "continuo-300-sOdd.json", { session_id: "sOdd" });
    const corruptPath = join(sessionsDir(root), "overnight-m1-sBad.json");
    writeFileSync(corruptPath, "{not json", "utf8");
    // record de verdade que carrega um worktree_claim legado não é espelho
    const realWithClaim = writeRaw(root, "continuo-300-sReal.json", {
      ...overnightRecord("sReal", NOW - 5 * 60 * 1000),
      kind: "continuo",
      ...mirror("sReal", NOW - 10 * HOUR),
    });
    const plan = planSessionGc(root, opts);
    for (const p of [oddPath, corruptPath]) {
      const e = plan.find((x) => x.files.includes(p));
      assert.strictEqual(e?.action, "kept");
      assert.match(e!.reason, /ilegível/);
    }
    const real = plan.find((x) => x.files.includes(realWithClaim));
    assert.strictEqual(real?.action, "kept");
    assert.doesNotMatch(real!.identity, /^worktree-claim-mirror:/);
  });
});
