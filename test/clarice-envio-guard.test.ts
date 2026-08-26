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
import { acquireEnvioLock } from "../scripts/lib/clarice-envio-lock.ts";

type Handler = StepResult | ((args: string[]) => StepResult) | StepResult[];

function jsonResult(obj: unknown, code = 0): StepResult {
  return { code, stdout: JSON.stringify(obj), stderr: "" };
}

/**
 * #5220 — `Handler` ganhou o caso `StepResult[]` (mesmo padrão de
 * `makeFakeExec` em `clarice-envio-run.test.ts`): consumido SEQUENCIALMENTE
 * por chamada ao MESMO script (índice por script, não global) — necessário
 * pra testar retry (1ª chamada transitória, 2ª sucesso). Handler esgotado
 * repete o ÚLTIMO elemento, nunca lança — simplifica os testes que só
 * querem "falha 3× seguidas" sem contar índices manualmente.
 */
function makeFakeExec(handlers: Record<string, Handler>): { exec: ExecFn; calls: Array<{ script: string; args: string[] }> } {
  const calls: Array<{ script: string; args: string[] }> = [];
  const counters: Record<string, number> = {};
  const exec: ExecFn = (script, args) => {
    calls.push({ script, args });
    const idx = counters[script] ?? 0;
    counters[script] = idx + 1;
    const h = handlers[script];
    if (h === undefined) throw new Error(`fakeExec: sem handler pra "${script}"`);
    if (typeof h === "function") return h(args);
    if (Array.isArray(h)) return h[Math.min(idx, h.length - 1)];
    return h;
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
    sleep: async () => {},
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

  it("lock detido por outra rodada => aborta (code 1), zero exec — mesma trava do #4765 usada por runEnvio", async () => {
    const root = freshRoot();
    // Guard resolve o ciclo via now-24h (fix do achado de virada de mês) —
    // o lock precisa estar sob o MESMO ciclo pra este teste ser realista.
    acquireEnvioLock(root, CYCLE, "run-19h-em-curso", new Date(NOW.getTime() - 60_000));
    const { exec, calls } = makeFakeExec({});
    const r = await runEnvioGuard(baseDeps(root, { exec }));
    assert.equal(r.code, 1);
    assert.match(r.reportMarkdown, /concorrente/);
    assert.equal(calls.length, 0, "lock detido aborta ANTES de qualquer chamada");
    rmSync(root, { recursive: true, force: true });
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

  // #5515 — defesa em profundidade: mesmo que o JSON recebido do subprocess
  // ainda venha "stop" cru (simulado aqui injetando o exec diretamente, sem
  // passar pela demoção que `clarice-envio-risk.ts` já faz internamente), o
  // guard consulta o override por conta própria e NÃO cancela.
  it("override do editor ATIVO no rootDir + freio STOP cru recebido do exec => NÃO cancela (defesa em profundidade)", async () => {
    const root = freshRoot();
    const dir = segmentsDir(root);
    writeFileSync(
      resolve(dir, "group-campaigns.json"),
      JSON.stringify([{ key: "d12-qua12", campaignId: 999, listId: 500, subject: "x", status: "scheduled" }]),
      "utf8",
    );
    mkdirSync(resolve(root, "data"), { recursive: true });
    writeFileSync(
      resolve(root, "data", "clarice-envio-override.json"),
      JSON.stringify({
        brake: "hold",
        until: "2026-08-14T00:00:00.000Z", // depois de NOW (12/08 05:00 BRT)
        reason: "pico de campanha de 27/06 (#5487) confirmado falso-positivo",
        decidedBy: "editor",
        issueRef: 5487,
        createdAt: "2026-08-11T02:05:00.000Z",
      }),
      "utf8",
    );
    let setStatusCalls = 0;
    const { exec } = makeFakeExec({
      "scripts/clarice-plan-wave.ts": jsonResult({ state: { waves: [wave({ key: "d12-qua12", status: "scheduled" })] } }),
      "scripts/clarice-envio-risk.ts": jsonResult({ brake: { level: "stop", reasons: ["hard bounce estourou"], maxUtil: 1.3 } }),
    });
    const r = await runEnvioGuard(
      baseDeps(root, { exec, setCampaignStatus: async () => { setStatusCalls++; } }),
    );
    assert.equal(r.code, 0);
    assert.equal(setStatusCalls, 0, "override cobre o STOP — onda pendente NÃO é cancelada");
    rmSync(root, { recursive: true, force: true });
  });

  it("override do editor EXPIRADO no rootDir + freio STOP cru => cancela normalmente (expiração é ignorada)", async () => {
    const root = freshRoot();
    const dir = segmentsDir(root);
    writeFileSync(
      resolve(dir, "group-campaigns.json"),
      JSON.stringify([{ key: "d12-qua12", campaignId: 999, listId: 500, subject: "x", status: "scheduled" }]),
      "utf8",
    );
    mkdirSync(resolve(root, "data"), { recursive: true });
    writeFileSync(
      resolve(root, "data", "clarice-envio-override.json"),
      JSON.stringify({
        brake: "hold",
        until: "2026-08-10T00:00:00.000Z", // antes de NOW — expirado
        reason: "override antigo, já vencido",
        decidedBy: "editor",
        issueRef: 1,
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      "utf8",
    );
    const suspendCalls: Array<{ campaignId: number; status: string }> = [];
    const { exec } = makeFakeExec({
      "scripts/clarice-plan-wave.ts": jsonResult({ state: { waves: [wave({ key: "d12-qua12", status: "scheduled" })] } }),
      "scripts/clarice-envio-risk.ts": jsonResult({ brake: { level: "stop", reasons: ["hard bounce estourou"], maxUtil: 1.3 } }),
    });
    const r = await runEnvioGuard(
      baseDeps(root, {
        exec,
        setCampaignStatus: async (_apiKey, campaignId, status) => {
          suspendCalls.push({ campaignId, status });
        },
      }),
    );
    assert.equal(r.code, 0);
    assert.equal(suspendCalls.length, 1, "override vencido não protege — cancela como se não houvesse override");
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

  // #5942/#5944 — REGRESSÃO: campanha já ENVIADA na Brevo (envio real
  // ocorreu antes do guard rodar, registro local desatualizado) NÃO é uma
  // falha — é estado seguro. O guard deve tratar como sucesso (code 0),
  // atualizar o registro local para "sent" e NÃO reportar como incompleto.
  it("REGRESSÃO (#5942/#5944): campanha já ENVIADA na Brevo => code 0, registro atualizado, NÃO é cancelamento incompleto", async () => {
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
    let statusCalls = 0;
    const r = await runEnvioGuard(
      baseDeps(root, {
        exec,
        setCampaignStatus: async () => {
          statusCalls++;
          // Simula a Brevo rejeitando o PUT porque a campanha já foi enviada
          throw new Error(`Brevo API PUT /emailCampaigns/999/status falhou (400): {"code":"invalid_parameter","message":"suspended is an invalid status for sent campaign"}`);
        },
      }),
    );
    assert.equal(statusCalls, 1, "deve tentar suspender a campanha antes de perceber que já está enviada");
    assert.equal(r.code, 0, "campanha já enviada NÃO é cancelamento incompleto — é estado seguro (code 0), não 2");
    assert.match(r.reportMarkdown, /já foi ENVIADA/);
    assert.match(r.reportMarkdown, /estado seguro/);
    // Verifica que o registro local reflete o estado real da Brevo (sent)
    const updated = JSON.parse(readFileSync(resolve(dir, "group-campaigns.json"), "utf8"));
    assert.equal(updated[0].status, "sent", "registro local reflete " +
      "o estado real da Brevo (campaign já enviada antes do guard rodar)");
    rmSync(root, { recursive: true, force: true });
  });

  // #5942/#5944 — REGRESSÃO: campanha já SUSPENSA na Brevo (cancelamento
  // realizado numa rodada anterior) NÃO é uma falha — é estado seguro.
  it("REGRESSÃO (#5942/#5944): campanha já SUSPENSA na Brevo => code 0, registro atualizado", async () => {
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
          throw new Error(`Brevo API PUT /emailCampaigns/999/status falhou (400): {"code":"invalid_parameter","message":"suspended is an invalid status for suspended campaign"}`);
        },
      }),
    );
    assert.equal(r.code, 0, "campanha já suspensa NÃO é cancelamento incompleto — é estado seguro (code 0), não 2");
    assert.match(r.reportMarkdown, /já estava SUSPENSA/);
    assert.match(r.reportMarkdown, /estado seguro/);
    const updated = JSON.parse(readFileSync(resolve(dir, "group-campaigns.json"), "utf8"));
    assert.equal(updated[0].status, "draft", "registro local reflete que a campanha " +
      "já estava suspensa (não precisa voltar a ser suspensa)");
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

  // -------------------------------------------------------------------------
  // #5220 — retry transitório dos pré-requisitos + fallback quando esgota.
  // -------------------------------------------------------------------------

  function transientResult(retryAfterSecs: number | null, reason = "GET .../api/campaigns falhou (503)"): StepResult {
    return { code: 3, stdout: JSON.stringify({ transient: true, retryAfterSecs, status: 503, reason }), stderr: reason };
  }

  function writeBrakeSnapshot(root: string, aammdd: string, brake: "ok" | "hold" | "stop", reasons: string[] = ["x"]): void {
    const dir = resolve(root, "data", "clarice-subscribers", "envio-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `envio-${aammdd}-brake.json`), JSON.stringify({ brake, reasons, recordedAt: "2026-08-11T22:00:00.000Z" }), "utf8");
  }

  describe("clarice-envio-guard — retry transitório de clarice-plan-wave (#5220)", () => {
    it("1ª tentativa TRANSITÓRIA seguida de sucesso => retenta e completa normalmente (freio OK, code 0)", async () => {
      const root = freshRoot();
      const sleeps: number[] = [];
      const { exec, calls } = makeFakeExec({
        "scripts/clarice-plan-wave.ts": [transientResult(5), jsonResult({ state: { waves: [wave({ key: "d12-qua12", status: "scheduled" })] } })],
        "scripts/clarice-envio-risk.ts": jsonResult({ brake: { level: "ok", reasons: ["saudável"], maxUtil: 0.1 } }),
      });
      const r = await runEnvioGuard(baseDeps(root, { exec, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } }));
      assert.equal(r.code, 0, r.reportMarkdown);
      assert.equal(r.reportId, "envio-260812-guard-ok");
      assert.equal(calls.filter((c) => c.script === "scripts/clarice-plan-wave.ts").length, 2, "retentou 1× e a 2ª chamada teve sucesso");
      assert.deepEqual(sleeps, [5000]);
      rmSync(root, { recursive: true, force: true });
    });

    it("REGRESSÃO (#6221): falha TRANSITÓRIA persiste nas 2 tentativas, capped no orçamento ENCOLHIDO do guard (2min, não 10min nem 35min do run) => cai no fallback rápido", async () => {
      const root = freshRoot();
      const sleeps: number[] = [];
      const { exec, calls } = makeFakeExec({
        "scripts/clarice-plan-wave.ts": [transientResult(3600), transientResult(3600)], // 1h pedido, capped
      });
      const r = await runEnvioGuard(baseDeps(root, { exec, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } }));
      assert.equal(calls.filter((c) => c.script === "scripts/clarice-plan-wave.ts").length, 2, "exatamente 2 tentativas, não mais (#6221 — era 3)");
      assert.deepEqual(sleeps, [2 * 60_000], "capped em 2min (orçamento ENCOLHIDO do guard, #6221) — só 1 espera, não 2");
      // sem group-campaigns.json => sem pendência local => code 1 (fallback não tem o que fazer, mas alarma).
      assert.equal(r.code, 1);
      assert.equal(r.reportId, "envio-260812-guard-prereq-falhou-sem-pendencia");
      rmSync(root, { recursive: true, force: true });
    });

    it("falha NÃO-transitória (exit 1 genérico) => cai no fallback direto, sem retentar", async () => {
      const root = freshRoot();
      let sleepCalls = 0;
      const { exec, calls } = makeFakeExec({
        "scripts/clarice-plan-wave.ts": { code: 1, stdout: "", stderr: "config inválida" },
      });
      const r = await runEnvioGuard(baseDeps(root, { exec, sleep: () => { sleepCalls++; return Promise.resolve(); } }));
      assert.equal(calls.filter((c) => c.script === "scripts/clarice-plan-wave.ts").length, 1, "erro não-transitório nunca retenta");
      assert.equal(sleepCalls, 0);
      assert.equal(r.code, 1);
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe("clarice-envio-guard — fallback quando pré-requisito esgota o retry (#5220)", () => {
    it("freio da rodada das 19:00 (brake.json) era OK => fallback DEIXA a onda seguir, mas com reportId próprio pro alarme distinguir do caminho normal", async () => {
      const root = freshRoot();
      writeBrakeSnapshot(root, "260811", "ok");
      const dir = segmentsDir(root);
      writeFileSync(
        resolve(dir, "group-campaigns.json"),
        JSON.stringify([{ key: "d12-qua12", campaignId: 999, listId: 500, subject: "x", scheduledAt: "2026-08-12T09:00:00.000Z", status: "scheduled" }]),
        "utf8",
      );
      const suspendCalls: number[] = [];
      const { exec } = makeFakeExec({
        "scripts/clarice-plan-wave.ts": [transientResult(1), transientResult(1), transientResult(1)],
      });
      const r = await runEnvioGuard(
        baseDeps(root, { exec, sleep: () => Promise.resolve(), setCampaignStatus: async (_k, id) => { suspendCalls.push(id); } }),
      );
      assert.equal(r.code, 0, r.reportMarkdown);
      assert.equal(r.reportId, "envio-260812-guard-prereq-fallback-deixou-passar");
      assert.equal(suspendCalls.length, 0, "freio anterior OK => NUNCA cancela no fallback");
      assert.match(r.reportMarkdown, /freio da noite era OK/);
      rmSync(root, { recursive: true, force: true });
    });

    it("freio da rodada das 19:00 era STOP => fallback SUSPENDE por precaução", async () => {
      const root = freshRoot();
      writeBrakeSnapshot(root, "260811", "stop", ["hard bounce estourou ontem"]);
      const dir = segmentsDir(root);
      writeFileSync(
        resolve(dir, "group-campaigns.json"),
        JSON.stringify([{ key: "d12-qua12", campaignId: 999, listId: 500, subject: "x", scheduledAt: "2026-08-12T09:00:00.000Z", status: "scheduled" }]),
        "utf8",
      );
      const suspendCalls: number[] = [];
      const { exec } = makeFakeExec({
        "scripts/clarice-plan-wave.ts": [transientResult(1), transientResult(1), transientResult(1)],
      });
      const r = await runEnvioGuard(
        baseDeps(root, { exec, sleep: () => Promise.resolve(), setCampaignStatus: async (_k, id) => { suspendCalls.push(id); } }),
      );
      assert.equal(r.code, 0, r.reportMarkdown);
      assert.equal(r.reportId, "envio-260812-guard-prereq-fallback-cancelou-nao-ok");
      assert.deepEqual(suspendCalls, [999]);
      assert.match(r.reportMarkdown, /freio da noite foi MEDIDO como STOP/);
      rmSync(root, { recursive: true, force: true });
    });

    it("freio anterior AUSENTE (brake.json nunca escrito) => fail-closed, fallback SUSPENDE", async () => {
      const root = freshRoot();
      const dir = segmentsDir(root);
      writeFileSync(
        resolve(dir, "group-campaigns.json"),
        JSON.stringify([{ key: "d12-qua12", campaignId: 999, listId: 500, subject: "x", scheduledAt: "2026-08-12T09:00:00.000Z", status: "scheduled" }]),
        "utf8",
      );
      const suspendCalls: number[] = [];
      const { exec } = makeFakeExec({
        "scripts/clarice-plan-wave.ts": [transientResult(1), transientResult(1), transientResult(1)],
      });
      const r = await runEnvioGuard(
        baseDeps(root, { exec, sleep: () => Promise.resolve(), setCampaignStatus: async (_k, id) => { suspendCalls.push(id); } }),
      );
      assert.equal(r.code, 0, r.reportMarkdown);
      assert.equal(r.reportId, "envio-260812-guard-prereq-fallback-cancelou-ausente");
      assert.deepEqual(suspendCalls, [999]);
      assert.match(r.reportMarkdown, /NÃO-OK \(fail-closed\)/);
      assert.match(r.reportMarkdown, /nenhum snapshot de freio da rodada das 19:00 foi encontrado/);
      rmSync(root, { recursive: true, force: true });
    });

    it("freio anterior ILEGÍVEL (brake.json corrompido) => fail-closed, fallback SUSPENDE", async () => {
      const root = freshRoot();
      const brakeDir = resolve(root, "data", "clarice-subscribers", "envio-reports");
      mkdirSync(brakeDir, { recursive: true });
      writeFileSync(resolve(brakeDir, "envio-260811-brake.json"), "{ nao e json valido", "utf8");
      const dir = segmentsDir(root);
      writeFileSync(
        resolve(dir, "group-campaigns.json"),
        JSON.stringify([{ key: "d12-qua12", campaignId: 999, listId: 500, subject: "x", scheduledAt: "2026-08-12T09:00:00.000Z", status: "scheduled" }]),
        "utf8",
      );
      const suspendCalls: number[] = [];
      const { exec } = makeFakeExec({
        "scripts/clarice-plan-wave.ts": [transientResult(1), transientResult(1), transientResult(1)],
      });
      const r = await runEnvioGuard(
        baseDeps(root, { exec, sleep: () => Promise.resolve(), setCampaignStatus: async (_k, id) => { suspendCalls.push(id); } }),
      );
      assert.equal(r.code, 0, r.reportMarkdown);
      assert.equal(r.reportId, "envio-260812-guard-prereq-fallback-cancelou-ausente");
      assert.deepEqual(suspendCalls, [999]);
      rmSync(root, { recursive: true, force: true });
    });

    it("fallback + suspensão falha na API => code 2 (cancelamento incompleto), nunca reportado como sucesso", async () => {
      const root = freshRoot();
      writeBrakeSnapshot(root, "260811", "stop");
      const dir = segmentsDir(root);
      writeFileSync(
        resolve(dir, "group-campaigns.json"),
        JSON.stringify([{ key: "d12-qua12", campaignId: 999, listId: 500, subject: "x", scheduledAt: "2026-08-12T09:00:00.000Z", status: "scheduled" }]),
        "utf8",
      );
      const { exec } = makeFakeExec({
        "scripts/clarice-plan-wave.ts": [transientResult(1), transientResult(1), transientResult(1)],
      });
      const r = await runEnvioGuard(
        baseDeps(root, {
          exec,
          sleep: () => Promise.resolve(),
          setCampaignStatus: async () => { throw new Error("Brevo 500"); },
        }),
      );
      assert.equal(r.code, 2, r.reportMarkdown);
      assert.equal(r.reportId, "envio-260812-guard-prereq-fallback-cancelamento-incompleto-nao-ok");
      rmSync(root, { recursive: true, force: true });
    });

    it("clarice-envio-risk (2º pré-requisito) esgota retry, plan-wave já tinha sucedido => fallback ainda assim funciona (deriva pendência do registro local, não de proposal)", async () => {
      const root = freshRoot();
      writeBrakeSnapshot(root, "260811", "ok");
      const dir = segmentsDir(root);
      writeFileSync(
        resolve(dir, "group-campaigns.json"),
        JSON.stringify([{ key: "d12-qua12", campaignId: 999, listId: 500, subject: "x", scheduledAt: "2026-08-12T09:00:00.000Z", status: "scheduled" }]),
        "utf8",
      );
      const { exec, calls } = makeFakeExec({
        "scripts/clarice-plan-wave.ts": jsonResult({ state: { waves: [wave({ key: "d12-qua12", status: "scheduled" })] } }),
        "scripts/clarice-envio-risk.ts": { code: 1, stdout: "", stderr: "dashboard indisponível" },
      });
      const r = await runEnvioGuard(baseDeps(root, { exec, sleep: () => Promise.resolve() }));
      assert.equal(calls.filter((c) => c.script === "scripts/clarice-envio-risk.ts").length, 1, "exit 1 não-transitório do risk não retenta");
      assert.equal(r.code, 0, r.reportMarkdown);
      assert.equal(r.reportId, "envio-260812-guard-prereq-fallback-deixou-passar");
      rmSync(root, { recursive: true, force: true });
    });
  });
});

// ─── #6134 — fallback NÃO desfaz override do editor (HOLD-por-decisão ≠ HOLD-por-risco) ───
describe("clarice-envio-guard — fallback com override vigente (#6134)", () => {
  // #6141 (achado do review): este describe é IRMÃO do de cima, não filho —
  // então NÃO herda o before/after que injeta a key. Sem isso, `runEnvioGuard`
  // aborta em "❌ BREVO_CLARICE_API_KEY não definida" antes de alcançar
  // qualquer lógica de override, e os 2 testes falham com `guard-abort`.
  let savedApiKey: string | undefined;
  before(() => {
    savedApiKey = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_CLARICE_API_KEY = "test-key";
  });
  after(() => {
    if (savedApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = savedApiKey;
  });

  function transientResult(retryAfterSecs: number | null, reason = "GET .../api/campaigns falhou (503)"): StepResult {
    return { code: 3, stdout: JSON.stringify({ transient: true, retryAfterSecs, status: 503, reason }), stderr: reason };
  }

  function writeBrakeSnapshot(root: string, aammdd: string, brake: "ok" | "hold" | "stop", reasons: string[] = ["x"]): void {
    const dir = resolve(root, "data", "clarice-subscribers", "envio-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `envio-${aammdd}-brake.json`), JSON.stringify({ brake, reasons, recordedAt: "2026-08-11T22:00:00.000Z" }), "utf8");
  }

  function writeOverride(root: string, untilIso: string): void {
    mkdirSync(resolve(root, "data"), { recursive: true });
    writeFileSync(
      resolve(root, "data", "clarice-envio-override.json"),
      JSON.stringify({ brake: "hold", until: untilIso, reason: "pico 1,92% falso-positivo confirmado", issueRef: 5998 }),
      "utf8",
    );
  }

  it("REGRESSÃO (#6134, code atualizado no #6221): freio HOLD + override do editor VIGENTE => NÃO cancela; code 3 com reportId -override-vigente (ESCALADA DELIBERADA, não erro duro)", async () => {
    const root = freshRoot();
    writeBrakeSnapshot(root, "260811", "hold");
    writeOverride(root, "2026-08-13T12:00:00.000Z"); // futuro relativo a NOW (12/08 08:00Z)
    const dir = segmentsDir(root);
    writeFileSync(
      resolve(dir, "group-campaigns.json"),
      JSON.stringify([{ key: "d12-qua12", campaignId: 999, listId: 500, subject: "x", scheduledAt: "2026-08-12T09:00:00.000Z", status: "scheduled" }]),
      "utf8",
    );
    const suspendCalls: number[] = [];
    const { exec } = makeFakeExec({
      "scripts/clarice-plan-wave.ts": [transientResult(1), transientResult(1)],
    });
    const r = await runEnvioGuard(
      baseDeps(root, { exec, sleep: () => Promise.resolve(), setCampaignStatus: async (_k, id) => { suspendCalls.push(id); } }),
    );
    // #6221 — code 3, NÃO 1: escalada DELIBERADA (o guard fez o certo, não
    // erro duro). `1` poria a unit systemd em `failed`, indistinguível de uma
    // exceção real pro `Diaria-Systemd-Failed-Units-Alarm` (#5942) — é
    // exatamente essa indistinguibilidade que a #6221 corrige.
    assert.equal(r.code, 3, r.reportMarkdown);
    assert.equal(r.reportId, "envio-260812-guard-prereq-fallback-override-vigente");
    assert.equal(suspendCalls.length, 0, "override vigente => NUNCA cancela por precaução");
    assert.match(r.reportMarkdown, /OVERRIDE DO EDITOR vigente/);
    rmSync(root, { recursive: true, force: true });
  });

  it("REGRESSÃO (#6221): escalada deliberada (code 3) permanece DISTINTA de erro duro genuíno (code 1) — lock held continua 1, nunca 3", async () => {
    // Mesma issue que introduziu o code 3 também exige que falha REAL
    // continue pondo a unit em `failed` (ver "Cuidado" no dispatch da
    // #6221) — este teste cobre o caminho de erro duro mais simples (lock
    // detido por outra rodada), que não deve ser afetado pela mudança.
    const root = freshRoot();
    acquireEnvioLock(root, CYCLE, "run-19h-em-curso", new Date(NOW.getTime() - 60_000));
    const { exec } = makeFakeExec({});
    const r = await runEnvioGuard(baseDeps(root, { exec }));
    assert.equal(r.code, 1, r.reportMarkdown);
    assert.notEqual(r.code, 3, "lock held é erro duro genuíno, nunca escalada deliberada");
    rmSync(root, { recursive: true, force: true });
  });

  it("REGRESSÃO (#6134): freio HOLD mas override EXPIRADO => fallback SUSPENDE normalmente (precaução vale de novo)", async () => {
    const root = freshRoot();
    writeBrakeSnapshot(root, "260811", "hold");
    writeOverride(root, "2026-08-11T12:00:00.000Z"); // passado relativo a NOW
    const dir = segmentsDir(root);
    writeFileSync(
      resolve(dir, "group-campaigns.json"),
      JSON.stringify([{ key: "d12-qua12", campaignId: 999, listId: 500, subject: "x", scheduledAt: "2026-08-12T09:00:00.000Z", status: "scheduled" }]),
      "utf8",
    );
    const suspendCalls: number[] = [];
    const { exec } = makeFakeExec({
      "scripts/clarice-plan-wave.ts": [transientResult(1), transientResult(1), transientResult(1)],
    });
    const r = await runEnvioGuard(
      baseDeps(root, { exec, sleep: () => Promise.resolve(), setCampaignStatus: async (_k, id) => { suspendCalls.push(id); } }),
    );
    assert.equal(r.code, 0, r.reportMarkdown);
    assert.equal(r.reportId, "envio-260812-guard-prereq-fallback-cancelou-nao-ok");
    assert.deepEqual(suspendCalls, [999]);
    rmSync(root, { recursive: true, force: true });
  });
});
