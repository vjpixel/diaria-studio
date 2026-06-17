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

  // ---------------------------------------------------------------------------
  // P3 (finding #7): chave 'radar' ausente no input → deve ser inicializada
  // ---------------------------------------------------------------------------

  it("inicializa radar quando ausente no input (#2315 P3)", () => {
    const promoted = makePromotedLancamento({
      researchUrl: "https://techcrunch.com/2026/06/15/test/",
      officialUrl: "https://huggingface.co/test/model",
    });
    // Sem chave 'radar' no objeto (ausente, não apenas vazio)
    const buckets: CategorizedFlat = { lancamento: [promoted] };
    const pastUrls = pastUrlsFrom("https://huggingface.co/test/model");

    const result = checkPromotedDedup(buckets, pastUrls);

    assert.equal(result.demoted.length, 1, "deve registrar 1 demote");
    assert.ok(Array.isArray(buckets.radar), "radar deve ser inicializado como array");
    assert.equal(buckets.radar!.length, 1, "radar deve conter o artigo demotado");
  });

  // ---------------------------------------------------------------------------
  // P2 (finding #5): duplicata within-edition — duas promoções para mesma URL
  // ---------------------------------------------------------------------------

  it("demote duplicata within-edition — duas promoções para a mesma URL oficial (#2315 P2)", () => {
    const officialUrl = "https://openai.com/blog/gpt5";
    const research1 = "https://techcrunch.com/2026/06/15/gpt5-launch/";
    const research2 = "https://the-decoder.com/2026/06/15/gpt5/";

    const buckets: CategorizedFlat = {
      lancamento: [
        makePromotedLancamento({ researchUrl: research1, officialUrl, title: "GPT-5 via TC" }),
        makePromotedLancamento({ researchUrl: research2, officialUrl, title: "GPT-5 via Decoder" }),
      ],
      radar: [],
    };
    // URL oficial NÃO está em past-editions (só duplicada within-edition)
    const pastUrls = new Set<string>();

    const result = checkPromotedDedup(buckets, pastUrls);

    // Ambas as promoções foram verificadas
    assert.equal(result.checked, 2, "2 promoções verificadas");
    // Pelo menos 1 demote por duplicata within-edition
    assert.ok(result.demoted.length >= 1, "deve haver pelo menos 1 demote por URL duplicada");
    // No máximo 1 deve sobrar em lancamento (a primeira)
    assert.ok(
      (buckets.lancamento?.length ?? 0) <= 1,
      "no máximo 1 artigo deve sobrar em lancamento",
    );
  });

  // ---------------------------------------------------------------------------
  // P3 (finding #6): from === to edge — URL research = URL oficial
  // ---------------------------------------------------------------------------

  it("lida com from===to sem crash — demota artigo quando URL repete (#2315 P3)", () => {
    const url = "https://huggingface.co/some/model";
    // 1m-ter anotou no-op: from e to são iguais
    const article: Article = {
      url,
      title: "Modelo X",
      primary_source_substituted: { from: url, to: url },
    };
    const buckets: CategorizedFlat = { lancamento: [article], radar: [] };
    const pastUrls = pastUrlsFrom(url); // URL repete past-editions

    const result = checkPromotedDedup(buckets, pastUrls);

    // Deve demote (URL repete) sem lançar exceção
    assert.equal(result.demoted.length, 1, "deve demote artigo com from===to que repete");
    assert.equal(buckets.lancamento?.length, 0, "artigo removido de lancamento");
    assert.equal(buckets.radar?.length, 1, "artigo adicionado a radar");
    // URL restaurada é from (mesmo que igual a to — sem alternativa)
    assert.equal(buckets.radar![0].url, url, "url restaurada para from (mesmo que === to)");
  });
});

// ---------------------------------------------------------------------------
// P3 (finding #8): CLI integration smoke — stdout deve ser JSON puro
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("#2315 — check-promoted-dedup CLI stdout smoke", () => {
  it("stdout é JSON parseable e limpo no caso sem demotions", () => {
    // Criar fixture sem promoções (nenhum primary_source_substituted)
    const fixture = {
      lancamento: [{ url: "https://openai.com/blog/new", title: "Sem promoção" }],
      radar: [],
    };
    const dir = mkdtempSync(join(tmpdir(), "dedup-cli-test-"));
    const fixturePath = join(dir, "tmp-categorized.json");
    writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");

    // past-editions.md com 1 seção válida (para não disparar required: true error)
    const pastEditionsPath = join(dir, "past-editions.md");
    writeFileSync(
      pastEditionsPath,
      "## 2026-06-15\n- https://some-other.com/article\n",
      "utf8",
    );

    // Executar o script e capturar stdout
    const stdout = execSync(
      `node --import=tsx/esm scripts/check-promoted-dedup.ts --categorized "${fixturePath}" --past-editions "${pastEditionsPath}"`,
      {
        cwd: new URL("..", import.meta.url).pathname.replace(/\/$/, "").replace(/^\/([A-Za-z]:)/, "$1"),
        encoding: "utf8",
      },
    );

    // stdout deve ser JSON puro e parseable
    let parsed: unknown;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(stdout);
    }, `stdout deve ser JSON válido — recebido: ${JSON.stringify(stdout)}`);

    const result = parsed as { demoted: unknown[]; checked: number };
    assert.ok(typeof result.checked === "number", "resultado.checked deve ser number");
    assert.ok(Array.isArray(result.demoted), "resultado.demoted deve ser array");
    assert.equal(result.demoted.length, 0, "sem demotions esperadas");
  });
});

