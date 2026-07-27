import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fetchQueuedCampaigns,
  fetchCampaignById,
  cycleNamePrefix,
  cycleNamePrefixes,
  filterCycleCampaigns,
  campaignCycleMismatchWarning,
  partitionByQueuedStatus,
  buildPlanLines,
  reapplyHtml,
  setCampaignStatus,
  sumListSubscribers,
  detectPostRescheduleDivergence,
  detectZeroAudienceAnomaly,
  emitLoudBanner,
  applyReapply,
  runApplyBatch,
  StuckSuspendedCampaignError,
  parseApplyArg,
  parseCampaignIdArg,
  main,
  type BrevoCampaignListItem,
} from "../scripts/clarice-reapply-scheduled-html.ts";

/**
 * Regressão #2940 + #4082 (#633): near-miss real 2026-07-03/04 (campanhas
 * A/B/C montadas manualmente na Brevo, bug de parsing r.campaigns vs
 * r.body.campaigns) e near-miss real 2026-07-27 (campanha #99 queued,
 * faltando 5h pro disparo — limit=1000 recusado + matching não via campanhas
 * do fluxo --group). Estes testes mockam `globalThis.fetch` — NUNCA tocam a
 * Brevo real.
 */

function mockCampaign(overrides: Partial<BrevoCampaignListItem> = {}): BrevoCampaignListItem {
  return {
    id: 81,
    name: "Clarice News 2606 d01-A (sáb)",
    status: "queued",
    subject: "Assunto A",
    scheduledAt: "2026-07-04T09:00:00.000Z",
    recipients: { lists: [55] },
    ...overrides,
  };
}

