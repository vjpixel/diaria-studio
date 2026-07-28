/**
 * test/brevo-dashboard-studio-kv-readonly-4206.test.ts (#4206)
 *
 * #4186 stopped the Studio Clarice panel from writing to the shared
 * production KV (`skipKvCache: true` on the 3 Brevo fetchers), but that also
 * turned off cache-ASIDE entirely — every open of the panel still fetched
 * LIVE from Brevo (up to ~100 GETs), just without caching the result. #4187
 * documented a real incident: the dashboard was rate-limited ~15min before a
 * real send, partly because of this.
 *
 * #4206 inverts the direction: `buildClariceDashboardHtml()` (no `fresh`) —
 * i.e. every normal page load — now renders 100% from the KV
 * (`dash:lastgood:campaigns` + `readKvTabs(env, "kv-only")` +
 * `fetchPlanCredits(env, "kv-only")`, none of which ever call Brevo) and
 * shows a banner with the real `fetchedAt` of the last collection. Only
 * `buildClariceDashboardHtml({ fresh: true })` (wired to `?fresh=1`, the
 * banner's "Atualizar agora" link) still does the live Brevo fetch — same
 * mechanism #4186 already hardened (skipKvCache:true on the 3 fetchers).
 *
 * This suite proves:
 *  (a) the default path makes ZERO network calls even when
 *      BREVO_CLARICE_API_KEY IS configured (the actual gap #4206 closes —
 *      test/studio-dashboard-panels.test.ts already covered the "key absent"
 *      case, which was never the problem);
 *  (b) the banner is honest about staleness — shows the real `fetchedAt` when
 *      known, and an explicit "sem coleta ainda" when the KV has never been
 *      populated (deterministic in this env: no CLOUDFLARE_ACCOUNT_ID/
 *      CLOUDFLARE_WORKERS_TOKEN → MemoryKv, always empty — see
 *      test/brevo-dashboard-studio-kv-adapter-4165-4173.test.ts for that
 *      fail-soft mechanism);
 *  (c) the "fresh" path still attempts a live Brevo call (proof that the
 *      button/query-param wiring actually reaches the network path, not just
 *      that the default path avoids it);
 *  (d) source-inspection wiring invariants, same pattern already established
 *      by test/brevo-dashboard-studio-skip-kv-cache-4186.test.ts for this
 *      exact file (mounting the full pipeline needs real Brevo+SQLite).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildClariceDashboardHtml,
  _resetClariceDashboardCache,
  injectKvOnlyBanner,
} from "../scripts/studio-ui/dashboard-clarice.ts";
import { withFetchSpy } from "./_helpers/with-fetch-spy.ts";

// ---------------------------------------------------------------------------
// (a)+(b) buildClariceDashboardHtml() default — KV-only, zero network calls
// ---------------------------------------------------------------------------

describe("buildClariceDashboardHtml() default (sem fresh) — KV-only (#4206)", () => {
  let originalBrevoKey: string | undefined;
  let originalAccount: string | undefined;
  let originalToken: string | undefined;

  beforeEach(() => {
    _resetClariceDashboardCache();
  });

  it("com BREVO_CLARICE_API_KEY configurada, NÃO faz NENHUMA chamada de rede (fecha o gap real do #4206 — #4186 sozinho não bastava)", async () => {
    originalBrevoKey = process.env.BREVO_CLARICE_API_KEY;
    originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    originalToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    process.env.BREVO_CLARICE_API_KEY = "test-key-4206";
    // Determinístico: sem credenciais Cloudflare, buildEnv() cai pro MemoryKv
    // (sempre vazio neste processo de teste) — nenhuma chamada de rede é
    // sequer POSSÍVEL para ler o KV, então esta prova não depende de mockar
    // a API do Cloudflare também.
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    try {
      await withFetchSpy(async (calls) => {
        const html = await buildClariceDashboardHtml();
        assert.deepStrictEqual(calls, [], "abrir o painel (default) não deve tocar a rede — nem Brevo, nem Cloudflare KV API");
        assert.ok(html.startsWith("<!DOCTYPE html>"), "deve renderizar o dashboard normalmente, não a página de erro");
        assert.doesNotMatch(html, /BREVO_CLARICE_API_KEY/, "não é a página 'não configurado' — a key está presente");
      });
    } finally {
      if (originalBrevoKey !== undefined) process.env.BREVO_CLARICE_API_KEY = originalBrevoKey;
      else delete process.env.BREVO_CLARICE_API_KEY;
      if (originalAccount !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
      if (originalToken !== undefined) process.env.CLOUDFLARE_WORKERS_TOKEN = originalToken;
    }
  });

  it("banner mostra 'Atualizar agora' com link ?fresh=1 (ação explícita, não efeito colateral de abrir a página)", async () => {
    originalBrevoKey = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_CLARICE_API_KEY = "test-key-4206";
    try {
      const html = await buildClariceDashboardHtml();
      assert.match(html, /Atualizar agora/);
      assert.match(html, /href="\?fresh=1"/);
    } finally {
      if (originalBrevoKey !== undefined) process.env.BREVO_CLARICE_API_KEY = originalBrevoKey;
      else delete process.env.BREVO_CLARICE_API_KEY;
    }
  });

  it("sem nenhuma coleta salva ainda (KV vazio), o banner é honesto — 'nunca (ainda sem coleta)', não inventa um horário", async () => {
    originalBrevoKey = process.env.BREVO_CLARICE_API_KEY;
    originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    originalToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    process.env.BREVO_CLARICE_API_KEY = "test-key-4206";
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    try {
      const html = await buildClariceDashboardHtml();
      assert.match(html, /nunca \(ainda sem coleta\)/);
    } finally {
      if (originalBrevoKey !== undefined) process.env.BREVO_CLARICE_API_KEY = originalBrevoKey;
      else delete process.env.BREVO_CLARICE_API_KEY;
      if (originalAccount !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
      if (originalToken !== undefined) process.env.CLOUDFLARE_WORKERS_TOKEN = originalToken;
    }
  });
});

// ---------------------------------------------------------------------------
// (c) buildClariceDashboardHtml({ fresh: true }) — o botão "Atualizar agora"
// continua disparando o fetch ao vivo (não regrediu pro comportamento
// KV-only também).
// ---------------------------------------------------------------------------

describe("buildClariceDashboardHtml({ fresh: true }) — botão 'Atualizar agora' ainda busca ao vivo (#4206)", () => {
  let originalBrevoKey: string | undefined;

  beforeEach(() => {
    _resetClariceDashboardCache();
  });

  it("com fresh:true, tenta pelo menos 1 chamada de rede à Brevo (distinto do default, que faz zero)", async () => {
    originalBrevoKey = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_CLARICE_API_KEY = "test-key-4206";
    try {
      await withFetchSpy(async (calls) => {
        await buildClariceDashboardHtml({ fresh: true });
        assert.ok(calls.length > 0, "fresh:true deve tentar buscar ao vivo na Brevo — o botão precisa funcionar de verdade");
        assert.ok(
          calls.some((c) => c.includes("api.brevo.com")),
          "a chamada tentada deve ser pra api.brevo.com, não pra outro destino",
        );
      });
    } finally {
      if (originalBrevoKey !== undefined) process.env.BREVO_CLARICE_API_KEY = originalBrevoKey;
      else delete process.env.BREVO_CLARICE_API_KEY;
    }
  });
});

// ---------------------------------------------------------------------------
// (e) #4226 — o resultado de ?fresh=1 nunca deve poluir o cache module-level
// que os loads NORMAIS (sem fresh) leem. Antes do fix, os dois caminhos
// escreviam no MESMO slot `cachedHtml` (TTL 5min) sem chave por modo: um
// clique em "Atualizar agora" sobrescrevia o cache, e qualquer load normal
// subsequente dentro do TTL recebia o HTML do fetch ao vivo (sem o banner
// "KV-only"), quebrando o invariante central do #4206.
// ---------------------------------------------------------------------------

describe("buildClariceDashboardHtml — cache não é poluído por ?fresh=1 (#4226)", () => {
  let originalBrevoKey: string | undefined;
  let originalAccount: string | undefined;
  let originalToken: string | undefined;

  beforeEach(() => {
    _resetClariceDashboardCache();
    originalBrevoKey = process.env.BREVO_CLARICE_API_KEY;
    originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    originalToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    process.env.BREVO_CLARICE_API_KEY = "test-key-4226";
    // Determinístico: sem credenciais Cloudflare, buildEnv() cai pro MemoryKv
    // (sempre vazio) — o caminho KV-only nunca toca a rede, mesmo fora de
    // withFetchSpy.
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
  });

  afterEach(() => {
    if (originalBrevoKey !== undefined) process.env.BREVO_CLARICE_API_KEY = originalBrevoKey;
    else delete process.env.BREVO_CLARICE_API_KEY;
    if (originalAccount !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
    if (originalToken !== undefined) process.env.CLOUDFLARE_WORKERS_TOKEN = originalToken;
  });

  it("sequência GET normal → GET ?fresh=1 → GET normal de novo (dentro do TTL) continua KV-only, nunca live", async () => {
    // 1. GET normal — popula o cache com o render KV-only.
    const htmlNormal1 = await buildClariceDashboardHtml();
    assert.match(htmlNormal1, /Mostrando a última coleta/, "1º load normal deve ser o render KV-only (com o banner)");

    // 2. GET ?fresh=1 — o fetch ao vivo falha neste ambiente de teste
    // (withFetchSpy proíbe rede), então o caminho live retorna a página de
    // erro. O ponto do teste não é o conteúdo do erro em si, é o que
    // acontece DEPOIS: esse HTML (de erro) nunca deve ser gravado no cache
    // que os loads normais leem.
    let htmlFresh = "";
    await withFetchSpy(async (calls) => {
      htmlFresh = await buildClariceDashboardHtml({ fresh: true });
      assert.ok(calls.length > 0, "fresh:true deve tentar buscar ao vivo na Brevo");
    });
    assert.match(htmlFresh, /Painel Clarice \(local\) — erro/, "com fetch bloqueado, o caminho live retorna a página de erro (prova que passou pelo caminho vivo, não o KV-only)");

    // 3. GET normal de novo, dentro do TTL de 5min — com o bug do #4226, o
    // slot cachedHtml teria sido sobrescrito no passo 2 e este load
    // retornaria o HTML de ERRO do fetch ao vivo, sem nenhuma chamada de
    // rede (porque "cacheado"). Com o fix, este load ignora completamente o
    // que aconteceu no passo 2 e serve de novo o KV-only.
    await withFetchSpy(async (calls) => {
      const htmlNormal2 = await buildClariceDashboardHtml();
      assert.deepStrictEqual(calls, [], "load normal pós-fresh não deve tocar a rede — nem para popular o cache");
      assert.match(htmlNormal2, /Mostrando a última coleta/, "load normal pós-fresh deve continuar KV-only");
      assert.doesNotMatch(htmlNormal2, /Painel Clarice \(local\) — erro/, "load normal pós-fresh NUNCA deve servir o resultado (nem que seja de erro) do fetch ao vivo");
      assert.notStrictEqual(htmlNormal2, htmlFresh, "load normal e load fresh devem divergir — provam que não compartilham cache");
    });
  });
});

// ---------------------------------------------------------------------------
// (b) injectKvOnlyBanner — unidade pura, sem precisar montar o pipeline
// ---------------------------------------------------------------------------

describe("injectKvOnlyBanner (#4206)", () => {
  const bareHtml = "<!DOCTYPE html><html><body><h1>x</h1></body></html>";

  it("com fetchedAt presente, mostra o horário formatado (BRT) e o link de refresh", () => {
    const html = injectKvOnlyBanner(bareHtml, "2026-07-28T12:00:00.000Z");
    assert.match(html, /BRT/);
    assert.match(html, /Atualizar agora/);
    assert.match(html, /href="\?fresh=1"/);
    assert.doesNotMatch(html, /rate-limit/i, "não deve reusar a wording de erro dos outros banners (#2733/#4187)");
  });

  it("com fetchedAt null, é honesto em vez de inventar um horário", () => {
    const html = injectKvOnlyBanner(bareHtml, null);
    assert.match(html, /nunca \(ainda sem coleta\)/);
  });

  it("insere logo após <body ...> (mesmo mecanismo dos outros banners do módulo)", () => {
    const html = injectKvOnlyBanner(bareHtml, null);
    const bodyIdx = html.indexOf("<body>");
    const bannerIdx = html.indexOf("Mostrando a última coleta");
    assert.ok(bodyIdx >= 0 && bannerIdx > bodyIdx && bannerIdx < html.indexOf("<h1>"));
  });
});

// ---------------------------------------------------------------------------
// (d) wiring — inspeção de fonte (mesmo padrão de
// brevo-dashboard-studio-skip-kv-cache-4186.test.ts, que testa este MESMO
// arquivo pelo mesmo motivo).
// ---------------------------------------------------------------------------

describe("dashboard-clarice.ts — wiring do render KV-only default (#4206)", () => {
  const srcPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../scripts/studio-ui/dashboard-clarice.ts",
  );
  const src = readFileSync(srcPath, "utf-8");

  it("buildClariceDashboardHtml despacha pra renderClariceDashboardKvOnlyUncached quando !opts.fresh", () => {
    assert.match(src, /const html = await renderClariceDashboardKvOnlyUncached\(\);/);
  });

  it("opts.fresh retorna renderClariceDashboardLiveUncached() diretamente, sem passar pela atribuição de cachedHtml (#4226)", () => {
    const fnStart = src.indexOf("export async function buildClariceDashboardHtml");
    assert.ok(fnStart > 0, "não achei buildClariceDashboardHtml no arquivo-fonte");
    const fnEnd = src.indexOf("\n}", fnStart);
    const body = src.slice(fnStart, fnEnd);
    assert.match(
      body,
      /if\s*\(opts\.fresh\)\s*\{\s*return renderClariceDashboardLiveUncached\(\);\s*\}/,
      "o caminho fresh deve retornar direto (early return), nunca escrever em cachedHtml",
    );
    const freshReturnIdx = body.indexOf("return renderClariceDashboardLiveUncached();");
    const cacheWriteIdx = body.indexOf("cachedHtml = {");
    assert.ok(
      freshReturnIdx > 0 && cacheWriteIdx > freshReturnIdx,
      "o return do caminho fresh precisa vir ANTES da única escrita em cachedHtml (que é do caminho KV-only)",
    );
  });

  it("renderClariceDashboardKvOnlyUncached lê dash:lastgood:campaigns via env.STATS_CACHE.get", () => {
    assert.match(src, /env\.STATS_CACHE\s*\n?\s*\.get\(LASTGOOD_CAMPAIGNS_KEY,\s*"json"\)/);
  });

  it("renderClariceDashboardKvOnlyUncached usa readKvTabs(env, \"kv-only\") e fetchPlanCredits(env, \"kv-only\") — nunca 'cached'/'fresh'", () => {
    const start = src.indexOf("async function renderClariceDashboardKvOnlyUncached");
    const end = src.indexOf("async function renderClariceDashboardLiveUncached");
    assert.ok(start > 0 && end > start, "não achei os limites da função no arquivo-fonte (mudou de forma inesperada?)");
    const body = src.slice(start, end);
    assert.match(body, /readKvTabs\(env,\s*"kv-only"\)/);
    assert.match(body, /fetchPlanCredits\(env,\s*"kv-only"\)/);
    assert.doesNotMatch(
      body,
      /fetchRecentCampaigns\(|fetchScheduledCampaigns\(/,
      "o caminho default NUNCA deve chamar os fetchers que batem na Brevo ao vivo",
    );
    assert.match(body, /injectKvOnlyBanner\(html,\s*fetchedAt\)/, "o banner de fetchedAt deve ser aplicado nesse caminho");
  });

  it("renderClariceDashboardLiveUncached (?fresh=1) preserva os 3 fetchers com skipKvCache:true (#4186, inalterado)", () => {
    const start = src.indexOf("async function renderClariceDashboardLiveUncached");
    assert.ok(start > 0, "não achei o caminho ao vivo no arquivo-fonte");
    const body = src.slice(start);
    assert.match(body, /fetchPlanCredits\(env,\s*"cached",\s*true\)/);
    assert.match(body, /fetchScheduledCampaigns\(env,\s*50,\s*false,\s*undefined,\s*true\)/);
    assert.match(body, /fetchRecentCampaigns\(env,\s*CAMPAIGNS_FETCH_LIMIT,\s*false,\s*undefined,\s*true\)/);
  });
});
