import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHtmlForVerify,
  verifyReappliedHtml,
  applyReapply,
  StuckSuspendedCampaignError,
  stuckSuspendedAction,
  rescheduleSuspendedCommand,
  validateRescheduleAt,
  rescheduleSuspendedCampaign,
  main,
  type BrevoCampaignListItem,
} from "../scripts/clarice-reapply-scheduled-html.ts";

/**
 * Regressão #12053 (#633): em 03/11/2026 `--cycle 2610-11 --apply` suspendeu
 * a campanha #395, gravou o HTML certo e PAROU sem reagendar — o GET-verify
 * comparava igualdade exata e a Brevo devolve `&amp;` dos `href` como `&`.
 * Todos os testes usam `fetch` falso — NUNCA tocam a Brevo real.
 */

const RENDERED =
  `<html><body><p>Olá</p>` +
  `<a href="https://diar.ia.br/?utm_source=clarice&amp;utm_medium=email&amp;utm_campaign=clarice-2610-11">link</a>` +
  `<p>Segundo parágrafo &amp;lt;tag&amp;gt; literal</p></body></html>`;

/** O que a Brevo devolve no GET: `&amp;` dos href desfeito em `&`. */
const BREVO_NORMALIZED = RENDERED.replace(
  /href="([^"]*)"/g,
  (_m, v: string) => `href="${v.replace(/&amp;/g, "&")}"`,
);

function mockCampaign(overrides: Partial<BrevoCampaignListItem> = {}): BrevoCampaignListItem {
  return {
    id: 395,
    name: "Clarice 2610 grupo:d4-sex06",
    status: "queued",
    subject: "Assunto",
    scheduledAt: "2026-11-06T09:00:00.000Z",
    recipients: { lists: [55] },
    ...overrides,
  };
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("normalizeHtmlForVerify / verifyReappliedHtml (#12053)", () => {
  it("`&amp;` no href × `&` devolvido pela Brevo: passa", () => {
    assert.notEqual(BREVO_NORMALIZED, RENDERED, "sanidade: o fixture difere byte a byte");
    assert.deepEqual(verifyReappliedHtml(RENDERED, BREVO_NORMALIZED), { ok: true });
  });

  it("formas numéricas `&#38;`/`&#x26;` equivalem a `&`", () => {
    assert.equal(normalizeHtmlForVerify("a?x=1&#38;y=2&#x26;z=3&amp;w=4"), "a?x=1&y=2&z=3&w=4");
  });

  it("`&amp;lt;` (texto literal) NÃO vira `&lt;` — seria mudança real de conteúdo", () => {
    assert.equal(normalizeHtmlForVerify("&amp;lt;b&amp;gt;"), "&amp;lt;b&amp;gt;");
    assert.equal(verifyReappliedHtml("<p>&amp;lt;b&amp;gt;</p>", "<p>&lt;b&gt;</p>").ok, false);
  });

  it("link trocado reprova, mesmo normalizando", () => {
    const swapped = BREVO_NORMALIZED.replace("clarice-2610-11", "clarice-2609-10");
    const r = verifyReappliedHtml(RENDERED, swapped);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /offset \d+/);
      assert.match(r.reason, /clarice-2609-10/);
    }
  });

  it("parágrafo faltando reprova", () => {
    const missing = BREVO_NORMALIZED.replace(/<p>Segundo parágrafo[^<]*<\/p>/, "");
    assert.equal(verifyReappliedHtml(RENDERED, missing).ok, false);
  });

  it("htmlContent ausente no GET reprova", () => {
    assert.equal(verifyReappliedHtml(RENDERED, undefined).ok, false);
  });

  it("diferença de espaço continua contando (normalização é só do `&`)", () => {
    assert.equal(verifyReappliedHtml("<p>a b</p>", "<p>a  b</p>").ok, false);
  });
});

/** Brevo falsa com estado: guarda status/html/scheduledAt e registra os PUTs. */
function fakeBrevo(opts: { status?: string; storeHtml?: (html: string) => string; scheduledAt?: string; name?: string } = {}) {
  const state = {
    name: opts.name ?? mockCampaign().name,
    status: opts.status ?? "queued",
    htmlContent: "<html>antigo</html>",
    scheduledAt: opts.scheduledAt ?? "2026-11-06T09:00:00.000Z",
  };
  const puts: { path: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace("https://api.brevo.com/v3", "");
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      puts.push({ path, body });
      if (path.endsWith("/status")) state.status = String(body.status);
      else {
        if (typeof body.htmlContent === "string") {
          state.htmlContent = (opts.storeHtml ?? ((h) => h))(body.htmlContent);
        }
        if (typeof body.scheduledAt === "string") {
          state.scheduledAt = body.scheduledAt;
          state.status = "queued";
        }
      }
      return new Response(null, { status: 204 });
    }
    if (path.startsWith("/contacts/lists/55")) return json({ id: 55, name: "lista", totalSubscribers: 1200 });
    if (path === "/emailCampaigns/395") return json({ ...mockCampaign(), ...state });
    return json({});
  }) as unknown as typeof globalThis.fetch;
  return { state, puts, fetchFn };
}

