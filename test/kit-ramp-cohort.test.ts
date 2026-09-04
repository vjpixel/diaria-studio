/**
 * test/kit-ramp-cohort.test.ts (#6507)
 *
 * Cobre a lógica PURA de `scripts/kit-ramp-cohort.ts` (parsing de entrada,
 * guard de blast radius, decisão de ordem Kit→Beehiiv, divergência/auditoria,
 * resumo) e, para o invariante central (#6507 — "quem está na tag do Kit NÃO
 * pode estar ativo na Beehiiv"), um teste de `applyCohortWave` com REDE
 * MOCKADA (`globalThis.fetch` para o lado Kit — via `kitFetch` — e um
 * `fetchImpl` injetado, independente, para o lado Beehiiv) que prova, ponta a
 * ponta, que uma tag do Kit que falha NUNCA deixa a chamada de desativação da
 * Beehiiv acontecer para aquele e-mail. Nenhum teste bate em API real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEmailListFile,
  evaluateKitRampBlastRadiusGuard,
  decideKitTagStep,
  decideBeehiivDeactivateAction,
  computeKitRampDivergence,
  summarizeCohortResults,
  formatCohortReport,
  formatAuditReport,
  applyCohortWave,
  KIT_RAMP_BLAST_RADIUS_THRESHOLD,
  type CohortEmailResult,
} from "../scripts/kit-ramp-cohort.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function withMockFetch<T>(handler: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

// ── parseEmailListFile ──────────────────────────────────────────────────

describe("parseEmailListFile", () => {
  it("normaliza (trim+lowercase), ignora comentário/linha vazia, dedup preservando ordem", () => {
    const raw = [
      "  Alice@Example.com  ",
      "",
      "# comentário",
      "bob@example.com",
      "alice@example.com", // duplicata (case-insensitive)
      "  ",
      "carol@example.com",
    ].join("\n");
    assert.deepEqual(parseEmailListFile(raw), ["alice@example.com", "bob@example.com", "carol@example.com"]);
  });

  it("arquivo vazio ou só comentários/blank produz lista vazia", () => {
    assert.deepEqual(parseEmailListFile("\n# nada\n\n  \n"), []);
  });
});

// ── evaluateKitRampBlastRadiusGuard ─────────────────────────────────────

describe("evaluateKitRampBlastRadiusGuard", () => {
  it("abaixo do limiar não bloqueia", () => {
    const g = evaluateKitRampBlastRadiusGuard(10, 100, false); // 10%
    assert.equal(g.blocked, false);
    assert.equal(g.ratio, 0.1);
  });

  it("exatamente no limiar (30%) NÃO bloqueia — estrito", () => {
    const g = evaluateKitRampBlastRadiusGuard(30, 100, false);
    assert.equal(g.ratio, KIT_RAMP_BLAST_RADIUS_THRESHOLD);
    assert.equal(g.blocked, false);
  });

  it("acima do limiar bloqueia", () => {
    const g = evaluateKitRampBlastRadiusGuard(31, 100, false);
    assert.equal(g.blocked, true);
  });

  it("--force-blast-radius sempre libera, mesmo bem acima do limiar", () => {
    const g = evaluateKitRampBlastRadiusGuard(90, 100, true);
    assert.equal(g.blocked, false);
  });

  it("denominador zero não divide por zero (ratio 0, não bloqueia)", () => {
    const g = evaluateKitRampBlastRadiusGuard(5, 0, false);
    assert.equal(g.ratio, 0);
    assert.equal(g.blocked, false);
  });
});

// ── decideKitTagStep ─────────────────────────────────────────────────────

describe("decideKitTagStep", () => {
  it("já tagueado → noop, independente de existir no Kit", () => {
    assert.equal(decideKitTagStep({ existedInKit: true, alreadyTagged: true }), "noop");
  });

  it("existe no Kit mas sem a tag → tag_existing", () => {
    assert.equal(decideKitTagStep({ existedInKit: true, alreadyTagged: false }), "tag_existing");
  });

  it("não existe no Kit → create_and_tag (nunca pula por ausência)", () => {
    assert.equal(decideKitTagStep({ existedInKit: false, alreadyTagged: false }), "create_and_tag");
  });
});

// ── decideBeehiivDeactivateAction — o invariante de ORDEM do #6507 ──────

describe("decideBeehiivDeactivateAction", () => {
  it("tag do Kit NÃO confirmada → nunca desativa, independente do estado Beehiiv", () => {
    assert.equal(
      decideBeehiivDeactivateAction({ kitTagConfirmed: false, beehiivActive: true }),
      "skip_kit_unconfirmed",
    );
    assert.equal(
      decideBeehiivDeactivateAction({ kitTagConfirmed: false, beehiivActive: false }),
      "skip_kit_unconfirmed",
    );
  });

  it("tag confirmada + já não-ativo na Beehiiv → sem ação (idempotência)", () => {
    assert.equal(
      decideBeehiivDeactivateAction({ kitTagConfirmed: true, beehiivActive: false }),
      "skip_not_active_beehiiv",
    );
  });

  it("tag confirmada + ativo na Beehiiv → desativa (único caminho pra 'deactivate')", () => {
    assert.equal(decideBeehiivDeactivateAction({ kitTagConfirmed: true, beehiivActive: true }), "deactivate");
  });
});

// ── computeKitRampDivergence — auditoria do invariante ──────────────────

describe("computeKitRampDivergence", () => {
  it("nenhuma sobreposição → divergent vazio", () => {
    const r = computeKitRampDivergence(["a@x.com", "b@x.com"], ["c@x.com"]);
    assert.deepEqual(r.divergent, []);
    assert.equal(r.kitTaggedCount, 2);
    assert.equal(r.beehiivActiveCount, 1);
  });

  it("sobreposição → divergent lista quem está nos DOIS, normalizado e ordenado", () => {
    const r = computeKitRampDivergence(["B@X.com", "a@x.com"], ["a@x.com", "c@x.com"]);
    assert.deepEqual(r.divergent, ["a@x.com"]);
  });

  it("normaliza (case/trim) antes de comparar — mesmo e-mail em cases diferentes não conta como divergência dupla", () => {
    const r = computeKitRampDivergence(["  Alice@Example.com  "], ["alice@example.com"]);
    assert.deepEqual(r.divergent, ["alice@example.com"]);
    assert.equal(r.kitTaggedCount, 1);
  });
});

// ── summarizeCohortResults ───────────────────────────────────────────────

function baseResult(overrides: Partial<CohortEmailResult>): CohortEmailResult {
  return {
    email: "x@example.com",
    existedInKit: true,
    kitTagAlreadyPresent: false,
    kitTagApplied: true,
    kitTagConfirmed: true,
    beehiivWasActive: true,
    beehiivAction: "deactivate",
    beehiivApplied: true,
    beehiivConfirmed: true,
    ...overrides,
  };
}

describe("summarizeCohortResults", () => {
  it("tabula tagueados/desativados/falhas/pulados corretamente", () => {
    const results: CohortEmailResult[] = [
      baseResult({ email: "a@x.com" }), // tagged + deactivated, tudo ok
      baseResult({ email: "b@x.com", kitTagConfirmed: false, beehiivAction: "skip_kit_unconfirmed", beehiivApplied: false }),
      baseResult({ email: "c@x.com", beehiivWasActive: false, beehiivAction: "skip_not_active_beehiiv", beehiivApplied: false }),
      baseResult({ email: "d@x.com", beehiivConfirmed: false }), // tag ok, desativação falhou
    ];
    const s = summarizeCohortResults(results);
    assert.equal(s.total, 4);
    assert.equal(s.kitTagged, 3); // a, c, d confirmados; b não
    assert.equal(s.kitTagFailed, 1);
    assert.equal(s.beehiivDeactivated, 1); // só "a"
    assert.equal(s.beehiivDeactivateFailed, 1); // "d"
    assert.equal(s.skippedKitUnconfirmed, 1); // "b"
    assert.equal(s.skippedNotActiveBeehiiv, 1); // "c"
  });

  it("residualDivergence conta quem ficou tagueado no Kit E ainda ativo na Beehiiv ao fim da rodada", () => {
    const results: CohortEmailResult[] = [
      baseResult({ email: "ok@x.com" }), // tag confirmada + desativado com sucesso → sem divergência
      baseResult({ email: "falhou@x.com", beehiivConfirmed: false }), // tag confirmada, desativação FALHOU → ainda ativo → divergência
    ];
    const s = summarizeCohortResults(results);
    assert.equal(s.residualDivergence, 1);
  });

  it("residualDivergence zero quando não havia ninguém ativo na Beehiiv pra começar", () => {
    const results: CohortEmailResult[] = [
      baseResult({ beehiivWasActive: false, beehiivAction: "skip_not_active_beehiiv", beehiivApplied: false }),
    ];
    assert.equal(summarizeCohortResults(results).residualDivergence, 0);
  });
});

// ── formatação — smoke test (conteúdo mínimo esperado no relatório) ─────

describe("formatCohortReport / formatAuditReport", () => {
  it("dry-run menciona explicitamente que nenhuma mutação foi aplicada", () => {
    const results = [baseResult({ kitTagApplied: false, beehiivApplied: false })];
    const summary = summarizeCohortResults(results);
    const text = formatCohortReport(results, summary, false);
    assert.match(text, /dry-run/);
    assert.match(text, /nenhuma mutação/i);
  });

  it("relatório de auditoria com divergência sinaliza DIVERGE e lista e-mail mascarado", () => {
    const result = computeKitRampDivergence(["dup@example.com"], ["dup@example.com"]);
    const text = formatAuditReport("rampa-kit", result);
    assert.match(text, /DIVERGE/);
    assert.doesNotMatch(text, /dup@example\.com/); // nunca e-mail cru
  });

  it("relatório de auditoria sem divergência sinaliza OK", () => {
    const result = computeKitRampDivergence(["a@x.com"], ["b@x.com"]);
    const text = formatAuditReport("rampa-kit", result);
    assert.match(text, /OK/);
  });
});

// ── applyCohortWave — invariante de ORDEM ponta a ponta, rede mockada ───

const KIT_CONFIG = { apiKey: "kit_test_key" };
const BEEHIIV_CONFIG = { apiKey: "beehiiv_test_key", publicationId: "pub_123" };
const TAG_ID = 999;

describe("applyCohortWave", () => {
  it("dry-run: NUNCA chama mutação (nem Kit POST, nem Beehiiv PUT) — só leitura", async () => {
    const beehiivCalls: string[] = [];
    const beehiivFetchImpl = (async (url: string, init?: RequestInit) => {
      beehiivCalls.push(`${init?.method ?? "GET"} ${url}`);
      return jsonResponse(200, { data: { status: "active" } });
    }) as typeof fetch;

    const kitCalls: string[] = [];
    const results = await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        kitCalls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("/subscribers?email_address=")) {
          return jsonResponse(200, { subscribers: [{ id: 1, email_address: "a@x.com", state: "active" }] });
        }
        if (url.includes("/subscribers/1/tags")) {
          return jsonResponse(200, { tags: [] }); // ainda não tagueado
        }
        throw new Error(`chamada Kit inesperada em dry-run: ${url}`);
      }) as typeof fetch,
      () =>
        applyCohortWave({
          emails: ["a@x.com"],
          push: false,
          kitConfig: KIT_CONFIG,
          tagId: TAG_ID,
          activeBeehiivEmails: new Set(["a@x.com"]),
          beehiivConfig: BEEHIIV_CONFIG,
          fetchImpl: beehiivFetchImpl,
        }),
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].kitTagApplied, false);
    assert.equal(results[0].beehiivApplied, false);
    // nenhuma chamada Kit foi de escrita (POST/PATCH/PUT/DELETE)
    assert.ok(kitCalls.every((c) => c.startsWith("GET")), `esperava só GET em dry-run, viu: ${kitCalls.join(", ")}`);
    // Beehiiv nunca foi tocada em dry-run
    assert.deepEqual(beehiivCalls, []);
  });

  it("--push: tag do Kit CONFIRMADA → desativa na Beehiiv (chamada real acontece)", async () => {
    let tagPosted = false; // declarado ANTES do await — o mock roda DENTRO do await, não depois
    const beehiivCalls: string[] = [];
    const beehiivFetchImpl = (async (url: string, init?: RequestInit) => {
      beehiivCalls.push(`${init?.method ?? "GET"} ${url}`);
      return jsonResponse(200, { data: { status: "inactive" } }); // PUT e a releitura seguinte já refletem
    }) as typeof fetch;

    const results = await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url.includes("/subscribers?email_address=")) {
          return jsonResponse(200, { subscribers: [{ id: 1, email_address: "a@x.com", state: "active" }] });
        }
        if (url.endsWith("/subscribers/1/tags") && method === "GET") {
          // 1ª leitura (pre-check, Fase A): sem a tag. 2ª leitura (pós-POST): já confirma.
          return jsonResponse(200, { tags: tagPosted ? [{ id: TAG_ID, name: "rampa-kit", created_at: "x" }] : [] });
        }
        if (url.includes(`/tags/${TAG_ID}/subscribers/1`) && method === "POST") {
          tagPosted = true;
          return new Response(null, { status: 204 });
        }
        throw new Error(`chamada Kit inesperada: ${method} ${url}`);
      }) as typeof fetch,
      () =>
        applyCohortWave({
          emails: ["a@x.com"],
          push: true,
          kitConfig: KIT_CONFIG,
          tagId: TAG_ID,
          activeBeehiivEmails: new Set(["a@x.com"]),
          beehiivConfig: BEEHIIV_CONFIG,
          fetchImpl: beehiivFetchImpl,
          sleepFn: async () => {}, // #7392: espaçamento real não é o foco deste teste
        }),
    );

    assert.equal(results[0].kitTagConfirmed, true);
    assert.equal(results[0].beehiivAction, "deactivate");
    assert.equal(results[0].beehiivApplied, true);
    assert.equal(results[0].beehiivConfirmed, true);
    // Beehiiv foi chamada: PUT (unsubscribe) + GET (releitura)
    assert.ok(beehiivCalls.some((c) => c.startsWith("PUT")), "esperava PUT de unsubscribe na Beehiiv");
  });

  it("--push: tag do Kit FALHA → Beehiiv NUNCA é chamada para aquele e-mail (invariante de ordem)", async () => {
    const beehiivCalls: string[] = [];
    const beehiivFetchImpl = (async (url: string, init?: RequestInit) => {
      beehiivCalls.push(`${init?.method ?? "GET"} ${url}`);
      return jsonResponse(200, { data: { status: "active" } });
    }) as typeof fetch;

    const results = await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url.includes("/subscribers?email_address=")) {
          return jsonResponse(200, { subscribers: [{ id: 1, email_address: "falha@x.com", state: "active" }] });
        }
        if (url.endsWith("/subscribers/1/tags") && method === "GET") {
          return jsonResponse(200, { tags: [] }); // nunca reflete a tag — simula releitura NÃO confirmando
        }
        if (url.includes(`/tags/${TAG_ID}/subscribers/1`) && method === "POST") {
          return new Response(null, { status: 204 }); // POST "sucede" (2xx) mas o efeito nunca aparece na releitura
        }
        throw new Error(`chamada Kit inesperada: ${method} ${url}`);
      }) as typeof fetch,
      () =>
        applyCohortWave({
          emails: ["falha@x.com"],
          push: true,
          kitConfig: KIT_CONFIG,
          tagId: TAG_ID,
          activeBeehiivEmails: new Set(["falha@x.com"]), // ativo na Beehiiv — seria elegível a desativar SE a tag confirmasse
          beehiivConfig: BEEHIIV_CONFIG,
          fetchImpl: beehiivFetchImpl,
          sleepFn: async () => {}, // #7392: espaçamento real não é o foco deste teste
        }),
    );

    assert.equal(results[0].kitTagConfirmed, false);
    assert.equal(results[0].beehiivAction, "skip_kit_unconfirmed");
    assert.equal(results[0].beehiivApplied, false);
    // A prova ponta a ponta do invariante: a Beehiiv NUNCA foi chamada pra este e-mail.
    assert.deepEqual(beehiivCalls, [], `Beehiiv não deveria ter sido chamada, mas viu: ${beehiivCalls.join(", ")}`);
  });

  it("já tagueado + já não-ativo na Beehiiv → nenhuma mutação em nenhuma ponta (idempotência)", async () => {
    const beehiivCalls: string[] = [];
    const beehiivFetchImpl = (async (url: string, init?: RequestInit) => {
      beehiivCalls.push(`${init?.method ?? "GET"} ${url}`);
      return jsonResponse(404, {});
    }) as typeof fetch;

    const results = await withMockFetch(
      (async (url: string) => {
        if (url.includes("/subscribers?email_address=")) {
          return jsonResponse(200, { subscribers: [{ id: 2, email_address: "convergido@x.com", state: "active" }] });
        }
        if (url.endsWith("/subscribers/2/tags")) {
          return jsonResponse(200, { tags: [{ id: TAG_ID, name: "rampa-kit", created_at: "x" }] });
        }
        throw new Error(`chamada Kit inesperada (deveria ser noop): ${url}`);
      }) as typeof fetch,
      () =>
        applyCohortWave({
          emails: ["convergido@x.com"],
          push: true,
          kitConfig: KIT_CONFIG,
          tagId: TAG_ID,
          activeBeehiivEmails: new Set(), // já não ativo
          beehiivConfig: BEEHIIV_CONFIG,
          fetchImpl: beehiivFetchImpl,
          sleepFn: async () => {}, // #7392: espaçamento real não é o foco deste teste
        }),
    );

    assert.equal(results[0].kitTagAlreadyPresent, true);
    assert.equal(results[0].kitTagApplied, false);
    assert.equal(results[0].beehiivAction, "skip_not_active_beehiiv");
    assert.deepEqual(beehiivCalls, []);
  });

  it("--push: PUT de desativação sucede, mas a RELEITURA de confirmação lança (rede) → nunca propaga, resolve ok:false (fleet review #6507, achado 1)", async () => {
    const beehiivFetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") return jsonResponse(200, { data: { status: "inactive" } });
      // a releitura (GET pós-write) lança — simula erro de rede/5xx real, não
      // um "status ainda active" (esse é outro caminho já coberto acima).
      throw new Error("ECONNRESET: releitura pós-escrita falhou");
    }) as typeof fetch;

    const results = await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url.includes("/subscribers?email_address=")) {
          return jsonResponse(200, { subscribers: [{ id: 1, email_address: "a@x.com", state: "active" }] });
        }
        if (url.endsWith("/subscribers/1/tags") && method === "GET") {
          return jsonResponse(200, { tags: [{ id: TAG_ID, name: "rampa-kit", created_at: "x" }] }); // já tagueado
        }
        throw new Error(`chamada Kit inesperada: ${method} ${url}`);
      }) as typeof fetch,
      () =>
        applyCohortWave({
          emails: ["a@x.com"],
          push: true,
          kitConfig: KIT_CONFIG,
          tagId: TAG_ID,
          activeBeehiivEmails: new Set(["a@x.com"]),
          beehiivConfig: BEEHIIV_CONFIG,
          fetchImpl: beehiivFetchImpl,
          sleepFn: async () => {}, // #7392: espaçamento real não é o foco deste teste
        }),
    );

    // A prova central: applyCohortWave NUNCA lança, mesmo com erro de rede na
    // releitura — resolve um results[] completo com o e-mail marcado como
    // falha capturada, não perde a rodada inteira.
    assert.equal(results.length, 1);
    assert.equal(results[0].beehiivApplied, true);
    assert.equal(results[0].beehiivConfirmed, false);
    assert.match(results[0].beehiivError ?? "", /ECONNRESET/);
  });

  it("dry-run: e-mail já tagueado no Kit e ainda ativo na Beehiiv → 'seria desativado', NUNCA 'FALHOU' (fleet review #6507, achado 2)", async () => {
    const beehiivCalls: string[] = [];
    const beehiivFetchImpl = (async (url: string, init?: RequestInit) => {
      beehiivCalls.push(`${init?.method ?? "GET"} ${url}`);
      return jsonResponse(200, { data: { status: "active" } });
    }) as typeof fetch;

    const results = await withMockFetch(
      (async (url: string) => {
        if (url.includes("/subscribers?email_address=")) {
          return jsonResponse(200, { subscribers: [{ id: 1, email_address: "a@x.com", state: "active" }] });
        }
        if (url.endsWith("/subscribers/1/tags")) {
          return jsonResponse(200, { tags: [{ id: TAG_ID, name: "rampa-kit", created_at: "x" }] }); // já tagueado
        }
        throw new Error(`chamada Kit inesperada em dry-run: ${url}`);
      }) as typeof fetch,
      () =>
        applyCohortWave({
          emails: ["a@x.com"],
          push: false, // dry-run
          kitConfig: KIT_CONFIG,
          tagId: TAG_ID,
          activeBeehiivEmails: new Set(["a@x.com"]), // ainda ativo — seria desativado num --push real
          beehiivConfig: BEEHIIV_CONFIG,
          fetchImpl: beehiivFetchImpl,
        }),
    );

    assert.equal(results[0].beehiivAction, "deactivate");
    assert.equal(results[0].beehiivApplied, false, "dry-run nunca aplica de verdade");
    // O bug: sem o fix, beehiivConfirmed ficava false aqui (nada tentado ≠
    // falha), fazendo o relatório mostrar FALHOU em vez de "seria desativado".
    assert.equal(results[0].beehiivConfirmed, true);
    assert.deepEqual(beehiivCalls, [], "dry-run nunca toca a Beehiiv de verdade");

    const summary = summarizeCohortResults(results);
    // Não é uma falha de desativação nem uma divergência residual — é só
    // preview. Nenhum AVISO de invariante violado deve disparar aqui.
    assert.equal(summary.beehiivDeactivateFailed, 0);
    assert.equal(summary.residualDivergence, 0);

    const report = formatCohortReport(results, summary, false);
    assert.match(report, /seria desativado/);
    assert.doesNotMatch(report, /FALHOU/);
  });

  // ── espaçamento entre chamadas (#7392) ──────────────────────────────

  it("#7392: espaça CADA chamada singular ao Kit na Fase A (buscar/criar → tag → releitura), nunca antes da 1ª de toda a rodada", async () => {
    const sleeps: number[] = [];
    const sleepFn = async (ms: number) => {
      sleeps.push(ms);
    };

    const beehiivFetchImpl = (async () => jsonResponse(200, { data: { status: "active" } })) as typeof fetch;

    await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        // e-mail nunca visto pelo Kit → percorre a cadeia inteira:
        // find (vazio) → create → tag → releitura de confirmação.
        if (url.includes("/subscribers?email_address=") && method === "GET") {
          return jsonResponse(200, { subscribers: [] });
        }
        if (url.endsWith("/subscribers") && method === "POST") {
          return jsonResponse(201, { subscriber: { id: 1, email_address: "novo@x.com", state: "active" } });
        }
        if (url.includes(`/tags/${TAG_ID}/subscribers/1`) && method === "POST") {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/subscribers/1/tags") && method === "GET") {
          return jsonResponse(200, { tags: [{ id: TAG_ID, name: "rampa-kit", created_at: "x" }] });
        }
        throw new Error(`chamada Kit inesperada: ${method} ${url}`);
      }) as typeof fetch,
      () =>
        applyCohortWave({
          emails: ["novo@x.com"],
          push: true,
          kitConfig: KIT_CONFIG,
          tagId: TAG_ID,
          activeBeehiivEmails: new Set(), // já não ativo — Fase B não chama nada
          beehiivConfig: BEEHIIV_CONFIG,
          fetchImpl: beehiivFetchImpl,
          sleepFn,
        }),
    );

    // 4 chamadas Kit (find, create, tag, releitura) → 3 esperas, nunca antes da 1ª.
    assert.deepEqual(sleeps, [350, 350, 350]);
  });

  it("#7392: espaçamento também atravessa a fronteira entre e-mails (não só dentro de um e-mail)", async () => {
    const sleeps: number[] = [];
    const sleepFn = async (ms: number) => {
      sleeps.push(ms);
    };
    const beehiivFetchImpl = (async () => jsonResponse(200, { data: { status: "active" } })) as typeof fetch;

    await withMockFetch(
      (async (url: string) => {
        // ambos já tagueados — 2 chamadas Kit por e-mail (find + fetchTags), sem POST.
        if (url.includes("/subscribers?email_address=")) {
          const email = decodeURIComponent(url.split("email_address=")[1] ?? "");
          const id = email.startsWith("a@") ? 1 : 2;
          return jsonResponse(200, { subscribers: [{ id, email_address: email, state: "active" }] });
        }
        if (url.endsWith("/subscribers/1/tags") || url.endsWith("/subscribers/2/tags")) {
          return jsonResponse(200, { tags: [{ id: TAG_ID, name: "rampa-kit", created_at: "x" }] });
        }
        throw new Error(`chamada Kit inesperada: ${url}`);
      }) as typeof fetch,
      () =>
        applyCohortWave({
          emails: ["a@x.com", "b@x.com"],
          push: true,
          kitConfig: KIT_CONFIG,
          tagId: TAG_ID,
          activeBeehiivEmails: new Set(),
          beehiivConfig: BEEHIIV_CONFIG,
          fetchImpl: beehiivFetchImpl,
          sleepFn,
        }),
    );

    // 4 chamadas Kit (find+fetchTags × 2 e-mails) → 3 esperas, incluindo a
    // que cruza de um e-mail pro outro.
    assert.deepEqual(sleeps, [350, 350, 350]);
  });

  it("#7392: exatamente 1 chamada Kit no total nunca espera — prova que a 1ª chamada de toda a rodada é sempre imediata", async () => {
    let sleepCalls = 0;
    const sleepFn = async () => {
      sleepCalls += 1;
    };
    const beehiivFetchImpl = (async () => jsonResponse(200, { data: { status: "active" } })) as typeof fetch;

    await withMockFetch(
      (async (url: string) => {
        // e-mail nunca visto + dry-run: o caller para depois do 1º `find`,
        // sem sequer checar tags (ver `!push` na Fase A) — só 1 chamada Kit.
        if (url.includes("/subscribers?email_address=")) {
          return jsonResponse(200, { subscribers: [] });
        }
        throw new Error(`chamada Kit inesperada em dry-run: ${url}`);
      }) as typeof fetch,
      () =>
        applyCohortWave({
          emails: ["novo@x.com"],
          push: false, // dry-run
          kitConfig: KIT_CONFIG,
          tagId: TAG_ID,
          activeBeehiivEmails: new Set(),
          beehiivConfig: BEEHIIV_CONFIG,
          fetchImpl: beehiivFetchImpl,
          sleepFn,
        }),
    );

    assert.equal(sleepCalls, 0);
  });
});
