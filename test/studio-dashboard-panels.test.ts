/**
 * test/studio-dashboard-panels.test.ts (#3563 — fatia 9 do epic #3554)
 *
 * Cobre os painéis embutidos do studio-server (diária/poll #3550 + Clarice
 * local #3553-A):
 *  - `buildDiariaDashboardHtml()` produz HTML autocontido válido, mesmo sem
 *    `data/` presente (sessão cloud, label `local` #2643) — graceful, nunca
 *    lança.
 *  - `GET /painel/diaria` no studio-server serve esse HTML (200, content-type
 *    text/html).
 *  - `GET /painel/clarice` SEM `BREVO_CLARICE_API_KEY` configurada retorna a
 *    página "não configurado" SEM fazer nenhuma chamada de rede — prova via
 *    `withFetchSpy` (#2812 item 3 helper) que o painel nunca dispara Brevo
 *    sem credencial, protegendo contra o incidente documentado de rate-limit
 *    horário da Brevo (memory: brevo-hourly-ratelimit).
 *  - Ambas as rotas continuam sob o guard read-only global (POST → 405,
 *    #3555).
 *
 * Não testa o caminho "feliz" do painel Clarice (Brevo API + store SQLite
 * real) aqui — exigiria mockar ~100 chamadas Brevo ou tocar credenciais
 * reais; a validação de ponta a ponta desse caminho é local/manual (label
 * `local`, mesmo espírito de #3550/#3553).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";
import { buildDiariaDashboardHtml } from "../scripts/studio-ui/dashboard-diaria.ts";
import { buildClariceDashboardHtml, _resetClariceDashboardCache } from "../scripts/studio-ui/dashboard-clarice.ts";
import { withFetchSpy } from "./_helpers/with-fetch-spy.ts";

describe("buildDiariaDashboardHtml (#3563, endereça #3550)", () => {
  it("produz um documento HTML autocontido com as abas esperadas, mesmo sem data/ populado", async () => {
    const html = await buildDiariaDashboardHtml();
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.match(html, /Dashboard Operacional/);
    // A aba "É IA?" (poll) vem embutida no MESMO documento — cobre o pedido
    // de embed do painel "poll" sem view separada.
    assert.match(html, /id="tab-eia"/);
    assert.match(html, /id="panel-eia"/);
  });

  it("inclui o botão 'Atualizar É IA?' (#3861 — exclusivo do studio-server, studioMode:true)", async () => {
    const html = await buildDiariaDashboardHtml();
    assert.match(html, /id="eia-refresh-btn"/);
    assert.match(html, /\/api\/painel\/eia\/refresh/);
  });

  it("(#3853): inclui os assets do menu unificado do Studio (studioMode:true) — página nativa, não mais documento à parte", async () => {
    const html = await buildDiariaDashboardHtml();
    assert.match(html, /<link rel="stylesheet" href="\/tokens\.generated\.css"/);
    assert.match(html, /<link rel="stylesheet" href="\/style\.css"/);
    assert.match(html, /<link rel="stylesheet" href="\/nav\.css"/);
    assert.match(html, /<link rel="stylesheet" href="\/chat-drawer\.css"/);
    assert.match(html, /id="app-nav" class="app-nav" aria-label="Navegação do Studio"/);
    assert.match(html, /window\.STUDIO_PAGE = "painel-diaria";/);
    assert.match(html, /<script src="\/nav\.js" type="module">/);
    assert.match(html, /<script src="\/chat-drawer\.js" type="module">/);
  });
});

describe("studio-server — painéis embutidos (#3563)", () => {
  let server: StudioServer;
  let originalBrevoKey: string | undefined;

  before(async () => {
    // Sem rootDir override: os builders de painel (buildDashboardData,
    // fetchRecentCampaigns) resolvem `data/`/env relativos ao process.cwd()
    // real do processo de teste (a raiz do repo) — não são parametrizáveis
    // por rootDir (ver docstring de dashboard-diaria.ts). Rodar com o
    // rootDir default mantém o teste consistente com o uso real
    // (`npm run studio` a partir da raiz).
    server = await startStudioServer({ port: 0 });
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    _resetClariceDashboardCache();
  });

  it("GET /painel/diaria retorna 200 com o dashboard operacional", async () => {
    const res = await fetch(new URL("/painel/diaria", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.match(body, /Dashboard Operacional/);
  });

  it("(#3853): GET /painel/diaria inclui #app-nav, /nav.js e window.STUDIO_PAGE = \"painel-diaria\" (contrato HTTP real, mesmo padrão de test/studio-nav.test.ts)", async () => {
    const res = await fetch(new URL("/painel/diaria", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('id="app-nav"'), "falta o mount point #app-nav");
    assert.ok(body.includes('src="/nav.js"'), "falta o script nav.js");
    assert.ok(body.includes('window.STUDIO_PAGE = "painel-diaria";'), "STUDIO_PAGE não bate com \"painel-diaria\"");
  });

  it("POST /painel/diaria é rejeitado — guard read-only global (#3555)", async () => {
    const res = await fetch(new URL("/painel/diaria", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("buildClariceDashboardHtml sem BREVO_CLARICE_API_KEY não faz NENHUMA chamada de rede (fail-safe estrutural, early return)", async () => {
    originalBrevoKey = process.env.BREVO_CLARICE_API_KEY;
    delete process.env.BREVO_CLARICE_API_KEY;
    try {
      // withFetchSpy stuba globalThis.fetch inteiro (lança se QUALQUER chamada
      // acontecer) — chamado direto (sem passar pelo HTTP loopback do
      // studio-server, que também usa fetch() pra fazer a request de teste
      // em si) pra isolar só o comportamento do builder.
      await withFetchSpy(async () => {
        const html = await buildClariceDashboardHtml();
        assert.match(html, /BREVO_CLARICE_API_KEY/);
      });
    } finally {
      if (originalBrevoKey !== undefined) process.env.BREVO_CLARICE_API_KEY = originalBrevoKey;
    }
  });

  it("GET /painel/clarice sem BREVO_CLARICE_API_KEY retorna 200 com a página 'não configurado'", async () => {
    originalBrevoKey = process.env.BREVO_CLARICE_API_KEY;
    delete process.env.BREVO_CLARICE_API_KEY;
    try {
      const res = await fetch(new URL("/painel/clarice", server.url));
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      const body = await res.text();
      assert.match(body, /BREVO_CLARICE_API_KEY/);
    } finally {
      if (originalBrevoKey !== undefined) process.env.BREVO_CLARICE_API_KEY = originalBrevoKey;
    }
  });

  it("POST /painel/clarice é rejeitado — guard read-only global (#3555)", async () => {
    const res = await fetch(new URL("/painel/clarice", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });
});
