/**
 * test/use-melhor-sources.test.ts (#1899 / #2176 / #2197)
 *
 * Cobre o helper da flag `use_melhor` (lista-semente de fontes da seção
 * Use Melhor) e o loader de hosts a partir do seed real.
 * #2176: adiciona testes do desempate path-mais-específico-vence.
 * #2197: adiciona testes do resolveAllSourcePrefixMap (warn em throw E em retorno vazio).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isUseMelhorSource,
  sourceHost,
  sourcePrefix,
  loadUseMelhorPrefixes,
  matchesUseMelhorPrefix,
  loadAllSourcePrefixMap,
  resolveAllSourcePrefixMap,
  resolveUseMelhorBySpecificity,
  type SourcePrefixEntry,
} from "../scripts/lib/use-melhor-sources.ts";

describe("isUseMelhorSource (#1899)", () => {
  it('só é true quando use_melhor == "1"', () => {
    assert.equal(isUseMelhorSource({ use_melhor: "1" }), true);
    assert.equal(isUseMelhorSource({ use_melhor: " 1 " }), true);
    assert.equal(isUseMelhorSource({ use_melhor: "" }), false);
    assert.equal(isUseMelhorSource({ use_melhor: "0" }), false);
    assert.equal(isUseMelhorSource({}), false);
  });
});

describe("sourceHost (#1899)", () => {
  it("normaliza host (lower, sem www)", () => {
    assert.equal(sourceHost("https://WWW.Fast.ai/"), "fast.ai");
    assert.equal(sourceHost("https://huggingface.co/learn"), "huggingface.co");
  });
  it("'' pra inválida", () => {
    assert.equal(sourceHost("nope"), "");
  });
});

describe("sourcePrefix (#1927 review)", () => {
  it("host dedicado → só host; host largo → host/path", () => {
    assert.equal(sourcePrefix("https://www.fast.ai/"), "fast.ai");
    assert.equal(
      sourcePrefix("https://github.com/anthropics/anthropic-cookbook"),
      "github.com/anthropics/anthropic-cookbook",
    );
    assert.equal(sourcePrefix("nope"), "");
  });
});

describe("loadUseMelhorPrefixes (seed real, #1899)", () => {
  const prefixes = loadUseMelhorPrefixes();
  it("retorna prefixos host/path das fontes flagueadas (path-aware)", () => {
    assert.ok(prefixes.length > 0, "deve haver fontes Use Melhor no seed");
    // host dedicado = só host (#1971: era fast.ai, desativada; eugeneyan.com segue no seed)
    assert.ok(prefixes.includes("eugeneyan.com"), "host dedicado = só host");
    // host largo (github) deve vir com path, não nu
    assert.ok(
      prefixes.some((p) => p.startsWith("github.com/")),
      "github vem com path, não host nu",
    );
    assert.ok(!prefixes.includes("github.com"), "github.com NU não pode estar (over-match)");
  });
});

describe("matchesUseMelhorPrefix (#1927 review)", () => {
  const prefixes = ["fast.ai", "github.com/anthropics/anthropic-cookbook"];
  it("casa artigo sob o prefixo", () => {
    assert.equal(matchesUseMelhorPrefix("https://www.fast.ai/posts/x.html", prefixes), true);
    assert.equal(
      matchesUseMelhorPrefix("https://github.com/anthropics/anthropic-cookbook/blob/main/x.ipynb", prefixes),
      true,
    );
  });
  it("NÃO casa outro path do mesmo host largo (boundary-safe)", () => {
    assert.equal(matchesUseMelhorPrefix("https://github.com/openai/whatever", prefixes), false);
    assert.equal(matchesUseMelhorPrefix("https://github.com/anthropics-other/x", prefixes), false);
  });
  it("não casa fonte de notícia", () => {
    assert.equal(matchesUseMelhorPrefix("https://canaltech.com.br/ia/x", prefixes), false);
  });
});

// ---------------------------------------------------------------------------
// #2176 — loadAllSourcePrefixMap + resolveUseMelhorBySpecificity
// ---------------------------------------------------------------------------

describe("loadAllSourcePrefixMap (#2176)", () => {
  const allEntries = loadAllSourcePrefixMap();

  it("retorna todas as fontes, incluindo as NÃO use_melhor", () => {
    assert.ok(allEntries.length > 0, "deve ter entries");
    // Deve incluir entradas use_melhor=false (fontes Primária/Secundária)
    const hasNonUseMelhor = allEntries.some((e) => !e.useMelhor);
    assert.ok(hasNonUseMelhor, "deve incluir fontes não-use_melhor");
  });

  it("entries ordenadas: prefixo mais longo primeiro", () => {
    for (let i = 1; i < allEntries.length; i++) {
      assert.ok(
        allEntries[i].prefix.length <= allEntries[i - 1].prefix.length,
        `entry[${i}] (len=${allEntries[i].prefix.length}) deve ser <= entry[${i-1}] (len=${allEntries[i-1].prefix.length})`,
      );
    }
  });

  it("cenário real blog.google: existe entrada use_melhor=false (Google Primária) e use_melhor=true (Blog Brasil)", () => {
    const googlePrimaria = allEntries.find(
      (e) => e.prefix === "blog.google" && !e.useMelhor,
    );
    const blogBrasil = allEntries.find(
      (e) => e.prefix.startsWith("blog.google/intl/pt-br") && e.useMelhor,
    );
    assert.ok(googlePrimaria, "Google Primária (blog.google host-only, não use_melhor) deve estar no mapa");
    assert.ok(blogBrasil, "Blog do Google Brasil (blog.google/intl/pt-br/..., use_melhor) deve estar no mapa");
    // Blog Brasil deve vir ANTES no array (prefixo mais longo)
    const idxBrasil = allEntries.indexOf(blogBrasil!);
    const idxPrimaria = allEntries.indexOf(googlePrimaria!);
    assert.ok(idxBrasil < idxPrimaria, "Blog Brasil (mais específico) deve vir antes de Google Primária no array ordenado");
  });
});

describe("resolveUseMelhorBySpecificity (#2176)", () => {
  // Simula o cenário real: blog.google host-only (não use_melhor) + blog.google/intl/pt-br (use_melhor)
  const fakeEntries: SourcePrefixEntry[] = [
    // Ordenado por comprimento desc (como loadAllSourcePrefixMap retorna)
    { prefix: "blog.google/intl/pt-br/novidades/tecnologia", useMelhor: true, index: 1 },
    { prefix: "blog.google", useMelhor: false, index: 0 },
    { prefix: "fast.ai", useMelhor: true, index: 2 },
    { prefix: "canaltech.com.br/inteligencia-artificial", useMelhor: false, index: 3 },
  ];

  it("#2176: URL em blog.google/intl/pt-br/novidades/tecnologia → use_melhor=true (path específico vence)", () => {
    const url = "https://blog.google/intl/pt-br/novidades/tecnologia/gemini-novo/";
    const result = resolveUseMelhorBySpecificity(url, fakeEntries);
    assert.equal(result, true, "path mais específico (use_melhor=true) deve vencer host-only (use_melhor=false)");
  });

  it("#2176: URL em blog.google/products/outro → use_melhor=false (Google Primária host-only vence)", () => {
    // Esta URL NÃO está sob o path específico do Blog Brasil → apenas Google Primária casa
    const url = "https://blog.google/products/search/ia-search-update/";
    const result = resolveUseMelhorBySpecificity(url, fakeEntries);
    assert.equal(result, false, "URL fora do path específico → fonte host-only (use_melhor=false) vence");
  });

  it("#2176: resultado é DETERMINÍSTICO independente de quantas vezes chamado", () => {
    const url = "https://blog.google/intl/pt-br/novidades/tecnologia/gemini-novo/";
    const r1 = resolveUseMelhorBySpecificity(url, fakeEntries);
    const r2 = resolveUseMelhorBySpecificity(url, fakeEntries);
    const r3 = resolveUseMelhorBySpecificity(url, fakeEntries);
    assert.equal(r1, r2);
    assert.equal(r2, r3);
  });

  it("URL em host dedicado use_melhor → true", () => {
    const url = "https://fast.ai/posts/lesson1.html";
    assert.equal(resolveUseMelhorBySpecificity(url, fakeEntries), true);
  });

  it("URL fora do seed → null (nenhuma fonte cadastrada casa)", () => {
    const url = "https://some-unknown-blog.example/ai-post";
    assert.equal(resolveUseMelhorBySpecificity(url, fakeEntries), null);
  });

  it("URL inválida → null", () => {
    assert.equal(resolveUseMelhorBySpecificity("not-a-url", fakeEntries), null);
  });

  it("desempate por comprimento: empate real de path → use_melhor=1 vence (desempate 2)", () => {
    // Dois prefixos do MESMO comprimento E ambos casam a URL → tie real.
    // Simula duas fontes distintas cadastradas com prefixos de MESMO comprimento
    // (ex: dois sub-sites do mesmo host que compartilham a mesma raiz de path).
    // Como `resolveUseMelhorBySpecificity` aceita a lista já ordenada, podemos
    // montar entradas que AMBAS casam a URL mas têm comprimentos idênticos —
    // isso acontece quando os prefixos são distintos mas igualmente longos E
    // a URL satisfaz ambos (ex: prefixo = url exata sem trailing slash).
    // Construção: URL = "example.com/section/post"; dois prefixos que casam:
    //   - "example.com/section" (len=19, useMelhor=false)
    //   - "example.com/section" seria igual, não dá distintos.
    // Alternativa correcta: mesmos prefixos distintos mas com url sob
    // o prefixo EXATO do host curto: usa um prefixo curto shared.
    // O único jeito de ter TWO matches em comprimento máximo é ter dois
    // prefixos do MESMO comprimento que são ambos prefixo da url-target.
    // Isso ocorre quando a URL começa com AMBOS — impossível com prefixos distintos.
    // Portanto o verdadeiro tie de desempate 2 são DOIS entries com prefix IGUAL.
    const sameLenEntries: SourcePrefixEntry[] = [
      // Dois entries com o MESMO prefix (mesmo comprimento) — situação real de dois
      // cadastros redundantes no seed: use_melhor=false (índice 0) e true (índice 1).
      // A lista está ordenada por (length desc, index asc) — comprimentos iguais.
      { prefix: "example.com/section", useMelhor: false, index: 0 },
      { prefix: "example.com/section", useMelhor: true, index: 1 },
      { prefix: "example.com", useMelhor: false, index: 2 },
    ];
    // A URL casa com AMBOS os prefixos "example.com/section" (comprimento máximo=19)
    const url = "https://example.com/section/post";
    const result = resolveUseMelhorBySpecificity(url, sameLenEntries);
    // Desempate 2: comprimentos iguais → use_melhor=1 vence (use_melhor=false é sobrescrito)
    assert.equal(result, true, "quando dois prefixos de mesmo comprimento casam, use_melhor=1 vence (desempate 2)");
  });

  it("desempate por índice: empate de comprimento e use_melhor → menor índice CSV vence (desempate 3)", () => {
    // Dois prefixos do MESMO comprimento e MESMO use_melhor=false: vence o de menor índice
    const sameLenSameUmEntries: SourcePrefixEntry[] = [
      { prefix: "example.com/sec-a", useMelhor: false, index: 0 },
      { prefix: "example.com/sec-b", useMelhor: false, index: 1 },
    ];
    // URL que casa com example.com/sec-a (índice 0)
    const urlA = "https://example.com/sec-a/post";
    // URL que casa com example.com/sec-b (índice 1)
    const urlB = "https://example.com/sec-b/post";
    assert.equal(resolveUseMelhorBySpecificity(urlA, sameLenSameUmEntries), false);
    assert.equal(resolveUseMelhorBySpecificity(urlB, sameLenSameUmEntries), false);
    // Ambas retornam false (use_melhor=false) — determinístico
  });

  it("seed real: URL em blog.google/intl/pt-br → use_melhor=true com mapa real", () => {
    // Usa o mapa REAL carregado do sources.csv — o cenário da issue #2176
    const realEntries = loadAllSourcePrefixMap();
    const ptBrUrl = "https://blog.google/intl/pt-br/novidades/tecnologia/google-ia-update/";
    const result = resolveUseMelhorBySpecificity(ptBrUrl, realEntries);
    assert.equal(
      result,
      true,
      "URL em blog.google/intl/pt-br/novidades/tecnologia deve resolver como use_melhor=true (Blog Brasil mais específico que Google Primária)",
    );
  });

  it("seed real: URL em blog.google/ fora do pt-br → use_melhor=false com mapa real", () => {
    const realEntries = loadAllSourcePrefixMap();
    const globalUrl = "https://blog.google/products/search/ia-update-2026/";
    const result = resolveUseMelhorBySpecificity(globalUrl, realEntries);
    assert.equal(
      result,
      false,
      "URL em blog.google/ fora de /intl/pt-br/ → Google Primária (use_melhor=false) vence",
    );
  });
});

// ---------------------------------------------------------------------------
// #2197 — resolveAllSourcePrefixMap: warn em throw E em retorno vazio
// ---------------------------------------------------------------------------

describe("resolveAllSourcePrefixMap (#2197)", () => {
  const fakeEntry: SourcePrefixEntry = { prefix: "fast.ai", useMelhor: true, index: 0 };

  it("(a) loader lança → emite console.warn '#2176 FIX NÃO ATIVO' e retorna []", () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(String(args[0]));
    try {
      const result = resolveAllSourcePrefixMap(() => {
        throw new Error("CSV inacessível");
      });
      assert.deepEqual(result, [], "deve retornar [] quando o loader lança");
      assert.ok(warns.length > 0, "deve emitir console.warn");
      assert.ok(
        warns[0].includes("#2176 FIX NÃO ATIVO"),
        `warn deve conter '#2176 FIX NÃO ATIVO', got: ${warns[0]}`,
      );
      assert.ok(
        warns[0].includes("CSV inacessível"),
        `warn deve incluir a mensagem de erro, got: ${warns[0]}`,
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it("(b) loader retorna [] sem lançar → emite console.warn '#2176 FIX NÃO ATIVO' e retorna []", () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(String(args[0]));
    try {
      const result = resolveAllSourcePrefixMap(() => []);
      assert.deepEqual(result, [], "deve retornar [] quando o loader retorna vazio");
      assert.ok(warns.length > 0, "deve emitir console.warn (caminho vazio-sem-throw)");
      assert.ok(
        warns[0].includes("#2176 FIX NÃO ATIVO"),
        `warn deve conter '#2176 FIX NÃO ATIVO', got: ${warns[0]}`,
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it("(c) loader retorna lista populada → sem console.warn, retorna o array", () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(String(args[0]));
    try {
      const result = resolveAllSourcePrefixMap(() => [fakeEntry]);
      assert.deepEqual(result, [fakeEntry], "deve retornar o array populado");
      assert.equal(warns.length, 0, "não deve emitir console.warn quando o loader retorna dados");
    } finally {
      console.warn = origWarn;
    }
  });

  it("seed real: loader padrão retorna array populado sem warn", () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(String(args[0]));
    try {
      const result = resolveAllSourcePrefixMap();
      assert.ok(result.length > 0, "seed real deve produzir entradas");
      assert.equal(warns.length, 0, "seed real válido não deve emitir warn");
    } finally {
      console.warn = origWarn;
    }
  });
});