async function withFakes<T>(fetchFn: typeof globalThis.fetch, fn: (errors: string[]) => Promise<T>): Promise<T> {
  const origFetch = globalThis.fetch;
  const origError = console.error;
  const errors: string[] = [];
  globalThis.fetch = fetchFn;
  console.error = ((...args: unknown[]) => { errors.push(args.join(" ")); }) as typeof console.error;
  try {
    return await fn(errors);
  } finally {
    globalThis.fetch = origFetch;
    console.error = origError;
  }
}

describe("applyReapply com a Brevo normalizando `&amp;` (#12053 — cenário real da #395)", () => {
  it("GET devolve o HTML normalizado: reagenda no horário original, nada fica suspenso", async () => {
    const brevo = fakeBrevo({ storeHtml: (h) => h.replace(/href="([^"]*)"/g, (_m, v: string) => `href="${v.replace(/&amp;/g, "&")}"`) });
    await withFakes(brevo.fetchFn, async () => {
      const result = await applyReapply("fake-key", "2610-11", mockCampaign(), RENDERED);
      assert.ok(result);
      assert.equal(brevo.state.status, "queued");
      assert.equal(brevo.state.scheduledAt, "2026-11-06T09:00:00.000Z");
      assert.equal(brevo.puts.filter((p) => "scheduledAt" in p.body).length, 1);
    });
  });

  it("HTML realmente diferente: fica suspensa, NÃO reagenda sozinha, banner traz o comando de recuperação", async () => {
    const brevo = fakeBrevo({ storeHtml: (h) => h.replace("<p>Olá</p>", "") });
    await withFakes(brevo.fetchFn, async (errors) => {
      await assert.rejects(
        () => applyReapply("fake-key", "2610-11", mockCampaign(), RENDERED),
        (e: unknown) => e instanceof StuckSuspendedCampaignError,
      );
      assert.equal(brevo.state.status, "suspended");
      assert.equal(brevo.puts.filter((p) => "scheduledAt" in p.body).length, 0, "nunca reagenda com HTML não verificado");
      const out = errors.join("\n");
      assert.match(out, /SUSPENSA/);
      assert.match(out, /--reschedule-suspended --scheduled-at 2026-11-06T09:00:00\.000Z --apply/);
      assert.match(out, /FOI aceito/);
    });
  });
});

describe("stuckSuspendedAction / rescheduleSuspendedCommand (#12053)", () => {
  it("distingue HTML gravado × não gravado e sempre traz o comando", () => {
    const base = { cycle: "2610-11", campaignId: 395, scheduledAt: "2026-11-06T09:00:00.000Z" };
    assert.match(stuckSuspendedAction({ ...base, htmlPutAccepted: true }), /FOI aceito/);
    assert.match(stuckSuspendedAction({ ...base, htmlPutAccepted: false }), /NÃO foi gravado/);
    assert.ok(stuckSuspendedAction({ ...base, htmlPutAccepted: false }).includes(rescheduleSuspendedCommand("2610-11", 395, base.scheduledAt)));
  });
});

describe("validateRescheduleAt (#12053)", () => {
  const now = new Date("2026-11-03T12:00:00.000Z");
  it("aceita horário futuro além da margem", () => {
    assert.equal(validateRescheduleAt("2026-11-06T09:00:00.000Z", now), undefined);
  });
  it("recusa passado, colado ao presente e lixo", () => {
    assert.ok(validateRescheduleAt("2026-11-03T11:00:00.000Z", now));
    assert.ok(validateRescheduleAt("2026-11-03T12:01:00.000Z", now));
    assert.ok(validateRescheduleAt("amanhã", now));
  });
});

describe("rescheduleSuspendedCampaign (#12053 — recuperação manual)", () => {
  const now = new Date("2026-11-03T12:00:00.000Z");
  const at = "2026-11-06T09:00:00.000Z";

  it("--apply: um único PUT scheduledAt (nunca PUT /status, nunca htmlContent) e GET-verify", async () => {
    const brevo = fakeBrevo({ status: "suspended" });
    await withFakes(brevo.fetchFn, async () => {
      const r = await rescheduleSuspendedCampaign("fake-key", "2610-11", 395, at, { apply: true, now });
      assert.ok(r);
      assert.deepEqual(brevo.puts, [{ path: "/emailCampaigns/395", body: { scheduledAt: at } }]);
      assert.equal(brevo.state.status, "queued");
    });
  });

  it("sem --apply: só lê, nenhum PUT", async () => {
    const brevo = fakeBrevo({ status: "suspended" });
    await withFakes(brevo.fetchFn, async () => {
      assert.equal(await rescheduleSuspendedCampaign("fake-key", "2610-11", 395, at, { apply: false, now }), null);
      assert.equal(brevo.puts.length, 0);
    });
  });

  it("campanha que não está suspensa: recusa sem escrever", async () => {
    const brevo = fakeBrevo({ status: "queued" });
    await withFakes(brevo.fetchFn, async () => {
      await assert.rejects(() => rescheduleSuspendedCampaign("fake-key", "2610-11", 395, at, { apply: true, now }), /não "suspended"/);
      assert.equal(brevo.puts.length, 0);
    });
  });

  // Regressão #12056: id errado apontando para campanha suspensa de OUTRO ciclo.
  for (const apply of [true, false]) {
    it(`campanha suspensa de outro ciclo: recusa sem nenhum PUT (${apply ? "--apply" : "dry-run"}) — #12056`, async () => {
      const brevo = fakeBrevo({ status: "suspended", name: "Clarice 2609 grupo:d2-qua04" });
      await withFakes(brevo.fetchFn, async () => {
        await assert.rejects(
          () => rescheduleSuspendedCampaign("fake-key", "2610-11", 395, at, { apply, now }),
          (e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            assert.match(msg, /"Clarice 2609 grupo:d2-qua04"/, "nomeia a campanha encontrada");
            assert.match(msg, /ciclo 2610-11/, "nomeia o ciclo esperado");
            assert.match(msg, /Nada foi tocado/);
            return true;
          },
        );
        assert.equal(brevo.puts.length, 0);
        assert.equal(brevo.state.status, "suspended");
      });
    });
  }

  it("campanha do fluxo antigo (\"Clarice News {yymm}\") do ciclo certo continua reagendando — #12056", async () => {
    const brevo = fakeBrevo({ status: "suspended", name: "Clarice News 2610 envio 3" });
    await withFakes(brevo.fetchFn, async () => {
      const r = await rescheduleSuspendedCampaign("fake-key", "2610-11", 395, at, { apply: true, now });
      assert.ok(r);
      assert.deepEqual(brevo.puts, [{ path: "/emailCampaigns/395", body: { scheduledAt: at } }]);
    });
  });

  it("horário no passado: recusa antes de qualquer chamada", async () => {
    let called = false;
    const fetchFn = (async () => { called = true; return json({}); }) as unknown as typeof globalThis.fetch;
    await withFakes(fetchFn, async () => {
      await assert.rejects(
        () => rescheduleSuspendedCampaign("fake-key", "2610-11", 395, "2026-11-01T09:00:00.000Z", { apply: true, now }),
        /#5939/,
      );
      assert.equal(called, false);
    });
  });

  it("GET-verify pós-PUT não confirma: lança", async () => {
    const brevo = fakeBrevo({ status: "suspended" });
    const wrapped = (async (url: string, init?: RequestInit) => {
      const res = await brevo.fetchFn(url, init);
      // A Brevo aceitou o PUT mas a campanha continua suspensa.
      if ((init?.method ?? "GET") === "PUT") brevo.state.status = "suspended";
      return res;
    }) as unknown as typeof globalThis.fetch;
    await withFakes(wrapped, async () => {
      await assert.rejects(() => rescheduleSuspendedCampaign("fake-key", "2610-11", 395, at, { apply: true, now }), /GET-verify pós-reagendamento/);
    });
  });
});

describe("main() --reschedule-suspended (#12053)", () => {
  it("sem --scheduled-at sai 1 sem tocar rede", async () => {
    const origExit = process.exit;
    let exitCode: number | undefined;
    let fetchCalled = false;
    (process as any).exit = ((code?: number) => { exitCode = code; throw new Error("process.exit called"); }) as any;
    const fetchFn = (async () => { fetchCalled = true; return json({}); }) as unknown as typeof globalThis.fetch;
    try {
      await withFakes(fetchFn, async () => {
        await assert.rejects(
          () => main(["--cycle", "2610-11", "--campaign-id", "395", "--reschedule-suspended"]),
          /process\.exit called/,
        );
      });
      assert.equal(exitCode, 1);
      assert.equal(fetchCalled, false);
    } finally {
      process.exit = origExit;
    }
  });

  it("dry-run não lê o HTML do disco nem escreve nada", async () => {
    const origKey = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_CLARICE_API_KEY = "fake-key";
    const brevo = fakeBrevo({ status: "suspended" });
    try {
      await withFakes(brevo.fetchFn, async (errors) => {
        await main(["--cycle", "2610-11", "--campaign-id", "395", "--reschedule-suspended", "--scheduled-at", "2099-01-01T09:00:00.000Z"]);
        assert.equal(brevo.puts.length, 0);
        assert.match(errors.join("\n"), /dry-run/);
      });
    } finally {
      if (origKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
      else process.env.BREVO_CLARICE_API_KEY = origKey;
    }
  });

  it("--cycle diferente do da campanha: main rejeita sem PUT, inclusive no dry-run (#12056)", async () => {
    const origKey = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_CLARICE_API_KEY = "fake-key";
    const brevo = fakeBrevo({ status: "suspended" }); // "Clarice 2610 grupo:..."
    try {
      await withFakes(brevo.fetchFn, async () => {
        await assert.rejects(
          () => main(["--cycle", "2609-10", "--campaign-id", "395", "--reschedule-suspended", "--scheduled-at", "2099-01-01T09:00:00.000Z", "--apply"]),
          /não é do ciclo 2609-10/,
        );
        assert.equal(brevo.puts.length, 0);
      });
    } finally {
      if (origKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
      else process.env.BREVO_CLARICE_API_KEY = origKey;
    }
  });
});
