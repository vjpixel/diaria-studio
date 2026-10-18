/**
 * test/evaluate-brevo-diaria-doi-resend-form-9986.test.ts (#9986)
 *
 * Regressão: o reenvio de DOI vinculava o contato `inactive` ao form principal
 * (9897918), o mesmo do cadastro nos workers. Quem já estava vinculado
 * recebia 200 (noop) e ficava preso para sempre, sem e-mail (~26% medido em
 * 17/10/2026). Decisão do editor (18/10, opção a): um 2º designer form de DOI
 * (`kit.doiResendFormId` = 10062841) para quem já respondeu 200 no principal.
 * O 201 nele envia o e-mail; 200 nos dois forms é terminal, com contador
 * próprio. Nunca unsubscribe/DELETE/PUT.
 *
 * Sem rede: `globalThis.fetch` é substituído em todos os casos.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  runEvaluation,
  doiResendTargetForm,
  mensagemDoiResendEsgotado,
  mensagemDoiNoopResumo,
} from "../scripts/evaluate-brevo-diaria.ts";
import {
  findContact,
  needsDoiResend,
  markDoiResendExhausted,
  DOI_RESEND_INTERVAL_DAYS,
  type BrevoDiariaContact,
} from "../scripts/lib/brevo-diaria-store.ts";

const PRIMARY = "9897918";
const RESEND = "10062841";
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function contact(email: string, overrides: Partial<BrevoDiariaContact> = {}): BrevoDiariaContact {
  return {
    email,
    beehiiv_subscription_id: `sub_${email}`,
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: "2026-07-01T00:00:00.000Z",
    last_evaluated_at: null,
    ...overrides,
  };
}

function brevoStatsRes(opens: number, sends: number): Response {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ campaignId: i + 1 }));
  return jsonRes(200, { statistics: { messagesSent: ids(sends), opened: ids(opens) } });
}

/** fetch falso com status por form; registra toda escrita no Kit. */
function installFetch(formStatus: Record<string, number>, probeStatus = 200) {
  const writes: { method: string; url: string }[] = [];
  const formPosts: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("api.kit.com") && method !== "GET") writes.push({ method, url: u });
    const m = u.match(/\/forms\/(\d+)\/subscribers/);
    if (m && method === "POST") {
      formPosts.push(m[1]!);
      return jsonRes(formStatus[m[1]!] ?? 201, { subscriber: { id: 77 } });
    }
    if (m && method === "GET") return jsonRes(probeStatus, { subscribers: [], pagination: { has_next_page: false } });
    if (u.includes("api.kit.com/v4/subscribers") && u.includes("email_address=")) {
      const email = new URL(u).searchParams.get("email_address") ?? "leitor@x.com";
      return jsonRes(200, {
        subscribers: [{ id: 77, email_address: email, state: "inactive", created_at: "2026-09-01T00:00:00.000Z" }],
      });
    }
    if (u.includes("api.kit.com")) return jsonRes(500, {});
    return brevoStatsRes(3, 3);
  }) as typeof fetch;
  return { writes, formPosts };
}

