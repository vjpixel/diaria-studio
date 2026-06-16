/**
 * test/check-promoted-dedup.test.ts (#2315)
 *
 * Regressão: promoção radar→lançamento (passo 1m-ter, regra #160) troca a URL
 * do artigo pela oficial APÓS dedup.ts ter rodado (passo 1l). A URL oficial pode
 * repetir uma das últimas 3 edições sem que nenhum check pegue.
 *
 * Caso real (edição 260616): Moonshot Kimi K2.7-Code foi promovido com
 * huggingface.co/moonshotai/Kimi-K2.7-Code — mesma URL do destaque D1 da
 * 260615. Dedup viu apenas a URL de pesquisa original (nova), não a oficial.
 *
 * Fix: `check-promoted-dedup.ts` roda após 1m-ter, verifica artigos com
 * `primary_source_substituted`, e demote aqueles cuja URL oficial repete.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkPromotedDedup,
  type Article,
  type CategorizedFlat,
} from "../scripts/check-promoted-dedup.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";

// ---------------------------------------------------------------------------
// Helpers de fixture
// ---------------------------------------------------------------------------

/** Cria um artigo de pesquisa (radar, URL nova) promovido para lançamento. */
function makePromotedLancamento(opts: {
  researchUrl: string;
  officialUrl: string;
  title?: string;
}): Article {
  return {
    url: opts.officialUrl, // passo 1m-ter já trocou para a oficial
    title: opts.title ?? "Produto X lançado",
    primary_source_substituted: {
      from: opts.researchUrl,
      to: opts.officialUrl,
    },
  };
}

/** Cria um artigo em lancamento sem promoção (URL original). */
function makeDirectLancamento(url: string, title?: string): Article {
  return { url, title: title ?? "Lançamento direto" };
}

/** Gera o Set de pastUrls como checkPromotedDedup espera (canonicalizadas). */
function pastUrlsFrom(...urls: string[]): Set<string> {
  return new Set(urls.map((u) => canonicalize(u)));
}

// ---------------------------------------------------------------------------
// Cenário principal: URL oficial repete edição anterior → demote
// ---------------------------------------------------------------------------

