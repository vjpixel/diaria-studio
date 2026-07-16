/**
 * test/studio-plan-watch.test.ts (#3555) — cobertura de
 * scripts/studio-ui/plan-watch.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { currentPlanSignature, watchPlanFiles } from "../scripts/studio-ui/plan-watch.ts";

function setupRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "studio-plan-watch-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("currentPlanSignature (#3555)", () => {
  it("sem data/overnight: path=null, mtimeMs=null", () => {
    const { root, cleanup } = setupRoot();
    try {
      const sig = currentPlanSignature(root, "overnight");
      assert.deepEqual(sig, { kind: "overnight", path: null, mtimeMs: null });
    } finally {
      cleanup();
    }
  });

  it("com plan.json presente: path relativo + mtimeMs numérico", () => {
    const { root, cleanup } = setupRoot();
    try {
      const planPath = join(root, "data", "develop", "260716", "plan.json");
      mkdirSync(join(planPath, ".."), { recursive: true });
      writeFileSync(planPath, "{}");
      const sig = currentPlanSignature(root, "develop");
      assert.equal(sig.kind, "develop");
      assert.ok(sig.path?.includes("260716"));
      assert.equal(typeof sig.mtimeMs, "number");
    } finally {
      cleanup();
    }
  });
});

describe("watchPlanFiles (#3555)", () => {
  it("dispara onChange quando um plan.json novo aparece", async () => {
    const { root, cleanup } = setupRoot();
    mkdirSync(join(root, "data", "overnight"), { recursive: true });
    mkdirSync(join(root, "data", "develop"), { recursive: true });

    const changes: unknown[] = [];
    const handle = watchPlanFiles(root, (sig) => changes.push(sig), { pollIntervalMs: 20 });
    try {
      const planPath = join(root, "data", "overnight", "260716", "plan.json");
      mkdirSync(join(planPath, ".."), { recursive: true });
      writeFileSync(planPath, JSON.stringify({ started_at: "x", issues: [] }));

      const deadline = Date.now() + 500;
      while (changes.length === 0 && Date.now() < deadline) {
        await delay(20);
      }
      assert.ok(changes.length >= 1, "esperava ao menos 1 mudança detectada");
      assert.equal((changes[0] as { kind: string }).kind, "overnight");
    } finally {
      handle.close();
      cleanup();
    }
  });

  it("dispara onChange de novo quando o mesmo plan.json é reescrito (mtime muda)", async () => {
    const { root, cleanup } = setupRoot();
    const planPath = join(root, "data", "develop", "260716", "plan.json");
    mkdirSync(join(planPath, ".."), { recursive: true });
    writeFileSync(planPath, JSON.stringify({ issues: [] }));

    const changes: unknown[] = [];
    const handle = watchPlanFiles(root, (sig) => changes.push(sig), { pollIntervalMs: 20 });
    try {
      // Espera estabilizar (sem mudanças) antes de reescrever.
      await delay(60);
      const before = changes.length;
      // Garante mtime diferente mesmo em filesystems com resolução de tempo
      // grosseira: reescreve com conteúdo maior.
      await delay(30);
      writeFileSync(planPath, JSON.stringify({ issues: [{ status: "merged" }] }));

      const deadline = Date.now() + 800;
      while (changes.length <= before && Date.now() < deadline) {
        await delay(20);
      }
      assert.ok(changes.length > before, "esperava nova mudança após reescrita");
    } finally {
      handle.close();
      cleanup();
    }
  });

  it("close() é idempotente", () => {
    const { root, cleanup } = setupRoot();
    const handle = watchPlanFiles(root, () => {}, { pollIntervalMs: 20 });
    handle.close();
    assert.doesNotThrow(() => handle.close());
    cleanup();
  });
});
