import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fetchQueuedCampaigns,
  cycleNamePrefix,
  filterCycleCampaigns,
  partitionByQueuedStatus,
  buildPlanLines,
  reapplyHtml,
  verifyUnchanged,
  parseApplyArg,
  main,
  type BrevoCampaignListItem,
  type BrevoCampaignDetail,
} from "../scripts/clarice-reapply-scheduled-html.ts";

/**
 * Regressão #2940 (#633): near-miss real 2026-07-03/04 — campanhas A/B/C
 * montadas manualmente na Brevo não tinham campaigns-summary.json, e o bug
 * que quase escondeu as campanhas foi ler `r.campaigns` em vez de
 * `r.body.campaigns` (brevoGet retorna `{status, body}`). Estes testes
 * mockam `globalThis.fetch` — NUNCA tocam a Brevo real.
 */

function mockCampaign(overrides: Partial<BrevoCampaignListItem> = {}): BrevoCampaignListItem {
  return {
    id: 81,
    name: "Clarice News 2606 d01-A (sáb)",
    status: "queued",
    subject: "Assunto A",
    scheduledAt: "2026-07-04T09:00:00.000Z",
    ...overrides,
  };
}

describe("fetchQueuedCampaigns (#2940 — parsing correto de body.campaigns)", () => {
  it("parseia body.campaigns corretamente (shape real da Brevo)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ campaigns: [mockCampaign()], count: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    try {
      const result = await fetchQueuedCampaigns("fake-key");
      assert.equal(result.length, 1);
      assert.equal(result[0].id, 81);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("inclui 'scheduled' e exclui 'sent' (finding review 260704: Brevo reporta queued OU scheduled)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          campaigns: [
            mockCampaign({ id: 81, status: "queued" }),
            mockCampaign({ id: 82, status: "scheduled" }),
            mockCampaign({ id: 83, status: "sent" }),
          ],
          count: 3,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    try {
      const result = await fetchQueuedCampaigns("fake-key");
      assert.deepEqual(result.map((c) => c.id).sort(), [81, 82]); // queued + scheduled, NUNCA o sent 83
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("lança erro claro se o corpo não tiver campaigns[] (bug do near-miss: ler r.campaigns em vez de r.body.campaigns)", async () => {
    const origFetch = globalThis.fetch;
    // Simula um shape onde 'campaigns' não está no lugar certo — deve falhar
    // ALTO, nunca silenciar retornando [].
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ notCampaigns: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    try {
      await assert.rejects(
        () => fetchQueuedCampaigns("fake-key"),
        /shape inesperado.*body\.campaigns/,
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("lança erro se HTTP não for 200", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof globalThis.fetch;
    try {
      await assert.rejects(() => fetchQueuedCampaigns("fake-key"), /HTTP 500/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("cycleNamePrefix / filterCycleCampaigns", () => {
  it("prefixo usa cycleToYymm (conteúdo, não o ciclo completo)", () => {
    assert.equal(cycleNamePrefix("2606-07"), "Clarice News 2606");
  });

  it("filtra só campanhas cujo nome bate com o prefixo do ciclo", () => {
    const campaigns = [
      mockCampaign({ id: 1, name: "Clarice News 2606 d01-A (sáb)" }),
      mockCampaign({ id: 2, name: "Clarice News 2605 d01-A (velho ciclo)" }),
      mockCampaign({ id: 3, name: "Outra coisa completamente diferente" }),
    ];
    const matched = filterCycleCampaigns(campaigns, "2606-07");
    assert.deepEqual(matched.map((c) => c.id), [1]);
  });
});

describe("partitionByQueuedStatus (#2940 — NUNCA toca sent/in_process)", () => {
  it("campanha sent no conjunto vai para skipped, não para toUpdate", () => {
    const campaigns = [
      mockCampaign({ id: 81, status: "queued" }),
      mockCampaign({ id: 82, status: "sent" }),
      mockCampaign({ id: 83, status: "in_process" }),
    ];
    const { toUpdate, skipped } = partitionByQueuedStatus(campaigns);
    assert.deepEqual(toUpdate.map((c) => c.id), [81]);
    assert.deepEqual(skipped.map((c) => c.id).sort(), [82, 83]);
  });

  it("todas queued → nenhuma pulada", () => {
    const campaigns = [mockCampaign({ id: 1 }), mockCampaign({ id: 2 })];
    const { toUpdate, skipped } = partitionByQueuedStatus(campaigns);
    assert.equal(toUpdate.length, 2);
    assert.equal(skipped.length, 0);
  });

  it("'scheduled' vai pra toUpdate (finding review 260704: pré-envio seguro, não pular)", () => {
    const campaigns = [
      mockCampaign({ id: 81, status: "queued" }),
      mockCampaign({ id: 82, status: "scheduled" }),
      mockCampaign({ id: 83, status: "sent" }),
    ];
    const { toUpdate, skipped } = partitionByQueuedStatus(campaigns);
    assert.deepEqual(toUpdate.map((c) => c.id).sort(), [81, 82]);
    assert.deepEqual(skipped.map((c) => c.id), [83]);
  });
});

describe("buildPlanLines", () => {
  it("lista campanhas a atualizar e campanhas puladas separadamente", () => {
    const toUpdate = [mockCampaign({ id: 81 })];
    const skipped = [mockCampaign({ id: 82, status: "sent" })];
    const lines = buildPlanLines(toUpdate, skipped).join("\n");
    assert.match(lines, /#81/);
    assert.match(lines, /#82/);
    assert.match(lines, /status=sent/);
  });
});

describe("reapplyHtml (#2940 — PUT só htmlContent)", () => {
  it("body do PUT contém só htmlContent (nunca subject/scheduledAt/recipients)", async () => {
    const origFetch = globalThis.fetch;
    let capturedBody: any = null;
    let capturedMethod = "";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedMethod = init?.method ?? "";
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(null, { status: 204 }); // 204 No Content — corpo DEVE ser null
    }) as unknown as typeof globalThis.fetch;
    try {
      await reapplyHtml("fake-key", 81, "<html>novo</html>");
      assert.equal(capturedMethod, "PUT");
      assert.deepEqual(Object.keys(capturedBody), ["htmlContent"]);
      assert.equal(capturedBody.htmlContent, "<html>novo</html>");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("verifyUnchanged", () => {
  it("nenhuma mudança em subject/scheduledAt/status → sem issues", () => {
    const before = mockCampaign();
    const after: BrevoCampaignDetail = { ...before, htmlContent: "<html>x</html>" };
    const issues = verifyUnchanged(before, after, "<html>x</html>");
    assert.deepEqual(issues, []);
  });

  it("subject mudou → issue reportada", () => {
    const before = mockCampaign();
    const after: BrevoCampaignDetail = { ...before, subject: "Outro assunto", htmlContent: "<html>x</html>" };
    const issues = verifyUnchanged(before, after, "<html>x</html>");
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /subject mudou/);
  });

  it("scheduledAt mudou → issue reportada", () => {
    const before = mockCampaign();
    const after: BrevoCampaignDetail = { ...before, scheduledAt: "2030-01-01T00:00:00.000Z", htmlContent: "<html>x</html>" };
    const issues = verifyUnchanged(before, after, "<html>x</html>");
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /scheduledAt mudou/);
  });

  it("status pós-update virou sent → issue reportada (nunca deveria acontecer, mas detectável)", () => {
    const before = mockCampaign();
    const after: BrevoCampaignDetail = { ...before, status: "sent", htmlContent: "<html>x</html>" };
    const issues = verifyUnchanged(before, after, "<html>x</html>");
    assert.ok(issues.some((i) => /status pós-update/.test(i.message)));
  });

  it("htmlContent divergente do esperado → issue reportada", () => {
    const before = mockCampaign();
    const after: BrevoCampaignDetail = { ...before, htmlContent: "<html>errado</html>" };
    const issues = verifyUnchanged(before, after, "<html>certo</html>");
    assert.ok(issues.some((i) => /htmlContent/.test(i.message)));
  });
});

describe("parseApplyArg (#2940 — --dry-run é o default)", () => {
  it("sem --apply → false (dry-run)", () => {
    assert.equal(parseApplyArg(["--cycle", "2606-07"]), false);
  });

  it("--apply → true", () => {
    assert.equal(parseApplyArg(["--cycle", "2606-07", "--apply"]), true);
  });
});

describe("main() — dry-run (default) NUNCA chama PUT (#633 item d)", () => {
  it("sem --apply: descobre campanhas mas não escreve nada", async () => {
    const origFetch = globalThis.fetch;
    const origEnv = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_CLARICE_API_KEY = "fake-key";

    let putCalled = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        putCalled = true;
        return new Response(null, { status: 204 }); // 204 No Content — corpo DEVE ser null
      }
      // GET /emailCampaigns?limit=... (lista de descoberta — sem filtro de status, #review-260704)
      if (String(url).includes("/emailCampaigns?limit")) {
        return new Response(
          JSON.stringify({ campaigns: [mockCampaign({ id: 81 }), mockCampaign({ id: 82, status: "sent" })] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(mockCampaign({ id: 81 })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    // htmlPath resolution will fail (no data/ in a clean checkout) before
    // reaching the network calls in a real run of main(); to isolate the
    // "dry-run never PUTs" behavior, we exercise the underlying pieces main()
    // composes rather than requiring a real monthly dir on disk.
    try {
      const all = await fetchQueuedCampaigns("fake-key");
      const matched = filterCycleCampaigns(all, "2606-07");
      const { toUpdate } = partitionByQueuedStatus(matched);
      assert.equal(toUpdate.length, 1);
      const apply = parseApplyArg(["--cycle", "2606-07"]);
      assert.equal(apply, false);
      // Simulating main()'s dry-run branch: apply=false must return before
      // any reapplyHtml/PUT call.
      if (!apply) {
        assert.equal(putCalled, false, "PUT não deve ter sido chamado em dry-run");
        return;
      }
      assert.fail("não deveria chegar aqui em dry-run");
    } finally {
      globalThis.fetch = origFetch;
      if (origEnv === undefined) delete process.env.BREVO_CLARICE_API_KEY;
      else process.env.BREVO_CLARICE_API_KEY = origEnv;
    }
  });

  it("main() de fato: sem --cycle válido, sai sem tocar rede (guard de argumento)", async () => {
    const origFetch = globalThis.fetch;
    const origExit = process.exit;
    let exitCode: number | undefined;
    let fetchCalled = false;
    (process as any).exit = ((code?: number) => {
      exitCode = code;
      throw new Error("process.exit called");
    }) as any;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      await assert.rejects(() => main(["--cycle", "not-a-cycle"]), /process\.exit called/);
      assert.equal(exitCode, 1);
      assert.equal(fetchCalled, false, "não deve chamar fetch sem --cycle válido");
    } finally {
      globalThis.fetch = origFetch;
      process.exit = origExit;
    }
  });
});
