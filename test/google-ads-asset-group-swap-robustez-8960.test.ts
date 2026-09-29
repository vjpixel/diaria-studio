/**
 * test/google-ads-asset-group-swap-robustez-8960.test.ts (#8960)
 *
 * Cobre os dois achados endurecidos da issue #8960 (review da PR #8956):
 *   1. Recuperação de falha parcial na Fase 1 — manifesto de progresso em
 *      `scripts/lib/google-ads-asset-group-assets.ts` (funções puras) +
 *      retomada idempotente no CLI `scripts/google-ads-swap-asset-group-creatives.ts`
 *      (fetch mockado, `fetch` real NUNCA é chamado).
 *   2. Cooldown de 7 dias do editor (`acao-adiada`, issue #8550) agora
 *      checado em código via `checkSwapCooldown` — `fetchCommentBodies` é
 *      injetado (nunca chama `gh` de verdade neste teste).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emptySwapProgress,
  parseSwapProgress,
  withSwapProgressStep,
  serializeSwapProgress,
  computeSwapFingerprint,
  type SwapProgress,
} from "../scripts/lib/google-ads-asset-group-assets.ts";
import { formatAcaoAdiadaMarker, formatExecutionBlockMarker } from "../scripts/lib/issue-decisions.ts";
import { main as swapMain, checkSwapCooldown } from "../scripts/google-ads-swap-asset-group-creatives.ts";

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

const SAMPLE_SEARCH_RESULTS = [
  {
    asset: { resourceName: "customers/2369219639/assets/1", id: "1", type: "TEXT", textAsset: { text: "Newsletter de IA" } },
    assetGroupAsset: { resourceName: "customers/2369219639/assetGroupAssets/g~1~HEADLINE", asset: "customers/2369219639/assets/1", fieldType: "HEADLINE", status: "ENABLED" },
  },
];

// ---------------------------------------------------------------------------
// Manifesto de progresso — funções puras
// ---------------------------------------------------------------------------

describe("#8960 — emptySwapProgress / parseSwapProgress / withSwapProgressStep", () => {
  it("emptySwapProgress começa sem etapas", () => {
    const p = emptySwapProgress(new Date("2026-09-28T00:00:00Z"));
    assert.deepEqual(p.steps, {});
    assert.equal(p.version, 1);
  });

  it("parseSwapProgress(null) e string vazia devolvem manifesto vazio (fail-soft)", () => {
    assert.deepEqual(parseSwapProgress(null).steps, {});
    assert.deepEqual(parseSwapProgress("").steps, {});
  });

  it("parseSwapProgress com JSON inválido nunca lança — devolve vazio", () => {
    assert.doesNotThrow(() => parseSwapProgress("{ isso não é json"));
    assert.deepEqual(parseSwapProgress("{ isso não é json").steps, {});
  });

  it("parseSwapProgress ignora etapa malformada mas mantém as válidas", () => {
    const raw = JSON.stringify({
      version: 1,
      updated_at: "2026-09-28T00:00:00Z",
      steps: {
        HEADLINE: { resourceNames: ["customers/1/assets/1"], linked: true },
        LONG_HEADLINE: { resourceNames: "não é array", linked: false }, // malformado
      },
    });
    const parsed = parseSwapProgress(raw);
    assert.deepEqual(Object.keys(parsed.steps), ["HEADLINE"]);
  });

  it("round-trip serialize -> parse preserva o conteúdo", () => {
    let p = emptySwapProgress(new Date("2026-09-28T00:00:00Z"));
    p = withSwapProgressStep(p, "HEADLINE", { resourceNames: ["customers/1/assets/1"], linked: false }, new Date("2026-09-28T00:00:01Z"));
    const roundTripped = parseSwapProgress(serializeSwapProgress(p));
    assert.deepEqual(roundTripped.steps.HEADLINE, { resourceNames: ["customers/1/assets/1"], linked: false });
  });

  it("withSwapProgressStep nunca muta o argumento original (pure)", () => {
    const p0 = emptySwapProgress();
    const p1 = withSwapProgressStep(p0, "DESCRIPTION", { resourceNames: ["x"], linked: false });
    assert.deepEqual(p0.steps, {});
    assert.deepEqual(p1.steps.DESCRIPTION, { resourceNames: ["x"], linked: false });
  });
});

// ---------------------------------------------------------------------------
// Cooldown do editor (#8960 achado #2) — checkSwapCooldown
// ---------------------------------------------------------------------------

describe("#8960 — checkSwapCooldown", () => {
  const now = new Date("2026-09-28T12:00:00Z");

  it("sem marcador acao-adiada -> não ativo", () => {
    assert.equal(checkSwapCooldown([], now).active, false);
  });

  it("acao-adiada pedida hoje -> cooldown ATIVO", () => {
    const marker = formatAcaoAdiadaMarker({ pedido_em: "2026-09-28T09:00:00Z", acao: "google-ads-swap --send", motivo: "ainda não", sessao: "develop" });
    const result = checkSwapCooldown([`comentário com marcador\n${marker}`], now);
    assert.equal(result.active, true);
    assert.equal(result.pedidoEm, "2026-09-28T09:00:00Z");
  });

  it("acao-adiada pedida há mais de 7 dias -> cooldown EXPIRADO", () => {
    const marker = formatAcaoAdiadaMarker({ pedido_em: "2026-09-10T09:00:00Z", acao: "google-ads-swap --send", motivo: "ainda não", sessao: "develop" });
    const result = checkSwapCooldown([marker], now);
    assert.equal(result.active, false);
  });

  it("bloqueio-execucao registrado DEPOIS do adiamento reabre a pergunta antes do prazo", () => {
    const adiada = formatAcaoAdiadaMarker({ pedido_em: "2026-09-20T09:00:00Z", acao: "google-ads-swap --send", motivo: "ainda não", sessao: "develop" });
    const bloco = formatExecutionBlockMarker({
      recorded_at: "2026-09-25",
      motivo: "novo achado",
      sessao: "overnight",
      condicao: { tipo: "externo", descricao: "editor precisa decidir" },
    });
    const result = checkSwapCooldown([adiada, bloco], now);
    assert.equal(result.active, false);
  });

  it("commentsBodies === null (leitura falhou) -> cooldown ATIVO (fail-CLOSED, #8972)", () => {
    // Distinção deliberada de `[]`: `null` é "não consegui ler", `[]` é "li
    // e não achei marcador". Só o 1º precisa recusar --send sem confirmação.
    const result = checkSwapCooldown(null, now);
    assert.equal(result.active, true);
  });
});

// ---------------------------------------------------------------------------
// CLI --send: gate de cooldown (fetchCommentBodies injetado, nunca chama gh)
// ---------------------------------------------------------------------------

describe("#8960 — CLI: cooldown bloqueia --send em código", () => {
  it("--send recusa quando fetchCommentBodies devolve um adiamento ativo", async () => {
    const marker = formatAcaoAdiadaMarker({ pedido_em: new Date().toISOString(), acao: "google-ads-swap --send", motivo: "ainda não", sessao: "develop" });
    const fetchMock = async () => {
      throw new Error("não deveria chamar fetch — cooldown precisa recusar antes de qualquer chamada de rede");
    };
    const fetchCommentBodiesMock = () => [marker];
    const code = await withEnv(AUTH_ENV, () =>
      swapMain(["--customer-id", "2369219639", "--send"], fetchMock as unknown as typeof fetch, fetchCommentBodiesMock),
    );
    assert.equal(code, 1);
  });

  it("--send prossegue (recusado só por falta de --images-manifest) quando não há adiamento ativo", async () => {
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
      throw new Error(`chamada inesperada: ${input}`);
    };
    const fetchCommentBodiesMock = () => [];
    const code = await withEnv(AUTH_ENV, () =>
      swapMain(["--customer-id", "2369219639", "--send"], fetchMock as unknown as typeof fetch, fetchCommentBodiesMock),
    );
    // Recusa (1) por falta de --images-manifest, não por cooldown -- prova
    // que o gate de cooldown deixou passar quando não há adiamento ativo.
    assert.equal(code, 1);
  });

  it("--send com cooldown ativo mas --skip-cooldown-check-UNSAFE ignora o gate (prossegue até a validação de manifesto)", async () => {
    const marker = formatAcaoAdiadaMarker({ pedido_em: new Date().toISOString(), acao: "google-ads-swap --send", motivo: "ainda não", sessao: "develop" });
    const fetchMock = async (input: string) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
      throw new Error(`chamada inesperada: ${input}`);
    };
    const fetchCommentBodiesMock = (): string[] => {
      throw new Error("não deveria nem tentar buscar comentários com --skip-cooldown-check-UNSAFE");
    };
    const code = await withEnv(AUTH_ENV, () =>
      swapMain(
        ["--customer-id", "2369219639", "--send", "--skip-cooldown-check-UNSAFE"],
        fetchMock as unknown as typeof fetch,
        fetchCommentBodiesMock as never,
      ),
    );
    // Sem --skip-cooldown-check-UNSAFE isso seria bloqueado pelo cooldown;
    // com a flag, chega até a recusa por falta de manifesto (código 1 pelo
    // motivo errado seria um falso negativo -- a prova real é que
    // fetchCommentBodiesMock, que lançaria, NUNCA foi chamado).
    assert.equal(code, 1);
  });

  it("--send recusa (fail-CLOSED) quando a leitura dos comentários falha (null), mesmo sem adiamento nenhum de verdade", async () => {
    const fetchMock = async () => {
      throw new Error("não deveria chamar fetch — cooldown fail-closed precisa recusar antes de qualquer chamada de rede");
    };
    const fetchCooldownCommentsMock = (): string[] | null => null; // simula `gh` indisponível/erro
    const code = await withEnv(AUTH_ENV, () =>
      swapMain(["--customer-id", "2369219639", "--send"], fetchMock as unknown as typeof fetch, fetchCooldownCommentsMock),
    );
    assert.equal(code, 1);
  });
});

// ---------------------------------------------------------------------------
// CLI --send: recuperação de falha parcial via --progress-file (#8960 achado #1)
// ---------------------------------------------------------------------------

describe("#8960 — CLI: manifesto de progresso sobrevive falha parcial na Fase 1", () => {
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

  it("falha no create de LONG_HEADLINE preserva HEADLINE no progresso; retry NÃO recria HEADLINE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-progress-"));
    const manifestPath = makeManifest(dir);
    const progressFile = join(dir, "progress.json");
    const fetchCommentBodiesMock = () => [];
    try {
      // Tentativa 1: headlines cria OK, long headlines falha (rede).
      let assetCounter = 100;
      const headlineCreatePayloads: number[] = [];
      const fetchMockAttempt1Real = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) {
          const body = JSON.parse(String(init?.body));
          headlineCreatePayloads.push(body.operations.length);
          if (headlineCreatePayloads.length === 2) throw new Error("network down (simulado)");
          const results = body.operations.map(() => ({ resourceName: `customers/2369219639/assets/${assetCounter++}` }));
          return jsonResponse(200, { results });
        }
        throw new Error(`chamada inesperada na tentativa 1: ${input}`);
      };
      const code1 = await withEnv(AUTH_ENV, () =>
        swapMain(
          ["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath, "--progress-file", progressFile],
          fetchMockAttempt1Real as unknown as typeof fetch,
          fetchCommentBodiesMock,
        ),
      );
      assert.equal(code1, 1, "tentativa 1 precisa falhar (network down simulado na 2ª chamada assets:mutate)");
      assert.ok(existsSync(progressFile), "progresso precisa ter sido gravado antes da falha");
      const progressAfterFailure: SwapProgress = JSON.parse(readFileSync(progressFile, "utf8"));
      assert.ok(progressAfterFailure.steps.HEADLINE, "HEADLINE precisa estar registrado (criado antes da falha em LONG_HEADLINE)");
      assert.equal(progressAfterFailure.steps.LONG_HEADLINE, undefined, "LONG_HEADLINE não chegou a ser criado");

      // Tentativa 2 (retry): HEADLINE não pode ser recriado -- só as etapas
      // restantes chamam assets:mutate de criação de texto.
      let createTextCallCount = 0;
      let assetCounter2 = 500;
      const fetchMockAttempt2 = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) {
          createTextCallCount++;
          const body = JSON.parse(String(init?.body));
          const results = body.operations.map(() => ({ resourceName: `customers/2369219639/assets/${assetCounter2++}` }));
          return jsonResponse(200, { results });
        }
        if (input.endsWith("assetGroupAssets:mutate")) {
          const body = JSON.parse(String(init?.body));
          return jsonResponse(200, { results: body.operations.map(() => ({ resourceName: "customers/2369219639/assetGroupAssets/new" })) });
        }
        throw new Error(`chamada inesperada na tentativa 2: ${input}`);
      };
      const code2 = await withEnv(AUTH_ENV, () =>
        swapMain(
          ["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath, "--progress-file", progressFile],
          fetchMockAttempt2 as unknown as typeof fetch,
          fetchCommentBodiesMock,
        ),
      );
      assert.equal(code2, 0, "retry precisa concluir a Fase 1 com sucesso");
      // 5 assets:mutate de CRIAÇÃO restantes (LONG_HEADLINE, DESCRIPTION + 3
      // imagens) -- HEADLINE já veio do progresso, não gerou chamada nova.
      assert.equal(createTextCallCount, 5, "HEADLINE não deveria ter sido recriado no retry");
      // Progresso é limpo depois de uma Fase 1 concluída com sucesso.
      assert.equal(existsSync(progressFile), false, "arquivo de progresso deveria ter sido removido após sucesso total");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha no LINK de uma etapa (assets criados, link falha) preserva resourceNames + linked:false; retry só relinka, não recria", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-progress-link-"));
    const manifestPath = makeManifest(dir);
    const progressFile = join(dir, "progress.json");
    const fetchCommentBodiesMock = () => [];
    try {
      let assetCounter = 900;
      let linkAttempts = 0;
      const fetchMockAttempt1 = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) {
          const body = JSON.parse(String(init?.body));
          const results = body.operations.map(() => ({ resourceName: `customers/2369219639/assets/${assetCounter++}` }));
          return jsonResponse(200, { results });
        }
        if (input.endsWith("assetGroupAssets:mutate")) {
          linkAttempts++;
          if (linkAttempts === 1) {
            // 1º link (HEADLINE) falha -- todo o resto de assets já foi
            // criado antes de chegar na fase de link.
            throw new Error("network down no link (simulado)");
          }
          const body = JSON.parse(String(init?.body));
          return jsonResponse(200, { results: body.operations.map(() => ({ resourceName: "customers/2369219639/assetGroupAssets/new" })) });
        }
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code1 = await withEnv(AUTH_ENV, () =>
        swapMain(
          ["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath, "--progress-file", progressFile],
          fetchMockAttempt1 as unknown as typeof fetch,
          fetchCommentBodiesMock,
        ),
      );
      assert.equal(code1, 1);
      const progressAfterFailure: SwapProgress = JSON.parse(readFileSync(progressFile, "utf8"));
      assert.ok(progressAfterFailure.steps.HEADLINE, "HEADLINE precisa ter sido criado (create sempre roda antes do link)");
      assert.equal(progressAfterFailure.steps.HEADLINE!.linked, false, "link falhou -- não pode estar marcado como linkado");

      // Retry: create de texto/imagem NUNCA deveria rodar de novo (tudo já
      // está no progresso) -- só assetGroupAssets:mutate (link).
      let createCallCount = 0;
      const fetchMockAttempt2 = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) {
          createCallCount++;
          throw new Error("não deveria recriar nenhum asset -- tudo já está no progresso");
        }
        if (input.endsWith("assetGroupAssets:mutate")) {
          const body = JSON.parse(String(init?.body));
          return jsonResponse(200, { results: body.operations.map(() => ({ resourceName: "customers/2369219639/assetGroupAssets/new" })) });
        }
        throw new Error(`chamada inesperada na tentativa 2: ${input}`);
      };
      const code2 = await withEnv(AUTH_ENV, () =>
        swapMain(
          ["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath, "--progress-file", progressFile],
          fetchMockAttempt2 as unknown as typeof fetch,
          fetchCommentBodiesMock,
        ),
      );
      assert.equal(code2, 0);
      assert.equal(createCallCount, 0, "nenhum asset deveria ser recriado -- só o link pendente");
      assert.equal(existsSync(progressFile), false, "progresso limpo após sucesso total");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fieldType com 2+ imagens: falha na 2ª imagem preserva a 1ª; retry cria SÓ a que falta (nunca trata parcial como completo)", async () => {
    // Achado do self-review da PR #8972 (P1): um fieldType pode ter
    // MÚLTIPLOS caminhos no manifesto (até 4 criativos por proporção,
    // ver docstring do módulo). Tratar `existing.resourceNames.length > 0`
    // como "etapa completa" (como uma versão anterior deste código fazia)
    // deixaria a 2ª imagem faltando pra sempre, sem erro nenhum.
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-progress-multi-image-"));
    const makeImg = (name: string) => {
      const p = join(dir, name);
      writeFileSync(p, Buffer.from(`fake-bytes-${name}`));
      return p;
    };
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        SQUARE_MARKETING_IMAGE: [makeImg("d1-1x1.jpg"), makeImg("d2-1x1.jpg")], // 2 imagens neste fieldType
        MARKETING_IMAGE: [makeImg("d1-191x1.jpg")],
        PORTRAIT_MARKETING_IMAGE: [makeImg("d1-4x5.jpg")],
      }),
    );
    const progressFile = join(dir, "progress.json");
    const fetchCommentBodiesMock = () => [];
    try {
      // Tentativa 1: textos OK, SQUARE_MARKETING_IMAGE cria a 1ª imagem e
      // falha na 2ª.
      let assetCounter = 700;
      let squareImageCreateCount = 0;
      const fetchMockAttempt1 = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) {
          const label = String(init?.body ?? "");
          if (label.includes("d1-1x1") || label.includes("d2-1x1")) {
            squareImageCreateCount++;
            if (squareImageCreateCount === 2) throw new Error("network down na 2ª imagem (simulado)");
          }
          const body = JSON.parse(String(init?.body));
          const results = body.operations.map(() => ({ resourceName: `customers/2369219639/assets/${assetCounter++}` }));
          return jsonResponse(200, { results });
        }
        throw new Error(`chamada inesperada na tentativa 1: ${input}`);
      };
      const code1 = await withEnv(AUTH_ENV, () =>
        swapMain(
          ["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath, "--progress-file", progressFile],
          fetchMockAttempt1 as unknown as typeof fetch,
          fetchCommentBodiesMock,
        ),
      );
      assert.equal(code1, 1, "tentativa 1 precisa falhar na 2ª imagem de SQUARE_MARKETING_IMAGE");
      const progressAfterFailure: SwapProgress = JSON.parse(readFileSync(progressFile, "utf8"));
      assert.equal(progressAfterFailure.steps.SQUARE_MARKETING_IMAGE?.resourceNames.length, 1, "só a 1ª imagem foi criada antes da falha");

      // Tentativa 2 (retry): só 1 chamada de assets:mutate pra imagem
      // (a que faltava) -- a 1ª NÃO pode ser recriada.
      let assetCounter2 = 900;
      let imageCreateCallsInRetry = 0;
      const fetchMockAttempt2 = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) {
          imageCreateCallsInRetry++;
          const body = JSON.parse(String(init?.body));
          const results = body.operations.map(() => ({ resourceName: `customers/2369219639/assets/${assetCounter2++}` }));
          return jsonResponse(200, { results });
        }
        if (input.endsWith("assetGroupAssets:mutate")) {
          const body = JSON.parse(String(init?.body));
          return jsonResponse(200, { results: body.operations.map(() => ({ resourceName: "customers/2369219639/assetGroupAssets/new" })) });
        }
        throw new Error(`chamada inesperada na tentativa 2: ${input}`);
      };
      const code2 = await withEnv(AUTH_ENV, () =>
        swapMain(
          ["--customer-id", "2369219639", "--send", "--images-manifest", manifestPath, "--progress-file", progressFile],
          fetchMockAttempt2 as unknown as typeof fetch,
          fetchCommentBodiesMock,
        ),
      );
      assert.equal(code2, 0, "retry precisa concluir com sucesso, criando só a imagem que faltava");
      // No retry: 1 chamada de imagem (d2-1x1, faltante em SQUARE) + 1
      // (MARKETING_IMAGE) + 1 (PORTRAIT_MARKETING_IMAGE) = 3 -- a 1ª imagem
      // de SQUARE (d1-1x1) NÃO gerou nova chamada.
      assert.equal(imageCreateCallsInRetry, 3, "só as imagens faltantes deveriam ser criadas no retry (nunca a 1ª de SQUARE de novo)");
      assert.equal(existsSync(progressFile), false, "progresso limpo após sucesso total");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fingerprint do progresso (#8972 item 3) — recusa reusar progresso de OUTRO swap
// ---------------------------------------------------------------------------

describe("#8972 item 3 — computeSwapFingerprint / recusa de progresso com fingerprint divergente", () => {
  it("computeSwapFingerprint é determinístico e muda se qualquer input mudar", () => {
    const base = computeSwapFingerprint('{"a":1}', "customers/1/assetGroups/2", "1");
    assert.equal(base, computeSwapFingerprint('{"a":1}', "customers/1/assetGroups/2", "1"), "mesmos inputs -> mesmo hash");
    assert.notEqual(base, computeSwapFingerprint('{"a":2}', "customers/1/assetGroups/2", "1"), "manifesto diferente -> hash diferente");
    assert.notEqual(base, computeSwapFingerprint('{"a":1}', "customers/1/assetGroups/9", "1"), "asset group diferente -> hash diferente");
    assert.notEqual(base, computeSwapFingerprint('{"a":1}', "customers/1/assetGroups/2", "9"), "customer diferente -> hash diferente");
  });

  it("--send RECUSA um --progress-file com etapas de um manifesto DIFERENTE do --images-manifest atual", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-fingerprint-"));
    const makeImg = (name: string) => {
      const p = join(dir, name);
      writeFileSync(p, Buffer.from(`fake-bytes-${name}`));
      return p;
    };
    const manifestA = join(dir, "manifest-a.json");
    writeFileSync(
      manifestA,
      JSON.stringify({
        SQUARE_MARKETING_IMAGE: [makeImg("a-1x1.jpg")],
        MARKETING_IMAGE: [makeImg("a-191x1.jpg")],
        PORTRAIT_MARKETING_IMAGE: [makeImg("a-4x5.jpg")],
      }),
    );
    const manifestB = join(dir, "manifest-b.json"); // CONTEÚDO diferente do A
    writeFileSync(
      manifestB,
      JSON.stringify({
        SQUARE_MARKETING_IMAGE: [makeImg("b-1x1.jpg")],
        MARKETING_IMAGE: [makeImg("b-191x1.jpg")],
        PORTRAIT_MARKETING_IMAGE: [makeImg("b-4x5.jpg")],
      }),
    );
    const progressFile = join(dir, "progress.json");
    const fetchCommentBodiesMock = () => [];
    try {
      // Tentativa 1 com o manifesto A: sucesso completo, mas o progresso é
      // apagado no fim -- pra este teste, interrompemos ANTES do apagamento
      // simulando falha no link (assim o arquivo com fingerprint(A) sobra).
      let assetCounter = 300;
      const fetchMockA = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        if (input.endsWith("assets:mutate")) {
          const body = JSON.parse(String(init?.body));
          const results = body.operations.map(() => ({ resourceName: `customers/2369219639/assets/${assetCounter++}` }));
          return jsonResponse(200, { results });
        }
        if (input.endsWith("assetGroupAssets:mutate")) {
          throw new Error("network down no link (simulado, pra deixar progress.json com fingerprint(A) no disco)");
        }
        throw new Error(`chamada inesperada: ${input}`);
      };
      const codeA = await withEnv(AUTH_ENV, () =>
        swapMain(
          ["--customer-id", "2369219639", "--send", "--images-manifest", manifestA, "--progress-file", progressFile],
          fetchMockA as unknown as typeof fetch,
          fetchCommentBodiesMock,
        ),
      );
      assert.equal(codeA, 1, "tentativa com manifesto A precisa falhar no link (de propósito, pra deixar o progresso no disco)");
      assert.ok(existsSync(progressFile));

      // Tentativa 2: MESMO --progress-file, mas com o manifesto B (conteúdo
      // diferente) -- a checagem de fingerprint só acontece depois da
      // leitura read-only do estado atual (token + :search), então esses
      // dois seguem permitidos; o que NUNCA pode rodar é qualquer
      // `:mutate` (create/link) -- é isso que prova que a recusa veio
      // ANTES de qualquer mutação real.
      const fetchMockB = async (input: string) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: SAMPLE_SEARCH_RESULTS });
        throw new Error(`não deveria chamar :mutate algum -- fingerprint divergente precisa recusar antes de qualquer mutação (chamada: ${input})`);
      };
      const codeB = await withEnv(AUTH_ENV, () =>
        swapMain(
          ["--customer-id", "2369219639", "--send", "--images-manifest", manifestB, "--progress-file", progressFile],
          fetchMockB as unknown as typeof fetch,
          fetchCommentBodiesMock,
        ),
      );
      assert.equal(codeB, 1, "fingerprint divergente precisa recusar --send");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