describe("fetchQueuedCampaigns — pagina em vez de pedir limit=1000 (#4082 item 1)", () => {
  it("pagina com limit=100 + offset até a página vir mais curta", async () => {
    const origFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    let page = 0;
    globalThis.fetch = (async (url: string) => {
      requestedUrls.push(String(url));
      const body =
        page === 0
          ? { campaigns: Array.from({ length: 100 }, (_, i) => mockCampaign({ id: i + 1 })) }
          : { campaigns: [mockCampaign({ id: 101 })] };
      page++;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    try {
      const result = await fetchQueuedCampaigns("fake-key");
      assert.equal(result.length, 101, "duas páginas somadas: 100 + 1");
      assert.ok(requestedUrls.every((u) => !u.includes("limit=1000")), "nunca deve pedir limit=1000");
      assert.ok(requestedUrls.some((u) => u.includes("limit=100&offset=0")));
      assert.ok(requestedUrls.some((u) => u.includes("limit=100&offset=100")));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("uma página só (< 100 itens) não pagina de novo", async () => {
    const origFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ campaigns: [mockCampaign({ id: 1 })] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    try {
      const result = await fetchQueuedCampaigns("fake-key");
      assert.equal(result.length, 1);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("simula o 400 real da Brevo pra limit=1000 — endpoint com limit correto nunca bate esse status", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("limit=1000")) {
        return new Response(
          JSON.stringify({ code: "out_of_range", message: "Limit exceeds max value" }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ campaigns: [mockCampaign({ id: 1 })] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    try {
      const result = await fetchQueuedCampaigns("fake-key");
      assert.equal(result.length, 1);
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
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    try {
      const result = await fetchQueuedCampaigns("fake-key");
      assert.deepEqual(result.map((c) => c.id).sort(), [81, 82]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("lança erro claro se o corpo não tiver campaigns[] (bug do near-miss: ler r.campaigns em vez de r.body.campaigns)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ notCampaigns: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    try {
      await assert.rejects(() => fetchQueuedCampaigns("fake-key"), /shape inesperado.*body\.campaigns/);
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

describe("cycleNamePrefixes / filterCycleCampaigns — reconhece os dois fluxos de nome (#4082 item 2)", () => {
  it("cycleNamePrefix (singular) mantém o prefixo do fluxo antigo, cycleNamePrefixes traz os dois", () => {
    assert.equal(cycleNamePrefix("2606-07"), "Clarice News 2606");
    assert.deepEqual(cycleNamePrefixes("2606-07"), ["Clarice News 2606", "Clarice 2606 grupo:"]);
  });

  it("casa 'Clarice News {yymm}' (fluxo clarice-schedule-sends.ts)", () => {
    const campaigns = [mockCampaign({ id: 1, name: "Clarice News 2606 d01-A (sáb)" })];
    assert.deepEqual(filterCycleCampaigns(campaigns, "2606-07").map((c) => c.id), [1]);
  });

  it("casa 'Clarice {yymm} grupo:{key}' (fluxo clarice-schedule-group.ts — near-miss #4082)", () => {
    const campaigns = [mockCampaign({ id: 2, name: "Clarice 2606 grupo:envio10" })];
    assert.deepEqual(filterCycleCampaigns(campaigns, "2606-07").map((c) => c.id), [2]);
  });

  it("filtra fora ciclo antigo e nomes não relacionados", () => {
    const campaigns = [
      mockCampaign({ id: 1, name: "Clarice News 2606 d01-A (sáb)" }),
      mockCampaign({ id: 2, name: "Clarice 2606 grupo:envio10" }),
      mockCampaign({ id: 3, name: "Clarice News 2605 d01-A (velho ciclo)" }),
      mockCampaign({ id: 4, name: "Clarice 2605 grupo:envio03" }),
      mockCampaign({ id: 5, name: "Outra coisa completamente diferente" }),
    ];
    const matched = filterCycleCampaigns(campaigns, "2606-07");
    assert.deepEqual(matched.map((c) => c.id).sort(), [1, 2]);
  });
});

describe("campaignCycleMismatchWarning (finding 2 do review #4142 — cross-check warning-only pra --campaign-id)", () => {
  it("nome bate com prefixo do ciclo -> undefined (sem aviso)", () => {
    const warning = campaignCycleMismatchWarning(
      { id: 99, name: "Clarice News 2606 d01-A (sáb)" },
      "2606-07",
    );
    assert.equal(warning, undefined);
  });

  it("nome bate com o prefixo do fluxo --group -> undefined (sem aviso)", () => {
    const warning = campaignCycleMismatchWarning({ id: 99, name: "Clarice 2606 grupo:envio10" }, "2606-07");
    assert.equal(warning, undefined);
  });

  it("nome não bate com nenhum prefixo do ciclo -> mensagem de aviso clara, nomeando ID e ciclo", () => {
    const warning = campaignCycleMismatchWarning(
      { id: 42, name: "Clarice News 2601 d03-C (ciclo antigo)" },
      "2606-07",
    );
    assert.ok(warning);
    assert.match(warning!, /#42/);
    assert.match(warning!, /2606-07/);
    assert.match(warning!, /--campaign-id é explícito/);
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
      return new Response(null, { status: 204 });
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

describe("setCampaignStatus", () => {
  it("PUT /emailCampaigns/{id}/status com o status informado", async () => {
    const origFetch = globalThis.fetch;
    let capturedPath = "";
    let capturedBody: any = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedPath = String(url);
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    try {
      await setCampaignStatus("fake-key", 81, "suspended");
      assert.match(capturedPath, /\/emailCampaigns\/81\/status$/);
      assert.deepEqual(capturedBody, { status: "suspended" });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("sumListSubscribers", () => {
  it("soma totalSubscribers de várias listas", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const id = String(url).match(/lists\/(\d+)/)?.[1];
      const total = id === "10" ? 100 : id === "20" ? 250 : 0;
      return new Response(JSON.stringify({ id: Number(id), name: "x", totalSubscribers: total }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    try {
      const total = await sumListSubscribers("fake-key", [10, 20]);
      assert.equal(total, 350);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("lista vazia -> 0, sem chamar fetch", async () => {
    const origFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      const total = await sumListSubscribers("fake-key", []);
      assert.equal(total, 0);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("detectPostRescheduleDivergence (#4082 item 4 — pure, sem rede)", () => {
  const expected = {
    scheduledAt: "2026-07-27T14:00:00.000Z",
    subject: "Assunto A",
    listIds: [10, 20],
    totalSubscribers: 6804,
  };

  it("tudo igual -> nenhuma divergência", () => {
    const problems = detectPostRescheduleDivergence(expected, {
      status: "queued",
      scheduledAt: expected.scheduledAt,
      subject: expected.subject,
      listIds: [20, 10], // ordem diferente — não deve importar
      totalSubscribers: 6804,
    });
    assert.deepEqual(problems, []);
  });

  it("status final não é queued/scheduled -> divergência", () => {
    const problems = detectPostRescheduleDivergence(expected, {
      status: "draft",
      scheduledAt: expected.scheduledAt,
      subject: expected.subject,
      listIds: expected.listIds,
      totalSubscribers: expected.totalSubscribers,
    });
    assert.ok(problems.some((p) => /status final/.test(p)));
  });

  it("scheduledAt não é byte-idêntico -> divergência (mesmo 1ms de diferença)", () => {
    const problems = detectPostRescheduleDivergence(expected, {
      status: "queued",
      scheduledAt: "2026-07-27T14:00:00.001Z",
      subject: expected.subject,
      listIds: expected.listIds,
      totalSubscribers: expected.totalSubscribers,
    });
    assert.ok(problems.some((p) => /scheduledAt final/.test(p)));
  });

  it("subject mudou -> divergência", () => {
    const problems = detectPostRescheduleDivergence(expected, {
      status: "queued",
      scheduledAt: expected.scheduledAt,
      subject: "Outro assunto",
      listIds: expected.listIds,
      totalSubscribers: expected.totalSubscribers,
    });
    assert.ok(problems.some((p) => /subject mudou/.test(p)));
  });

  it("listas mudaram -> divergência", () => {
    const problems = detectPostRescheduleDivergence(expected, {
      status: "queued",
      scheduledAt: expected.scheduledAt,
      subject: expected.subject,
      listIds: [10, 30],
      totalSubscribers: expected.totalSubscribers,
    });
    assert.ok(problems.some((p) => /listas mudaram/.test(p)));
  });

  it("totalSubscribers divergente -> divergência (#4082 item 4 — re-snapshot no reagendamento)", () => {
    const problems = detectPostRescheduleDivergence(expected, {
      status: "queued",
      scheduledAt: expected.scheduledAt,
      subject: expected.subject,
      listIds: expected.listIds,
      totalSubscribers: 6000,
    });
    assert.ok(problems.some((p) => /totalSubscribers mudou/.test(p)));
  });
});

describe("detectZeroAudienceAnomaly (finding 3 do review #4142 — pure, sem rede)", () => {
  it("listIds vazio -> anomalia (recipients.lists ausente/vazio)", () => {
    const msg = detectZeroAudienceAnomaly("antes", [], 0);
    assert.ok(msg);
    assert.match(msg!, /ausente\/vazio antes/);
  });

  it("totalSubscribers 0 mesmo com listIds preenchido -> anomalia", () => {
    const msg = detectZeroAudienceAnomaly("depois", [55], 0);
    assert.ok(msg);
    assert.match(msg!, /totalSubscribers = 0 depois/);
  });

  it("listIds e totalSubscribers normais -> undefined", () => {
    assert.equal(detectZeroAudienceAnomaly("antes", [55], 6804), undefined);
  });
});

describe("detectPostRescheduleDivergence + anomalia de audiência zero (finding 3 #4142)", () => {
  const expected = {
    scheduledAt: "2026-07-27T14:00:00.000Z",
    subject: "Assunto A",
    listIds: [] as number[],
    totalSubscribers: 0,
  };

  it("0 antes e 0 depois (recipients.lists ausente nos dois momentos) NÃO deve passar silenciosamente — antes bug do finding 3, isto retornava []", () => {
    const problems = detectPostRescheduleDivergence(expected, {
      status: "queued",
      scheduledAt: expected.scheduledAt,
      subject: expected.subject,
      listIds: [],
      totalSubscribers: 0,
    });
    assert.ok(problems.length > 0, "deve reportar pelo menos a anomalia de audiência zero");
    assert.ok(problems.some((p) => /ausente\/vazio depois/.test(p)));
  });

  it("totalSubscribers 0 pós-reschedule com listIds preenchido -> divergência (anomalia, não sucesso)", () => {
    const problems = detectPostRescheduleDivergence(
      { scheduledAt: expected.scheduledAt, subject: expected.subject, listIds: [55], totalSubscribers: 100 },
      {
        status: "queued",
        scheduledAt: expected.scheduledAt,
        subject: expected.subject,
        listIds: [55],
        totalSubscribers: 0,
      },
    );
    assert.ok(problems.some((p) => /totalSubscribers = 0 depois/.test(p)));
  });
});

describe("emitLoudBanner (#4082 item 5 — banner impossível de ignorar)", () => {
  it("imprime via console.error contendo STAGE/MOTIVO/AÇÃO", () => {
    const origError = console.error;
    const lines: string[] = [];
    console.error = ((...args: unknown[]) => { lines.push(args.join(" ")); }) as typeof console.error;
    try {
      emitLoudBanner({
        stage: "clarice-reapply-scheduled-html --cycle 2606-07",
        reason: "campanha #99 ficou SUSPENSA e NÃO foi reagendada",
        action: "reagende manualmente para 2026-07-27T14:00:00.000Z",
      });
      const out = lines.join("\n");
      assert.match(out, /PIPELINE PAROU/);
      assert.match(out, /STAGE:/);
      assert.match(out, /MOTIVO:.*campanha #99.*SUSPENSA/);
      assert.match(out, /AÇÃO:.*reagende manualmente/);
    } finally {
      console.error = origError;
    }
  });
});

describe("applyReapply — fluxo suspend → update → reschedule (#4082 item 3)", () => {
  it("caminho feliz: suspend, PUT html, GET-verify, PUT scheduledAt, GET final sem divergência", async () => {
    const origFetch = globalThis.fetch;
    const camp = mockCampaign({ id: 99, recipients: { lists: [55] } });
    let putStatusCalls = 0;
    let putHtmlCalls = 0;
    let putScheduleCalls = 0;
    let getCampaignCalls = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.brevo.com/v3", "");
      const method = init?.method ?? "GET";
      if (method === "PUT" && path.endsWith("/status")) {
        putStatusCalls++;
        return new Response(null, { status: 204 });
      }
      if (method === "PUT" && path === "/emailCampaigns/99") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if ("htmlContent" in body) putHtmlCalls++;
        if ("scheduledAt" in body) putScheduleCalls++;
        return new Response(null, { status: 204 });
      }
      if (path.startsWith("/contacts/lists/55")) {
        return new Response(JSON.stringify({ id: 55, name: "lista", totalSubscribers: 6804 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/emailCampaigns/99") {
        getCampaignCalls++;
        // 1ª chamada: revalidação pré-suspend. 2ª: GET-verify pós-html.
        // 3ª: GET final pós-reschedule. Todas retornam o mesmo estado —
        // htmlContent só aparece "atualizado" a partir da 2ª chamada em diante
        // pra simular o PUT já ter surtido efeito.
        const htmlContent = getCampaignCalls >= 2 ? "<html>novo</html>" : undefined;
        return new Response(JSON.stringify({ ...camp, htmlContent }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    try {
      const result = await applyReapply("fake-key", "2606-07", camp, "<html>novo</html>");
      assert.equal(putStatusCalls, 1);
      assert.equal(putHtmlCalls, 1);
      assert.equal(putScheduleCalls, 1);
      assert.ok(result);
      assert.equal(result!.campaignId, 99);
      assert.equal(result!.totalSubscribersBefore, 6804);
      assert.equal(result!.totalSubscribersAfter, 6804);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("scheduledAt restaurado é BYTE-IDÊNTICO ao original capturado antes do suspend", async () => {
    const origFetch = globalThis.fetch;
    const originalScheduledAt = "2026-07-27T14:00:00.000Z";
    // recipients.lists precisa ser não-vazio/não-zero (finding 3 #4142 aborta
    // ANTES do suspend se a audiência já for anômala) — este teste quer testar
    // o byte-identical do scheduledAt, não a anomalia.
    const camp = mockCampaign({ id: 99, scheduledAt: originalScheduledAt, recipients: { lists: [55] } });
    let capturedScheduledAtPut: string | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.brevo.com/v3", "");
      const method = init?.method ?? "GET";
      if (method === "PUT" && path.endsWith("/status")) return new Response(null, { status: 204 });
      if (method === "PUT" && path === "/emailCampaigns/99") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if ("scheduledAt" in body) capturedScheduledAtPut = body.scheduledAt;
        return new Response(null, { status: 204 });
      }
      if (path.startsWith("/contacts/lists/55")) {
        return new Response(JSON.stringify({ id: 55, name: "lista", totalSubscribers: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/emailCampaigns/99") {
        return new Response(JSON.stringify({ ...camp, htmlContent: "<html>novo</html>" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    try {
      await applyReapply("fake-key", "2606-07", camp, "<html>novo</html>");
      assert.equal(capturedScheduledAtPut, originalScheduledAt);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("falha entre suspend e reschedule -> emite banner ruidoso e relança (campanha fica presa em suspended)", async () => {
    const origFetch = globalThis.fetch;
    const origError = console.error;
    const errorLines: string[] = [];
    console.error = ((...args: unknown[]) => { errorLines.push(args.join(" ")); }) as typeof console.error;
    // recipients.lists precisa ser não-vazio com totalSubscribers>0 (finding 3
    // #4142 adicionou um abort ANTES do suspend pra audiência anômala — este
    // teste quer exercitar a falha DEPOIS do suspend, então a audiência
    // "antes" precisa ser normal pra chegar lá).
    const camp = mockCampaign({ id: 99, recipients: { lists: [55] } });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.brevo.com/v3", "");
      const method = init?.method ?? "GET";
      if (method === "PUT" && path.endsWith("/status")) return new Response(null, { status: 204 });
      if (method === "PUT" && path === "/emailCampaigns/99") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if ("htmlContent" in body) {
          // Simula falha no PUT de htmlContent (rede caiu logo após o suspend).
          return new Response("boom", { status: 500 });
        }
        return new Response(null, { status: 204 });
      }
      if (path.startsWith("/contacts/lists/55")) {
        return new Response(JSON.stringify({ id: 55, name: "lista", totalSubscribers: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/emailCampaigns/99") {
        return new Response(JSON.stringify(camp), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    try {
      await assert.rejects(
        () => applyReapply("fake-key", "2606-07", camp, "<html>novo</html>"),
        (e: unknown) => e instanceof StuckSuspendedCampaignError,
      );
      const out = errorLines.join("\n");
      assert.match(out, /PIPELINE PAROU/);
      assert.match(out, /#99/);
      assert.match(out, /SUSPENSA/);
      assert.match(out, /AÇÃO IMEDIATA/);
    } finally {
      globalThis.fetch = origFetch;
      console.error = origError;
    }
  });

  it("totalSubscribers diverge pós-reschedule -> emite banner (campanha JÁ reagendada, não 'presa') e relança", async () => {
    const origFetch = globalThis.fetch;
    const origError = console.error;
    const errorLines: string[] = [];
    console.error = ((...args: unknown[]) => { errorLines.push(args.join(" ")); }) as typeof console.error;
    const camp = mockCampaign({ id: 99, recipients: { lists: [55] } });
    let listCallCount = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.brevo.com/v3", "");
      const method = init?.method ?? "GET";
      if (method === "PUT" && path.endsWith("/status")) return new Response(null, { status: 204 });
      if (method === "PUT" && path === "/emailCampaigns/99") return new Response(null, { status: 204 });
      if (path.startsWith("/contacts/lists/55")) {
        listCallCount++;
        // Antes do suspend: 6804. Depois do reschedule: caiu pra 6000 (lista mudou).
        const total = listCallCount === 1 ? 6804 : 6000;
        return new Response(JSON.stringify({ id: 55, name: "lista", totalSubscribers: total }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/emailCampaigns/99") {
        return new Response(JSON.stringify({ ...camp, htmlContent: "<html>novo</html>" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    try {
      await assert.rejects(() => applyReapply("fake-key", "2606-07", camp, "<html>novo</html>"), /Divergência pós-reschedule/);
      const out = errorLines.join("\n");
      assert.match(out, /PIPELINE PAROU/);
      assert.match(out, /totalSubscribers mudou/);
      // Não deve alegar que a campanha está "presa" suspensa — já foi reagendada.
      assert.ok(!/SUSPENSA e NÃO foi reagendada/.test(out));
    } finally {
      globalThis.fetch = origFetch;
      console.error = origError;
    }
  });

  it("finding 3 (#4142): recipients.lists ausente ANTES do suspend -> aborta sem tocar nada (nenhum PUT, nem suspend)", async () => {
    const origFetch = globalThis.fetch;
    const camp = mockCampaign({ id: 99, recipients: {} });
    let putCalled = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        putCalled = true;
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(camp), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    try {
      await assert.rejects(
        () => applyReapply("fake-key", "2606-07", camp, "<html>novo</html>"),
        /ausente\/vazio antes.*Abortando antes de suspender/,
      );
      assert.equal(putCalled, false, "nem suspend nem nenhum outro PUT deve ter sido chamado");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("finding 3 (#4142): totalSubscribers 0 ANTES do suspend (lista existe mas vazia) -> aborta sem tocar nada", async () => {
    const origFetch = globalThis.fetch;
    const camp = mockCampaign({ id: 99, recipients: { lists: [55] } });
    let putCalled = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.brevo.com/v3", "");
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        putCalled = true;
        return new Response(null, { status: 204 });
      }
      if (path.startsWith("/contacts/lists/55")) {
        return new Response(JSON.stringify({ id: 55, name: "lista", totalSubscribers: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(camp), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    try {
      await assert.rejects(
        () => applyReapply("fake-key", "2606-07", camp, "<html>novo</html>"),
        /totalSubscribers = 0 antes.*Abortando antes de suspender/,
      );
      assert.equal(putCalled, false, "nem suspend nem nenhum outro PUT deve ter sido chamado");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("finding 1 (#4142): falha na Fase A (suspend->html->reschedule) rejeita com StuckSuspendedCampaignError", async () => {
    const origFetch = globalThis.fetch;
    const origError = console.error;
    console.error = (() => {}) as typeof console.error;
    // recipients.lists precisa ser não-vazio/não-zero (finding 3 #4142 aborta
    // ANTES do suspend se a audiência já for anômala) — este teste quer testar
    // a falha DEPOIS do suspend (Fase A), não a anomalia de audiência.
    const camp = mockCampaign({ id: 99, recipients: { lists: [55] } });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.brevo.com/v3", "");
      const method = init?.method ?? "GET";
      if (method === "PUT" && path.endsWith("/status")) return new Response(null, { status: 204 });
      if (method === "PUT" && path === "/emailCampaigns/99") return new Response("boom", { status: 500 });
      if (path.startsWith("/contacts/lists/55")) {
        return new Response(JSON.stringify({ id: 55, name: "lista", totalSubscribers: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/emailCampaigns/99") {
        return new Response(JSON.stringify(camp), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    try {
      let caught: unknown;
      try {
        await applyReapply("fake-key", "2606-07", camp, "<html>novo</html>");
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof StuckSuspendedCampaignError, "deve lançar StuckSuspendedCampaignError, não Error genérico");
      assert.equal((caught as StuckSuspendedCampaignError).campaignId, 99);
    } finally {
      globalThis.fetch = origFetch;
      console.error = origError;
    }
  });

  it("campanha não é mais queued/scheduled na revalidação -> pula sem tocar (retorna null, nenhum PUT)", async () => {
    const origFetch = globalThis.fetch;
    const camp = mockCampaign({ id: 99 });
    let putCalled = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") { putCalled = true; return new Response(null, { status: 204 }); }
      return new Response(JSON.stringify({ ...camp, status: "sent" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    try {
      const result = await applyReapply("fake-key", "2606-07", camp, "<html>novo</html>");
      assert.equal(result, null);
      assert.equal(putCalled, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("runApplyBatch (finding 1 do review #4142 — aborta o lote no primeiro stuck-suspended)", () => {
  /** Monta um fetch mock por campaign id: `behaviors[id]` = "ok" | "stuck". */
  function makeBatchFetch(behaviors: Record<number, "ok" | "stuck">) {
    return (async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.brevo.com/v3", "");
      const method = init?.method ?? "GET";
      const idMatch = path.match(/\/emailCampaigns\/(\d+)/);
      const id = idMatch ? Number(idMatch[1]) : undefined;
      if (method === "PUT" && path.endsWith("/status")) return new Response(null, { status: 204 });
      if (method === "PUT" && id !== undefined && path === `/emailCampaigns/${id}`) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if ("htmlContent" in body && behaviors[id] === "stuck") {
          return new Response("boom", { status: 500 });
        }
        return new Response(null, { status: 204 });
      }
      if (path.startsWith("/contacts/lists/")) {
        return new Response(JSON.stringify({ id: 55, name: "lista", totalSubscribers: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (id !== undefined) {
        return new Response(
          JSON.stringify({
            id,
            name: `Clarice News 2606 d0${id}`,
            status: "queued",
            subject: "Assunto",
            scheduledAt: "2026-07-27T14:00:00.000Z",
            recipients: { lists: [55] },
            // Sempre "atualizado" — o GET-verify pós-PUT-html de applyReapply
            // compara contra o `html` passado ao runApplyBatch (sempre
            // "<html>novo</html>" nestes testes); não modelamos a ordem
            // antes/depois do PUT porque não é isso que este describe testa.
            htmlContent: "<html>novo</html>",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
  }

  function campaignItem(id: number): BrevoCampaignListItem {
    return {
      id,
      name: `Clarice News 2606 d0${id}`,
      status: "queued",
      subject: "Assunto",
      scheduledAt: "2026-07-27T14:00:00.000Z",
      recipients: { lists: [55] },
    };
  }

  it("todas OK -> succeeded com as 3, aborted false, notProcessed vazio", async () => {
    const origFetch = globalThis.fetch;
    const origError = console.error;
    console.error = (() => {}) as typeof console.error;
    globalThis.fetch = makeBatchFetch({});
    try {
      const toUpdate = [campaignItem(1), campaignItem(2), campaignItem(3)];
      const result = await runApplyBatch("fake-key", "2606-07", toUpdate, "<html>novo</html>");
      assert.equal(result.succeeded.length, 3);
      assert.equal(result.failedIds.length, 0);
      assert.equal(result.aborted, false);
      assert.deepEqual(result.notProcessed, []);
    } finally {
      globalThis.fetch = origFetch;
      console.error = origError;
    }
  });

  it("2ª campanha fica stuck-suspended -> aborta o lote, 3ª NUNCA é tentada (nenhum PUT pra ela)", async () => {
    const origFetch = globalThis.fetch;
    const origError = console.error;
    const errorLines: string[] = [];
    console.error = ((...args: unknown[]) => { errorLines.push(args.join(" ")); }) as typeof console.error;
    let putCalledForId3 = false;
    const baseFetch = makeBatchFetch({ 2: "stuck" });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT" && String(url).includes("/emailCampaigns/3")) putCalledForId3 = true;
      return baseFetch(url as any, init);
    }) as unknown as typeof globalThis.fetch;
    try {
      const toUpdate = [campaignItem(1), campaignItem(2), campaignItem(3)];
      const result = await runApplyBatch("fake-key", "2606-07", toUpdate, "<html>novo</html>");
      assert.equal(result.succeeded.length, 1, "só a campanha #1 deve ter sucedido");
      assert.equal(result.succeeded[0]?.campaignId, 1);
      assert.ok(result.failedIds.includes(2));
      assert.equal(result.aborted, true);
      assert.deepEqual(result.notProcessed.map((c) => c.id), [3], "campanha #3 nunca deveria ter sido tentada");
      assert.equal(putCalledForId3, false, "nenhum PUT deveria ter sido emitido pra campanha #3");
      const out = errorLines.join("\n");
      assert.match(out, /INTERROMPIDO/);
      assert.match(out, /#3/);
      assert.match(out, /NÃO foram processadas/);
    } finally {
      globalThis.fetch = origFetch;
      console.error = origError;
    }
  });

  it("stuck-suspended é a ÚLTIMA campanha do lote -> aborta mas não emite banner de 'não processadas' (nada sobrou)", async () => {
    const origFetch = globalThis.fetch;
    const origError = console.error;
    const errorLines: string[] = [];
    console.error = ((...args: unknown[]) => { errorLines.push(args.join(" ")); }) as typeof console.error;
    globalThis.fetch = makeBatchFetch({ 2: "stuck" });
    try {
      const toUpdate = [campaignItem(1), campaignItem(2)];
      const result = await runApplyBatch("fake-key", "2606-07", toUpdate, "<html>novo</html>");
      assert.equal(result.aborted, true);
      assert.deepEqual(result.notProcessed, []);
      const out = errorLines.join("\n");
      assert.ok(!/INTERROMPIDO/.test(out), "sem campanhas remanescentes, não há lote a declarar interrompido");
    } finally {
      globalThis.fetch = origFetch;
      console.error = origError;
    }
  });

  it("divergência pós-reschedule (não stuck) NÃO aborta o lote — próxima campanha ainda é tentada", async () => {
    const origFetch = globalThis.fetch;
    const origError = console.error;
    console.error = (() => {}) as typeof console.error;
    // Campanha #1: totalSubscribers muda entre "antes" (100) e "depois" (50) —
    // divergência pós-reschedule (Fase B, não stuck: a campanha já voltou pra
    // fila). Campanha #2: fluxo normal, sem divergência.
    let listCalls = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.brevo.com/v3", "");
      const method = init?.method ?? "GET";
      const idMatch = path.match(/\/emailCampaigns\/(\d+)/);
      const id = idMatch ? Number(idMatch[1]) : undefined;
      if (method === "PUT" && path.endsWith("/status")) return new Response(null, { status: 204 });
      if (method === "PUT" && id !== undefined) return new Response(null, { status: 204 });
      if (path.startsWith("/contacts/lists/")) {
        listCalls++;
        // Chamadas 1-2 = campanha #1 (antes=100, depois=50); 3-4 = campanha #2 (100 nos dois).
        const total = listCalls <= 1 ? 100 : listCalls === 2 ? 50 : 100;
        return new Response(JSON.stringify({ id: 55, name: "lista", totalSubscribers: total }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (id !== undefined) {
        return new Response(
          JSON.stringify({
            id,
            name: `Clarice News 2606 d0${id}`,
            status: "queued",
            subject: "Assunto",
            scheduledAt: "2026-07-27T14:00:00.000Z",
            recipients: { lists: [55] },
            htmlContent: "<html>novo</html>",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    try {
      const toUpdate = [campaignItem(1), campaignItem(2)];
      const result = await runApplyBatch("fake-key", "2606-07", toUpdate, "<html>novo</html>");
      assert.equal(result.aborted, false, "divergência pós-reschedule não é stuck-suspended — não aborta o lote");
      assert.ok(result.failedIds.includes(1), "campanha #1 deve estar em failedIds (divergência)");
      assert.equal(result.succeeded.length, 1, "campanha #2 deve ter sucedido normalmente");
      assert.equal(result.succeeded[0]?.campaignId, 2);
    } finally {
      globalThis.fetch = origFetch;
      console.error = origError;
    }
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

describe("parseCampaignIdArg (#4082 item 2 — pula a descoberta por nome)", () => {
  it("ausente → undefined", () => {
    assert.equal(parseCampaignIdArg(["--cycle", "2606-07"]), undefined);
  });

  it("--campaign-id 99 → 99", () => {
    assert.equal(parseCampaignIdArg(["--cycle", "2606-07", "--campaign-id", "99"]), 99);
  });

  it("valor não-inteiro → lança erro claro", () => {
    assert.throws(() => parseCampaignIdArg(["--campaign-id", "abc"]), /inválido/);
  });

  it("valor negativo/zero → lança erro claro", () => {
    assert.throws(() => parseCampaignIdArg(["--campaign-id", "0"]), /inválido/);
    assert.throws(() => parseCampaignIdArg(["--campaign-id", "-5"]), /inválido/);
  });
});

describe("fetchCampaignById (#4082 — usado por --campaign-id)", () => {
  it("retorna o body da campanha em GET 200", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(mockCampaign({ id: 99 })), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    try {
      const c = await fetchCampaignById("fake-key", 99);
      assert.equal(c.id, 99);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("HTTP != 200 -> lança erro claro", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof globalThis.fetch;
    try {
      await assert.rejects(() => fetchCampaignById("fake-key", 99), /HTTP 404/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("main() — dry-run (default) NUNCA chama PUT (#633 item d)", () => {
  it("sem --apply: descobre campanhas mas não escreve nada", async () => {
    const origFetch = globalThis.fetch;
    let putCalled = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        putCalled = true;
        return new Response(null, { status: 204 });
      }
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

    // Exercita as peças que main() compõe no branch dry-run (a resolução de
    // htmlPath falha sem data/ num clone limpo — aqui isolamos o
    // comportamento "dry-run nunca dá PUT" sem depender de disco).
    try {
      const all = await fetchQueuedCampaigns("fake-key");
      const matched = filterCycleCampaigns(all, "2606-07");
      const { toUpdate } = partitionByQueuedStatus(matched);
      assert.equal(toUpdate.length, 1);
      const apply = parseApplyArg(["--cycle", "2606-07"]);
      assert.equal(apply, false);
      if (!apply) {
        assert.equal(putCalled, false, "PUT não deve ter sido chamado em dry-run");
        return;
      }
      assert.fail("não deveria chegar aqui em dry-run");
    } finally {
      globalThis.fetch = origFetch;
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

  it("main() de fato: --campaign-id inválido sai sem tocar rede", async () => {
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
      await assert.rejects(
        () => main(["--cycle", "2606-07", "--campaign-id", "abc"]),
        /process\.exit called/,
      );
      assert.equal(exitCode, 1);
      assert.equal(fetchCalled, false, "não deve chamar fetch com --campaign-id inválido");
    } finally {
      globalThis.fetch = origFetch;
      process.exit = origExit;
    }
  });
});
