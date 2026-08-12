/**
 * test/brevo-draft-campaigns-5064.test.ts (#5064)
 *
 * `detectExistingWaveForSendDate` (clarice-envio-run.ts, #5058) só enxergava
 * onda `queued`/`sent` — uma onda PARCIALMENTE MONTADA (`--create` rodou,
 * `--schedule` falhou/não rodou ainda) fica invisível, porque o dashboard
 * (`/api/campaigns?includeScheduled=1`) nunca devolve `draft` (ver
 * `buildCampaignsResponse` no Worker). Fecha o guard consultando a Brevo
 * DIRETO (a key já está disponível localmente) — sem precisar de endpoint
 * novo no Worker `brevo-dashboard`.
 *
 * Cobertura:
 *  - fetchDraftCampaigns: paginação + filtro status=draft + objeto completo
 *    (name/recipients/status), ao contrário de fetchQueuedCampaignListIds/
 *    fetchSentCampaignListIds (que só devolvem list ids).
 *  - Integração ponta-a-ponta (self-review PR #5092, finding de confiança
 *    MÉDIA): as suítes de `test/clarice-wave-plan.test.ts`/
 *    `test/clarice-envio-run.test.ts` cobrem as peças puras isoladas
 *    (`fetchDraftCampaigns`, `mergeCampaignSources`, `waveDateFragment`,
 *    `detectExistingWaveForSendDate`) e o guard consumindo um `WaveProposal`
 *    MONTADO À MÃO — nunca `planWave()` de verdade. O describe abaixo chama
 *    `planWave()` de ponta a ponta (fetch do dashboard mockado via
 *    `fetchImpl` + fetch global mockado pra Brevo direta — lists/account/
 *    committed/draft/postmaster + SQLite `:memory:`) e alimenta o resultado
 *    real no guard, reproduzindo o cenário do incidente original: uma
 *    rodada anterior rodou `--create` (draft na Brevo, sem `--schedule`), e
 *    uma 2ª rodada não deveria montar uma 2ª onda pro mesmo `sendDate`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchDraftCampaigns } from "../scripts/lib/brevo-client.ts";
import { planWave } from "../scripts/clarice-plan-wave.ts";
import { detectExistingWaveForSendDate } from "../scripts/clarice-envio-run.ts";
import { waveKey } from "../scripts/lib/clarice-wave-plan.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

function makeJsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: () => "application/json" },
  } as unknown as Response);
}

describe("fetchDraftCampaigns (#5064)", () => {
  it("filtra status=draft e devolve objetos completos (name/recipients/status), paginado", async () => {
    const orig = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const urlStr = String(url);
      calls.push(urlStr);
      assert.ok(urlStr.includes("status=draft"), `toda chamada deve filtrar status=draft: ${urlStr}`);
      if (urlStr.includes("offset=0")) {
        const campaigns = Array.from({ length: 50 }, (_, i) => ({
          id: i,
          name: `Clarice 2607 grupo:d${i}-qui06`,
          status: "draft",
          recipients: { lists: [500 + i] },
        }));
        return makeJsonResponse({ campaigns });
      }
      return makeJsonResponse({
        campaigns: [{ id: 999, name: "Clarice 2607 grupo:d12-qua12", status: "draft", recipients: { lists: [900] } }],
      });
    }) as unknown as typeof fetch;
    try {
      const drafts = await fetchDraftCampaigns("fake-key");
      assert.equal(drafts.length, 51, "deve paginar até a página incompleta");
      assert.equal(calls.length, 2);
      assert.equal(drafts[50].name, "Clarice 2607 grupo:d12-qua12");
      assert.deepEqual(drafts[0].recipients, { lists: [500] });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("nenhuma campanha em draft => array vazio, 1 única chamada", async () => {
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return makeJsonResponse({ campaigns: [] });
    }) as unknown as typeof fetch;
    try {
      const drafts = await fetchDraftCampaigns("fake-key");
      assert.deepEqual(drafts, []);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("campanha sem recipients não quebra (undefined preservado, não crasha)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      makeJsonResponse({ campaigns: [{ id: 1, name: "Clarice 2607 grupo:novos", status: "draft" }] })) as unknown as typeof fetch;
    try {
      const drafts = await fetchDraftCampaigns("fake-key");
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].recipients, undefined);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// Integração ponta-a-ponta: planWave() real → detectExistingWaveForSendDate
// (self-review PR #5092, finding de confiança MÉDIA)
// ---------------------------------------------------------------------------

function jsonResponseWithStatus(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: () => "application/json" },
  } as unknown as Response);
}

/** Mesmo shape de `sentCampaign` em test/clarice-wave-plan.test.ts — copiado
 *  aqui (não importado) porque é local ao arquivo de teste, não exportado. */