describe("#2315 — checkPromotedDedup", () => {
  it("demote artigo promovido cuja URL oficial repete past-editions", () => {
    // Kimi K2.7-Code: URL de pesquisa nova, mas URL oficial já publicada ontem
    const researchUrl = "https://techcrunch.com/2026/06/15/moonshot-kimi-k27/";
    const officialUrl = "https://huggingface.co/moonshotai/Kimi-K2.7-Code";

    const promoted = makePromotedLancamento({ researchUrl, officialUrl, title: "Moonshot Kimi K2.7-Code" });

    const buckets: CategorizedFlat = {
      lancamento: [promoted],
      radar: [],
      use_melhor: [],
      video: [],
    };

    // URL oficial está em past-editions (edição 260615)
    const pastUrls = pastUrlsFrom(officialUrl);

    const result = checkPromotedDedup(buckets, pastUrls);

    // 1. Devemos ter exatamente 1 demote
    assert.equal(result.demoted.length, 1, "deve registrar 1 demote");
    assert.equal(result.checked, 1, "deve ter verificado 1 promoção");

    // 2. lancamento deve estar vazio (artigo saiu)
    assert.equal(buckets.lancamento?.length, 0, "lancamento deve estar vazio após demote");

    // 3. artigo deve estar em radar com URL restaurada
    assert.equal(buckets.radar?.length, 1, "radar deve ter 1 artigo após demote");
    const demotedArticle = buckets.radar![0];
    assert.equal(demotedArticle.url, researchUrl, "URL restaurada para a de pesquisa original");
    assert.equal(demotedArticle.title, "Moonshot Kimi K2.7-Code");

    // 4. primary_source_substituted removido; primary_source_demoted adicionado
    assert.equal(
      demotedArticle.primary_source_substituted,
      undefined,
      "primary_source_substituted deve ser removido",
    );
    assert.ok(demotedArticle.primary_source_demoted, "primary_source_demoted deve existir");
    assert.equal(
      (demotedArticle.primary_source_demoted as { url_oficial: string }).url_oficial,
      officialUrl,
    );

    // 5. entrada no log de demote
    assert.equal(result.demoted[0].url_from, researchUrl);
    assert.equal(result.demoted[0].url_to, officialUrl);
    assert.equal(result.demoted[0].title, "Moonshot Kimi K2.7-Code");
  });

  // ---------------------------------------------------------------------------
  // URL oficial NÃO repete → lançamento mantido
  // ---------------------------------------------------------------------------

  it("mantém artigo promovido cuja URL oficial é nova", () => {
    const researchUrl = "https://techcrunch.com/2026/06/15/nova-ferramenta/";
    const officialUrl = "https://openai.com/blog/nova-ferramenta";

    const promoted = makePromotedLancamento({ researchUrl, officialUrl });
    const buckets: CategorizedFlat = {
      lancamento: [promoted],
      radar: [],
    };

    // past-editions não tem a URL oficial
    const pastUrls = pastUrlsFrom("https://anthropic.com/news/other-thing");

    const result = checkPromotedDedup(buckets, pastUrls);

    assert.equal(result.demoted.length, 0, "nenhum demote esperado");
    assert.equal(result.checked, 1, "1 promoção verificada");
    assert.equal(buckets.lancamento?.length, 1, "artigo permanece em lancamento");
    assert.equal(buckets.lancamento![0].url, officialUrl, "URL oficial mantida");
    assert.equal(buckets.radar?.length, 0, "radar inalterado");
  });

  // ---------------------------------------------------------------------------
  // Artigo em lancamento SEM promoção → não é verificado
  // ---------------------------------------------------------------------------

  it("ignora artigos em lancamento sem primary_source_substituted", () => {
    const directUrl = "https://anthropic.com/blog/claude-4";
    const buckets: CategorizedFlat = {
      lancamento: [makeDirectLancamento(directUrl, "Claude 4")],
      radar: [],
    };

    // Mesmo que a URL coincida, só artigos promovidos são re-checados
    const pastUrls = pastUrlsFrom(directUrl);

    const result = checkPromotedDedup(buckets, pastUrls);

    assert.equal(result.demoted.length, 0, "artigo direto não sofre demote");
    assert.equal(result.checked, 0, "nada verificado (sem promoção)");
    assert.equal(buckets.lancamento?.length, 1, "artigo permanece em lancamento");
  });

  // ---------------------------------------------------------------------------
  // Múltiplos artigos: demote seletivo
  // ---------------------------------------------------------------------------

  it("demote seletivo — apenas artigo com URL repetida, mantém outros", () => {
    const repeatResearch = "https://techcrunch.com/2026/06/15/repeat/";
    const repeatOfficial = "https://huggingface.co/moonshotai/Kimi-K2.7-Code";

    const newResearch = "https://canaltech.com.br/ia/novo-produto/";
    const newOfficial = "https://openai.com/blog/novo-produto";

    const buckets: CategorizedFlat = {
      lancamento: [
        makePromotedLancamento({ researchUrl: repeatResearch, officialUrl: repeatOfficial, title: "Repeat" }),
        makePromotedLancamento({ researchUrl: newResearch, officialUrl: newOfficial, title: "Novo" }),
        makeDirectLancamento("https://anthropic.com/blog/direct", "Direct"),
      ],
      radar: [],
    };

    // Só a URL do primeiro artigo repete
    const pastUrls = pastUrlsFrom(repeatOfficial);

    const result = checkPromotedDedup(buckets, pastUrls);

    assert.equal(result.demoted.length, 1, "apenas 1 demote");
    assert.equal(result.checked, 2, "2 promoções verificadas (artigo direto ignorado)");
    assert.equal(buckets.lancamento?.length, 2, "2 artigos restam em lancamento");
    assert.equal(buckets.radar?.length, 1, "1 artigo em radar (o demotado)");

    // O artigo demotado é o do repeatOfficial
    assert.equal(buckets.radar![0].url, repeatResearch, "URL restaurada no artigo demotado");

    // Os artigos restantes em lancamento têm as URLs oficiais (novas ou diretas)
    const lancUrls = buckets.lancamento!.map((a) => a.url);
    assert.ok(lancUrls.includes(newOfficial), "artigo novo permanece em lancamento");
    assert.ok(lancUrls.includes("https://anthropic.com/blog/direct"), "artigo direto permanece");
  });

  // ---------------------------------------------------------------------------
  // Canonicalização: variações de URL devem ser detectadas como repeat
  // ---------------------------------------------------------------------------

  it("detecta repeat via canonicalização (trailing slash, UTM params)", () => {
    const researchUrl = "https://techcrunch.com/2026/06/15/kimi/";
    const officialUrl = "https://huggingface.co/moonshotai/Kimi-K2.7-Code?utm_source=twitter";

    // past-editions tem a versão limpa (sem trailing slash, sem UTM)
    const cleanUrl = "https://huggingface.co/moonshotai/Kimi-K2.7-Code";

    const promoted = makePromotedLancamento({ researchUrl, officialUrl });
    const buckets: CategorizedFlat = { lancamento: [promoted], radar: [] };

    const pastUrls = pastUrlsFrom(cleanUrl); // canonicalize(cleanUrl) == canonicalize(officialUrl)

    const result = checkPromotedDedup(buckets, pastUrls);

    assert.equal(result.demoted.length, 1, "deve detectar repeat mesmo com variação de URL");
    assert.equal(buckets.lancamento?.length, 0);
    assert.equal(buckets.radar?.length, 1);
  });

  // ---------------------------------------------------------------------------
  // Buckets sem lancamento → idempotente
  // ---------------------------------------------------------------------------

  it("é idempotente quando lancamento está ausente ou vazio", () => {
    const empty: CategorizedFlat = { radar: [], use_melhor: [] };
    const result = checkPromotedDedup(empty, pastUrlsFrom("https://x.com/foo"));
    assert.equal(result.demoted.length, 0);
    assert.equal(result.checked, 0);

    const emptyArr: CategorizedFlat = { lancamento: [], radar: [] };
    const result2 = checkPromotedDedup(emptyArr, pastUrlsFrom("https://x.com/foo"));
    assert.equal(result2.demoted.length, 0);
    assert.equal(result2.checked, 0);
  });

  // ---------------------------------------------------------------------------
  // past-editions vazio → nenhum demote (bootstrap)
  // ---------------------------------------------------------------------------

  it("nenhum demote quando past-editions está vazio (bootstrap)", () => {
    const promoted = makePromotedLancamento({
      researchUrl: "https://techcrunch.com/2026/06/15/first/",
      officialUrl: "https://openai.com/blog/first-edition",
    });

    const buckets: CategorizedFlat = { lancamento: [promoted], radar: [] };
    const emptyPastUrls = new Set<string>(); // sem histórico

    const result = checkPromotedDedup(buckets, emptyPastUrls);

    assert.equal(result.demoted.length, 0);
    assert.equal(buckets.lancamento?.length, 1, "artigo mantido quando histórico vazio");
  });
});
