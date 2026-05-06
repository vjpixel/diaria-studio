/**
 * drain-follow-ups.test.ts — tests for issues #665, #667, #666, #669
 *
 * #665: searchThreads failure returns skipped:true / reason:"search_failed"
 * #667: DrainResult exposes errors count from getThread failures
 * #666: resolveCoverageLine pure function — 5 paths
 * #669: iterateThreads pure helper — getThread failure path covered directly
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchFailedResult,
  iterateThreads,
  type GmailThread,
  type GmailThread2,
} from "../scripts/inbox-drain.ts";
import { resolveCoverageLine } from "../scripts/render-categorized-md.ts";

// ---------------------------------------------------------------------------
// #665 — searchThreads failure structure
// ---------------------------------------------------------------------------

describe("buildSearchFailedResult (#665)", () => {
  it("retorna DrainResult com skipped:true e reason:search_failed", () => {
    const result = buildSearchFailedResult("ZodError: payload.headers required");
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "search_failed");
    assert.equal(result.new_entries, 0);
    assert.deepEqual(result.urls, []);
    assert.deepEqual(result.topics, []);
    assert.equal(result.most_recent_iso, null);
  });

  it("inclui errors:1 e error_samples", () => {
    const result = buildSearchFailedResult("Gmail API error (503)");
    assert.equal(result.errors, 1);
    assert.ok(Array.isArray(result.error_samples));
    assert.equal(result.error_samples![0], "Gmail API error (503)");
  });

  it("trunca erro longo a 200 chars", () => {
    const longMsg = "x".repeat(500);
    const result = buildSearchFailedResult(longMsg);
    assert.equal(result.error_samples![0].length, 200);
  });

  it("resultado diferenciado de drain vazio normal (drain vazio tem skipped:false)", () => {
    const result = buildSearchFailedResult("oops");
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "search_failed");
  });
});

// ---------------------------------------------------------------------------
// #667 — DrainResult interface: campos errors e error_samples são opcionais
// ---------------------------------------------------------------------------

describe("DrainResult errors fields (#667)", () => {
  it("buildSearchFailedResult inclui errors e error_samples", () => {
    const r = buildSearchFailedResult("err");
    assert.ok("errors" in r);
    assert.ok("error_samples" in r);
    assert.equal(r.errors, 1);
  });

  it("campos são opcionais — resultado de drain limpo não precisa ter errors", () => {
    // Garante que o tipo aceita ausência dos campos
    const clean: ReturnType<typeof buildSearchFailedResult> = {
      new_entries: 1,
      urls: [],
      topics: [],
      most_recent_iso: "2026-05-05T10:00:00Z",
      skipped: false,
    };
    assert.equal(clean.errors, undefined);
    assert.equal(clean.error_samples, undefined);
  });
});

// ---------------------------------------------------------------------------
// #666 — resolveCoverageLine pure function
// ---------------------------------------------------------------------------

describe("resolveCoverageLine (#666)", () => {
  const fallback = () => "fallback line";

  it("path 1a — cliIn é 01-approved.json com inputCoverage.line", () => {
    const line = resolveCoverageLine({
      cliInBasename: "01-approved.json",
      inputCoverage: { line: "Para esta edição, eu (o editor) enviei 5 submissões..." },
      siblingCoverage: null,
      fallback,
    });
    assert.equal(line, "Para esta edição, eu (o editor) enviei 5 submissões...");
  });

  it("path 1b — cliIn é 01-approved.json sem inputCoverage → fallback", () => {
    const line = resolveCoverageLine({
      cliInBasename: "01-approved.json",
      inputCoverage: undefined,
      siblingCoverage: null,
      fallback,
    });
    assert.equal(line, "fallback line");
  });

  it("path 1c — cliIn é 01-approved.json com inputCoverage sem line → fallback", () => {
    const line = resolveCoverageLine({
      cliInBasename: "01-approved.json",
      inputCoverage: {},
      siblingCoverage: null,
      fallback,
    });
    assert.equal(line, "fallback line");
  });

  it("path 2 — cliIn é outro arquivo, siblingCoverage tem line", () => {
    const line = resolveCoverageLine({
      cliInBasename: "01-categorized.json",
      inputCoverage: undefined,
      siblingCoverage: { line: "Para esta edição, eu (o editor) enviei 26 submissões..." },
      fallback,
    });
    assert.equal(line, "Para esta edição, eu (o editor) enviei 26 submissões...");
  });

  it("path 3 — cliIn é outro arquivo, siblingCoverage é null → fallback", () => {
    const line = resolveCoverageLine({
      cliInBasename: "01-categorized.json",
      inputCoverage: undefined,
      siblingCoverage: null,
      fallback,
    });
    assert.equal(line, "fallback line");
  });

  it("path 4 — cliIn é outro arquivo, siblingCoverage sem line → fallback", () => {
    const line = resolveCoverageLine({
      cliInBasename: "01-categorized.json",
      inputCoverage: undefined,
      siblingCoverage: {},
      fallback,
    });
    assert.equal(line, "fallback line");
  });

  it("siblingCoverage não é consultada quando cliIn é approved.json", () => {
    // Garante que path 1 não lê sibling mesmo que exista (evitar re-read de disco)
    let siblingCalled = false;
    const line = resolveCoverageLine({
      cliInBasename: "01-approved.json",
      inputCoverage: { line: "from input" },
      get siblingCoverage() {
        siblingCalled = true;
        return { line: "from sibling" };
      },
      fallback,
    });
    assert.equal(line, "from input");
    assert.equal(siblingCalled, false);
  });
});

// ---------------------------------------------------------------------------
// #669 — iterateThreads pure helper
// ---------------------------------------------------------------------------

/**
 * Constrói um GmailThread2 mínimo viável: 1 mensagem com From, Subject, body
 * com URL ou texto. Permite testar o loop sem depender da Gmail API.
 */
