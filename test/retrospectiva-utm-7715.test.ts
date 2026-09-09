/**
 * test/retrospectiva-utm-7715.test.ts (#7715)
 *
 * `retrospectiva.diar.ia.br` serve dois produtos — a Retrospectiva do Mês
 * (`/AAMM`, apoio Mantenedor R$25+) e a retrospectiva anual/aniversário
 * (`/AAAA`|`/aniversarioAAAA`, cadastro grátis) — mas os links de conversão
 * dessas páginas não carregavam UTM próprio: sem isso, o que justifica manter
 * os dois formatos (saber quanto cada um converte) ficava invisível no funil,
 * e um `utm_source` único do domínio misturaria as duas audiências numa
 * métrica só (decisão do editor, corpo da #7715).
 *
 * Este teste trava:
 *   1. os 2 emissores novos entram no inventário único (`UTM_EMITTERS`) —
 *      nunca um literal solto no call site;
 *   2. os 2 renders derivam do registry (sem literal duplicado);
 *   3. o CTA de saída de CADA superfície carrega o triplo certo, com
 *      `utm_campaign` por PATH (não por ciclo genérico) — mesmo padrão de
 *      `buildArtigoEspecialEmailCampaign` (#7659);
 *   4. `utm_source` das duas variantes nunca se mistura.
 *
 * A "Atenção" da issue (import de `scripts/lib/shared/utm-registry.ts` — puro,
 * sem I/O — dentro do bundle do Worker) é coberta por
 * `test/worker-bundle-node-only-imports.test.ts`, que já escaneia TODO
 * `workers/{nome}/src/index.ts` recursivamente; não duplicado aqui via
 * subprocesso (`node --test` dentro de `node --test` dispara o guard de
 * recursão do test runner e não roda de verdade — rodar os dois arquivos
 * lado a lado, como este PR já faz, é o jeito correto de confirmar os dois).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  UTM_EMITTERS,
  RETROSPECTIVA_MENSAL_UTM_SOURCE,
  RETROSPECTIVA_MENSAL_UTM_MEDIUM,
  RETROSPECTIVA_ANUAL_UTM_SOURCE,
  RETROSPECTIVA_ANUAL_UTM_MEDIUM,
  buildRetrospectivaMensalCampaign,
  buildRetrospectivaAnualCampaign,
} from "../scripts/lib/shared/utm-registry.ts";
import { renderPaywall, renderTeaserWithPaywall } from "../workers/retrospectiva/src/render-mensal.ts";
import { renderNoTeaser, renderTeaserWithSignup } from "../workers/retrospectiva/src/render-anual.ts";

const MENSAL_PATH = "2607";
const ANUAL_PATH = "2026";
const ANIVERSARIO_PATH = "aniversario2026";

describe("#7715 — inventário: os 2 emissores novos entram em UTM_EMITTERS", () => {
  it("retrospectiva-mensal está presente, com source/medium/campaignPattern corretos", () => {
    const e = UTM_EMITTERS.find((x) => x.id === "retrospectiva-mensal");
    assert.ok(e, "id 'retrospectiva-mensal' ausente do inventário");
    assert.equal(e?.source, RETROSPECTIVA_MENSAL_UTM_SOURCE);
    assert.equal(e?.medium, RETROSPECTIVA_MENSAL_UTM_MEDIUM);
    assert.equal(e?.campaignPattern, `${RETROSPECTIVA_MENSAL_UTM_SOURCE}-{path}`);
    assert.equal(e?.status, "ativo");
  });

  it("retrospectiva-anual está presente, com source/medium/campaignPattern corretos", () => {
    const e = UTM_EMITTERS.find((x) => x.id === "retrospectiva-anual");
    assert.ok(e, "id 'retrospectiva-anual' ausente do inventário");
    assert.equal(e?.source, RETROSPECTIVA_ANUAL_UTM_SOURCE);
    assert.equal(e?.medium, RETROSPECTIVA_ANUAL_UTM_MEDIUM);
    assert.equal(e?.campaignPattern, `${RETROSPECTIVA_ANUAL_UTM_SOURCE}-{path}`);
    assert.equal(e?.status, "ativo");
  });

  it("os 2 utm_source nunca se misturam", () => {
    assert.notEqual(RETROSPECTIVA_MENSAL_UTM_SOURCE, RETROSPECTIVA_ANUAL_UTM_SOURCE);
  });
});

describe("#7715 — buildRetrospectivaMensalCampaign / buildRetrospectivaAnualCampaign são puras e por PATH", () => {
  it("mensal: retrospectiva-mensal-{AAMM}", () => {
    assert.equal(buildRetrospectivaMensalCampaign(MENSAL_PATH), "retrospectiva-mensal-2607");
  });

  it("anual: retrospectiva-anual-{AAAA}", () => {
    assert.equal(buildRetrospectivaAnualCampaign(ANUAL_PATH), "retrospectiva-anual-2026");
  });

  it("aniversário: retrospectiva-anual-{aniversarioAAAA} (mesmo path, mesmo emissor)", () => {
    assert.equal(buildRetrospectivaAnualCampaign(ANIVERSARIO_PATH), "retrospectiva-anual-aniversario2026");
  });

  it("edições diferentes nunca colidem no mesmo utm_campaign", () => {
    assert.notEqual(buildRetrospectivaMensalCampaign("2607"), buildRetrospectivaMensalCampaign("2608"));
    assert.notEqual(buildRetrospectivaAnualCampaign("2026"), buildRetrospectivaAnualCampaign("aniversario2026"));
  });
});

describe("#7715 — link de saída da Retrospectiva do Mês carrega o triplo certo", () => {
  function assertUtm(html: string, expectedCampaign: string) {
    const m = /href="([^"]*apoia\.se\/diaria[^"]*)"/.exec(html);
    assert.ok(m, "CTA de apoio (apoia.se) não encontrado no HTML");
    const href = m![1].replace(/&amp;/g, "&");
    const url = new URL(href);
    assert.equal(url.searchParams.get("utm_source"), RETROSPECTIVA_MENSAL_UTM_SOURCE);
    assert.equal(url.searchParams.get("utm_medium"), RETROSPECTIVA_MENSAL_UTM_MEDIUM);
    assert.equal(url.searchParams.get("utm_campaign"), expectedCampaign);
  }

  it("paywall seco (renderPaywall)", () => {
    assertUtm(renderPaywall(MENSAL_PATH), "retrospectiva-mensal-2607");
  });

  it("bloco de conversão do trecho (renderTeaserWithPaywall)", () => {
    const teaser = "<html><body><p>começo do artigo</p></body></html>";
    assertUtm(renderTeaserWithPaywall(teaser, MENSAL_PATH), "retrospectiva-mensal-2607");
  });

  it("edições distintas geram utm_campaign distinto na mesma superfície", () => {
    const a = renderPaywall("2607");
    const b = renderPaywall("2608");
    const campA = new URL(/href="([^"]*apoia\.se\/diaria[^"]*)"/.exec(a)![1].replace(/&amp;/g, "&")).searchParams.get(
      "utm_campaign",
    );
    const campB = new URL(/href="([^"]*apoia\.se\/diaria[^"]*)"/.exec(b)![1].replace(/&amp;/g, "&")).searchParams.get(
      "utm_campaign",
    );
    assert.notEqual(campA, campB);
  });
});

describe("#7715 — link/action de saída da retrospectiva anual/aniversário carrega o triplo certo", () => {
  function extractActionUtm(html: string): URLSearchParams {
    const m = /action="([^"]*jogar\/subscribe[^"]*)"/.exec(html);
    assert.ok(m, "form action (subscribe endpoint) não encontrado no HTML");
    const action = m![1].replace(/&amp;/g, "&");
    return new URL(action).searchParams;
  }

  it("form de cadastro (renderNoTeaser) — path anual", () => {
    const html = renderNoTeaser("https://retrospectiva.diar.ia.br/2026", ANUAL_PATH);
    const params = extractActionUtm(html);
    assert.equal(params.get("utm_source"), RETROSPECTIVA_ANUAL_UTM_SOURCE);
    assert.equal(params.get("utm_medium"), RETROSPECTIVA_ANUAL_UTM_MEDIUM);
    assert.equal(params.get("utm_campaign"), "retrospectiva-anual-2026");
  });

  it("form de cadastro (renderNoTeaser) — path aniversário", () => {
    const html = renderNoTeaser("https://retrospectiva.diar.ia.br/aniversario2026", ANIVERSARIO_PATH);
    const params = extractActionUtm(html);
    assert.equal(params.get("utm_campaign"), "retrospectiva-anual-aniversario2026");
  });

  it("bloco de conversão do trecho (renderTeaserWithSignup)", () => {
    const teaser = "<html><body><p>começo da retrospectiva</p></body></html>";
    const html = renderTeaserWithSignup(teaser, "https://retrospectiva.diar.ia.br/2026", ANUAL_PATH);
    const params = extractActionUtm(html);
    assert.equal(params.get("utm_source"), RETROSPECTIVA_ANUAL_UTM_SOURCE);
    assert.equal(params.get("utm_campaign"), "retrospectiva-anual-2026");
  });

  it("o fetch() do submit progressivo usa o MESMO endpoint com UTM (não o SUBSCRIBE_ENDPOINT cru)", () => {
    // A URL vai serializada via JSON.stringify dentro do <script> — "&" não
    // precisa de escape em JSON, então o par aparece literal no HTML.
    const html = renderNoTeaser("https://retrospectiva.diar.ia.br/2026", ANUAL_PATH);
    assert.match(html, /window\.fetch\("https:\/\/eia\.diar\.ia\.br\/jogar\/subscribe\?[^"]*utm_campaign=retrospectiva-anual-2026[^"]*"/);
  });
});

describe("#7715 — nenhuma colisão de utm_source com outros emissores do registry", () => {
  it("retrospectiva-mensal/retrospectiva-anual são únicos em UTM_EMITTERS", () => {
    const sources = UTM_EMITTERS.map((e) => e.source.toLowerCase());
    const mensalCount = sources.filter((s) => s === RETROSPECTIVA_MENSAL_UTM_SOURCE).length;
    const anualCount = sources.filter((s) => s === RETROSPECTIVA_ANUAL_UTM_SOURCE).length;
    assert.equal(mensalCount, 1, "retrospectiva-mensal duplicado em UTM_EMITTERS");
    assert.equal(anualCount, 1, "retrospectiva-anual duplicado em UTM_EMITTERS");
  });
});
