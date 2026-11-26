/**
 * test/dedup-url-key-14020-14021.test.ts (#14020, #14021)
 *
 * #14021: a chave do dedup (`dedupUrlKey`) não unificava `www.` nem o
 * esquema. O past-editions.md de 2026-10-22 lista o mesmo artigo da
 * Anthropic como `https://www.anthropic.com/...` e `http://anthropic.com/...`,
 * e as duas formas passavam como links distintos.
 *
 * #14020: o #12592 trocou a chave só em `dedup.ts`. O recheck da promoção
 * (`check-promoted-dedup`), o filtro de secundárias do `finalize-stage1` e o
 * invariante `no-duplicate-urls-vs-past-editions` do Stage 4 seguiam em
 * `canonicalize`, então a variante `/pt-BR/` escapava justamente nos passos
 * que pegam o que entra depois do dedup.
 *
 * Casos negativos: falso positivo aqui é descartar notícia nova, então URLs
 * realmente distintas (subdomínio, slug parecido com idioma, seção de 2 letras
 * fora dos domínios com idioma no caminho) seguem com chaves diferentes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, dedupUrlKey } from "../scripts/lib/url-utils.ts";
import { dedup } from "../scripts/dedup.ts";
import { checkPromotedDedup, type CategorizedFlat } from "../scripts/check-promoted-dedup.ts";
import { applyPastSecondaryFilter } from "../scripts/finalize-stage1.ts";
import { findDuplicateUrlsAgainstPastEditions } from "../scripts/lib/invariant-checks/stage-4.ts";

// Par real do data/past-editions.md (edição de 2026-10-22).
const SCORPION_WWW = "https://www.anthropic.com/research/claude-scorpion-toxin-binder-design";
const SCORPION_HTTP = "http://anthropic.com/research/claude-scorpion-toxin-binder-design";
// Reprodução do #14020.
const SHIRUDO = "https://openai.com/index/introducing-shirudo";
const SHIRUDO_PT_BR = "https://openai.com/pt-BR/index/introducing-shirudo";

describe("dedupUrlKey unifica www e esquema (#14021)", () => {
  it("o par real de 2026-10-22 vira a mesma chave", () => {
    assert.equal(dedupUrlKey(SCORPION_WWW), dedupUrlKey(SCORPION_HTTP));
  });

  it("www, sem www e http dão a mesma chave, em https sem www", () => {
    const key = "https://x.com/a";
    assert.equal(dedupUrlKey("https://www.x.com/a"), key);
    assert.equal(dedupUrlKey("https://x.com/a"), key);
    assert.equal(dedupUrlKey("http://x.com/a"), key);
    assert.equal(dedupUrlKey("http://WWW.X.com/a/"), key);
    assert.equal(dedupUrlKey("http://exame.com/a"), dedupUrlKey("https://exame.com/a"));
  });

  it("combina com o prefixo de idioma e com utm/fragmento", () => {
    assert.equal(
      dedupUrlKey("http://www.openai.com/pt-BR/index/introducing-shirudo/?utm_source=x#top"),
      dedupUrlKey(SHIRUDO),
    );
  });

  it("é idempotente", () => {
    for (const u of [SCORPION_WWW, SCORPION_HTTP, SHIRUDO_PT_BR, "http://www.x.com/en-US/a"]) {
      assert.equal(dedupUrlKey(dedupUrlKey(u)), dedupUrlKey(u));
    }
  });

  it("não funde URLs realmente distintas", () => {
    // Subdomínio real não é `www.`.
    assert.notEqual(dedupUrlKey("https://blog.x.com/a"), dedupUrlKey("https://x.com/a"));
    assert.notEqual(dedupUrlKey("https://www2.x.com/a"), dedupUrlKey("https://x.com/a"));
    // Host que só tem `www.` + TLD fica como está.
    assert.equal(dedupUrlKey("https://www.com/a"), "https://www.com/a");
    // Caminho diferente.
    assert.notEqual(dedupUrlKey("https://www.x.com/a"), dedupUrlKey("https://x.com/b"));
    // Slug parecido com idioma e seção de 2 letras fora da lista seguem no caminho.
    assert.notEqual(dedupUrlKey("https://x.com/ai-news"), dedupUrlKey("https://x.com/news"));
    assert.notEqual(dedupUrlKey("https://www.x.com/it/a"), dedupUrlKey("https://x.com/a"));
    // Query que não é tracking diferencia.
    assert.notEqual(dedupUrlKey("https://x.com/a?id=1"), dedupUrlKey("https://x.com/a?id=2"));
  });

  it("canonicalize (URL gravada) continua mantendo www, esquema e idioma", () => {
    assert.equal(canonicalize(SCORPION_WWW), SCORPION_WWW);
    assert.equal(canonicalize(SCORPION_HTTP), SCORPION_HTTP);
    assert.equal(canonicalize(SHIRUDO_PT_BR), SHIRUDO_PT_BR);
  });
});

describe("dedup() Pass 1 com www/http (#14021)", () => {
  it("past com www remove candidato http sem www", () => {
    const result = dedup(
      [
        { url: SCORPION_HTTP, title: "Claude designs scorpion toxin binder" },
        { url: "https://example.com/outra", title: "Outra notícia sem relação nenhuma" },
      ],
      new Set([canonicalize(SCORPION_WWW)]),
      0.85,
    );
    assert.deepEqual(result.kept.map((a) => a.url), ["https://example.com/outra"]);
  });
});

function promoted(researchUrl: string, officialUrl: string) {
  return {
    url: officialUrl,
    title: "Produto lançado",
    primary_source_substituted: { from: researchUrl, to: officialUrl },
  };
}

describe("checkPromotedDedup usa a chave do dedup (#14020, #14021)", () => {
  it("promoção para /pt-BR/ de URL publicada sem prefixo é rebaixada", () => {
    const research = "https://techcrunch.com/2026/11/25/openai-shirudo";
    const buckets: CategorizedFlat = {
      lancamento: [promoted(research, SHIRUDO_PT_BR)],
      radar: [],
      use_melhor: [],
      video: [],
    };
    const result = checkPromotedDedup(buckets, new Set([canonicalize(SHIRUDO)]));
    assert.equal(result.demoted.length, 1);
    assert.equal(buckets.lancamento?.length, 0);
    assert.equal(buckets.radar?.[0].url, research);
  });

  it("promoção para http sem www de URL publicada com www é rebaixada", () => {
    const research = "https://example.com/cobertura";
    const buckets: CategorizedFlat = {
      lancamento: [promoted(research, SCORPION_HTTP)],
      radar: [],
      use_melhor: [],
      video: [],
    };
    const result = checkPromotedDedup(buckets, new Set([canonicalize(SCORPION_WWW)]));
    assert.equal(result.demoted.length, 1);
  });

  it("colisão com artigo nativo na variante www é pega", () => {
    const buckets: CategorizedFlat = {
      lancamento: [promoted("https://example.com/cobertura", SCORPION_HTTP)],
      radar: [{ url: SCORPION_WWW, title: "Nativo" }],
      use_melhor: [],
      video: [],
    };
    const result = checkPromotedDedup(buckets, new Set());
    assert.equal(result.demoted.length, 1);
    assert.match(result.demoted[0].reason, /nativo/);
  });

  it("URL oficial distinta (subdomínio) não é rebaixada", () => {
    const buckets: CategorizedFlat = {
      lancamento: [promoted("https://example.com/c", "https://blog.x.com/a")],
      radar: [],
      use_melhor: [],
      video: [],
    };
    const result = checkPromotedDedup(buckets, new Set([canonicalize("https://www.x.com/a")]));
    assert.equal(result.demoted.length, 0);
    assert.equal(buckets.lancamento?.length, 1);
  });
});

describe("applyPastSecondaryFilter usa a chave do dedup (#14020, #14021)", () => {
  const mk = (url: string) => ({ url, title: url, score: 50 });

  it("descarta as variantes /pt-BR/ e www/http da secundária passada", () => {
    const { kept, dropped } = applyPastSecondaryFilter(
      [mk(SHIRUDO_PT_BR), mk(SCORPION_HTTP), mk("https://blog.x.com/a")],
      new Set([canonicalize(SHIRUDO), canonicalize(SCORPION_WWW), canonicalize("https://x.com/a")]),
      new Set(),
    );
    assert.deepEqual(dropped.map((d) => d.url), [SHIRUDO_PT_BR, SCORPION_HTTP]);
    assert.deepEqual(kept.map((a) => a.url), ["https://blog.x.com/a"]);
  });

  it("highlight promovido em outra variante segue com bypass", () => {
    const { kept, dropped } = applyPastSecondaryFilter(
      [mk(SHIRUDO_PT_BR)],
      new Set([canonicalize(SHIRUDO)]),
      new Set([SHIRUDO]),
    );
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 0);
  });
});

describe("findDuplicateUrlsAgainstPastEditions usa a chave do dedup (#14020, #14021)", () => {
  it("acusa a variante /pt-BR/ (reprodução do #14020)", () => {
    const origins = new Map([[canonicalize(SHIRUDO), "2026-11-24"]]);
    assert.equal(findDuplicateUrlsAgainstPastEditions(`**[Mesma](${SHIRUDO})**\n`, origins).length, 1);
    const m = findDuplicateUrlsAgainstPastEditions(`**[Variante](${SHIRUDO_PT_BR})**\n`, origins);
    assert.equal(m.length, 1);
    assert.equal(m[0].url, SHIRUDO_PT_BR, "a URL reportada é a do texto, intacta");
    assert.equal(m[0].originDate, "2026-11-24");
  });

  it("acusa a variante http sem www", () => {
    const origins = new Map([[canonicalize(SCORPION_WWW), "2026-10-22"]]);
    const m = findDuplicateUrlsAgainstPastEditions(`**[X](${SCORPION_HTTP})**\n`, origins);
    assert.equal(m.length, 1);
  });

  it("isenção (destaque aprovado) vale para a variante", () => {
    const origins = new Map([[canonicalize(SHIRUDO), "2026-11-24"]]);
    const m = findDuplicateUrlsAgainstPastEditions(
      `**[Variante](${SHIRUDO_PT_BR})**\n`,
      origins,
      new Set([canonicalize(SHIRUDO)]),
    );
    assert.equal(m.length, 0);
  });

  it("não acusa URL distinta (subdomínio, outro caminho)", () => {
    const origins = new Map([[canonicalize("https://www.x.com/a"), "2026-11-24"]]);
    const md = `**[A](https://blog.x.com/a)**\n\n**[B](https://x.com/b)**\n`;
    assert.equal(findDuplicateUrlsAgainstPastEditions(md, origins).length, 0);
  });
});
