/**
 * beehiiv-sync-needs-clicks.test.ts (#1357 followup)
 *
 * Cobre identifyPostsNeedingClicks — decide quais posts vão pro manifest
 * de enrichment via MCP. Mirror dos filtros de build-link-ctr.ts (status,
 * idade >7d, clicks>0) pra garantir que o manifest e o builder convergem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { identifyPostsNeedingClicks } from "../scripts/beehiiv-sync.ts";

const NOW = new Date("2026-05-18T12:00:00Z");
const SECONDS = 1;
const oneDayAgo = Math.floor((NOW.getTime() - 24 * 60 * 60 * 1000) / 1000) * SECONDS;
const tenDaysAgo = Math.floor((NOW.getTime() - 10 * 24 * 60 * 60 * 1000) / 1000) * SECONDS;
const eightDaysAgo = Math.floor((NOW.getTime() - 8 * 24 * 60 * 60 * 1000) / 1000) * SECONDS;
const sixDaysAgo = Math.floor((NOW.getTime() - 6 * 24 * 60 * 60 * 1000) / 1000) * SECONDS;

describe("identifyPostsNeedingClicks", () => {
  it("inclui post confirmed > 7d, email.clicks>0, stats.clicks vazio", () => {
    const got = identifyPostsNeedingClicks([
      { id: "p1", title: "T1", status: "confirmed", publish_date: tenDaysAgo, stats: { email: { clicks: 10 }, clicks: [] } },
    ], NOW);
    assert.equal(got.length, 1);
    assert.equal(got[0].id, "p1");
    assert.equal(got[0].email_clicks, 10);
  });

  it("exclui post não-confirmed", () => {
    const got = identifyPostsNeedingClicks([
      { id: "p1", status: "draft", publish_date: tenDaysAgo, stats: { email: { clicks: 10 }, clicks: [] } },
    ], NOW);
    assert.equal(got.length, 0);
  });

  it("exclui post < 7d (CTR ainda não estabilizado)", () => {
    const got = identifyPostsNeedingClicks([
      { id: "p_recent", status: "confirmed", publish_date: sixDaysAgo, stats: { email: { clicks: 10 }, clicks: [] } },
      { id: "p_yesterday", status: "confirmed", publish_date: oneDayAgo, stats: { email: { clicks: 10 }, clicks: [] } },
    ], NOW);
    assert.equal(got.length, 0);
  });

  it("inclui no boundary (exatamente 8 dias)", () => {
    const got = identifyPostsNeedingClicks([
      { id: "p_old", status: "confirmed", publish_date: eightDaysAgo, stats: { email: { clicks: 5 }, clicks: [] } },
    ], NOW);
    assert.equal(got.length, 1);
  });

  it("exclui post com clicks já enriquecidos (soma por-link bate o agregado)", () => {
    const got = identifyPostsNeedingClicks([
      { id: "p_done", status: "confirmed", publish_date: tenDaysAgo,
        stats: { email: { clicks: 10 }, clicks: [{ url: "x", email: { verified_clicks: 10 } }] } },
    ], NOW);
    assert.equal(got.length, 0);
  });

  it("#4493: inclui post com cache PARCIAL — 1 linha cobrindo bem menos da metade do agregado", () => {
    // Reprodução do achado real (26w31): stats.clicks com 1 linha só, mas
    // email.clicks agregado de 34-51 — o gate antigo (length > 0) tratava
    // isso como "já enriquecido" e nunca corrigia.
    const got = identifyPostsNeedingClicks([
      {
        id: "p_partial", status: "confirmed", publish_date: tenDaysAgo,
        stats: { email: { clicks: 40 }, clicks: [{ url: "x", email: { verified_clicks: 1 } }] },
      },
    ], NOW);
    assert.equal(got.length, 1, "cache com 1 linha cobrindo 2,5% do agregado precisa re-fetch");
    assert.equal(got[0].id, "p_partial");
  });

  it("#4493: NÃO re-busca post com cache saudável (24+ linhas somando perto do agregado)", () => {
    // Evita regressão de custo — cache saudável real não deve voltar pro
    // manifest de enrichment a cada sync incremental.
    const healthyRows = Array.from({ length: 24 }, (_, i) => ({
      url: `https://exemplo.com/link-${i}`,
      email: { verified_clicks: 2 },
    }));
    const got = identifyPostsNeedingClicks([
      {
        id: "p_healthy", status: "confirmed", publish_date: tenDaysAgo,
        stats: { email: { clicks: 50 }, clicks: healthyRows }, // soma = 48/50 = 96%
      },
    ], NOW);
    assert.equal(got.length, 0);
  });

  it("exclui post com 0 aggregate clicks (nada a buscar)", () => {
    const got = identifyPostsNeedingClicks([
      { id: "p_zero", status: "confirmed", publish_date: tenDaysAgo, stats: { email: { clicks: 0 }, clicks: [] } },
    ], NOW);
    assert.equal(got.length, 0);
  });

  it("ordena por publish_date desc + respeita budget", () => {
    const fifteenDaysAgo = Math.floor((NOW.getTime() - 15 * 24 * 60 * 60 * 1000) / 1000);
    const got = identifyPostsNeedingClicks([
      { id: "older",  status: "confirmed", publish_date: fifteenDaysAgo, stats: { email: { clicks: 1 }, clicks: [] } },
      { id: "newer",  status: "confirmed", publish_date: eightDaysAgo,  stats: { email: { clicks: 2 }, clicks: [] } },
      { id: "middle", status: "confirmed", publish_date: tenDaysAgo,    stats: { email: { clicks: 3 }, clicks: [] } },
    ], NOW, 2);
    assert.equal(got.length, 2);
    assert.equal(got[0].id, "newer", "mais recente primeiro");
    assert.equal(got[1].id, "middle");
  });

  it("manifest sem campo _publish_date no output", () => {
    const got = identifyPostsNeedingClicks([
      { id: "p1", status: "confirmed", publish_date: tenDaysAgo, stats: { email: { clicks: 1 }, clicks: [] } },
    ], NOW);
    assert.equal(got.length, 1);
    assert.ok(!("_publish_date" in got[0]), "campo interno não vaza no JSON output");
    assert.deepEqual(Object.keys(got[0]).sort(), ["email_clicks", "id", "title"]);
  });
});
