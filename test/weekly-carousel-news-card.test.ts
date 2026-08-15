/**
 * weekly-carousel-news-card.test.ts (#5330)
 *
 * resolveOrGenerateNewsCardUrl: recompõe o título de um card D1/D2/D3 com o
 * tamanho de fonte único do carrossel, gerando um arquivo/upload NOVO —
 * nunca sobrescreve `04-{destaque}-4x5.jpg` (o card já publicado no feed
 * diário). `generator` é sempre um fake injetado em teste (nunca a
 * implementação real — sharp/upload de verdade, mesma classe de restrição
 * de `defaultSectionCardGenerator`/`defaultFlatCardGenerator`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveOrGenerateNewsCardUrl, type NewsCardGenerator } from "../scripts/lib/weekly-carousel-news-card.ts";

describe("resolveOrGenerateNewsCardUrl (cache + recomposição)", () => {
  it("cache MISS: chama o generator 1x com os dados corretos, grava em 06-news-cards.json, retorna a URL", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-newscard-"));
    try {
      let calls = 0;
      let capturedInput: any = null;
      const generator: NewsCardGenerator = async (input) => {
        calls++;
        capturedInput = input;
        return { url: `https://cdn.example.com/${input.kvKey}` };
      };
      const result = await resolveOrGenerateNewsCardUrl(
        dataRoot,
        "260815-highlights",
        {
          editionDate: "260810",
          editionDir: "/fake/edition/dir",
          destaque: "d1",
          title: "Título do destaque",
          category: "NOTÍCIAS",
          fontSize: 62,
        },
        generator,
      );
      assert.equal(calls, 1);
      // #5330 fleet review: fontSize agora faz parte da chave/kvKey (evita
      // servir cache com tamanho desatualizado).
      // #5386: kvKey precisa casar com a allowlist `img-` do Worker (nunca
      // mais `weekly/{carouselKey}/{key}-4x5.jpg` — ver `poll-img-key-allowlist-weekly-5386.test.ts`).
      assert.equal(result.url, "https://cdn.example.com/img-unknown-weekly-260815-highlights-260810-d1-62-4x5.jpg");
      assert.equal(capturedInput.fontSize, 62);
      assert.equal(capturedInput.title, "Título do destaque");
      const cachePath = join(dataRoot, "weekly", "260815-highlights", "_internal", "06-news-cards.json");
      assert.ok(existsSync(cachePath));
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      assert.equal(cached["260810-d1-62"].url, result.url);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("cache HIT (2ª chamada, mesma edição+destaque): NUNCA chama o generator de novo", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-newscard-"));
    try {
      let calls = 0;
      const generator: NewsCardGenerator = async ({ kvKey }) => {
        calls++;
        return { url: `https://cdn.example.com/${kvKey}` };
      };
      const input = {
        editionDate: "260810",
        editionDir: "/fake/edition/dir",
        destaque: "d1",
        title: "Título",
        category: "NOTÍCIAS",
        fontSize: 62,
      };
      const result1 = await resolveOrGenerateNewsCardUrl(dataRoot, "260815-highlights", input, generator);
      const result2 = await resolveOrGenerateNewsCardUrl(dataRoot, "260815-highlights", input, generator);
      assert.equal(calls, 1, "2ª chamada deveria ser cache hit");
      assert.equal(result1.url, result2.url);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("#5330 fleet review (correctness): fontSize DIFERENTE pra mesma edição+destaque é cache MISS — nunca serve card com tamanho desatualizado", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-newscard-"));
    try {
      let calls = 0;
      const generator: NewsCardGenerator = async ({ kvKey }) => {
        calls++;
        return { url: `https://cdn.example.com/${kvKey}` };
      };
      const base = { editionDate: "260810", editionDir: "/fake", destaque: "d1", title: "D1", category: "NOTÍCIAS" };
      // Simula um re-run do mesmo carrossel com um fontSize recalculado
      // diferente (ex: editor trocou 1 item, mudando o título mais
      // restritivo) — sem fontSize na chave, isso serviria o card ANTIGO
      // em silêncio, quebrando a padronização visual que este módulo existe
      // pra garantir.
      const result1 = await resolveOrGenerateNewsCardUrl(dataRoot, "260815-highlights", { ...base, fontSize: 62 }, generator);
      const result2 = await resolveOrGenerateNewsCardUrl(dataRoot, "260815-highlights", { ...base, fontSize: 50 }, generator);
      assert.equal(calls, 2, "fontSize diferente deveria SEMPRE regenerar, nunca reusar o cache do tamanho antigo");
      assert.notEqual(result1.url, result2.url);
      assert.match(result1.url ?? "", /-62-4x5\.jpg$/);
      assert.match(result2.url ?? "", /-50-4x5\.jpg$/);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("d1/d2/d3 da MESMA edição nunca colidem em cache (chave inclui o destaque)", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-newscard-"));
    try {
      const generator: NewsCardGenerator = async ({ kvKey }) => ({ url: `https://cdn.example.com/${kvKey}` });
      const base = { editionDate: "260810", editionDir: "/fake", category: "NOTÍCIAS", fontSize: 62 };
      const resultD1 = await resolveOrGenerateNewsCardUrl(dataRoot, "260815-clicked", { ...base, destaque: "d1", title: "D1" }, generator);
      const resultD2 = await resolveOrGenerateNewsCardUrl(dataRoot, "260815-clicked", { ...base, destaque: "d2", title: "D2" }, generator);
      assert.notEqual(resultD1.url, resultD2.url);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("highlights e clicked do MESMO sábado, mesmo destaque, nunca colidem (carouselKey inclui o modo)", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-newscard-"));
    try {
      const generator: NewsCardGenerator = async ({ kvKey }) => ({ url: `https://cdn.example.com/${kvKey}` });
      const input = { editionDate: "260810", editionDir: "/fake", destaque: "d1", title: "D1", category: "NOTÍCIAS", fontSize: 62 };
      const resultHighlights = await resolveOrGenerateNewsCardUrl(dataRoot, "260815-highlights", input, generator);
      const resultClicked = await resolveOrGenerateNewsCardUrl(dataRoot, "260815-clicked", input, generator);
      assert.notEqual(resultHighlights.url, resultClicked.url);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("generator lança → {url: null, error}, nunca lança pro caller, nunca grava cache", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-newscard-"));
    try {
      const generator: NewsCardGenerator = async () => {
        throw new Error("arte-base ausente (simulado)");
      };
      const result = await resolveOrGenerateNewsCardUrl(
        dataRoot,
        "260815-highlights",
        { editionDate: "260810", editionDir: "/fake", destaque: "d1", title: "D1", category: "NOTÍCIAS", fontSize: 62 },
        generator,
      );
      assert.equal(result.url, null);
      assert.match(result.error ?? "", /arte-base ausente/);
      const cachePath = join(dataRoot, "weekly", "260815-highlights", "_internal", "06-news-cards.json");
      assert.equal(existsSync(cachePath), false, "erro não deveria gravar cache");
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("06-news-cards.json corrompido → {url: null, error} descrevendo a corrupção, nunca lança", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-newscard-"));
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const dir = join(dataRoot, "weekly", "260815-highlights", "_internal");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "06-news-cards.json"), "{ isto não é json válido", "utf8");

      let called = false;
      const generator: NewsCardGenerator = async ({ kvKey }) => {
        called = true;
        return { url: `https://cdn.example.com/${kvKey}` };
      };
      const result = await resolveOrGenerateNewsCardUrl(
        dataRoot,
        "260815-highlights",
        { editionDate: "260810", editionDir: "/fake", destaque: "d1", title: "D1", category: "NOTÍCIAS", fontSize: 62 },
        generator,
      );
      assert.equal(result.url, null);
      assert.match(result.error ?? "", /corrompido/);
      assert.equal(called, false, "não deveria chamar o generator com cache corrompido — reporta o erro, não mascara com regeneração");
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
