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
  hasSinglePageContentChanged,
  buildSinglePageIndexNowPayload,
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

  it("#7347: index-page.generated.ts NÃO vira /temas/index-page (404) — vira /temas/", () => {
    assert.deepEqual(
      buildIndexNowUrls(["workers/arquivo/src/hubs/index-page.generated.ts"]),
      [`https://${ARQUIVO_HOST}/temas/`],
    );
  });

  it("#7347: hub real + index-page no mesmo push -> 2 URLs distintas, sem 404", () => {
    assert.deepEqual(
      buildIndexNowUrls([
        "workers/arquivo/src/hubs/anthropic-claude.generated.ts",
        "workers/arquivo/src/hubs/index-page.generated.ts",
      ]),
      [`https://${ARQUIVO_HOST}/temas/anthropic-claude`, `https://${ARQUIVO_HOST}/temas/`],
    );
  });

  it("#7347: qualquer .generated.ts fora de HUB_REGISTRY (não só index-page) mapeia pra /temas/, nunca 404", () => {
    // Fecha a classe inteira, não só o caso hardcoded "index-page" — um
    // artefato futuro no mesmo diretório que não seja um hub registrado
    // nunca deve produzir uma URL /temas/{slug} inexistente.
    assert.deepEqual(
      buildIndexNowUrls(["workers/arquivo/src/hubs/algum-artefato-novo.generated.ts"]),
      [`https://${ARQUIVO_HOST}/temas/`],
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

describe("hasSinglePageContentChanged (#5703)", () => {
  const WATCH = ["workers/cursos/src/courses-full.generated.ts", "workers/cursos/public/index.html"];

  it("arquivo alterado bate exatamente com um watchPrefix -> true", () => {
    assert.equal(hasSinglePageContentChanged(["workers/cursos/src/courses-full.generated.ts"], WATCH), true);
  });

  it("arquivo alterado é um prefixo watched (diretório) -> true", () => {
    assert.equal(hasSinglePageContentChanged(["workers/livros/public/index.html"], ["workers/livros/public/"]), true);
  });

  it("nenhum arquivo alterado casa -> false (o gate)", () => {
    assert.equal(hasSinglePageContentChanged(["workers/cursos/wrangler.toml", "workers/cursos/README.md"], WATCH), false);
  });

  it("lista de arquivos vazia -> false", () => {
    assert.equal(hasSinglePageContentChanged([], WATCH), false);
  });

  it("watchPrefixes vazio -> false, mesmo com arquivos alterados", () => {
    assert.equal(hasSinglePageContentChanged(["workers/cursos/src/courses-full.generated.ts"], []), false);
  });

  it("normaliza separador de path Windows (\\\\ -> /)", () => {
    assert.equal(
      hasSinglePageContentChanged(["workers\\cursos\\src\\courses-full.generated.ts"], WATCH),
      true,
    );
  });
});

describe("buildSinglePageIndexNowPayload (#5703)", () => {
  const WATCH = ["workers/cursos/src/courses-full.generated.ts"];

  it("monta payload de 1 URL (a raiz) quando o gate abre e a chave está presente", () => {
    const payload = buildSinglePageIndexNowPayload(WATCH, "chave-cursos", {
      host: "cursos.diar.ia.br",
      watchPrefixes: WATCH,
    });
    assert.ok(payload);
    assert.equal(payload!.host, "cursos.diar.ia.br");
    assert.equal(payload!.key, "chave-cursos");
    assert.equal(payload!.keyLocation, "https://cursos.diar.ia.br/chave-cursos.txt");
    assert.deepEqual(payload!.urlList, ["https://cursos.diar.ia.br/"]);
  });

  it("nenhum watchPrefix alterado -> null (gate fechado)", () => {
    assert.equal(
      buildSinglePageIndexNowPayload(["workers/cursos/README.md"], "chave", {
        host: "cursos.diar.ia.br",
        watchPrefixes: WATCH,
      }),
      null,
    );
  });

  it("chave vazia -> null, mesmo com watchPrefix alterado", () => {
    assert.equal(
      buildSinglePageIndexNowPayload(WATCH, "", { host: "cursos.diar.ia.br", watchPrefixes: WATCH }),
      null,
    );
  });

  it("baseUrl customizado é respeitado no keyLocation e na urlList", () => {
    const payload = buildSinglePageIndexNowPayload(WATCH, "k", {
      host: "livros.diar.ia.br",
      baseUrl: "https://staging.example.com",
      watchPrefixes: WATCH,
    });
    assert.ok(payload);
    assert.equal(payload!.keyLocation, "https://staging.example.com/k.txt");
    assert.deepEqual(payload!.urlList, ["https://staging.example.com/"]);
  });
});