// ---------------------------------------------------------------------------
// #2338 fix 2 — from===to annotation + empty-from guard
// ---------------------------------------------------------------------------

describe("#2338/fix2 — from===to repeated URL annotated in reason", () => {
  it("from===to com URL repetida: reason inclui aviso que from também repete", () => {
    const url = "https://huggingface.co/some/model";
    const article: Article = {
      url,
      title: "Modelo X",
      primary_source_substituted: { from: url, to: url }, // from === to
    };
    const buckets: CategorizedFlat = { lancamento: [article], radar: [] };
    const pastUrls = pastUrlsFrom(url); // URL repete past-editions

    const result = checkPromotedDedup(buckets, pastUrls);

    assert.equal(result.demoted.length, 1, "deve demote");
    const demotedReason = result.demoted[0].reason;
    // reason must flag that the from URL also repeats, so editor knows not to re-promote
    assert.match(
      demotedReason,
      /from.*repete|também repete/i,
      "#2338: reason deve avisar que from (=URL de pesquisa original) também repete past-editions",
    );
  });

  it("from===to com URL NÃO repetida: reason NÃO inclui sufixo de from-repeat", () => {
    // within-edition duplicate: from===to but URL not in past-editions
    const url = "https://openai.com/blog/new-model";
    const article1: Article = {
      url,
      title: "New Model A",
      primary_source_substituted: { from: url, to: url },
    };
    const article2: Article = {
      url,
      title: "New Model B",
      primary_source_substituted: { from: url, to: url },
    };
    const buckets: CategorizedFlat = { lancamento: [article1, article2], radar: [] };
    const pastUrls = new Set<string>(); // não repete past-editions

    const result = checkPromotedDedup(buckets, pastUrls);

    // O segundo deve ser demotado por within-edition duplicate
    assert.ok(result.demoted.length >= 1, "pelo menos 1 demote por within-edition duplicate");
    // O reason do within-edition duplicate não deve mencionar "from repete" (URL é nova)
    const withinReason = result.demoted[0].reason;
    assert.doesNotMatch(
      withinReason,
      /from.*repete/i,
      "#2338: reason de within-edition-duplicate não deve incluir sufixo de from-repeat quando URL não está em past-editions",
    );
  });
});

describe("#2338/fix2 — empty from guard", () => {
  it("from='' com to válido e repetido: deve demote (não pular silenciosamente)", () => {
    const officialUrl = "https://huggingface.co/some/model";
    const article: Article = {
      url: officialUrl,
      title: "Modelo Y",
      primary_source_substituted: { from: "", to: officialUrl }, // from vazio
    };
    const buckets: CategorizedFlat = { lancamento: [article], radar: [] };
    const pastUrls = pastUrlsFrom(officialUrl); // URL oficial repete

    const result = checkPromotedDedup(buckets, pastUrls);

    // Deve ter verificado e demotado (não pulado por from vazio)
    assert.equal(result.checked, 1, "#2338: from:'' não deve impedir a verificação de to");
    assert.equal(result.demoted.length, 1, "#2338: deve demote quando to repete, mesmo com from:''");
    assert.equal(buckets.lancamento?.length, 0, "artigo deve sair de lancamento");
    assert.equal(buckets.radar?.length, 1, "artigo deve ir pra radar");
    // O item demotado deve ter URL navegável (não vazia) — fallback para article.url quando from===''
    const radarUrl = buckets.radar![0].url;
    assert.notEqual(radarUrl, "", "#2338: radar item deve ter URL navegável (não '' mesmo com from vazio)");
    assert.ok(typeof radarUrl === "string" && radarUrl.startsWith("http"), "#2338: URL do radar item deve ser uma URL válida");
  });

  it("from='' com to válido e NÃO repetido: mantém em lancamento", () => {
    const officialUrl = "https://openai.com/blog/brand-new";
    const article: Article = {
      url: officialUrl,
      title: "Coisa Nova",
      primary_source_substituted: { from: "", to: officialUrl },
    };
    const buckets: CategorizedFlat = { lancamento: [article], radar: [] };
    const pastUrls = new Set<string>(); // sem histórico

    const result = checkPromotedDedup(buckets, pastUrls);

    assert.equal(result.checked, 1, "#2338: from:'' deve ser verificado normalmente");
    assert.equal(result.demoted.length, 0, "URL nova não deve ser demotada");
    assert.equal(buckets.lancamento?.length, 1, "artigo deve permanecer em lancamento");
  });
});
