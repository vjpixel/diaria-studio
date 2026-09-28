/**
 * test/google-ads-asset-group-creatives-8550.test.ts (#8550)
 *
 * Cobre `scripts/lib/google-ads-asset-group-assets.ts` (classificação +
 * payload builders puros) e `scripts/google-ads-swap-asset-group-creatives.ts`
 * (CLI, fetch mockado). Fixtures de classificação usam os 76 registros REAIS
 * lidos ao vivo em 28/09/2026 (ver docstring do módulo de lib) — reduzidos
 * aqui a uma amostra representativa de cada caso (stale/keep/needsReview/
 * protected), não o dump inteiro.
 *
 * Nenhum teste chama a API real: `fetch` é sempre mock. `--send` sem
 * `--images-manifest` (ou com manifesto incompleto) nunca deve criar nada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAssetGroupAssetsQuery,
  parseAssetGroupAssetRows,
  classifyAssetGroupAssets,
  isStaleImageName,
  validateNewTextAssetPlan,
  buildCreateTextAssetsPayload,
  buildCreateImageAssetPayload,
  buildLinkAssetGroupAssetsPayload,
  buildRemoveAssetGroupAssetsPayload,
  NEW_HEADLINES,
  NEW_LONG_HEADLINES,
  NEW_DESCRIPTIONS,
  type AssetGroupAssetApiRow,
  type AssetGroupAssetItem,
} from "../scripts/lib/google-ads-asset-group-assets.ts";
import { main as swapMain } from "../scripts/google-ads-swap-asset-group-creatives.ts";

const AUTH_ENV = {
  GOOGLE_ADS_CLIENT_ID: "client-id",
  GOOGLE_ADS_CLIENT_SECRET: "client-secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh-token",
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "6236094249",
  GOOGLE_ADS_CUSTOMER_ID: "2369219639",
};

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Nenhum adiamento (`acao-adiada`) -- cooldown do #8960 nunca bloqueia
 *  estes testes, que exercitam outros comportamentos de `--send`. */
function noAcaoAdiadaMock(): string[] {
  return [];
}

// ---------------------------------------------------------------------------
// buildAssetGroupAssetsQuery / parseAssetGroupAssetRows
// ---------------------------------------------------------------------------

describe("#8550 — buildAssetGroupAssetsQuery", () => {
  it("monta a query com o resource name do grupo interpolado", () => {
    const q = buildAssetGroupAssetsQuery("customers/2369219639/assetGroups/6642889160");
    assert.match(q, /FROM asset_group_asset/);
    assert.match(q, /asset_group_asset\.asset_group = 'customers\/2369219639\/assetGroups\/6642889160'/);
  });
});

describe("#8550 — parseAssetGroupAssetRows", () => {
  it("normaliza uma linha de texto e uma de imagem bem-formadas", () => {
    const rows: AssetGroupAssetApiRow[] = [
      {
        asset: { resourceName: "customers/1/assets/10", id: "10", type: "TEXT", textAsset: { text: "Newsletter de IA" } },
        assetGroupAsset: { resourceName: "customers/1/assetGroupAssets/g~10~HEADLINE", asset: "customers/1/assets/10", fieldType: "HEADLINE", status: "ENABLED" },
      },
      {
        asset: { resourceName: "customers/1/assets/11", id: "11", type: "IMAGE", name: "logo_1.jpg" },
        assetGroupAsset: { resourceName: "customers/1/assetGroupAssets/g~11~SQUARE_MARKETING_IMAGE", asset: "customers/1/assets/11", fieldType: "SQUARE_MARKETING_IMAGE", status: "ENABLED" },
      },
    ];
    const items = parseAssetGroupAssetRows(rows);
    assert.equal(items.length, 2);
    assert.equal(items[0].text, "Newsletter de IA");
    assert.equal(items[1].imageName, "logo_1.jpg");
  });

  it("descarta linha sem os campos mínimos (nunca lança)", () => {
    const rows: AssetGroupAssetApiRow[] = [{ asset: {}, assetGroupAsset: {} }, {}];
    assert.deepEqual(parseAssetGroupAssetRows(rows), []);
  });
});

// ---------------------------------------------------------------------------
// isStaleImageName
// ---------------------------------------------------------------------------

