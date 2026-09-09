/**
 * test/clarice-plan-wave-7738.test.ts (#7738)
 *
 * Regressão pro achado ao vivo de 2026-09-09/10: `queueAvailable` em
 * `clarice-envio-run.ts` vinha de `proposal.availableFirstSend`, que conta
 * SÓ quem nunca recebeu email na vida (`sends_count<=0`) — sub-representa a
 * capacidade real da fila diária unificada (`buildDailySendQueue`,
 * `clarice-segment.ts` #7406), que inclui também engajados de ciclos
 * anteriores (`priority_points>0`, qualquer `sends_count`).
 *
 * A 1ª tentativa de correção (PR #7804, commit f0d08fa) adicionou
 * `computeDailyQueueAvailable` em `clarice-segment.ts` mas nunca a chamou de
 * `clarice-plan-wave.ts` — `clarice-envio-run.ts` lia
 * `(proposal as any).availableDailyQueue`, campo que `buildWaveProposal`
 * nunca populava; o `?? proposal.availableFirstSend` sempre vencia e o bug
 * original persistia em produção apesar do teste unitário de
 * `computeDailyQueueAvailable` (isolado, sem chamador real) estar verde.
 *
 * Este teste chama `planWave()` de ponta a ponta (mesmo padrão de
 * `test/clarice-plan-wave-5395.test.ts`) com um contato ENGAJADO
 * (`sends_count>0`, `priority_points>0`) que `availableFirstSend` NUNCA
 * conta (não é 1º envio) mas que a fila diária unificada deve contar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { planWave } from "../scripts/clarice-plan-wave.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";
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

describe("planWave(): availableDailyQueue conta engajados de ciclo anterior que availableFirstSend nunca conta (#7738)", () => {
  it("contato com sends_count>0 e priority_points>0 entra em availableDailyQueue mas fica fora de availableFirstSend", async () => {
    const cycle = "2608-09";
    const dir = mkdtempSync(resolve(tmpdir(), "cpw-7738-"));
    const dbPath = resolve(dir, "clarice.db");

    const db = openClariceDb(dbPath);
    // engajado: já recebeu email antes (sends_count>0), score positivo — fila
    // diária unificada conta, mas availableFirstSend (FIRST_SEND_FILTER
    // exige sends_count<=0) nunca conta.
    db.prepare(
      "INSERT INTO clarice_users (email, tier, cohort, sends_count, priority_points, mv_bucket, send_eligible) VALUES ('engajado@x.com', 1, 'assinantes-ativos', 3, 20, NULL, 1)",
    ).run();
    // ramp-warm: nunca recebeu, verified — conta nos dois.
    db.prepare(
      "INSERT INTO clarice_users (email, tier, cohort, sends_count, priority_points, mv_bucket, send_eligible) VALUES ('fresh@x.com', 8, 'leads-2023h2', 0, 0, 'verified', 1)",
    ).run();
    db.close();

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
    process.env.BREVO_CLARICE_API_KEY = "fake-key-teste-7738";
    try {
      const proposal = await planWave({
        cycle,
        dates: ["2026-09-01"],
        dbPath,
        dashboardUrl: "https://fake-dashboard.example",
        lockedSubject: "assunto travado",
        novosStateBaseDir: "/tmp/clarice-novos-state-inexistente-7738",
        segmentsBaseDir: dir,
        fetchImpl: fetchImplDashboard,
      });

      assert.equal(
        proposal.availableFirstSend,
        1,
        `esperado 1 (só "fresh@x.com" — "engajado@x.com" já recebeu antes), veio ${proposal.availableFirstSend}`,
      );
      assert.equal(
        proposal.availableDailyQueue,
        2,
        `esperado 2 (fila diária unificada inclui engajado+ramp-warm), veio ${proposal.availableDailyQueue}`,
      );
    } finally {
      globalThis.fetch = origFetch;
      if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
      else process.env.BREVO_CLARICE_API_KEY = origApiKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
