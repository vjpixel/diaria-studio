/**
 * test/clarice-schedule-group-10271.test.ts (#10271) — regressão (#633).
 *
 * Defeito 1: a guarda do `--update-html` de `clarice-schedule-group.ts` olhava
 * só `status === "scheduled" | "sent"`. Uma entrada `draft` com
 * `scheduleAcceptedAt` (#10211 — PUT aceito, GET-verify falho, campanha na
 * fila da Brevo) ou `sendNowAcceptedAt` passava: o script fazia PUT de
 * `htmlContent` numa campanha já na fila e reescrevia `envioIndex`/
 * `queroIncluded`. Fix: guarda é `envioWentOut(c)` (`runUpdateHtml`).
 *
 * Defeito 2: o teste do #10211 exercitava `runScheduleLoop` de
 * `clarice-schedule-sends.ts` (grava `campaigns-summary.json`), não o call site
 * de `clarice-schedule-group.ts` que persiste em `group-campaigns.json` — o
 * arquivo que a contagem de envios lê. Aqui o caminho `--schedule` do group
 * (`runScheduleLive`) roda com GET-verify falho contra um
 * `group-campaigns.json` REAL em diretório temporário, relido pelo mesmo
 * leitor (`readGroupCampaigns`) e pela mesma contagem (`resolveEnvioIndex`)
 * que o `--create` da onda seguinte usa.
 *
 * Só fakes — nenhuma chamada à Brevo.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readGroupCampaigns,
  runScheduleLive,
  runUpdateHtml,
  type CampaignEntry,
} from "../scripts/clarice-schedule-group.ts";
import { resolveEnvioIndex } from "../scripts/lib/clarice-quero-phrase.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "clarice-10271-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCampaigns(name: string, campaigns: CampaignEntry[]): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(campaigns, null, 2));
  return p;
}

describe("#10271 — --schedule do group grava scheduleAcceptedAt no group-campaigns.json", () => {
  it("GET-verify falho: status fica draft, scheduleAcceptedAt persiste e a onda seguinte é o envio 2", async () => {
    const campaigns: CampaignEntry[] = [
      { key: "d1-sab03-A", campaignId: 11, listId: 1, subject: "s", scheduledAt: "2026-10-17T09:00:00.000Z", status: "draft" },
    ];
    const path = writeCampaigns("schedule-group-campaigns.json", campaigns);
    const events: string[] = [];

    await runScheduleLive(campaigns[0] as CampaignEntry & { scheduledAt: string }, campaigns, path, {
      putScheduleFn: async (id, at) => {
        events.push(`put:${id}:${at}`);
      },
      verifyFn: async () => {
        events.push("verify");
        throw new Error("GET-verify: timeout");
      },
      logFn: () => {},
      now: () => new Date("2026-10-14T12:00:00.000Z"),
    });

    assert.deepEqual(events, ["put:11:2026-10-17T09:00:00.000Z", "verify"]);
    const onDisk = readGroupCampaigns(path);
    assert.equal(onDisk[0].status, "draft", "GET-verify falho não promove o status");
    assert.equal(onDisk[0].scheduleAcceptedAt, "2026-10-14T12:00:00.000Z", "marcador gravado em group-campaigns.json");
    // A contagem usada pelo --create da onda seguinte lê ESTE arquivo.
    assert.equal(resolveEnvioIndex(onDisk, "d2-dom04-A"), 2, "d1 (na fila da Brevo) conta como envio 1");
  });

  it("PUT recusado: nada é marcado (a campanha não entrou na fila)", async () => {
    const campaigns: CampaignEntry[] = [
      { key: "d1-sab03-A", campaignId: 12, listId: 1, subject: "s", scheduledAt: "2026-10-17T09:00:00.000Z", status: "draft" },
    ];
    const path = writeCampaigns("schedule-put-fail.json", campaigns);
    await assert.rejects(
      runScheduleLive(campaigns[0] as CampaignEntry & { scheduledAt: string }, campaigns, path, {
        putScheduleFn: async () => {
          throw new Error("Brevo 500");
        },
        verifyFn: async () => ({ status: "scheduled" }),
        logFn: () => {},
      }),
      /Brevo 500/,
    );
    assert.equal(readGroupCampaigns(path)[0].scheduleAcceptedAt, undefined);
    assert.equal(resolveEnvioIndex(readGroupCampaigns(path), "d2-dom04-A"), 1);
  });

  it("GET-verify ok: status scheduled + marcador", async () => {
    const campaigns: CampaignEntry[] = [
      { key: "d1-sab03-A", campaignId: 13, listId: 1, subject: "s", scheduledAt: "2026-10-17T09:00:00.000Z", status: "draft" },
    ];
    const path = writeCampaigns("schedule-ok.json", campaigns);
    await runScheduleLive(campaigns[0] as CampaignEntry & { scheduledAt: string }, campaigns, path, {
      putScheduleFn: async () => {},
      verifyFn: async () => ({ status: "queued" }),
      logFn: () => {},
      now: () => new Date("2026-10-14T12:00:00.000Z"),
    });
    const onDisk = readGroupCampaigns(path);
    assert.equal(onDisk[0].status, "scheduled");
    assert.equal(onDisk[0].scheduleAcceptedAt, "2026-10-14T12:00:00.000Z");
  });
});

describe("#10271 — --update-html recusa campanha que já saiu (envioWentOut)", () => {
  const base: CampaignEntry = {
    key: "d1-sab03-A",
    campaignId: 21,
    listId: 1,
    subject: "s",
    scheduledAt: "2026-10-17T09:00:00.000Z",
    status: "draft",
    envioIndex: 1,
    queroIncluded: true,
  };
  const cases: Array<[string, Partial<CampaignEntry>]> = [
    ["draft com scheduleAcceptedAt (#10211 — GET-verify falho)", { scheduleAcceptedAt: "2026-10-14T12:00:00.000Z" }],
    ["draft com sendNowAcceptedAt (#9638)", { sendNowAcceptedAt: "2026-10-14T12:00:00.000Z" }],
    ["scheduled", { status: "scheduled" }],
    ["sent", { status: "sent" }],
  ];
  for (const [label, patch] of cases) {
    it(`${label}: sem PUT e envioIndex/queroIncluded intocados`, async () => {
      const c: CampaignEntry = { ...base, ...patch };
      const campaigns = [c];
      const path = writeCampaigns(`update-skip-${c.campaignId}-${label.length}.json`, campaigns);
      const puts: number[] = [];
      const logs: string[] = [];
      const r = await runUpdateHtml(c, campaigns, path, "<p>novo</p>", { envioIndex: 2, included: false }, {
        putHtmlFn: async (id) => {
          puts.push(id);
        },
        logFn: (m) => logs.push(m),
      });
      assert.equal(r, "skipped");
      assert.deepEqual(puts, [], "nenhum PUT de htmlContent");
      assert.equal(c.envioIndex, 1);
      assert.equal(c.queroIncluded, true);
      const onDisk = readGroupCampaigns(path)[0];
      assert.equal(onDisk.envioIndex, 1, "registro em disco descreve o que foi pra Brevo");
      assert.equal(onDisk.queroIncluded, true);
      assert.match(logs.join("\n"), /html NÃO atualizado/);
    });
  }

  it("draft sem marcador: PUT + envioIndex/queroIncluded regravados", async () => {
    const c: CampaignEntry = { ...base };
    const campaigns = [c];
    const path = writeCampaigns("update-ok.json", campaigns);
    const puts: Array<[number, string]> = [];
    const r = await runUpdateHtml(c, campaigns, path, "<p>novo</p>", { envioIndex: 2, included: false }, {
      putHtmlFn: async (id, h) => {
        puts.push([id, h]);
      },
      logFn: () => {},
    });
    assert.equal(r, "updated");
    assert.deepEqual(puts, [[21, "<p>novo</p>"]]);
    const onDisk = readGroupCampaigns(path)[0];
    assert.equal(onDisk.envioIndex, 2);
    assert.equal(onDisk.queroIncluded, false);
  });
});