async function run(
  c: BrevoDiariaContact | BrevoDiariaContact[],
  opts: { resendForm?: string | undefined; log?: (m: string) => void } = {},
) {
  const contacts = Array.isArray(c) ? c : [c];
  return runEvaluation({
    contacts,
    store: { contacts },
    push: true,
    publicationId: "pub_1",
    beehiivApiKey: "bkey",
    brevoApiKey: "brkey",
    listId: 7,
    log: opts.log ?? (() => {}),
    newsletterBackend: "kit",
    kitApiKey: "kkey",
    kitDoiFormId: PRIMARY,
    kitDoiResendFormId: "resendForm" in opts ? opts.resendForm : RESEND,
  });
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("doiResendTargetForm — pura (#9986)", () => {
  it("noop no principal + 2º form configurado → resend", () => {
    assert.equal(doiResendTargetForm({ doi_resend_noop_at: ago(8) }, true), "resend");
  });
  it("sem noop → primary; sem 2º form → primary", () => {
    assert.equal(doiResendTargetForm({}, true), "primary");
    assert.equal(doiResendTargetForm({ doi_resend_noop_at: ago(8) }, false), "primary");
  });
});

describe("needsDoiResend — terminal com doi_resend_exhausted_at (#9986)", () => {
  it("exausto nunca volta, mesmo muito depois do intervalo", () => {
    assert.equal(needsDoiResend(contact("a@x.com", { doi_resend_noop_at: ago(90), doi_resend_exhausted_at: ago(90) })), false);
  });
  it("markDoiResendExhausted grava só em in_brevo", () => {
    const out = markDoiResendExhausted({ contacts: [contact("a@x.com"), contact("b@x.com", { status: "promoted_beehiiv" })] }, "a@x.com", "2026-10-18T00:00:00.000Z");
    assert.equal(findContact(out, "a@x.com")!.doi_resend_exhausted_at, "2026-10-18T00:00:00.000Z");
    assert.equal(findContact(out, "b@x.com")!.doi_resend_exhausted_at, undefined);
  });
});

describe("runEvaluation — 2º form de DOI (#9986)", () => {
  it("noop anterior no principal → POST no 10062841 (e não no principal); 201 envia e conta", async () => {
    const k = installFetch({ [RESEND]: 201 });
    const r = await run(contact("leitor@x.com", { doi_resend_noop_at: ago(DOI_RESEND_INTERVAL_DAYS + 1) }));
    assert.deepEqual(k.formPosts, [RESEND]);
    assert.equal(r.doiResent, 1);
    assert.equal(r.doiResentViaResendForm, 1);
    assert.equal(r.doiResendExhausted, 0);
    assert.equal(r.failed, 0);
    const stored = findContact(r.store, "leitor@x.com")!;
    assert.ok(stored.doi_resent_at);
    assert.equal(stored.doi_resend_exhausted_at, undefined);
  });

  it("200 no principal nesta rodada → segue pro 10062841 na mesma rodada", async () => {
    const k = installFetch({ [PRIMARY]: 200, [RESEND]: 201 });
    const r = await run(contact("leitor@x.com"));
    assert.deepEqual(k.formPosts, [PRIMARY, RESEND]);
    assert.equal(r.doiResendNoop, 1);
    assert.equal(r.doiResent, 1);
    assert.equal(r.doiResentViaResendForm, 1);
  });

  it("201 no principal não toca o 2º form", async () => {
    const k = installFetch({ [PRIMARY]: 201 });
    const r = await run(contact("leitor@x.com"));
    assert.deepEqual(k.formPosts, [PRIMARY]);
    assert.equal(r.doiResent, 1);
    assert.equal(r.doiResentViaResendForm, 0);
  });

  it("200 nos dois forms → terminal com contador próprio, e a rodada seguinte não chama o Kit", async () => {
    const k1 = installFetch({ [PRIMARY]: 200, [RESEND]: 200 });
    const r1 = await run(contact("leitor@x.com"));
    assert.deepEqual(k1.formPosts, [PRIMARY, RESEND]);
    assert.equal(r1.doiResendExhausted, 1);
    assert.equal(r1.doiResent, 0);
    assert.equal(r1.failed, 0);
    const after = findContact(r1.store, "leitor@x.com")!;
    assert.ok(after.doi_resend_exhausted_at);
    assert.equal(after.status, "in_brevo", "contato não sai do store");

    // Muito depois do intervalo: terminal, nenhuma chamada.
    const k2 = installFetch({ [PRIMARY]: 201, [RESEND]: 201 });
    const logs: string[] = [];
    const old = { ...after, doi_resend_noop_at: ago(60), doi_resend_exhausted_at: ago(60) };
    const r2 = await run(old, { log: (m) => logs.push(m) });
    assert.deepEqual(k2.formPosts, []);
    assert.equal(r2.doiResent + r2.doiResendExhausted + r2.doiResendNoop, 0);
    assert.ok(logs.some((l) => l.includes("vinculado aos dois forms de DOI")));
  });

  it("201 no 2º form, depois 200 nele fora do intervalo → terminal (uma vez por contato)", async () => {
    installFetch({ [RESEND]: 200 });
    const r = await run(contact("leitor@x.com", { doi_resend_noop_at: ago(20), doi_resent_at: ago(DOI_RESEND_INTERVAL_DAYS + 1) }));
    assert.equal(r.doiResendExhausted, 1);
    assert.ok(findContact(r.store, "leitor@x.com")!.doi_resend_exhausted_at);
  });

  it("nunca unsubscribe/DELETE/PUT: as únicas escritas são POSTs de vínculo aos dois forms", async () => {
    const k = installFetch({ [PRIMARY]: 200, [RESEND]: 200 });
    await run(contact("leitor@x.com"));
    assert.equal(k.writes.length, 2, JSON.stringify(k.writes));
    assert.ok(k.writes.every((w) => w.method === "POST" && /\/forms\/\d+\/subscribers\/77$/.test(w.url)));
    assert.ok(!k.writes.some((w) => w.url.includes("/unsubscribe")));
  });

  it("sem kit.doiResendFormId: comportamento anterior (noop tenta o principal de novo)", async () => {
    const k = installFetch({ [PRIMARY]: 200 });
    const r = await run(contact("leitor@x.com", { doi_resend_noop_at: ago(DOI_RESEND_INTERVAL_DAYS + 1) }), { resendForm: undefined });
    assert.deepEqual(k.formPosts, [PRIMARY]);
    assert.equal(r.doiResendNoop, 1);
    assert.equal(r.doiResendExhausted, 0);
  });

  it("2º form igual ao principal ou de sistema → ignorado com warn", async () => {
    for (const bad of [PRIMARY, "9839463"]) {
      const k = installFetch({ [PRIMARY]: 200 });
      const logs: string[] = [];
      const r = await run(contact("leitor@x.com"), { resendForm: bad, log: (m) => logs.push(m) });
      assert.deepEqual(k.formPosts, [PRIMARY], bad);
      assert.equal(r.doiResendExhausted, 0);
      assert.ok(logs.some((l) => l.includes("kit.doiResendFormId")), bad);
    }
  });

  it("aviso do resumo segue o form VALIDADO, não a presença na config (form inválido → noops presos continuam avisados)", async () => {
    for (const bad of [PRIMARY, "9839463"]) {
      installFetch({ [PRIMARY]: 200 });
      const r = await run(contact("leitor@x.com"), { resendForm: bad, log: () => {} });
      assert.equal(r.doiResendFormActive, false, bad);
      assert.equal(r.doiResendNoop, 1, bad);
      const m = mensagemDoiNoopResumo(r);
      assert.ok(m, `aviso de noop sumiu com 2º form inválido ${bad}`);
      assert.match(m!, /^warn: 1 contato\(s\) inactive já vinculado\(s\) ao form DOI/);
    }
    installFetch({ [PRIMARY]: 200, [RESEND]: 201 });
    const ok = await run(contact("leitor@x.com"), { log: () => {} });
    assert.equal(ok.doiResendFormActive, true);
    assert.equal(mensagemDoiNoopResumo(ok), null); // noop seguiu pro 2º form e enviou
  });

  it("falhas permanentes no 2º form são decididas pelo 2º form (2xx no principal não as torna per-contact)", async () => {
    // Principal responde 200 (2xx) para os dois; 2º form 404 para os dois e
    // probe 404 → global para o 2º form: nenhum backoff por contato.
    installFetch({ [PRIMARY]: 200, [RESEND]: 404 }, 404);
    const logs: string[] = [];
    const r = await run([contact("a@x.com"), contact("b@x.com")], { log: (m) => logs.push(m) });
    assert.equal(r.failed, 2);
    for (const e of ["a@x.com", "b@x.com"]) assert.equal(findContact(r.store, e)!.doi_resend_failed_at, undefined, e);
    assert.ok(logs.some((l) => l.includes(`kit.doiResendFormId=${RESEND}`)));
  });
});

describe("resumo e config (#9986)", () => {
  it("mensagemDoiResendEsgotado: null sem esgotado; com esgotado nomeia o total e a issue", () => {
    assert.equal(mensagemDoiResendEsgotado(0), null);
    assert.equal(mensagemDoiResendEsgotado(Number.NaN), null);
    const m = mensagemDoiResendEsgotado(3)!;
    assert.match(m, /^warn: 3 contato\(s\)/);
    assert.match(m, /#9986/);
  });

  it("platform.config.json tem kit.doiResendFormId = 10062841, distinto do doiFormId", () => {
    const cfg = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
    assert.equal(cfg.kit.doiResendFormId, RESEND);
    assert.notEqual(cfg.kit.doiResendFormId, cfg.kit.doiFormId);
  });

  it("main() passa kit.doiResendFormId e imprime os contadores novos no resumo", () => {
    const src = readFileSync(new URL("../scripts/evaluate-brevo-diaria.ts", import.meta.url), "utf8");
    assert.match(src, /kitDoiResendFormId: platformConfig\.kit\?\.doiResendFormId/);
    assert.match(src, /result\.doiResendExhausted/);
    assert.match(src, /result\.doiResentViaResendForm/);
    // Aviso escolhido pelo form validado (finding do review): nunca pela config crua.
    assert.match(src, /const doiNoopMsg = mensagemDoiNoopResumo\(result\);/);
    assert.doesNotMatch(src, /doiNoopMsg = platformConfig\.kit\?\.doiResendFormId/);
  });
});
