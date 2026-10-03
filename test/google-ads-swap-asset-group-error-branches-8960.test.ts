/**
 * test/google-ads-swap-asset-group-error-branches-8960.test.ts (#8960 item 3)
 *
 * Cobre os branches de erro de `scripts/google-ads-swap-asset-group-creatives.ts`
 * que ficaram sem teste dedicado (achado #3 do review da PR #8956, ver issue
 * #8960): falha de rede, HTTP não-2xx e corpo não-JSON em cada call site
 * (`googleAds:search`, `assets:mutate` de criação, `assetGroupAssets:mutate`
 * de link e de remoção), `--customer-id`/env vars ausentes, e falha na
 * renovação do access token.
 *
 * `test/google-ads-asset-group-creatives-8550.test.ts` já cobre os fluxos
 * felizes e a contagem de resultados incompleta em `assets:mutate`(create)/
 * `assetGroupAssets:mutate` (link/remove); `test/google-ads-asset-group-swap-
 * robustez-8960.test.ts` já cobre o cooldown e a recuperação de falha
 * parcial via manifesto de progresso (inclusive uma falha de REDE simulada
 * na criação de texto). Este arquivo fecha os branches que sobraram: HTTP
 * não-2xx / corpo não-JSON em CADA call site, e o preflight de auth do CLI.
 *
 * Nenhum teste chama a API real: `fetch` é sempre mock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main as swapMain } from "../scripts/google-ads-swap-asset-group-creatives.ts";
import { PMAX_PLAN_OUT_TMP } from "./_helpers/pmax-stateful-search.ts";

const AUTH_ENV = {
  GOOGLE_ADS_CLIENT_ID: "client-id",
  GOOGLE_ADS_CLIENT_SECRET: "client-secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh-token",
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "6236094249",
  GOOGLE_ADS_CUSTOMER_ID: "2369219639",
  PMAX_SWAP_PLAN_OUT: PMAX_PLAN_OUT_TMP,
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
 *  estes testes, que exercitam outros branches de `--send`. */
function noAcaoAdiadaMock(): string[] {
  return [];
}

const SAMPLE_SEARCH_RESULTS = [
  {
    asset: { resourceName: "customers/2369219639/assets/1", id: "1", type: "TEXT", textAsset: { text: "Newsletter de IA" } },
    assetGroupAsset: { resourceName: "customers/2369219639/assetGroupAssets/g~1~HEADLINE", asset: "customers/2369219639/assets/1", fieldType: "HEADLINE", status: "ENABLED" },
  },
];

/** Fase 2 com piso (#8550 sync): 3 headlines não-stale APROVADOS, então o
 *  stale "Newsletter de IA" é removível sem deixar HEADLINE abaixo de 3 — os
 *  testes abaixo chegam de fato ao `assetGroupAssets:mutate` (remove). */
const PHASE2_SEARCH_RESULTS = [
  ...SAMPLE_SEARCH_RESULTS,
  ...["21", "22", "23"].map((id) => ({
    asset: { resourceName: `customers/2369219639/assets/${id}`, id, type: "TEXT", textAsset: { text: `Título novo ${id}` } },
    assetGroupAsset: {
      resourceName: `customers/2369219639/assetGroupAssets/g~${id}~HEADLINE`,
      asset: `customers/2369219639/assets/${id}`,
      fieldType: "HEADLINE",
      status: "ENABLED",
      policySummary: { approvalStatus: "APPROVED" },
    },
  })),
];

function makeManifest(dir: string): string {
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
  return manifestPath;
}

// ---------------------------------------------------------------------------
// Preflight de auth do CLI
// ---------------------------------------------------------------------------

