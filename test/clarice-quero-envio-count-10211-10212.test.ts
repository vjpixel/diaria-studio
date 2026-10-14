/**
 * #10211 / #10212 — regressão (#633) da contagem de envios do ciclo para a
 * frase do "quero" (#10179/#10189).
 *
 * #10211: onda agendada cujo GET-verify falhou (PUT aceito, status local
 * `draft`) precisa contar como envio — senão a onda seguinte ocupa o mesmo
 * índice 1 e o 2º envio real sai SEM a frase. E a suspensão pelo freio do
 * `clarice-envio-guard` precisa desfazer essa contagem.
 *
 * #10212: no `clarice-novos` com `--content-cycle` ≠ `--cycle` (fallback D3),
 * o índice é contado no ciclo de CONTEÚDO, não no de contatos.
 *
 * Só fixtures/fakes — nunca Brevo real.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyQueroPhrase,
  buildContentEnvioHistory,
  clearScheduleAcceptance,
  envioWentOut,
  hasQueroPhrase,
  resolveEnvioIndex,
  type EnvioHistoryEntry,
} from "../scripts/lib/clarice-quero-phrase.ts";
import { runScheduleLoop } from "../scripts/clarice-schedule-sends.ts";
import { queroHtmlForCampaign } from "../scripts/clarice-reapply-scheduled-html.ts";
import { runEnvioGuard, type EnvioGuardDeps } from "../scripts/clarice-envio-guard.ts";
import type { StepResult, ExecFn } from "../scripts/clarice-envio-run.ts";

const HTML =
  '<p>Apresentação.</p>\n<p>Se você quiser receber essa newsletter com prioridade, responda a este e-mail dizendo &quot;quero&quot;. Resto.</p>';

describe("#10211 — agendamento aceito com GET-verify falho conta como envio", () => {
  it("runScheduleLoop grava scheduleAcceptedAt antes do GET-verify; a onda seguinte é o envio 2 (com a frase)", async () => {
    const campaigns = [
      { key: "d1-sab03-A", campaignId: 11, listId: 1, subject: "s", scheduledAt: "2026-10-17T12:00:00.000Z", status: "draft" as const },
    ];
    const writes: string[] = [];
    await runScheduleLoop(campaigns, new Set(["d1-sab03-A"]), "/fake/campaigns.json", {
      putFn: async () => {},
      verifyFn: async () => {
        throw new Error("GET-verify: timeout");
      },
      writeFn: (_p, c) => writes.push(c),
      logFn: () => {},
      now: () => new Date("2026-10-14T12:00:00.000Z"),
      allowImminent: true,
    });

    assert.equal(campaigns[0].status, "draft", "GET-verify falho não promove o status");
    const persisted = JSON.parse(writes.at(-1) ?? "[]") as EnvioHistoryEntry[];
    assert.equal(persisted[0].scheduleAcceptedAt, "2026-10-14T12:00:00.000Z", "marcador persistido em disco");

    // Cenário real da issue: no dia seguinte a d2 é criada.
    assert.equal(resolveEnvioIndex(persisted, "d2-dom04-A"), 2, "d1 (na fila da Brevo) é o envio 1");
    assert.equal(hasQueroPhrase(applyQueroPhrase(HTML, resolveEnvioIndex(persisted, "d2-dom04-A")).html), true);
    assert.equal(resolveEnvioIndex(persisted, "d1-sab03-B"), 1, "outra célula da mesma onda mantém o índice 1");
  });

  it("PUT recusado não grava o marcador (a campanha nunca entrou na fila)", async () => {
    const campaigns = [
      { key: "d1-sab03-A", campaignId: 11, listId: 1, subject: "s", scheduledAt: "2026-10-17T12:00:00.000Z", status: "draft" as const },
    ];
    await assert.rejects(
      runScheduleLoop(campaigns, new Set(["d1-sab03-A"]), "/fake/campaigns.json", {
        putFn: async () => {
          throw new Error("Brevo 400");
        },
        verifyFn: async () => ({ status: "queued" }),
        writeFn: () => {},
        logFn: () => {},
        now: () => new Date("2026-10-14T12:00:00.000Z"),
        allowImminent: true,
      }),
    );
    assert.equal((campaigns[0] as EnvioHistoryEntry).scheduleAcceptedAt, undefined);
    assert.equal(resolveEnvioIndex(campaigns, "d2-dom04-A"), 1);
  });

  it("envioWentOut: scheduleAcceptedAt conta; vazio não", () => {
    assert.equal(envioWentOut({ key: "a", status: "draft", scheduleAcceptedAt: "2026-10-14T12:00:00Z" }), true);
    assert.equal(envioWentOut({ key: "a", status: "draft", scheduleAcceptedAt: "" }), false);
  });

  it("clearScheduleAcceptance (suspensão) devolve a onda a 'nunca saiu'", () => {
    const e: EnvioHistoryEntry & { status: string } = { key: "d1-sab03-A", status: "scheduled", scheduleAcceptedAt: "2026-10-14T12:00:00Z" };
    clearScheduleAcceptance(e);
    assert.equal(e.status, "draft");
    assert.equal(e.scheduleAcceptedAt, undefined);
    assert.equal(resolveEnvioIndex([e], "d2-dom04-A"), 1);
  });
});

describe("#10211 — clarice-envio-guard: suspensão tira o marcador do registro local", () => {
  let savedApiKey: string | undefined;
  before(() => {
    savedApiKey = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_CLARICE_API_KEY = "test-key";
  });
  after(() => {
    if (savedApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = savedApiKey;
  });

  it("freio STOP suspende a onda agendada → status draft SEM scheduleAcceptedAt", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarice-quero-10211-"));
    try {
      const dir = resolve(root, "data", "clarice-subscribers", "2607-08", "segments");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, "group-campaigns.json"),
        JSON.stringify([
          {
            key: "d12-qua12",
            campaignId: 999,
            listId: 500,
            subject: "x",
            status: "draft",
            scheduledAt: "2026-08-12T09:00:00.000Z",
            scheduleAcceptedAt: "2026-08-11T20:00:00.000Z",
          },
        ]),
        "utf8",
      );
      const json = (obj: unknown): StepResult => ({ code: 0, stdout: JSON.stringify(obj), stderr: "" });
      const exec: ExecFn = (script) => {
        if (script === "scripts/clarice-plan-wave.ts") {
          return json({
            state: {
              waves: [{ key: "d12-qua12", listId: 1, subject: "x", status: "scheduled", scheduledAt: "2026-08-12T09:00:00.000Z", volume: 100 }],
            },
          });
        }
        if (script === "scripts/clarice-envio-risk.ts") return json({ brake: { level: "stop", reasons: ["bounce"], maxUtil: 1.3 } });
        throw new Error(`exec inesperado: ${script}`);
      };
      const suspended: number[] = [];
      const deps: EnvioGuardDeps = {
        rootDir: root,
        now: () => new Date("2026-08-12T08:00:00.000Z"),
        exec,
        isEnabled: () => true,
        execMode: () => "local",
        sleep: async () => {},
        setCampaignStatus: async (_k, id) => {
          suspended.push(id);
        },
      };
      const r = await runEnvioGuard(deps);
      assert.equal(r.code, 0);
      assert.deepEqual(suspended, [999]);
      const updated = JSON.parse(readFileSync(resolve(dir, "group-campaigns.json"), "utf8"));
      assert.equal(updated[0].status, "draft");
      assert.equal("scheduleAcceptedAt" in updated[0], false, "suspensa não conta mais como envio do ciclo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#10212 — índice contado no ciclo de CONTEÚDO", () => {
  // Conteúdo X = 2608-09 (já saiu 3 vezes); contatos Y = 2609-10 (ainda sem conteúdo próprio pronto).
  const X = "2608-09";
  const Y = "2609-10";
  const X_HISTORY: EnvioHistoryEntry[] = [
    { key: "d1-sab29-A", status: "sent" },
    { key: "d2-dom30-A", status: "sent" },
    { key: "d3-seg31", status: "sent" },
  ];

  it("novos de fallback D3 (conteúdo X, contatos Y) herda a posição do conteúdo X → com a frase", () => {
    const history = buildContentEnvioHistory({ segmentsCycle: Y, contentCycle: X, segmentsHistory: [], contentCycleHistory: X_HISTORY });
    const idx = resolveEnvioIndex(history, "novos-261002");
    assert.equal(idx, 4, "antes do #10212 era 1 (contado no histórico vazio de Y) e tirava a frase");
    assert.equal(hasQueroPhrase(applyQueroPhrase(HTML, idx).html), true);
  });

  it("1º envio real do conteúdo Y ignora o novos que levou o conteúdo X → sem a frase", () => {
    const yHistory: EnvioHistoryEntry[] = [
      { key: "novos-261002", status: "sent", contentCycle: X },
      { key: "novos-261003", status: "sent", contentCycle: X },
    ];
    const history = buildContentEnvioHistory({ segmentsCycle: Y, contentCycle: Y, segmentsHistory: yHistory });
    const idx = resolveEnvioIndex(history, "d1-sab10-A");
    assert.equal(idx, 1, "antes do #10212 era 3 e o 1º envio do conteúdo Y saía com a frase");
    assert.equal(hasQueroPhrase(applyQueroPhrase(HTML, idx).html), false);
  });

  it("2º novos de fallback conta o 1º (registrado em Y com contentCycle X)", () => {
    const yHistory: EnvioHistoryEntry[] = [{ key: "novos-261002", status: "sent", contentCycle: X }];
    const history = buildContentEnvioHistory({ segmentsCycle: Y, contentCycle: X, segmentsHistory: yHistory, contentCycleHistory: [] });
    assert.equal(resolveEnvioIndex(history, "novos-261003"), 2);
    assert.equal(resolveEnvioIndex(history, "novos-261002"), 1, "re-execução da mesma onda mantém o índice");
  });

  it("key do ciclo de conteúdo nunca colide com a key do ciclo de contatos", () => {
    const history = buildContentEnvioHistory({
      segmentsCycle: Y,
      contentCycle: X,
      segmentsHistory: [],
      contentCycleHistory: [{ key: "novos-261002", status: "sent" }],
    });
    assert.equal(resolveEnvioIndex(history, "novos-261002"), 2, "a onda homônima do ciclo X é outro envio");
  });

  it("mesmo ciclo nos dois papéis (clarice-envio-run): comportamento do #10189 preservado", () => {
    const own: EnvioHistoryEntry[] = [
      { key: "novos-261001", status: "draft" },
      { key: "d1-sab03-A", status: "sent" },
    ];
    const history = buildContentEnvioHistory({ segmentsCycle: Y, contentCycle: Y, segmentsHistory: own, contentCycleHistory: X_HISTORY });
    assert.equal(resolveEnvioIndex(history, "d2-dom04-A"), 2, "contentCycleHistory é ignorado quando os ciclos coincidem");
  });

  it("reapply: novos de outro conteúdo registrado no ciclo não empurra o 1º envio agendado", () => {
    const r = queroHtmlForCampaign(HTML, "Clarice 2609 grupo:d1-sab10-A", Y, [
      { key: "novos-261002", status: "sent", contentCycle: X },
      { key: "d1-sab10-A", status: "scheduled" },
    ]);
    assert.equal(hasQueroPhrase(r.html), false);
  });
});
