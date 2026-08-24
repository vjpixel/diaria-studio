/**
 * test/fetch-tally-audience.test.ts (#466)
 *
 * Cobre `fetchAllTallyResponses` (paginação, sem rede real) e os guards
 * rápidos de `main()` (TALLY_API_KEY ausente, kit.tallyFormId ausente,
 * --dry-run) — todos retornam ANTES de chamar `runAudience`. O caminho
 * completo (escrita real + `update-audience.ts`) já é coberto por
 * `test/audience-run.test.ts`; não duplicado aqui.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fetchAllTallyResponses, main } from "../scripts/fetch-tally-audience.ts";

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("fetchAllTallyResponses", () => {
  it("1 página (hasMore:false): devolve as respostas transformadas dessa página", async () => {
    const fetchImpl = (async () =>
      jsonRes({
        page: 1,
        hasMore: false,
        questions: [{ id: "q1", title: "Pergunta?", type: "MULTIPLE_CHOICE" }],
        submissions: [{ id: "s1", isCompleted: true, responses: [{ id: "r1", questionId: "q1", answer: ["A"] }] }],
      })) as typeof fetch;
    const result = await fetchAllTallyResponses("formId", "key", { fetchImpl });
    assert.equal(result.responses.length, 1);
    assert.equal(result.responses[0].answers[0].question_prompt, "Pergunta?");
    assert.equal(result.totalSeen, 1);
    assert.equal(result.totalIncomplete, 0);
  });

  it("2 páginas (hasMore:true depois false): pagina até esgotar e concatena", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const page = url.includes("page=2") ? 2 : 1;
      return jsonRes({
        page,
        hasMore: page === 1,
        questions: [{ id: "q1", title: "Pergunta?", type: "MULTIPLE_CHOICE" }],
        submissions: [{ id: `s${page}`, isCompleted: true, responses: [{ id: `r${page}`, questionId: "q1", answer: [`resp${page}`] }] }],
      });
    }) as typeof fetch;
    const result = await fetchAllTallyResponses("formId", "key", { fetchImpl });
    assert.equal(calls.length, 2);
    assert.equal(result.responses.length, 2);
    assert.deepEqual(result.responses.map((r) => r.id), ["s1", "s2"]);
  });

  it("submissões incompletas contam em totalSeen/totalIncomplete mas não em responses", async () => {
    const fetchImpl = (async () =>
      jsonRes({
        page: 1,
        hasMore: false,
        questions: [{ id: "q1", title: "Pergunta?", type: "MULTIPLE_CHOICE" }],
        submissions: [
          { id: "completa", isCompleted: true, responses: [{ id: "r1", questionId: "q1", answer: ["A"] }] },
          { id: "incompleta", isCompleted: false, responses: [{ id: "r2", questionId: "q1", answer: ["B"] }] },
        ],
      })) as typeof fetch;
    const result = await fetchAllTallyResponses("formId", "key", { fetchImpl });
    assert.equal(result.responses.length, 1);
    assert.equal(result.totalSeen, 2);
    assert.equal(result.totalIncomplete, 1);
  });

  it("shape inesperado (2xx mas sem questions/submissions arrays) lança erro nomeado, não um TypeError opaco", async () => {
    const fetchImpl = (async () => jsonRes({ ok: true })) as typeof fetch;
    await assert.rejects(() => fetchAllTallyResponses("formId", "key", { fetchImpl }), /shape inesperado/);
  });

  it("excede MAX_PAGES (hasMore sempre true): aborta com erro nomeado em vez de loop infinito", async () => {
    const fetchImpl = (async () =>
      jsonRes({ page: 1, hasMore: true, questions: [], submissions: [] })) as typeof fetch;
    await assert.rejects(() => fetchAllTallyResponses("formId", "key", { fetchImpl }), /excedeu.*páginas/);
  });

  it("resposta não-2xx lança erro com o status e o body", async () => {
    const fetchImpl = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    await assert.rejects(
      () => fetchAllTallyResponses("formId", "key", { fetchImpl }),
      /403/,
    );
  });
});

describe("main() — guards rápidos (nunca chegam em runAudience)", () => {
  const origEnv = { ...process.env };
  const origArgv = process.argv;

  afterEach(() => {
    process.env = { ...origEnv };
    process.argv = origArgv;
    process.exitCode = undefined;
  });

  it("TALLY_API_KEY ausente: exitCode 1", async () => {
    const root = mkdtempSync(join(tmpdir(), "fetch-tally-"));
    try {
      delete process.env.TALLY_API_KEY;
      writeFileSync(resolve(root, "platform.config.json"), JSON.stringify({ kit: { tallyFormId: "x" } }), "utf8");
      await main(root);
      assert.equal(process.exitCode, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("kit.tallyFormId ausente: exitCode 1", async () => {
    const root = mkdtempSync(join(tmpdir(), "fetch-tally-"));
    try {
      process.env.TALLY_API_KEY = "test-key";
      writeFileSync(resolve(root, "platform.config.json"), JSON.stringify({}), "utf8");
      await main(root);
      assert.equal(process.exitCode, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--dry-run: busca as respostas mas não escreve nada nem chama runAudience", async () => {
    const root = mkdtempSync(join(tmpdir(), "fetch-tally-"));
    try {
      process.env.TALLY_API_KEY = "test-key";
      writeFileSync(resolve(root, "platform.config.json"), JSON.stringify({ kit: { tallyFormId: "x" } }), "utf8");
      process.argv = ["node", "fetch-tally-audience.ts", "--dry-run"];
      // main() não expõe fetchImpl injetável (só fetchAllTallyResponses
      // expõe) — mocka o fetch GLOBAL com uma resposta 200 vazia, restaurado
      // no finally logo abaixo. dry-run não precisa de dados reais pra
      // confirmar que não escreve nada nem chama runAudience.
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ page: 1, hasMore: false, questions: [], submissions: [] }), { status: 200 })) as typeof fetch;
      try {
        await main(root);
      } finally {
        globalThis.fetch = origFetch;
      }
      assert.notEqual(process.exitCode, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