describe("#8960 — google-ads-swap-asset-group-creatives: --customer-id/env vars ausentes", () => {
  it("sem --customer-id e sem GOOGLE_ADS_CUSTOMER_ID -> falha antes de qualquer fetch", async () => {
    const fetchMock = async () => {
      throw new Error("não deveria chamar fetch sem customer-id resolvido");
    };
    const code = await withEnv({ ...AUTH_ENV, GOOGLE_ADS_CUSTOMER_ID: "" }, () =>
      swapMain([], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
    );
    assert.equal(code, 1);
  });

  it("env vars de auth ausentes -> falha antes de qualquer fetch", async () => {
    const fetchMock = async () => {
      throw new Error("não deveria chamar fetch sem as env vars de auth resolvidas");
    };
    const code = await withEnv({ ...AUTH_ENV, GOOGLE_ADS_DEVELOPER_TOKEN: "" }, () =>
      swapMain(["--customer-id", "2369219639"], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
    );
    assert.equal(code, 1);
  });
});

describe("#8960 — google-ads-swap-asset-group-creatives: falha na renovação do access token", () => {
  it("falha de rede no /token -> falha limpa, nunca chega a ler o asset group", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") throw new Error("network down (simulado)");
      throw new Error(`não deveria chamar mais nada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () => swapMain(["--customer-id", "2369219639"], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock));
    assert.equal(code, 1);
  });
});

// ---------------------------------------------------------------------------
// Leitura do estado atual (googleAds:search)
// ---------------------------------------------------------------------------

describe("#8960 — google-ads-swap-asset-group-creatives: leitura do estado atual (:search)", () => {
  it("falha de rede no :search -> falha limpa, nunca tenta classificar/mutar", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) throw new Error("network down (simulado)");
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () => swapMain(["--customer-id", "2369219639"], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock));
    assert.equal(code, 1);
  });

  it(":search HTTP não-2xx -> falha limpa", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(500, { error: "internal" });
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () => swapMain(["--customer-id", "2369219639"], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock));
    assert.equal(code, 1);
  });

  it(":search corpo não-JSON -> falha limpa", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return new Response("isto não é JSON", { status: 200 });
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () => swapMain(["--customer-id", "2369219639"], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock));
    assert.equal(code, 1);
  });
});

// ---------------------------------------------------------------------------
// Fase 1 — criação de assets (assets:mutate)
// ---------------------------------------------------------------------------

describe("#8960 — google-ads-swap-asset-group-creatives: Fase 1, criação de assets (assets:mutate)", () => {
  it("assets:mutate (criação de texto) HTTP não-2xx -> falha limpa, nunca chega a linkar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-create-http-"));
    const manifestPath = makeManifest(dir);
    try {
      let linkCalled = false;
      const fetchMock = async (input: string) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) return jsonResponse(400, { error: "INVALID_ARGUMENT" });
        if (input.endsWith("assetGroupAssets:mutate")) linkCalled = true;
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath, "--progress-file", join(dir, "progress.json")], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
      );
      assert.equal(code, 1);
      assert.equal(linkCalled, false, "não deve tentar linkar nada quando a criação de texto já falhou");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assets:mutate (criação de texto) corpo não-JSON -> falha limpa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-create-nonjson-"));
    const manifestPath = makeManifest(dir);
    try {
      const fetchMock = async (input: string) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) return new Response("isto não é JSON", { status: 200 });
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath, "--progress-file", join(dir, "progress.json")], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
      );
      assert.equal(code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assets:mutate (criação de texto) devolve HTTP 2xx com resultado SEM resourceName -> erro, nunca linka um recurso fantasma", async () => {
    // Achado do self-review deste PR: `createAssets` tem um branch dedicado
    // pra "resposta 2xx, mesma contagem de resultados, mas algum item veio
    // sem `resourceName`" (scripts/google-ads-swap-asset-group-creatives.ts,
    // linha `resourceNames.length !== results.length`) que nenhum teste
    // exercitava — só o caso de CONTAGEM diferente (#8550 test) e o de HTTP
    // não-2xx (teste acima) tinham cobertura.
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-create-no-resourcename-"));
    const manifestPath = makeManifest(dir);
    try {
      const fetchMock = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) {
          const body = JSON.parse(String(init?.body));
          // Mesma contagem de `results` que `operations`, mas sem `resourceName`.
          const results = body.operations.map(() => ({}));
          return jsonResponse(200, { results });
        }
        if (input.endsWith("assetGroupAssets:mutate")) throw new Error("não deveria tentar linkar recurso sem resourceName");
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath, "--progress-file", join(dir, "progress.json")], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
      );
      assert.equal(code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assets:mutate (criação de IMAGEM) HTTP não-2xx -> falha limpa (texto já criado, imagem falha)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-create-image-http-"));
    const manifestPath = makeManifest(dir);
    try {
      let assetCounter = 100;
      const fetchMock = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) {
          const body = JSON.parse(String(init?.body));
          // Texto (3 chamadas de 1 operação de TEXT cada) passa; a 1ª chamada
          // de imagem (1 operação de IMAGE) falha com HTTP não-2xx.
          const isImageCreate = JSON.stringify(body).includes("imageAsset");
          if (isImageCreate) return jsonResponse(503, { error: "UNAVAILABLE" });
          const results = body.operations.map(() => ({ resourceName: `customers/2369219639/assets/${assetCounter++}` }));
          return jsonResponse(200, { results });
        }
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath, "--progress-file", join(dir, "progress.json")], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
      );
      assert.equal(code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fase 1 — link (assetGroupAssets:mutate)
// ---------------------------------------------------------------------------

describe("#8960 — google-ads-swap-asset-group-creatives: Fase 1, link (assetGroupAssets:mutate)", () => {
  it("falha de rede no link -> falha limpa (assets já criados ficam registrados no progresso)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-link-network-"));
    const manifestPath = makeManifest(dir);
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
        if (input.endsWith("assetGroupAssets:mutate")) throw new Error("network down no link (simulado)");
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath, "--progress-file", join(dir, "progress.json")], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
      );
      assert.equal(code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("link HTTP não-2xx -> falha limpa, estado reportado como inconsistente", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-link-http-"));
    const manifestPath = makeManifest(dir);
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
        if (input.endsWith("assetGroupAssets:mutate")) return jsonResponse(500, { error: "internal" });
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath, "--progress-file", join(dir, "progress.json")], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
      );
      assert.equal(code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("link corpo não-JSON -> falha limpa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-link-nonjson-"));
    const manifestPath = makeManifest(dir);
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
        if (input.endsWith("assetGroupAssets:mutate")) return new Response("isto não é JSON", { status: 200 });
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath, "--progress-file", join(dir, "progress.json")], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
      );
      assert.equal(code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fase 2 — remoção (assetGroupAssets:mutate)
// ---------------------------------------------------------------------------

describe("#8960 — google-ads-swap-asset-group-creatives: Fase 2, remoção (assetGroupAssets:mutate)", () => {
  it("falha de rede na remoção -> falha limpa", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(200, { results: PHASE2_SEARCH_RESULTS });
      if (input.endsWith("assetGroupAssets:mutate")) throw new Error("network down na remoção (simulado)");
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () =>
      swapMain(["--customer-id", "2369219639", "--send", "--remove-stale"], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
    );
    assert.equal(code, 1);
  });

  it("remoção HTTP não-2xx -> falha limpa", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(200, { results: PHASE2_SEARCH_RESULTS });
      if (input.endsWith("assetGroupAssets:mutate")) return jsonResponse(500, { error: "internal" });
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () =>
      swapMain(["--customer-id", "2369219639", "--send", "--remove-stale"], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
    );
    assert.equal(code, 1);
  });

  it("remoção corpo não-JSON -> falha limpa", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(200, { results: PHASE2_SEARCH_RESULTS });
      if (input.endsWith("assetGroupAssets:mutate")) return new Response("isto não é JSON", { status: 200 });
      throw new Error(`chamada inesperada: ${input}`);
    };
    const code = await withEnv(AUTH_ENV, () =>
      swapMain(["--customer-id", "2369219639", "--send", "--remove-stale"], fetchMock as unknown as typeof fetch, noAcaoAdiadaMock),
    );
    assert.equal(code, 1);
  });
});
