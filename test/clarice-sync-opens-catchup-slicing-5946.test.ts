/**
 * test/clarice-sync-opens-catchup-slicing-5946.test.ts (#5946)
 *
 * REGRESSÃO: o catch-up de opens (`runOpensCatchup`, `scripts/clarice-sync-brevo.ts`)
 * forçava `forceRefresh: true` para TODA campanha dentro da janela, todo dia,
 * sem exceção. Quando o volume de campanhas na janela cresceu (~62-121, ver
 * diagnóstico completo na issue #5946), isso sozinho excede o teto de 100
 * req/hora/CONTA da família `/v3/emailCampaigns*` da Brevo
 * (`docs/brevo-rate-limits.md`), causando falhas parciais em streak
 * (`campaignsFailed > 0`, que `extract-opens-catchup-status.ts` reprova como
 * `status: "error"`).
 *
 * O fix fatia QUANTAS campanhas já cacheadas são forçadas a re-exportar por
 * execução (`maxRefreshPerRun`/`pickCampaignsToRefresh`), priorizando as
 * mais "estagnadas" (sem cache, ou `exportedAt` mais antigo). O progresso é
 * durável sem checkpoint dedicado: `exportedAt` já persiste em disco entre
 * execuções — a rotação por staleness naturalmente retoma de onde parou.
 *
 * Este arquivo trava:
 *   1. `pickCampaignsToRefresh` — decisão pura de priorização.
 *   2. `runOpensCatchup` com `maxRefreshPerRun` — só as campanhas
 *      selecionadas chamam `exportRecipients` (rede); as demais reusam o
 *      cache em disco sem gastar cota, mas ainda contribuem seus openers
 *      já cacheados pro resultado agregado.
 *   3. Durabilidade entre execuções: uma campanha que ficou de fora hoje
 *      (por causa do teto) é priorizada na execução seguinte.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  pickCampaignsToRefresh,
  runOpensCatchup,
  DEFAULT_OPENS_CATCHUP_MAX_REFRESH_PER_RUN,
  type OpensCatchupDeps,
} from "../scripts/clarice-sync-brevo.ts";
import type { SentCampaignRef, CampaignExportClient } from "../scripts/clarice-engagement-cohorts-v2.ts";

// ─── pickCampaignsToRefresh (pura) ────────────────────────────────────────

function ref(id: number): SentCampaignRef {
  return { id, name: `Campanha ${id}` };
}

test("pickCampaignsToRefresh: recent.length <= max → refresca todas (sem corte)", () => {
  const recent = [ref(1), ref(2), ref(3)];
  const picked = pickCampaignsToRefresh(recent, new Map(), 5);
  assert.deepEqual([...picked].sort(), [1, 2, 3]);
});

test("pickCampaignsToRefresh: max <= 0 desliga o fatiamento (refresca todas)", () => {
  const recent = [ref(1), ref(2), ref(3)];
  const picked = pickCampaignsToRefresh(recent, new Map(), 0);
  assert.deepEqual([...picked].sort(), [1, 2, 3]);
});

test("pickCampaignsToRefresh: campanha SEM cache (exportedAt undefined) tem prioridade máxima", () => {
  const recent = [ref(1), ref(2), ref(3)];
  const exportedAtById = new Map<number, string | undefined>([
    [1, "2026-08-20T00:00:00.000Z"],
    [2, undefined], // nunca exportada
    [3, "2026-08-25T00:00:00.000Z"],
  ]);
  const picked = pickCampaignsToRefresh(recent, exportedAtById, 1);
  assert.deepEqual([...picked], [2]);
});

test("pickCampaignsToRefresh: entre cacheadas, a de exportedAt mais ANTIGO vem primeiro", () => {
  const recent = [ref(1), ref(2), ref(3)];
  const exportedAtById = new Map<number, string | undefined>([
    [1, "2026-08-24T00:00:00.000Z"],
    [2, "2026-08-20T00:00:00.000Z"], // mais antiga → mais estagnada → prioridade
    [3, "2026-08-25T00:00:00.000Z"],
  ]);
  const picked = pickCampaignsToRefresh(recent, exportedAtById, 2);
  assert.deepEqual([...picked].sort(), [1, 2]); // 2 (mais antiga) + 1 (2ª mais antiga); 3 fica de fora
});

test("pickCampaignsToRefresh: empate de exportedAt é resolvido por id (determinístico)", () => {
  const recent = [ref(3), ref(1), ref(2)];
  const exportedAtById = new Map<number, string | undefined>([
    [1, "2026-08-20T00:00:00.000Z"],
    [2, "2026-08-20T00:00:00.000Z"],
    [3, "2026-08-20T00:00:00.000Z"],
  ]);
  const picked = pickCampaignsToRefresh(recent, exportedAtById, 2);
  assert.deepEqual([...picked].sort(), [1, 2]);
});

// ─── runOpensCatchup com maxRefreshPerRun (client fake — sem rede) ───────

function fakeCampaign(id: number, ageDays: number): SentCampaignRef {
  return {
    id,
    name: `Campanha ${id}`,
    sentDate: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
  };
}

function makeFakeClient(
  campaigns: SentCampaignRef[],
  recipientsByCampaign: Record<number, Array<{ email: string; opened: boolean }>>,
  onExport?: (campaignId: number) => void,
): CampaignExportClient {
  return {
    async listSentCampaigns() {
      return campaigns;
    },
    async exportRecipients(campaignId) {
      onExport?.(campaignId);
      return { processId: `p-${campaignId}` };
    },
    async pollProcess(processId) {
      const id = Number(String(processId).replace("p-", ""));
      return { status: "completed", exportUrl: `fake://export/${id}` };
    },
    async downloadCsv(url) {
      const id = Number(url.replace("fake://export/", ""));
      const rows = recipientsByCampaign[id] ?? [];
      const header = "Email_ID,Delivered_Date,Total Opens";
      const lines = rows.map((r) => `${r.email},2026-08-01 10:00:00,${r.opened ? 1 : 0}`);
      return [header, ...lines].join("\n");
    },
  };
}

test("runOpensCatchup: maxRefreshPerRun limita quantas campanhas JÁ CACHEADAS chamam exportRecipients", async () => {
  const cacheDir = mkdtempSync(resolve(tmpdir(), "opens-catchup-slice-"));
  const campaigns = [fakeCampaign(1, 1), fakeCampaign(2, 2), fakeCampaign(3, 3)];
  const recipients = {
    1: [{ email: "a@x.com", opened: true }],
    2: [{ email: "b@x.com", opened: true }],
    3: [{ email: "c@x.com", opened: true }],
  };

  const exportCalls: number[] = [];
  const client = makeFakeClient(campaigns, recipients, (id) => exportCalls.push(id));

  const baseDeps: OpensCatchupDeps = {
    client,
    fetchContact: async (identifier) => ({ email: identifier }),
    upsert: () => {},
    cacheDir,
  };

  // 1ª execução: nenhum cache em disco ainda → TODAS as 3 são "novas" e
  // precisam do baseline, independente do teto (maxRefreshPerRun não limita
  // campanha nunca vista).
  const first = await runOpensCatchup({ ...baseDeps, maxRefreshPerRun: 1 });
  assert.equal(first.campaignsFailed, 0);
  assert.deepEqual(exportCalls.sort(), [1, 2, 3], "1ª run: todas sem cache ainda, todas exportam");
  assert.equal(first.openersFound, 3);

  // 2ª execução, MESMO cacheDir (simula o dia seguinte): agora as 3 já têm
  // cache — só 1 (o teto) deve re-exportar.
  exportCalls.length = 0;
  const second = await runOpensCatchup({ ...baseDeps, maxRefreshPerRun: 1 });
  assert.equal(second.campaignsFailed, 0);
  assert.equal(exportCalls.length, 1, `esperava exatamente 1 re-export (teto), obteve: ${exportCalls}`);
  // As outras 2 reusaram o cache — openersFound ainda soma as 3 (2 do cache + 1 recém-exportada).
  assert.equal(second.openersFound, 3, "campanhas fora do teto ainda contribuem via cache, sem gastar rede");
});

test("runOpensCatchup: campaignsSkippedRefresh reporta quantas leram do cache sem re-export", async () => {
  // #5946 self-review finding 2: sem este contador, um streak que PERSISTA
  // depois do fatiamento é indiagnosticável — `campaignsInWindow` conta todas
  // as campanhas da janela (refrescadas ou não), então não distingue "o teto
  // ainda é grande demais pra cota do momento" de "o problema não era volume
  // de re-export".
  const cacheDir = mkdtempSync(resolve(tmpdir(), "opens-catchup-skipped-"));
  const campaigns = [fakeCampaign(1, 1), fakeCampaign(2, 2), fakeCampaign(3, 3)];
  const recipients = {
    1: [{ email: "a@x.com", opened: true }],
    2: [{ email: "b@x.com", opened: true }],
    3: [{ email: "c@x.com", opened: true }],
  };
  const client = makeFakeClient(campaigns, recipients, () => {});
  const baseDeps: OpensCatchupDeps = {
    client,
    fetchContact: async (identifier) => ({ email: identifier }),
    upsert: () => {},
    cacheDir,
  };

  // 1ª run: nada em cache — todas são "novas", nenhuma é pulada pelo teto.
  const first = await runOpensCatchup({ ...baseDeps, maxRefreshPerRun: 1 });
  assert.equal(first.campaignsSkippedRefresh, 0, "1ª run: nenhuma tem cache, nenhuma é pulada");

  // 2ª run, mesmo cacheDir: as 3 têm cache, o teto deixa 1 re-exportar → 2 puladas.
  const second = await runOpensCatchup({ ...baseDeps, maxRefreshPerRun: 1 });
  assert.equal(second.campaignsSkippedRefresh, 2, "2ª run: 3 na janela - 1 do teto = 2 lidas do cache");
  assert.equal(second.campaignsInWindow, 3, "campaignsInWindow segue contando a janela inteira");

  // Teto >= janela: ninguém é pulado.
  const third = await runOpensCatchup({ ...baseDeps, maxRefreshPerRun: 10 });
  assert.equal(third.campaignsSkippedRefresh, 0, "teto acima do tamanho da janela não pula ninguém");
});

test("runOpensCatchup: campanha que ficou de fora do teto hoje é priorizada amanhã (rotação durável via exportedAt em disco)", async () => {
  const cacheDir = mkdtempSync(resolve(tmpdir(), "opens-catchup-rotation-"));
  const campaigns = [fakeCampaign(1, 1), fakeCampaign(2, 2)];
  const recipients = {
    1: [{ email: "a@x.com", opened: true }],
    2: [{ email: "b@x.com", opened: true }],
  };

  const exportCalls: number[] = [];
  const client = makeFakeClient(campaigns, recipients, (id) => exportCalls.push(id));
  const baseDeps: OpensCatchupDeps = {
    client,
    fetchContact: async (identifier) => ({ email: identifier }),
    upsert: () => {},
    cacheDir,
  };

  // Run 1: sem cache — as 2 exportam (baseline).
  await runOpensCatchup(baseDeps);
  assert.deepEqual(exportCalls.sort(), [1, 2]);

  // Run 2: teto de 1 — a ordem de desempate por id escolhe a campanha 1
  // primeiro (exportedAt igual, ids diferentes — ver teste de empate acima).
  exportCalls.length = 0;
  await runOpensCatchup({ ...baseDeps, maxRefreshPerRun: 1 });
  assert.deepEqual(exportCalls, [1], "run 2: só a campanha 1 (menor id em empate) re-exporta");

  // Run 3: agora a campanha 1 tem exportedAt MAIS RECENTE que a 2 (que ficou
  // parada desde a run 1) — a rotação deve inverter e priorizar a 2.
  exportCalls.length = 0;
  await runOpensCatchup({ ...baseDeps, maxRefreshPerRun: 1 });
  assert.deepEqual(exportCalls, [2], "run 3: a campanha 2 (mais estagnada agora) é priorizada — rotação funciona");
});

test("DEFAULT_OPENS_CATCHUP_MAX_REFRESH_PER_RUN é positivo (fatiamento ligado por padrão)", () => {
  assert.ok(DEFAULT_OPENS_CATCHUP_MAX_REFRESH_PER_RUN > 0);
});