describe("#8550 — isStaleImageName", () => {
  it("casa os 2 padrões confirmados ao vivo (dez/2025)", () => {
    assert.equal(isStaleImageName("Generated image - 2025-12-27 10:55:41.197 (7)"), true);
    assert.equal(isStaleImageName("Gemini_Generated_Image_5g52sa5g52sa5g52_1.png"), true);
  });

  it("NÃO casa nomes legítimos (logo_1.jpg, ou undefined)", () => {
    assert.equal(isStaleImageName("logo_1.jpg"), false);
    assert.equal(isStaleImageName("ad-d1-1x1-overlay.jpg"), false);
    assert.equal(isStaleImageName(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// classifyAssetGroupAssets — amostra representativa dos 76 registros reais
// ---------------------------------------------------------------------------

function item(overrides: Partial<AssetGroupAssetItem>): AssetGroupAssetItem {
  return {
    assetGroupAssetResourceName: "customers/1/assetGroupAssets/g~x~HEADLINE",
    assetResourceName: "customers/1/assets/x",
    assetId: "x",
    fieldType: "HEADLINE",
    status: "ENABLED",
    assetType: "TEXT",
    ...overrides,
  };
}

describe("#8550 — classifyAssetGroupAssets", () => {
  it("texto genérico conhecido -> stale", () => {
    const c = classifyAssetGroupAssets([item({ text: "Newsletter de IA", assetId: "315354302078" })]);
    assert.equal(c.stale.length, 1);
    assert.equal(c.keep.length, 0);
  });

  it('"diar.ia.br" -> keep (não genérico, mais recente)', () => {
    const c = classifyAssetGroupAssets([item({ text: "diar.ia.br", assetId: "409202011006" })]);
    assert.equal(c.keep.length, 1);
    assert.equal(c.stale.length, 0);
  });

  it("texto ENABLED desconhecido -> needsReview (nunca presume)", () => {
    const c = classifyAssetGroupAssets([item({ text: "um texto que não está em nenhuma lista" })]);
    assert.equal(c.needsReview.length, 1);
  });

  it("imagem 'Generated image...' -> stale", () => {
    const c = classifyAssetGroupAssets([
      item({ fieldType: "SQUARE_MARKETING_IMAGE", assetType: "IMAGE", text: undefined, imageName: "Generated image - 2025-12-27 10:55:41.197 (5)" }),
    ]);
    assert.equal(c.stale.length, 1);
  });

  it("logo_1.jpg -> needsReview (issue não resolveu, nunca auto-decide)", () => {
    const c = classifyAssetGroupAssets([item({ fieldType: "SQUARE_MARKETING_IMAGE", assetType: "IMAGE", text: undefined, imageName: "logo_1.jpg" })]);
    assert.equal(c.needsReview.length, 1);
    assert.equal(c.stale.length, 0);
    assert.equal(c.keep.length, 0);
  });

  it("YOUTUBE_VIDEO, CALL_TO_ACTION_SELECTION, LOGO, LANDSCAPE_LOGO, BUSINESS_NAME -> sempre protected", () => {
    const protectedTypes = ["YOUTUBE_VIDEO", "CALL_TO_ACTION_SELECTION", "LOGO", "LANDSCAPE_LOGO", "BUSINESS_NAME"] as const;
    const items = protectedTypes.map((fieldType) => item({ fieldType, assetType: "TEXT", text: "qualquer coisa" }));
    const c = classifyAssetGroupAssets(items);
    assert.equal(c.protectedItems.length, protectedTypes.length);
    assert.equal(c.stale.length, 0);
    assert.equal(c.needsReview.length, 0);
  });

  it("itens REMOVED/PAUSED são ignorados (já não estão ativos)", () => {
    const c = classifyAssetGroupAssets([
      item({ text: "Newsletter de IA", status: "REMOVED" }),
      item({ text: "diar.ia.br", status: "PAUSED" }),
    ]);
    assert.equal(c.stale.length, 0);
    assert.equal(c.keep.length, 0);
    assert.equal(c.needsReview.length, 0);
    assert.equal(c.protectedItems.length, 0);
  });

  it("amostra mista reproduz as proporções do dump real (28/09/2026)", () => {
    const items: AssetGroupAssetItem[] = [
      item({ text: "Newsletter de IA" }),
      item({ text: "Tutoriais de IA Diários" }),
      item({ text: "diar.ia.br" }),
      item({ fieldType: "SQUARE_MARKETING_IMAGE", assetType: "IMAGE", text: undefined, imageName: "Generated image - 2025-12-27 10:55:41.197" }),
      item({ fieldType: "SQUARE_MARKETING_IMAGE", assetType: "IMAGE", text: undefined, imageName: "logo_1.jpg" }),
      item({ fieldType: "YOUTUBE_VIDEO", assetType: "VIDEO", text: undefined }),
    ];
    const c = classifyAssetGroupAssets(items);
    assert.equal(c.stale.length, 3); // 2 headlines genéricos + 1 imagem "Generated image"
    assert.equal(c.keep.length, 1); // diar.ia.br
    assert.equal(c.needsReview.length, 1); // logo_1.jpg
    assert.equal(c.protectedItems.length, 1); // youtube video
  });
});

// ---------------------------------------------------------------------------
// validateNewTextAssetPlan
// ---------------------------------------------------------------------------

describe("#8550 — validateNewTextAssetPlan", () => {
  it("o conjunto definido na issue (NEW_HEADLINES/LONG_HEADLINES/DESCRIPTIONS) passa nos limites do PMax", () => {
    const v = validateNewTextAssetPlan();
    assert.deepEqual(v.errors, []);
    assert.equal(v.ok, true);
  });

  it("recusa headline acima de 30 chars", () => {
    const v = validateNewTextAssetPlan(["um título de teste que estoura o limite de trinta caracteres com folga"], NEW_LONG_HEADLINES, NEW_DESCRIPTIONS);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("headline")));
  });

  it("recusa quando nenhuma description é <=60 chars", () => {
    const v = validateNewTextAssetPlan(NEW_HEADLINES, NEW_LONG_HEADLINES, [
      "uma description propositalmente longa o suficiente pra passar de sessenta caracteres",
      "outra description também longa o suficiente pra passar de sessenta caracteres também",
    ]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("60")));
  });

  it("recusa contagem de headlines fora do intervalo [3, 15]", () => {
    const v = validateNewTextAssetPlan(["a", "b"], NEW_LONG_HEADLINES, NEW_DESCRIPTIONS);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("headlines: 2")));
  });
});

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

describe("#8550 — payload builders", () => {
  it("buildCreateTextAssetsPayload gera 1 operação de create por texto", () => {
    const p = buildCreateTextAssetsPayload(["a", "b", "c"], "HEADLINE");
    assert.equal(p.operations.length, 3);
    assert.deepEqual(p.operations[1], { create: { textAsset: { text: "b" } } });
  });

  it("buildCreateImageAssetPayload carrega o base64 e o nome", () => {
    const p = buildCreateImageAssetPayload("QUJD", "foo.jpg");
    assert.deepEqual(p.operations, [{ create: { name: "foo.jpg", imageAsset: { data: "QUJD" } } }]);
  });

  it("buildLinkAssetGroupAssetsPayload liga cada resource ao grupo com o fieldType certo", () => {
    const p = buildLinkAssetGroupAssetsPayload("customers/1/assetGroups/2", ["customers/1/assets/10", "customers/1/assets/11"], "HEADLINE");
    assert.equal(p.operations.length, 2);
    assert.deepEqual(p.operations[0], { create: { assetGroup: "customers/1/assetGroups/2", asset: "customers/1/assets/10", fieldType: "HEADLINE" } });
  });

  it("buildRemoveAssetGroupAssetsPayload monta 1 operação remove por resource", () => {
    const p = buildRemoveAssetGroupAssetsPayload(["customers/1/assetGroupAssets/a", "customers/1/assetGroupAssets/b"]);
    assert.deepEqual(p.operations, [{ remove: "customers/1/assetGroupAssets/a" }, { remove: "customers/1/assetGroupAssets/b" }]);
  });
});

// ---------------------------------------------------------------------------
// CLI (fetch mockado) — dry-run nunca muta; --send sem manifesto recusa
// ---------------------------------------------------------------------------

const SAMPLE_SEARCH_RESULTS = [
  {
    asset: { resourceName: "customers/2369219639/assets/1", id: "1", type: "TEXT", textAsset: { text: "Newsletter de IA" } },
    assetGroupAsset: { resourceName: "customers/2369219639/assetGroupAssets/g~1~HEADLINE", asset: "customers/2369219639/assets/1", fieldType: "HEADLINE", status: "ENABLED" },
  },
  {
    asset: { resourceName: "customers/2369219639/assets/2", id: "2", type: "TEXT", textAsset: { text: "diar.ia.br" } },
    assetGroupAsset: { resourceName: "customers/2369219639/assetGroupAssets/g~2~HEADLINE", asset: "customers/2369219639/assets/2", fieldType: "HEADLINE", status: "ENABLED" },
  },
  {
    asset: { resourceName: "customers/2369219639/assets/3", id: "3", type: "IMAGE", name: "logo_1.jpg" },
    assetGroupAsset: { resourceName: "customers/2369219639/assetGroupAssets/g~3~SQUARE_MARKETING_IMAGE", asset: "customers/2369219639/assets/3", fieldType: "SQUARE_MARKETING_IMAGE", status: "ENABLED" },
  },
];

describe("#8550 — CLI google-ads-swap-asset-group-creatives", () => {
  it("dry-run (default): lê e classifica, NÃO chama nenhum :mutate", async () => {
    const calls: string[] = [];
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      calls.push(input);
      if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () => swapMain(["--customer-id", "2369219639"], fetchMock as unknown as typeof fetch));
    assert.equal(code, 0);
    assert.ok(!calls.some((c) => c.includes(":mutate")));
  });

  it("--send SEM --images-manifest recusa (nenhuma mutação)", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
      throw new Error(`chamada inesperada em --send sem manifesto: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () => swapMain(["--customer-id", "2369219639", "--send"], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock));
    assert.equal(code, 1);
  });

  it("--send com manifesto INCOMPLETO (falta 1 proporção) recusa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-manifest-"));
    const img1x1 = join(dir, "d1-1x1.jpg");
    writeFileSync(img1x1, Buffer.from("fake-jpg-bytes"));
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        SQUARE_MARKETING_IMAGE: [img1x1],
        MARKETING_IMAGE: [], // vazio de propósito — proporção 1,91:1 ausente
        PORTRAIT_MARKETING_IMAGE: [img1x1],
      }),
    );
    try {
      const fetchMock = async (input: string) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        throw new Error(`chamada inesperada com manifesto incompleto: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
      );
      assert.equal(code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--send com manifesto COMPLETO: cria textos+imagens e linka ao grupo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-manifest-full-"));
    const makeImg = (name: string) => {
      const p = join(dir, name);
      writeFileSync(p, Buffer.from(`fake-bytes-${name}`));
      return p;
    };
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        SQUARE_MARKETING_IMAGE: [makeImg("d1-1x1.jpg")],
        MARKETING_IMAGE: [makeImg("d1-191x1.jpg")],
        PORTRAIT_MARKETING_IMAGE: [makeImg("d1-4x5.jpg")],
      }),
    );
    try {
      const mutateCalls: string[] = [];
      let assetCounter = 100;
      const fetchMock = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) {
          mutateCalls.push("assets:mutate");
          const body = JSON.parse(String(init?.body));
          const results = body.operations.map(() => ({ resourceName: `customers/2369219639/assets/${assetCounter++}` }));
          return jsonResponse(200, { results });
        }
        if (input.endsWith("assetGroupAssets:mutate")) {
          mutateCalls.push("assetGroupAssets:mutate");
          const body = JSON.parse(String(init?.body));
          return jsonResponse(200, { results: body.operations.map(() => ({ resourceName: "customers/2369219639/assetGroupAssets/new" })) });
        }
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
      );
      assert.equal(code, 0);
      // 3 assets:mutate de texto (headline/long headline/description) + 3 de imagem (1 por proporção)
      assert.equal(mutateCalls.filter((c) => c === "assets:mutate").length, 6);
      // 1 assetGroupAssets:mutate (link) por fieldType com resourceNames (6 tipos: HEADLINE, LONG_HEADLINE, DESCRIPTION + 3 imagens)
      assert.equal(mutateCalls.filter((c) => c === "assetGroupAssets:mutate").length, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--remove-stale sem --send é dry-run (não muta)", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () => swapMain(["--customer-id", "2369219639", "--remove-stale"], fetchMock as unknown as typeof fetch));
    assert.equal(code, 0);
  });

  it("--send --remove-stale remove só os stale (nunca needsReview/protected/keep)", async () => {
    let removedResourceNames: string[] = [];
    const fetchMock = async (input: string, init?: RequestInit) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
      if (input.endsWith("assetGroupAssets:mutate")) {
        const body = JSON.parse(String(init?.body));
        removedResourceNames = body.operations.map((op: { remove: string }) => op.remove);
        return jsonResponse(200, { results: removedResourceNames.map((r: string) => ({ resourceName: r })) });
      }
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () => swapMain(["--customer-id", "2369219639", "--send", "--remove-stale"], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock));
    assert.equal(code, 0);
    // Da amostra SAMPLE_SEARCH_RESULTS: só "Newsletter de IA" é stale (diar.ia.br é keep, logo_1.jpg é needsReview).
    assert.deepEqual(removedResourceNames, ["customers/2369219639/assetGroupAssets/g~1~HEADLINE"]);
  });

  it("rejeita --asset-group-id não-numérico ANTES de qualquer chamada de rede (defesa contra injeção de GAQL)", async () => {
    const fetchMock = async () => {
      throw new Error("não deveria chamar fetch — validação de --asset-group-id precisa falhar antes");
    };
    const code = await withEnv(AUTH_ENV, () =>
      swapMain(["--customer-id", "2369219639", "--asset-group-id", "123' OR '1'='1"], fetchMock as unknown as typeof fetch),
    );
    assert.equal(code, 1);
  });

  it("assets:mutate devolvendo MENOS resultados que operações enviadas -> erro, nunca linka silenciosamente menos que o pedido", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-manifest-shortresults-"));
    const makeImg = (name: string) => {
      const p = join(dir, name);
      writeFileSync(p, Buffer.from(`fake-bytes-${name}`));
      return p;
    };
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        SQUARE_MARKETING_IMAGE: [makeImg("d1-1x1.jpg")],
        MARKETING_IMAGE: [makeImg("d1-191x1.jpg")],
        PORTRAIT_MARKETING_IMAGE: [makeImg("d1-4x5.jpg")],
      }),
    );
    try {
      let linkCallCount = 0;
      const fetchMock = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) {
          const body = JSON.parse(String(init?.body));
          // Pede N operações, a API "confirma" só a 1ª -- resposta 2xx
          // mas incompleta (achado do review da PR #8956).
          return jsonResponse(200, { results: [{ resourceName: "customers/2369219639/assets/1" }] });
        }
        if (input.endsWith("assetGroupAssets:mutate")) {
          linkCallCount++;
          return jsonResponse(200, { results: [] });
        }
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
      );
      assert.equal(code, 1, "resposta com menos resultados que operações enviadas precisa ser erro, não sucesso parcial silencioso");
      // NEW_HEADLINES tem 4 itens -- a 1ª chamada de assets:mutate (headlines)
      // já devolve só 1 resultado pra 4 operações, então falha ali, ANTES de
      // qualquer link (nenhum recurso fica meio-linkado).
      assert.equal(linkCallCount, 0, "não deve tentar linkar nada quando a criação já veio incompleta");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assetGroupAssets:mutate (link) confirmando MENOS links que o pedido -> erro, reporta estado inconsistente", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-manifest-shortlink-"));
    const makeImg = (name: string) => {
      const p = join(dir, name);
      writeFileSync(p, Buffer.from(`fake-bytes-${name}`));
      return p;
    };
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        SQUARE_MARKETING_IMAGE: [makeImg("d1-1x1.jpg")],
        MARKETING_IMAGE: [makeImg("d1-191x1.jpg")],
        PORTRAIT_MARKETING_IMAGE: [makeImg("d1-4x5.jpg")],
      }),
    );
    try {
      let assetCounter = 100;
      const fetchMock = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) {
          const body = JSON.parse(String(init?.body));
          const results = body.operations.map(() => ({ resourceName: `customers/2369219639/assets/${assetCounter++}` }));
          return jsonResponse(200, { results });
        }
        if (input.endsWith("assetGroupAssets:mutate")) {
          // Sempre confirma 0 links, não importa quantos foram pedidos.
          return jsonResponse(200, { results: [] });
        }
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
      );
      assert.equal(code, 1, "link confirmando menos recursos que o enviado precisa falhar, não reportar Fase 1 concluída");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assetGroupAssets:mutate (remove) confirmando MENOS remoções que o pedido -> erro", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
      if (input.endsWith("assetGroupAssets:mutate")) return jsonResponse(200, { results: [] });
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () => swapMain(["--customer-id", "2369219639", "--send", "--remove-stale"], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock));
    assert.equal(code, 1);
  });

  it("--images-manifest com valor NÃO-array pra um fieldType recusa --send com erro limpo (nunca lança exceção crua)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-manifest-malformed-"));
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        SQUARE_MARKETING_IMAGE: "not-an-array",
        MARKETING_IMAGE: [123],
        PORTRAIT_MARKETING_IMAGE: [],
      }),
    );
    try {
      const fetchMock = async (input: string) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
      );
      assert.equal(code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#8550 — buildAssetGroupAssetsQuery valida o resource name (achado do review, GAQL injection)", () => {
  it("rejeita resource name fora do formato customers/{dígitos}/assetGroups/{dígitos}", () => {
    assert.throws(() => buildAssetGroupAssetsQuery("customers/1/assetGroups/2' OR '1'='1"), /precisa ser/);
    assert.throws(() => buildAssetGroupAssetsQuery(""), /precisa ser/);
  });

  it("aceita o formato correto", () => {
    assert.doesNotThrow(() => buildAssetGroupAssetsQuery("customers/2369219639/assetGroups/6642889160"));
  });
});