function makeFullThread(
  id: string,
  opts: { from?: string; subject?: string; body?: string; isoDate?: string } = {},
): GmailThread2 {
  const from = opts.from ?? "editor@example.com";
  const subject = opts.subject ?? "(test)";
  const body = opts.body ?? "Body com https://example.com/article";
  const isoDate = opts.isoDate ?? "2026-05-05T10:00:00.000Z";
  const internalDate = String(new Date(isoDate).getTime());
  // Body em base64url (Gmail format)
  const b64 = Buffer.from(body, "utf8")
    .toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_");

  return {
    id,
    messages: [
      {
        id: `msg-${id}`,
        internalDate,
        payload: {
          mimeType: "text/plain",
          body: { data: b64 },
          headers: [
            { name: "From", value: from },
            { name: "Subject", value: subject },
          ],
        },
      },
    ],
  };
}

describe("iterateThreads (#669) — getThread error handling", () => {
  it("retorna threadErrors=0 quando nenhum thread falha", async () => {
    const threads: GmailThread[] = [
      { id: "t1" }, { id: "t2" }, { id: "t3" },
    ];
    const fetchThread = async (id: string): Promise<GmailThread2> =>
      makeFullThread(id, { isoDate: `2026-05-05T1${id.charAt(1)}:00:00.000Z` });

    const result = await iterateThreads(threads, fetchThread, null);

    assert.equal(result.threadErrors, 0);
    assert.deepEqual(result.threadErrorSamples, []);
    assert.equal(result.inboxEntries.length, 3, "deve produzir 3 entradas");
  });

  it("incrementa threadErrors quando fetchThread falha em uma thread", async () => {
    const threads: GmailThread[] = [
      { id: "t1" }, { id: "t2" }, { id: "t3" },
    ];
    const fetchThread = async (id: string): Promise<GmailThread2> => {
      if (id === "t2") throw new Error("Gmail 503: backend error");
      return makeFullThread(id, { isoDate: `2026-05-05T1${id.charAt(1)}:00:00.000Z` });
    };

    const result = await iterateThreads(threads, fetchThread, null);

    assert.equal(result.threadErrors, 1, "1 thread falhou");
    assert.equal(result.threadErrorSamples.length, 1);
    assert.ok(result.threadErrorSamples[0].includes("503"));
    assert.equal(result.inboxEntries.length, 2, "2 threads bem-sucedidas viraram entrada");
  });

  it("acumula múltiplos erros mas trunca samples em 3", async () => {
    // 5 threads, todas falham com mensagens distintas
    const threads: GmailThread[] = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}` }));
    const fetchThread = async (id: string): Promise<GmailThread2> => {
      throw new Error(`Erro em ${id}`);
    };

    const result = await iterateThreads(threads, fetchThread, null);

    assert.equal(result.threadErrors, 5, "todas as 5 falharam");
    assert.equal(
      result.threadErrorSamples.length,
      3,
      "samples são limitados a 3 pra não inflar log",
    );
    // Deve conter samples das 3 primeiras (t0, t1, t2)
    assert.ok(result.threadErrorSamples[0].includes("t0"));
    assert.ok(result.threadErrorSamples[1].includes("t1"));
    assert.ok(result.threadErrorSamples[2].includes("t2"));
    assert.equal(result.inboxEntries.length, 0);
  });

  it("trunca cada sample a 200 chars (defesa anti-stack-trace gigante)", async () => {
    const longMsg = "x".repeat(500);
    const fetchThread = async (): Promise<GmailThread2> => {
      throw new Error(longMsg);
    };

    const result = await iterateThreads([{ id: "t1" }], fetchThread, null);

    assert.equal(result.threadErrorSamples[0].length, 200);
  });

  it("trata Error não-padrão (string lançada) sem crashar", async () => {
    const fetchThread = async (): Promise<GmailThread2> => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "raw string error";
    };

    const result = await iterateThreads([{ id: "t1" }], fetchThread, null);

    assert.equal(result.threadErrors, 1);
    assert.equal(result.threadErrorSamples[0], "raw string error");
  });

  it("aplica filtro lastDrain — só processa mensagens mais novas que cursor", async () => {
    const fetchThread = async (id: string): Promise<GmailThread2> => {
      // Thread 1: mensagem em 09:00 (antes do cursor)
      // Thread 2: mensagem em 11:00 (depois do cursor)
      const time = id === "t1" ? "2026-05-05T09:00:00.000Z" : "2026-05-05T11:00:00.000Z";
      return makeFullThread(id, { isoDate: time });
    };
    const lastDrain = "2026-05-05T10:00:00.000Z";

    const result = await iterateThreads([{ id: "t1" }, { id: "t2" }], fetchThread, lastDrain);

    assert.equal(result.threadErrors, 0);
    assert.equal(result.inboxEntries.length, 1, "só t2 (depois do cursor) entra");
    assert.equal(result.mostRecentIso, "2026-05-05T11:00:00.000Z");
  });

  it("extrai URLs do body como resultUrls", async () => {
    const fetchThread = async (id: string): Promise<GmailThread2> =>
      makeFullThread(id, { body: "Olha esse link: https://example.com/article aqui" });

    const result = await iterateThreads([{ id: "t1" }], fetchThread, null);

    assert.equal(result.resultUrls.length, 1);
    assert.equal(result.resultUrls[0].url, "https://example.com/article");
  });

  it("body sem URL e suficientemente longo vira topic", async () => {
    const fetchThread = async (id: string): Promise<GmailThread2> =>
      makeFullThread(id, {
        body: "Sugestão de pauta sobre AI safety na semana — sem link específico ainda",
      });

    const result = await iterateThreads([{ id: "t1" }], fetchThread, null);

    assert.equal(result.resultUrls.length, 0);
    assert.equal(result.resultTopics.length, 1);
    assert.ok(result.resultTopics[0].text.includes("AI safety"));
  });

  it("erros parciais não afetam coleta de threads bem-sucedidas (DrainResult.errors > 0 + new_entries > 0)", async () => {
    // Cenário do issue: alguns threads falham (errors > 0), outros sucedem (new_entries > 0)
    const threads: GmailThread[] = [
      { id: "t1" }, { id: "t2-broken" }, { id: "t3" },
    ];
    const fetchThread = async (id: string): Promise<GmailThread2> => {
      if (id === "t2-broken") throw new Error("ZodError: payload.headers required");
      return makeFullThread(id, { isoDate: `2026-05-05T1${id.charAt(1)}:00:00.000Z` });
    };

    const result = await iterateThreads(threads, fetchThread, null);

    assert.equal(result.threadErrors, 1, "errors >= 1");
    assert.equal(result.inboxEntries.length, 2, "new_entries reflete só as bem-sucedidas");
    // Garante que o sample tem o erro real
    assert.ok(result.threadErrorSamples[0].includes("ZodError"));
  });
});
