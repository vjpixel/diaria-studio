/**
 * test/indexnow.test.ts (#4909 item 2)
 *
 * Regressão pura pra `scripts/lib/indexnow.ts` — builder do payload IndexNow
 * + gate "mudou desde o último deploy". Nenhum teste bate em rede — este
 * módulo não faz I/O (o POST em si vive em `scripts/ping-indexnow.ts`,
 * coberto separadamente com `fetch` injetado/mockado).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractChangedHubSlugs,
  buildIndexNowUrls,
  buildIndexNowPayload,
  ARQUIVO_HOST,
} from "../scripts/lib/indexnow.ts";

describe("extractChangedHubSlugs (#4909)", () => {
  it("extrai o slug de um .generated.ts alterado", () => {
    assert.deepEqual(
      extractChangedHubSlugs(["workers/arquivo/src/hubs/anthropic-claude.generated.ts"]),
      ["anthropic-claude"],
    );
  });

  it("extrai múltiplos slugs, preservando ordem", () => {
    assert.deepEqual(
      extractChangedHubSlugs([
        "workers/arquivo/src/hubs/anthropic-claude.generated.ts",
        "workers/arquivo/src/hubs/openai-chatgpt.generated.ts",
      ]),
      ["anthropic-claude", "openai-chatgpt"],
    );
  });

  it("lista sem nenhum .generated.ts -> lista vazia (o gate)", () => {
    assert.deepEqual(
      extractChangedHubSlugs([
        "scripts/build-hub-page.ts",
        "workers/arquivo/src/hubs/registry.ts",
        "workers/arquivo/src/hubs/meta.ts",
        "docs/seo-notes.md",
      ]),
      [],
    );
  });

  it("lista vazia -> lista vazia", () => {
    assert.deepEqual(extractChangedHubSlugs([]), []);
  });

  it("ignora .generated.ts fora de workers/arquivo/src/hubs/", () => {
    assert.deepEqual(
      extractChangedHubSlugs(["workers/cursos/src/courses-full.generated.ts"]),
      [],
    );
  });

  it("normaliza separador de path Windows (\\\\ -> /)", () => {
    assert.deepEqual(
      extractChangedHubSlugs(["workers\\arquivo\\src\\hubs\\google-gemini.generated.ts"]),
      ["google-gemini"],
    );
  });

  it("descarta um path com barra no slug resultante (defensivo — layout não tem subdiretório)", () => {
    assert.deepEqual(
      extractChangedHubSlugs(["workers/arquivo/src/hubs/sub/dir.generated.ts"]),
      [],
    );
  });
});

describe("buildIndexNowUrls (#4909)", () => {
  it("1 hub alterado -> 1 URL /temas/{slug}", () => {
    assert.deepEqual(
      buildIndexNowUrls(["workers/arquivo/src/hubs/anthropic-claude.generated.ts"]),
      [`https://${ARQUIVO_HOST}/temas/anthropic-claude`],
    );
  });

  it("nenhum .generated.ts alterado -> [] (gate fechado)", () => {
    assert.deepEqual(buildIndexNowUrls(["scripts/build-hub-page.ts"]), []);
  });

  it("baseUrl customizado é respeitado", () => {
    assert.deepEqual(
      buildIndexNowUrls(["workers/arquivo/src/hubs/meta-ai.generated.ts"], "https://staging.example.com"),
      ["https://staging.example.com/temas/meta-ai"],
    );
  });
});

describe("buildIndexNowPayload (#4909)", () => {
  const CHANGED = ["workers/arquivo/src/hubs/anthropic-claude.generated.ts"];

  it("monta payload completo quando há URL a pingar e chave presente", () => {
    const payload = buildIndexNowPayload(CHANGED, "minha-chave-opaca");
    assert.ok(payload);
    assert.equal(payload!.host, ARQUIVO_HOST);
    assert.equal(payload!.key, "minha-chave-opaca");
    assert.equal(payload!.keyLocation, `https://${ARQUIVO_HOST}/minha-chave-opaca.txt`);
    assert.deepEqual(payload!.urlList, [`https://${ARQUIVO_HOST}/temas/anthropic-claude`]);
  });

  it("lista sem .generated.ts -> null (gate fechado), mesmo com chave presente", () => {
    assert.equal(buildIndexNowPayload(["docs/seo-notes.md"], "minha-chave"), null);
  });

  it("chave vazia -> null, mesmo com .generated.ts alterado", () => {
    assert.equal(buildIndexNowPayload(CHANGED, ""), null);
  });

  it("host/baseUrl customizados propagam pro keyLocation e urlList", () => {
    const payload = buildIndexNowPayload(CHANGED, "k", {
      host: "outro.host",
      baseUrl: "https://outro.host",
    });
    assert.ok(payload);
    assert.equal(payload!.host, "outro.host");
    assert.equal(payload!.keyLocation, "https://outro.host/k.txt");
    assert.deepEqual(payload!.urlList, ["https://outro.host/temas/anthropic-claude"]);
  });
});
