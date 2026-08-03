/**
 * weekly-instagram-ondemand-card.test.ts (#4513)
 *
 * Cobre a geração SOB DEMANDA do card 4:5 pra itens de RADAR/USE MELHOR que
 * vencem o ranking do post semanal do Instagram sem card pré-gerado.
 *
 * `defaultSectionCardGenerator` (chamada real de `image-generate.ts`/API de
 * imagem paga) NUNCA é exercitada aqui — só as funções puras (`sectionCardCacheKey`,
 * `syntheticDestaqueIdFor`, `buildOnDemandEditorialText`), a leitura/escrita de
 * cache em disco (`readSectionCardUrl`/`writeSectionCardUrl`), e a orquestração
 * (`resolveOrGenerateSectionCardUrl`) com um gerador FAKE injetado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  sectionCardCacheKey,
  syntheticDestaqueIdFor,
  buildOnDemandEditorialText,
  readSectionCardUrl,
  writeSectionCardUrl,
  resolveOrGenerateSectionCardUrl,
  type SectionCardGenerator,
} from "../scripts/lib/weekly-instagram-ondemand-card.ts";
import type { InstagramRankedCandidate } from "../scripts/lib/weekly-instagram-select.ts";

function sectionItemFixture(overrides: Partial<InstagramRankedCandidate> = {}): InstagramRankedCandidate {
  return {
    editionDate: "260727",
    url: "https://exemplo.com/radar-item",
    title: "Item de Radar bem clicado",
    body: "Descrição do item de radar.",
    why: "",
    category: "RADAR",
    kind: "section",
    section: "radar",
    uniqueVerifiedClicks: 8,
    webUniqueClicks: 1,
    opens: 100,
    ratePct: 9,
    excluded: false,
    hasClickData: true,
    ...overrides,
  };
}

describe("sectionCardCacheKey / syntheticDestaqueIdFor (pure, determinísticas)", () => {
  it("mesma URL sempre gera a mesma chave/id — idempotência do cache", () => {
    const url = "https://exemplo.com/radar-item?utm_source=x";
    assert.equal(sectionCardCacheKey("radar", url), sectionCardCacheKey("radar", url));
    assert.equal(syntheticDestaqueIdFor(url), syntheticDestaqueIdFor(url));
  });

  it("chave difere por seção mesmo pra mesma URL (radar vs use_melhor não colidem)", () => {
    const url = "https://exemplo.com/item";
    assert.notEqual(sectionCardCacheKey("radar", url), sectionCardCacheKey("use_melhor", url));
  });

  it("URLs diferentes geram chaves/ids diferentes", () => {
    assert.notEqual(
      sectionCardCacheKey("radar", "https://exemplo.com/a"),
      sectionCardCacheKey("radar", "https://exemplo.com/b"),
    );
    assert.notEqual(syntheticDestaqueIdFor("https://exemplo.com/a"), syntheticDestaqueIdFor("https://exemplo.com/b"));
  });

  it("syntheticDestaqueIdFor sempre casa com /^d9\\d+$/ — nunca colide com d1/d2/d3 reais", () => {
    for (const url of ["https://exemplo.com/a", "https://x.com/b?c=1", "not a url at all"]) {
      assert.match(syntheticDestaqueIdFor(url), /^d9\d+$/);
    }
  });

  it("normaliza query/hash/protocolo case antes de hashear — variantes da mesma URL casam", () => {
    assert.equal(
      sectionCardCacheKey("radar", "https://Exemplo.com/item?utm=1"),
      sectionCardCacheKey("radar", "https://exemplo.com/item"),
    );
  });
});

describe("buildOnDemandEditorialText", () => {
  it("concatena título + corpo (MVP — sem prompt cênico dedicado, ver docstring do arquivo)", () => {
    const text = buildOnDemandEditorialText({ title: "Título X", body: "Corpo Y." });
    assert.equal(text, "Título X. Corpo Y.");
  });
});

describe("readSectionCardUrl / writeSectionCardUrl (roundtrip em disco)", () => {
  it("readSectionCardUrl retorna null quando 06-public-images.json não existe", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-ondemand-card-"));
    try {
      assert.deepEqual(readSectionCardUrl(root, "radar_abc123_4x5"), { url: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeSectionCardUrl grava e readSectionCardUrl lê de volta, preservando chaves d1/d2/d3 já presentes (#1865)", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-ondemand-card-"));
    try {
      writeFileSync(
        resolve(root, "06-public-images.json"),
        JSON.stringify({ images: { d1: { url: "https://cdn.example.com/d1.jpg" } } }),
        "utf8",
      );
      writeSectionCardUrl(root, "radar_abc123_4x5", "https://cdn.example.com/radar-card.jpg");

      const resolved = readSectionCardUrl(root, "radar_abc123_4x5");
      assert.equal(resolved.url, "https://cdn.example.com/radar-card.jpg");

      // d1 preservado — merge-por-cima, nunca zera o cache existente.
      const raw = JSON.parse(readFileSync(resolve(root, "06-public-images.json"), "utf8"));
      assert.equal(raw.images.d1.url, "https://cdn.example.com/d1.jpg");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readSectionCardUrl reporta corruptError distinto de ausência, sem lançar", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-ondemand-card-"));
    try {
      writeFileSync(resolve(root, "06-public-images.json"), "{ not valid json", "utf8");
      const resolved = readSectionCardUrl(root, "radar_abc123_4x5");
      assert.equal(resolved.url, null);
      assert.ok(resolved.corruptError, "deveria reportar corruptError em vez de lançar");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveOrGenerateSectionCardUrl (orquestração — gerador SEMPRE injetado/fake em teste)", () => {
  it("item sem section (kind=destaque por engano) retorna erro sem chamar o gerador", async () => {
    let called = 0;
    const fakeGenerator: SectionCardGenerator = async () => {
      called++;
      return { url: "https://should-not-be-called.example.com" };
    };
    const root = mkdtempSync(join(tmpdir(), "diaria-ondemand-card-"));
    try {
      const item = sectionItemFixture({ kind: "destaque", section: undefined, destaqueNumber: 1 });
      const result = await resolveOrGenerateSectionCardUrl(item, root, fakeGenerator);
      assert.equal(result.url, null);
      assert.equal(result.generated, false);
      assert.match(result.error ?? "", /só serve pra RADAR\/USE MELHOR/);
      assert.equal(called, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cache MISS: chama o gerador exatamente 1x, grava o resultado em 06-public-images.json, retorna generated:true", async () => {
    let called = 0;
    let receivedDestaqueId = "";
    const fakeGenerator: SectionCardGenerator = async ({ destaqueId }) => {
      called++;
      receivedDestaqueId = destaqueId;
      return { url: "https://cdn.example.com/radar-card-gerado.jpg" };
    };
    const root = mkdtempSync(join(tmpdir(), "diaria-ondemand-card-"));
    try {
      const item = sectionItemFixture();
      const result = await resolveOrGenerateSectionCardUrl(item, root, fakeGenerator);
      assert.equal(result.url, "https://cdn.example.com/radar-card-gerado.jpg");
      assert.equal(result.generated, true);
      assert.equal(called, 1);
      assert.match(receivedDestaqueId, /^d9\d+$/);

      const cacheKey = sectionCardCacheKey("radar", item.url);
      const cached = JSON.parse(readFileSync(resolve(root, "06-public-images.json"), "utf8"));
      assert.equal(cached.images[cacheKey].url, "https://cdn.example.com/radar-card-gerado.jpg");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cache HIT (re-run idempotente): NUNCA chama o gerador de novo — evita custo de API repetido", async () => {
    let called = 0;
    const fakeGenerator: SectionCardGenerator = async () => {
      called++;
      return { url: "https://should-not-be-called-again.example.com" };
    };
    const root = mkdtempSync(join(tmpdir(), "diaria-ondemand-card-"));
    try {
      const item = sectionItemFixture();
      const cacheKey = sectionCardCacheKey("radar", item.url);
      writeSectionCardUrl(root, cacheKey, "https://cdn.example.com/ja-gerado.jpg");

      const result = await resolveOrGenerateSectionCardUrl(item, root, fakeGenerator);
      assert.equal(result.url, "https://cdn.example.com/ja-gerado.jpg");
      assert.equal(result.generated, false);
      assert.equal(called, 0, "gerador NUNCA deveria ser chamado em cache hit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gerador lança — erro propaga como {url:null, error}, sem gravar cache, sem lançar pro caller", async () => {
    const fakeGenerator: SectionCardGenerator = async () => {
      throw new Error("Gemini API indisponível (simulado)");
    };
    const root = mkdtempSync(join(tmpdir(), "diaria-ondemand-card-"));
    try {
      const item = sectionItemFixture();
      const result = await resolveOrGenerateSectionCardUrl(item, root, fakeGenerator);
      assert.equal(result.url, null);
      assert.equal(result.generated, false);
      assert.match(result.error ?? "", /Gemini API indisponível/);

      const cacheKey = sectionCardCacheKey("radar", item.url);
      const cached = readSectionCardUrl(root, cacheKey);
      assert.equal(cached.url, null, "falha do gerador não deveria gravar cache");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("use_melhor e radar da MESMA url resolvem cache keys diferentes (nunca colidem)", async () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-ondemand-card-"));
    try {
      const url = "https://exemplo.com/item-compartilhado";
      let calls = 0;
      const fakeGenerator: SectionCardGenerator = async () => {
        calls++;
        return { url: `https://cdn.example.com/gerado-${calls}.jpg` };
      };
      const radarItem = sectionItemFixture({ url, section: "radar", category: "RADAR" });
      const useMelhorItem = sectionItemFixture({ url, section: "use_melhor", category: "USE MELHOR" });

      const radarResult = await resolveOrGenerateSectionCardUrl(radarItem, root, fakeGenerator);
      const useMelhorResult = await resolveOrGenerateSectionCardUrl(useMelhorItem, root, fakeGenerator);

      assert.equal(calls, 2, "seções diferentes da mesma URL geram cards SEPARADOS");
      assert.notEqual(radarResult.url, useMelhorResult.url);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
