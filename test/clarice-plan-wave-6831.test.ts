/**
 * test/clarice-plan-wave-6831.test.ts (#6831)
 *
 * Cobre `committedLookupRetryAfterSecs` em `planWave()` — o campo ADITIVO
 * que permite `clarice-envio-run.ts` distinguir "consulta de campanhas
 * comprometidas falhou por RATE LIMIT real da Brevo" (retryable com
 * orçamento maior) de "falhou por outro motivo" (rede, 401, chave ausente —
 * NUNCA retryable). `planWave()` NUNCA lança por causa disto — ver
 * docstring do campo em `scripts/lib/clarice-wave-plan.ts`.
 *
 * Mesmo padrão de harness de `test/clarice-plan-wave-5395.test.ts`: fetch
 * global mockado pra Brevo direta + `fetchImpl` mockado pro dashboard +
 * SQLite real em arquivo temporário.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { planWave } from "../scripts/clarice-plan-wave.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

function jsonResponseWithStatus(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
  } as unknown as Response);
}

/** Mesmo shape mínimo de `maturedSentCampaign` em test/clarice-plan-wave-5395.test.ts
 *  — só o suficiente pra `proposeVolumes` conseguir derivar um volume-base (>48h maduro). */
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

async function setupAndRun(opts: {
  brevoGetHandler: (url: string) => Promise<Response>;
}): Promise<{ proposal: Awaited<ReturnType<typeof planWave>> }> {
  const cycle = "2608-09";
  const dir = mkdtempSync(resolve(tmpdir(), "cpw-6831-"));
  const dbPath = resolve(dir, "clarice.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, tier, cohort, sends_count, mv_bucket) VALUES ('a@x.com', 8, 'leads-2023h2', 0, 'verified')",
  ).run();
  db.close();

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/emailCampaigns")) return opts.brevoGetHandler(u);
    if (u.includes("/v3/account")) {
      return jsonResponseWithStatus({ plan: [{ type: "free", credits: 100000, creditsType: "sendLimit" }] });
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
  process.env.BREVO_CLARICE_API_KEY = "fake-key-teste-6831";
  try {
    const proposal = await planWave({
      cycle,
      dates: ["2026-09-03"],
      dbPath,
      dashboardUrl: "https://fake-dashboard.example",
      lockedSubject: "assunto travado",
      novosStateBaseDir: "/tmp/clarice-novos-state-inexistente-6831",
      segmentsBaseDir: dir,
      fetchImpl: fetchImplDashboard,
    });
    return { proposal };
  } finally {
    globalThis.fetch = origFetch;
    if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origApiKey;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("planWave(): committedLookupRetryAfterSecs (#6831)", () => {
  it("429 com Retry-After GRANDE (excede o orçamento de 30s do withBrevo429Retry interno) -> committedLookupFailed=true, retryAfterSecs extraído, NUNCA lança", async () => {
    const { proposal } = await setupAndRun({
      brevoGetHandler: async (u) => jsonResponseWithStatus({ message: "too many requests" }, 429, { "retry-after": "3570" }),
    });
    assert.equal(proposal.committedLookupFailed, true);
    assert.equal(proposal.committedLookupRetryAfterSecs, 3570);
    assert.ok(proposal.committedLookupError?.includes("3570"), proposal.committedLookupError ?? "");
  });

  it("falha NÃO-rate-limit (401) -> committedLookupFailed=true, retryAfterSecs null (nunca inventa um valor)", async () => {
    const { proposal } = await setupAndRun({
      brevoGetHandler: async () => jsonResponseWithStatus({ message: "unauthorized" }, 401),
    });
    assert.equal(proposal.committedLookupFailed, true);
    assert.equal(proposal.committedLookupRetryAfterSecs, null);
  });

  it("sucesso -> committedLookupFailed=false, retryAfterSecs null", async () => {
    const { proposal } = await setupAndRun({
      brevoGetHandler: async () => jsonResponseWithStatus({ campaigns: [] }),
    });
    assert.equal(proposal.committedLookupFailed, false);
    assert.equal(proposal.committedLookupRetryAfterSecs, null);
  });

  // A variante "esgota as 3 tentativas internas do brevoGet, sem header
  // Retry-After" também produz retryAfterSecs:null (mesmo branch acima) mas
  // não tem cobertura DEDICADA aqui: `brevoGet`/`fetchCommittedCampaignListIds`
  // não expõem `_sleep` injetável nesse caminho (só `brevoGet` recebe o
  // parâmetro; `fetchCampaignListIdsByStatus` nunca o repassa), e reproduzir
  // via `planWave()` esperaria ~13s reais (RETRY_MS = [1s,3s,9s]). A
  // combinatória relevante (retryAfterSecs presente-e-grande vs. ausente) já
  // está coberta a um nível abaixo por `test/brevo-committed-campaigns-3682.test.ts`/
  // `test/brevo-get-retry.test.ts` (que injetam `_sleep`); este arquivo cobre
  // só a WIRING nova (o campo aditivo em `WaveProposal`), não reprova o
  // retry em si.
});
