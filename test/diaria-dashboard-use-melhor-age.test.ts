/**
 * test/diaria-dashboard-use-melhor-age.test.ts (#3146)
 *
 * Fix: a tabela "Use Melhor → Por edição (últimas 20)" mostrava "—" tanto
 * para itens ainda dentro da janela de estabilização de CTR (< 7 dias,
 * MIN_AGE_DAYS_FOR_CLICKS — clicks ainda não foram buscados da Beehiiv) quanto
 * para itens com join lossy real (URL de pesquisa ≠ URL publicada, ~22% gap
 * já documentado). As duas condições pareciam idênticas pro editor — uma é
 * transitória (resolve sozinha), a outra pode nunca resolver.
 *
 * Cobre (#633 regressão):
 *  - Edição recente (< 7 dias, sem ctr_pct) → "aguardando estabilização (Nd)"
 *  - Edição antiga (>= 7 dias, sem ctr_pct) → "—" cru (o gap real, sem regressão)
 *  - Item COM ctr_pct sempre mostra o número, independente da idade
 *  - Drift entre scripts/lib/shared/ctr-config.ts e a cópia espelhada no
 *    Worker (scripts/lib/ não é importável no bundle — mesmo padrão de
 *    isAprofundeAnchor)
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MIN_AGE_DAYS_FOR_CLICKS as SHARED_MIN_AGE_DAYS_FOR_CLICKS } from "../scripts/lib/shared/ctr-config.ts";

function makeBase(): import("../workers/diaria-dashboard/src/types.ts").DashboardData {
  return {
    generated_at: "2026-07-10T00:00:00Z",
    schema_version: 1,
    source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
    ctr: null,
    overnight: { runs: [], total_runs: 0 },
    use_melhor: null,
    poll_eia: null,
    stubs: [],
  };
}

// "now" fixo pra determinismo: 2026-07-10 (mesma referência do CLAUDE.md/currentDate).
const NOW = new Date("2026-07-10T12:00:00Z");

describe("MIN_AGE_DAYS_FOR_CLICKS — sem drift entre fonte compartilhada e Worker (#3146)", () => {
  test("scripts/beehiiv-sync.ts importa a mesma constante compartilhada", async () => {
    // beehiiv-sync.ts não expõe mais MIN_AGE_DAYS_FOR_CLICKS local — o cutoff
    // usado por identifyPostsNeedingClicks vem só da fonte compartilhada.
    // Testamos o comportamento indiretamente: um post publicado exatamente
    // no limite (SHARED - 1 dias) ainda é considerado "recente demais".
    const { identifyPostsNeedingClicks } = await import("../scripts/beehiiv-sync.ts");
    const now = new Date("2026-05-18T12:00:00Z");
    const justInsideWindow = Math.floor(
      (now.getTime() - (SHARED_MIN_AGE_DAYS_FOR_CLICKS - 1) * 24 * 60 * 60 * 1000) / 1000,
    );
    const result = identifyPostsNeedingClicks(
      [{ id: "p1", status: "confirmed", publish_date: justInsideWindow, stats: { email: { clicks: 5 }, clicks: [] } }],
      now,
    );
    assert.deepEqual(result, [], `post publicado há ${SHARED_MIN_AGE_DAYS_FOR_CLICKS - 1}d (< ${SHARED_MIN_AGE_DAYS_FOR_CLICKS}) não deve entrar no manifest de clicks`);
  });

  test("valor compartilhado é 7 (cutoff documentado no CLAUDE.md/issue #3146)", () => {
    assert.equal(SHARED_MIN_AGE_DAYS_FOR_CLICKS, 7);
  });
});

describe("renderUseMelhorSection — distingue 'aguardando estabilização' de '—' real (#3146)", () => {
  test("edição recente (< 7 dias) sem ctr_pct → 'aguardando estabilização (Nd)', não '—' cru", async () => {
    const { renderUseMelhorSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    // 260708 é 2 dias antes de NOW (2026-07-10) — dentro da janela de 7 dias.
    data.use_melhor = {
      total_editions_with_use_melhor: 1,
      first_edition: "260708",
      editions: [{
        edition: "260708",
        items: [{ url: "https://recente.com/post", title: "Edição recente", ctr_pct: null, unique_verified_clicks: null }],
        ctr_matched: 0,
        ctr_unmatched: 1,
      }],
      top_items: [],
      coverage: { total_items: 1, matched: 0, unmatched: 1, coverage_pct: 0 },
    };

    const html = renderUseMelhorSection(data, NOW);

    assert.match(html, /aguardando estabilização \(2d\)/, "deve mostrar a idade da edição em dias, não '—' cru");
    assert.doesNotMatch(html, /<span class="muted">—<\/span>/, "não deve cair no '—' genérico pra edição recente");
  });

  test("edição antiga (>= 7 dias) sem ctr_pct → mantém '—' cru (gap real de join, sem regressão)", async () => {
    const { renderUseMelhorSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    // 260601 está bem além de 7 dias antes de NOW (2026-07-10).
    data.use_melhor = {
      total_editions_with_use_melhor: 1,
      first_edition: "260601",
      editions: [{
        edition: "260601",
        items: [{ url: "https://antiga.com/post", title: "Edição antiga sem match", ctr_pct: null, unique_verified_clicks: null }],
        ctr_matched: 0,
        ctr_unmatched: 1,
      }],
      top_items: [],
      coverage: { total_items: 1, matched: 0, unmatched: 1, coverage_pct: 0 },
    };

    const html = renderUseMelhorSection(data, NOW);

    assert.doesNotMatch(html, /aguardando estabilização/, "edição antiga não deve sugerir espera — o gap não vai se resolver sozinho");
    assert.match(html, /<span class="muted">—<\/span>/, "deve manter o '—' cru pro gap de join real (~22% esperado)");
  });

  test("edição exatamente no limite (idade == MIN_AGE_DAYS_FOR_CLICKS) já é tratada como estabilizada", async () => {
    const { renderUseMelhorSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    // 260703 é exatamente 7 dias antes de NOW (2026-07-10) — no boundary.
    data.use_melhor = {
      total_editions_with_use_melhor: 1,
      first_edition: "260703",
      editions: [{
        edition: "260703",
        items: [{ url: "https://limite.com/post", title: "No limite", ctr_pct: null, unique_verified_clicks: null }],
        ctr_matched: 0,
        ctr_unmatched: 1,
      }],
      top_items: [],
      coverage: { total_items: 1, matched: 0, unmatched: 1, coverage_pct: 0 },
    };

    const html = renderUseMelhorSection(data, NOW);

    assert.doesNotMatch(html, /aguardando estabilização/, "no limite exato (7d) já não é mais 'recente demais' — mesmo cutoff de beehiiv-sync.ts (publish_date * 1000 > cutoffMs)");
  });

  test("self-review: edição com AAMMDD de hoje/futuro (idade negativa) cai no '—', não 'aguardando estabilização (-Nd)'", async () => {
    // #3146 self-review: dado o convênio D+1 (pesquisa roda 1 dia antes da
    // data da edição), a pasta data/editions/{AAMMDD} pode existir com
    // AAMMDD igual ou posterior a "hoje" antes da edição ser de fato
    // publicada — editionAgeDays daria negativo nesse caso.
    const { renderUseMelhorSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    data.use_melhor = {
      total_editions_with_use_melhor: 1,
      first_edition: "260711",
      editions: [{
        edition: "260711", // 1 dia DEPOIS de NOW (2026-07-10) — idade negativa
        items: [{ url: "https://futura.com/post", title: "Edição futura (D+1)", ctr_pct: null, unique_verified_clicks: null }],
        ctr_matched: 0,
        ctr_unmatched: 1,
      }],
      top_items: [],
      coverage: { total_items: 1, matched: 0, unmatched: 1, coverage_pct: 0 },
    };

    const html = renderUseMelhorSection(data, NOW);

    assert.doesNotMatch(html, /aguardando estabilização/, "idade negativa não deve virar mensagem de espera");
    assert.doesNotMatch(html, /-\d+d/, "não deve renderizar contagem de dias negativa");
    assert.match(html, /<span class="muted">—<\/span>/, "deve cair no fallback '—' pra idade negativa");
  });

  test("item COM ctr_pct sempre mostra o número, independente da idade da edição", async () => {
    const { renderUseMelhorSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    data.use_melhor = {
      total_editions_with_use_melhor: 1,
      first_edition: "260709",
      editions: [{
        edition: "260709", // 1 dia antes de NOW — bem dentro da janela
        items: [{ url: "https://com-ctr.com/post", title: "Com CTR (join anterior)", ctr_pct: 6.5, unique_verified_clicks: 12 }],
        ctr_matched: 1,
        ctr_unmatched: 0,
      }],
      top_items: [],
      coverage: { total_items: 1, matched: 1, unmatched: 0, coverage_pct: 100 },
    };

    const html = renderUseMelhorSection(data, NOW);

    assert.match(html, /6\.5%/, "CTR real deve aparecer mesmo com a edição recente");
    assert.doesNotMatch(html, /aguardando estabilização/, "não deve mostrar mensagem de espera quando já há CTR");
  });

  test("edição com AAMMDD malformado não crasha e cai no '—' (idade desconhecida)", async () => {
    const { renderUseMelhorSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    data.use_melhor = {
      total_editions_with_use_melhor: 1,
      first_edition: "abcdef",
      editions: [{
        edition: "abcdef",
        items: [{ url: "https://malformado.com/post", title: "Edição malformada", ctr_pct: null, unique_verified_clicks: null }],
        ctr_matched: 0,
        ctr_unmatched: 1,
      }],
      top_items: [],
      coverage: { total_items: 1, matched: 0, unmatched: 1, coverage_pct: 0 },
    };

    let html: string;
    assert.doesNotThrow(() => { html = renderUseMelhorSection(data, NOW); }, "AAMMDD inválido não deve crashar o render");
    assert.match(html!, /<span class="muted">—<\/span>/, "idade desconhecida deve cair no fallback '—' em vez de arriscar uma mensagem de espera");
  });

  test("chamada sem 'now' explícito (default new Date()) continua funcionando — compat com callers existentes", async () => {
    const { renderUseMelhorSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    data.use_melhor = {
      total_editions_with_use_melhor: 1,
      first_edition: "260501",
      editions: [{
        edition: "260501",
        items: [{ url: "https://old.com/post", title: "Velha", ctr_pct: 5.0, unique_verified_clicks: 10 }],
        ctr_matched: 1,
        ctr_unmatched: 0,
      }],
      top_items: [],
      coverage: { total_items: 1, matched: 1, unmatched: 0, coverage_pct: 100 },
    };
    let html: string;
    assert.doesNotThrow(() => { html = renderUseMelhorSection(data); }, "sem 2º argumento não deve crashar (default now = new Date())");
    assert.match(html!, /5\.0%/, "deve renderizar normalmente sem 'now' explícito");
  });
});
