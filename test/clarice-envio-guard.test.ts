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

  it("REGRESSÃO (achado do code-reviewer, confiança 88%): na virada de mês, resolve o ciclo de ONTEM (quando a onda foi planejada), não o de hoje", async () => {
    // clarice-envio-run.ts fixa o ciclo às 19:00 de ontem (mês de AGOSTO,
    // "2607-08") pra uma onda que dispara HOJE (01/09). Se o guard
    // recomputasse o ciclo a partir do PRÓPRIO `now` (01/09, já setembro),
    // ele consultaria "2608-09" — onde a campanha pendente NÃO está
    // registrada — e reportaria falsamente "nada a fazer" na noite de
    // maior risco (1ª onda de um ciclo novo, sem histórico).
    const nowSept1 = new Date("2026-09-01T08:00:00.000Z"); // 05:00 BRT, 01/09/2026
    const root = freshRoot();
    const { exec, calls } = makeFakeExec({
      "scripts/clarice-plan-wave.ts": jsonResult({ state: { waves: [wave({ key: "d12-qua12", status: "sent" })] } }),
    });
    await runEnvioGuard(baseDeps(root, { exec, now: () => nowSept1 }));
    const planCall = calls.find((c) => c.script === "scripts/clarice-plan-wave.ts");
    assert.ok(planCall, "deveria ter chamado clarice-plan-wave.ts");
    const cycleArg = planCall!.args[planCall!.args.indexOf("--cycle") + 1];
    assert.equal(cycleArg, "2607-08", "deve consultar o ciclo de AGOSTO (quando a onda foi planejada ontem às 19h), não o de setembro");
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

  it("REGRESSÃO (achado CRITICAL do silent-failure-hunter): freio STOP mas campaignId desconhecido => code 2 (NUNCA 0 — cancelamento não confirmado)", async () => {
    // Antes do fix, esta rodada retornava code:0 ("sucesso") mesmo sem
    // cancelar NENHUMA onda — o único sinal externo (exit code) mentia
    // exatamente no cenário mais perigoso. code:2 é o sinal correto de
    // "cancelamento incompleto", nunca colapsado no mesmo 0 do caminho feliz.
    const root = freshRoot();
    segmentsDir(root); // dir existe, mas sem group-campaigns.json
    const { exec } = makeFakeExec({
      "scripts/clarice-plan-wave.ts": jsonResult({ state: { waves: [wave({ key: "d12-qua12", status: "scheduled" })] } }),
      "scripts/clarice-envio-risk.ts": jsonResult({ brake: { level: "stop", reasons: ["x"], maxUtil: 1.1 } }),
    });
    const r = await runEnvioGuard(baseDeps(root, { exec }));
    assert.equal(r.code, 2);
    assert.match(r.reportMarkdown, /campaignId desconhecido|painel Brevo/);
    assert.match(r.reportMarkdown, /NEM TODA onda pendente foi confirmada/);
    assert.equal(r.reportId, "envio-260812-guard-cancelamento-incompleto");
    rmSync(root, { recursive: true, force: true });
  });

  it("REGRESSÃO (achado CRITICAL): falha ao suspender (API lança) => code 2, reporta o erro, não derruba a rodada inteira", async () => {
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
    assert.equal(r.code, 2, "falha na API NUNCA pode reportar como sucesso (code 0)");
    assert.match(r.reportMarkdown, /Brevo 500|falha ao suspender/);
    rmSync(root, { recursive: true, force: true });
  });

  it("2 ondas pendentes, 1 confirma e 1 falha => code 2 (parcial NÃO é sucesso)", async () => {
    const root = freshRoot();
    const dir = segmentsDir(root);
    writeFileSync(
      resolve(dir, "group-campaigns.json"),
      JSON.stringify([
        { key: "d12-qua12-A", campaignId: 900, listId: 500, subject: "x", status: "scheduled" },
        { key: "d12-qua12-B", campaignId: 901, listId: 501, subject: "y", status: "scheduled" },
      ]),
      "utf8",
    );
    const { exec } = makeFakeExec({
      "scripts/clarice-plan-wave.ts": jsonResult({
        state: {
          waves: [wave({ key: "d12-qua12-A", status: "scheduled" }), wave({ key: "d12-qua12-B", status: "scheduled" })],
        },
      }),
      "scripts/clarice-envio-risk.ts": jsonResult({ brake: { level: "stop", reasons: ["x"], maxUtil: 1.1 } }),
    });
    const r = await runEnvioGuard(
      baseDeps(root, {
        exec,
        setCampaignStatus: async (_apiKey, campaignId) => {
          if (campaignId === 901) throw new Error("Brevo 500 na célula B");
        },
      }),
    );
    assert.equal(r.code, 2);
    const updated = JSON.parse(readFileSync(resolve(dir, "group-campaigns.json"), "utf8"));
    assert.equal(updated.find((e: { key: string }) => e.key === "d12-qua12-A").status, "draft", "a que teve sucesso precisa persistir");
    assert.equal(updated.find((e: { key: string }) => e.key === "d12-qua12-B").status, "scheduled", "a que falhou NÃO muda de status local");
    rmSync(root, { recursive: true, force: true });
  });

  it("group-campaigns.json corrompido => tratado como sem entradas, mas AVISA que é corrupção (não 'nunca teve campanha')", async () => {
    const root = freshRoot();
    const dir = segmentsDir(root);
    writeFileSync(resolve(dir, "group-campaigns.json"), "{ isto nao e json valido", "utf8");
    const { exec } = makeFakeExec({
      "scripts/clarice-plan-wave.ts": jsonResult({ state: { waves: [wave({ key: "d12-qua12", status: "scheduled" })] } }),
      "scripts/clarice-envio-risk.ts": jsonResult({ brake: { level: "stop", reasons: ["x"], maxUtil: 1.1 } }),
    });
    const r = await runEnvioGuard(baseDeps(root, { exec }));
    assert.equal(r.code, 2);
    assert.match(r.reportMarkdown, /CORROMPIDO/);
    rmSync(root, { recursive: true, force: true });
  });
});