function maturedSentCampaign(
  id: number,
  name: string,
  sentDate: string,
  listId: number,
  sent: number,
): BrevoCampaign {
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

describe("planWave() → detectExistingWaveForSendDate: wiring ponta-a-ponta (#5064, self-review PR #5092)", () => {
  it("onda draft (--create rodou, --schedule não) pro sendDate de amanhã É detectada pelo guard — não monta 2ª onda", async () => {
    // `planWave()` NÃO aceita `now` injetável (usa `new Date()` real — gap de
    // testabilidade pré-existente, fora do escopo deste teste) — as datas
    // abaixo são derivadas do relógio REAL da máquina que roda o teste, nunca
    // hardcoded, pra que "maduro (>48h)" (`proposeVolumes`) seja verdadeiro
    // não importa quando o CI rodar.
    const cycle = "2607-08";
    const realNow = new Date();
    const sendDate = new Date(realNow.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const maturedSentDate = new Date(realNow.getTime() - 72 * 60 * 60 * 1000).toISOString();
    // Continua a numeração — d5 já enviado (matured sent abaixo é d5).
    const draftKey = waveKey(6, sendDate);

    const maturedSent = maturedSentCampaign(501, `Clarice ${cycle} grupo:d5-seg10`, maturedSentDate, 777, 1000);

    // A onda #5064: --create rodou (campanha criada, status draft, SEM
    // scheduledAt) — nunca aparece no dashboard (`/api/campaigns?includeScheduled=1`
    // só devolve sent/queued), só na Brevo direto via fetchDraftCampaigns.
    const draftCampaignRaw = {
      id: 900,
      name: `Clarice ${cycle} grupo:${draftKey}`,
      subject: "assunto proposto",
      status: "draft",
      sentDate: null,
      scheduledAt: null,
      createdAt: "2026-08-12T08:00:00.000Z",
      recipients: { lists: [888] },
    };

    const brevoCalls: string[] = [];
    const origFetch = globalThis.fetch;
    // Fetch GLOBAL — tudo que `planWave` chama SEM passar por `fetchImpl`:
    // brevoGet (lists/account/committed/draft) e fetchPostmasterSpamEntry
    // (que recebe `fetch` global explicitamente, não `opts.fetchImpl`).
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      brevoCalls.push(u);
      if (u.includes("/v3/account")) {
        return jsonResponseWithStatus({ plan: [{ type: "free", credits: 100000, creditsType: "sendLimit" }] });
      }
      if (u.includes("/v3/emailCampaigns?status=draft")) {
        return jsonResponseWithStatus({ campaigns: u.includes("offset=0") ? [draftCampaignRaw] : [] });
      }
      if (u.includes("/v3/emailCampaigns?status=queued")) {
        return jsonResponseWithStatus({ campaigns: [] });
      }
      if (u.includes("/v3/emailCampaigns?status=sent")) {
        return jsonResponseWithStatus({ campaigns: [] });
      }
      if (u.includes("/contacts/lists/777")) {
        return jsonResponseWithStatus({ name: `Clarice ${cycle} grupo:d5-seg10`, totalSubscribers: 1000 });
      }
      if (u.includes("/contacts/lists/888")) {
        return jsonResponseWithStatus({ name: `Clarice ${cycle} grupo:${draftKey}`, totalSubscribers: 0 });
      }
      if (u.includes("/api/postmaster-spam")) {
        return jsonResponseWithStatus({}, 404); // sem leitura — resolveSpamSignal trata null com segurança.
      }
      throw new Error(`chamada Brevo inesperada neste teste: ${u}`);
    }) as unknown as typeof fetch;

    // Fetch do DASHBOARD (`fetchImpl`, seam dedicado #5058) — só devolve
    // sent/queued, NUNCA draft (é isso que o #5064 fecha).
    const fetchImplDashboard = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/campaigns")) return jsonResponseWithStatus([maturedSent]);
      throw new Error(`chamada inesperada no fetchImpl do dashboard: ${u}`);
    }) as unknown as typeof fetch;

    const origApiKey = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_CLARICE_API_KEY = "fake-key-teste-integracao-5064";
    try {
      const proposal = await planWave({
        cycle,
        dates: [sendDate],
        dbPath: ":memory:",
        dashboardUrl: "https://fake-dashboard.example",
        lockedSubject: "assunto travado", // simplifica o teste A/B/C — fora do escopo deste teste.
        novosStateBaseDir: "/tmp/clarice-novos-state-inexistente-5064-integration-test",
        fetchImpl: fetchImplDashboard,
      });

      // (a)+(b): fetchDraftCampaigns rodou e mergeCampaignSources de fato
      // fundiu a onda draft com a sent/queued do dashboard — sem isso,
      // `state.waves` nunca teria a chave draft.
      assert.ok(brevoCalls.some((u) => u.includes("status=draft")), "fetchDraftCampaigns deveria ter sido chamado");
      const draftWave = proposal.state.waves.find((w) => w.key === draftKey);
      assert.ok(
        draftWave,
        `onda draft "${draftKey}" deveria estar em state.waves; waves=${JSON.stringify(proposal.state.waves)}`,
      );
      assert.equal(draftWave!.status, "draft");
      assert.equal(draftWave!.scheduledAt, null);

      // (c): o MESMO guard que clarice-envio-run.ts chama com o proposal
      // real decide corretamente que já existe onda pra sendDate — reproduz
      // o cenário do incidente original do #5064.
      const existing = detectExistingWaveForSendDate(proposal.state.waves, sendDate);
      assert.equal(existing.length, 1);
      assert.equal(existing[0].key, draftKey);
      assert.equal(existing[0].status, "draft");
      assert.equal(existing[0].scheduledAt, null);
    } finally {
      globalThis.fetch = origFetch;
      if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
      else process.env.BREVO_CLARICE_API_KEY = origApiKey;
    }
  });
});
