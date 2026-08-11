/**
 * test/clarice-envio-guard.test.ts (#5026)
 *
 * Cobre `scripts/clarice-envio-guard.ts` — mesmo harness de exec fake de
 * `clarice-envio-run.test.ts`. `setCampaignStatus` também é injetado (fake
 * que registra chamadas) — nenhum PUT real na Brevo.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runEnvioGuard, findPendingWavesToday, type EnvioGuardDeps } from "../scripts/clarice-envio-guard.ts";
import type { StepResult, ExecFn } from "../scripts/clarice-envio-run.ts";
import type { WaveState } from "../scripts/lib/clarice-wave-plan.ts";

type Handler = StepResult | ((args: string[]) => StepResult);

function jsonResult(obj: unknown, code = 0): StepResult {
  return { code, stdout: JSON.stringify(obj), stderr: "" };
}

function makeFakeExec(handlers: Record<string, Handler>): { exec: ExecFn; calls: Array<{ script: string; args: string[] }> } {
  const calls: Array<{ script: string; args: string[] }> = [];
  const exec: ExecFn = (script, args) => {
    calls.push({ script, args });
    const h = handlers[script];
    if (h === undefined) throw new Error(`fakeExec: sem handler pra "${script}"`);
    return typeof h === "function" ? h(args) : h;
  };
  return { exec, calls };
}

const NOW = new Date("2026-08-12T08:00:00.000Z"); // 05:00 BRT, 12/08/2026 — dia do disparo
const CYCLE = "2607-08";
const TARGET_DATE = "2026-08-12";

function wave(over: Partial<WaveState> & { key: string }): WaveState {
  return { listId: 1, subject: "x", status: "scheduled", scheduledAt: `${TARGET_DATE}T09:00:00.000Z`, volume: 100, ...over };
}

function baseDeps(rootDir: string, overrides: Partial<EnvioGuardDeps> = {}): EnvioGuardDeps {
  return {
    rootDir,
    now: () => NOW,
    exec: () => {
      throw new Error("exec não deveria ser chamado — configure handlers");
    },
    isEnabled: () => true,
    execMode: () => "local",
    setCampaignStatus: async () => {
      throw new Error("setCampaignStatus não deveria ser chamado nesta config");
    },
    ...overrides,
  };
}

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "clarice-envio-guard-"));
}

function segmentsDir(root: string): string {
  const dir = resolve(root, "data", "clarice-subscribers", CYCLE, "segments");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("findPendingWavesToday", () => {
  it("scheduledAt de HOJE com status != sent => pendente", () => {
    const r = findPendingWavesToday([wave({ key: "d12-qua12", status: "scheduled" })], NOW);
    assert.equal(r.length, 1);
  });
  it("status sent => não é pendente", () => {
    const r = findPendingWavesToday([wave({ key: "d12-qua12", status: "sent" })], NOW);
    assert.equal(r.length, 0);
  });
  it("scheduledAt de outro dia => não é pendente", () => {
    const r = findPendingWavesToday([wave({ key: "d13-qui13", scheduledAt: "2026-08-13T09:00:00.000Z" })], NOW);
    assert.equal(r.length, 0);
  });
});

describe("clarice-envio-guard (#5026)", () => {
  let savedApiKey: string | undefined;
  before(() => {
    savedApiKey = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_CLARICE_API_KEY = "test-key";
  });
  after(() => {
    if (savedApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = savedApiKey;
  });

  it("kill switch desligado => pausa sem chamar exec", async () => {
    const root = freshRoot();
    const { exec, calls } = makeFakeExec({});
    const r = await runEnvioGuard(baseDeps(root, { exec, isEnabled: () => false }));
    assert.equal(r.code, 0);
    assert.equal(calls.length, 0);
    rmSync(root, { recursive: true, force: true });
  });

  it("sem onda pendente hoje => nada a fazer (code 0), risk NUNCA é chamado", async () => {
    const root = freshRoot();
    const { exec, calls } = makeFakeExec({
      "scripts/clarice-plan-wave.ts": jsonResult({
        state: { waves: [wave({ key: "d12-qua12", status: "sent" })] },
      }),
    });
    const r = await runEnvioGuard(baseDeps(root, { exec }));
    assert.equal(r.code, 0);
    assert.ok(!calls.some((c) => c.script === "scripts/clarice-envio-risk.ts"), "sem pendência, não precisa nem checar risco fresco");
    rmSync(root, { recursive: true, force: true });
  });

  it("onda pendente + freio OK (fresco) => confirma, NÃO cancela", async () => {
    const root = freshRoot();
    let setStatusCalls = 0;
    const { exec } = makeFakeExec({
      "scripts/clarice-plan-wave.ts": jsonResult({ state: { waves: [wave({ key: "d12-qua12", status: "scheduled" })] } }),
      "scripts/clarice-envio-risk.ts": jsonResult({ brake: { level: "ok", reasons: ["saudável"], maxUtil: 0.1 } }),
    });
    const r = await runEnvioGuard(
      baseDeps(root, { exec, setCampaignStatus: async () => { setStatusCalls++; } }),
    );
    assert.equal(r.code, 0);
    assert.equal(setStatusCalls, 0);
    rmSync(root, { recursive: true, force: true });
  });

  it("onda pendente + freio STOP (fresco) => cancela (suspended) e atualiza o registro local", async () => {
    const root = freshRoot();
    const dir = segmentsDir(root);
    writeFileSync(
      resolve(dir, "group-campaigns.json"),
      JSON.stringify([{ key: "d12-qua12", campaignId: 999, listId: 500, subject: "x", status: "scheduled" }]),
      "utf8",
    );
    const suspendCalls: Array<{ apiKey: string; campaignId: number; status: string }> = [];
    const { exec } = makeFakeExec({
      "scripts/clarice-plan-wave.ts": jsonResult({ state: { waves: [wave({ key: "d12-qua12", status: "scheduled" })] } }),
      "scripts/clarice-envio-risk.ts": jsonResult({ brake: { level: "stop", reasons: ["hard bounce estourou"], maxUtil: 1.3 } }),
    });
    const r = await runEnvioGuard(
      baseDeps(root, {
        exec,
        setCampaignStatus: async (apiKey, campaignId, status) => {
          suspendCalls.push({ apiKey, campaignId, status });
        },
      }),
    );
    assert.equal(r.code, 0);
    assert.equal(suspendCalls.length, 1);
    assert.equal(suspendCalls[0].campaignId, 999);
    assert.equal(suspendCalls[0].status, "suspended");

    const updated = JSON.parse(readFileSync(resolve(dir, "group-campaigns.json"), "utf8"));
    assert.equal(updated[0].status, "draft", "registro local reflete que não é mais 'scheduled'");
    rmSync(root, { recursive: true, force: true });
  });

  it("freio STOP mas campaignId desconhecido (sem entrada no registro) => reporta, NÃO lança", async () => {
    const root = freshRoot();
    segmentsDir(root); // dir existe, mas sem group-campaigns.json
    const { exec } = makeFakeExec({
      "scripts/clarice-plan-wave.ts": jsonResult({ state: { waves: [wave({ key: "d12-qua12", status: "scheduled" })] } }),
      "scripts/clarice-envio-risk.ts": jsonResult({ brake: { level: "stop", reasons: ["x"], maxUtil: 1.1 } }),
    });
    const r = await runEnvioGuard(baseDeps(root, { exec }));
    assert.equal(r.code, 0);
    assert.match(r.reportMarkdown, /campaignId desconhecido|painel Brevo/);
    rmSync(root, { recursive: true, force: true });
  });

  it("falha ao suspender (API lança) => reporta o erro, não derruba a rodada inteira", async () => {
    const root = freshRoot();
    const dir = segmentsDir(root);
    writeFileSync(
      resolve(dir, "group-campaigns.json"),
      JSON.stringify([{ key: "d12-qua12", campaignId: 999, listId: 500, subject: "x", status: "scheduled" }]),
      "utf8",
    );
    const { exec } = makeFakeExec({
      "scripts/clarice-plan-wave.ts": jsonResult({ state: { waves: [wave({ key: "d12-qua12", status: "scheduled" })] } }),
      "scripts/clarice-envio-risk.ts": jsonResult({ brake: { level: "stop", reasons: ["x"], maxUtil: 1.1 } }),
    });
    const r = await runEnvioGuard(
      baseDeps(root, {
        exec,
        setCampaignStatus: async () => {
          throw new Error("Brevo 500");
        },
      }),
    );
    assert.equal(r.code, 0);
    assert.match(r.reportMarkdown, /Brevo 500|falha ao suspender/);
    rmSync(root, { recursive: true, force: true });
  });
});
