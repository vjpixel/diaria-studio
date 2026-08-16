/**
 * test/clarice-plan-wave-5395.test.ts (#5395)
 *
 * Regressão pro achado ao vivo de 260816: `availableFirstSend` (plan-wave)
 * e a fila REAL (`clarice-build-segment.ts --group ramp-warm`) usavam guards
 * diferentes — o plan-wave só excluía quem estava COMMITTED numa campanha
 * Brevo queued/sent (`excludeCommittedToQueuedCampaigns`), sem aplicar o
 * guard cycle-wide `sent-or-queued.json` (#3227/#4759) que a fila real já
 * aplicava. Um contato selecionado por uma invocação anterior do ciclo (ex:
 * lista Brevo cuja campanha foi depois suspensa/replanejada, nunca virando
 * queued/sent) ficava no pior dos mundos: já rastreado como
 * enviado/reservado em `sent-or-queued.json`, mas ainda contado como
 * DISPONÍVEL por `availableFirstSend` — inflando a fila que
 * `clarice-envio-run.ts` usa pra decidir o volume da onda.
 *
 * Este teste chama `planWave()` de ponta a ponta (mesmo padrão de
 * `test/brevo-draft-campaigns-5064.test.ts`: fetch global mockado pra Brevo
 * direta + `fetchImpl` mockado pro dashboard + SQLite REAL em arquivo
 * temporário — não `:memory:`, porque cada `openClariceDb(":memory:")` cria
 * um banco NOVO e vazio, e este teste precisa que as linhas inseridas
 * sobrevivam até `planWave()` abrir o banco internamente).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { planWave } from "../scripts/clarice-plan-wave.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";
import { appendSentOrQueuedEmails } from "../scripts/clarice-build-segment.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

function jsonResponseWithStatus(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: () => "application/json" },
  } as unknown as Response);
}

/** Mesmo shape de `maturedSentCampaign` em test/brevo-draft-campaigns-5064.test.ts
 *  (não importado — local ao arquivo de teste lá) — só o mínimo pra
 *  `proposeVolumes` conseguir derivar um volume-base (>48h maduro). */
function maturedSentCampaign(id: number, name: string, sentDate: string, listId: number, sent: number): BrevoCampaign {
  return {
    id,
    name,
    subject: "assunto travado",
    status: "sent",
    sentDate,
    scheduledAt: null,
    createdAt: sentDate,
    recipients: { lists: [listId] },
    statistics: {
      globalStats: {
        sent,
        delivered: sent,
        hardBounces: 0,
        softBounces: 0,
        uniqueViews: Math.round(sent * 0.25),
        viewed: Math.round(sent * 0.25),
        trackableViews: sent,
        uniqueClicks: Math.round(sent * 0.05),
        clickers: Math.round(sent * 0.05),
        unsubscriptions: 0,
        complaints: 0,
        appleMppOpens: 0,
      },
    },
  } as BrevoCampaign;
}

describe("planWave(): availableFirstSend aplica o MESMO guard sent-or-queued.json que a fila real (#5395)", () => {
  it("contato em sent-or-queued.json (e fora de campanha queued/sent) NÃO é contado como disponível", async () => {
    const cycle = "2608-09";
    const dir = mkdtempSync(resolve(tmpdir(), "cpw-5395-"));
    const dbPath = resolve(dir, "clarice.db");

    const db = openClariceDb(dbPath);
    // órfão: elegível pra ramp-warm (1º envio, verified), mas já rastreado
    // como enviado/reservado em sent-or-queued.json por uma invocação
    // anterior do ciclo (ex: lista 117/129 replanejada, #5395 achado real).
    db.prepare(
      "INSERT INTO clarice_users (email, tier, cohort, sends_count, mv_bucket) VALUES ('orphan@x.com', 8, 'leads-2023h2', 0, 'verified')",
    ).run();
    // controle: mesma elegibilidade, mas NUNCA selecionado antes — precisa
    // continuar contando como disponível (o fix não pode zerar a fila toda).
    db.prepare(
      "INSERT INTO clarice_users (email, tier, cohort, sends_count, mv_bucket) VALUES ('fresh@x.com', 8, 'leads-2023h2', 0, 'verified')",
    ).run();
    db.close();

    const segDir = clariceSegmentsDir(cycle, dir);
    appendSentOrQueuedEmails(segDir, cycle, "replan-260809-controle", ["orphan@x.com"]);

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/v3/account")) {
        return jsonResponseWithStatus({ plan: [{ type: "free", credits: 100000, creditsType: "sendLimit" }] });
      }
      if (u.includes("/v3/emailCampaigns?status=draft")) return jsonResponseWithStatus({ campaigns: [] });
      if (u.includes("/v3/emailCampaigns?status=queued")) return jsonResponseWithStatus({ campaigns: [] });
      if (u.includes("/v3/emailCampaigns?status=sent")) return jsonResponseWithStatus({ campaigns: [] });
      if (u.includes("/contacts/lists/777")) {
        return jsonResponseWithStatus({ name: `Clarice ${cycle} grupo:d5-seg10`, totalSubscribers: 1000 });
      }
      if (u.includes("/api/postmaster-spam")) return jsonResponseWithStatus({}, 404);
      throw new Error(`chamada Brevo inesperada neste teste: ${u}`);
    }) as unknown as typeof fetch;

    const realNow = new Date();
    const maturedSentDate = new Date(realNow.getTime() - 72 * 60 * 60 * 1000).toISOString();
    const maturedSent = maturedSentCampaign(501, `Clarice ${cycle} grupo:d5-seg10`, maturedSentDate, 777, 1000);

    const fetchImplDashboard = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/campaigns")) return jsonResponseWithStatus([maturedSent]);
      throw new Error(`chamada inesperada no fetchImpl do dashboard: ${u}`);
    }) as unknown as typeof fetch;

    const origApiKey = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_CLARICE_API_KEY = "fake-key-teste-5395";
    try {
      const proposal = await planWave({
        cycle,
        dates: ["2026-09-01"],
        dbPath,
        dashboardUrl: "https://fake-dashboard.example",
        lockedSubject: "assunto travado",
        novosStateBaseDir: "/tmp/clarice-novos-state-inexistente-5395",
        segmentsBaseDir: dir,
        fetchImpl: fetchImplDashboard,
      });

      assert.equal(
        proposal.availableFirstSend,
        1,
        `esperado 1 (só "fresh@x.com" — "orphan@x.com" já está em sent-or-queued.json), veio ${proposal.availableFirstSend}`,
      );
    } finally {
      globalThis.fetch = origFetch;
      if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
      else process.env.BREVO_CLARICE_API_KEY = origApiKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
