/**
 * test/reativar-token-sem-doi-8194.test.ts (#8194)
 *
 * Token assinado do botão "Confirmar" da Brevo: com token válido o worker
 * `reativar` ativa direto no Kit (sem vínculo ao form de DOI); sem token ou
 * com token inválido, segue o DOI. Cobre também a promoção de quem já é
 * `inactive` via form de sistema e a recusa de ressuscitar estado terminal.
 * Mock de fetch, sem rede.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { activateSubscriptionKit, handleConfirm, type Env } from "../workers/reativar/src/index.ts";
import { computeReativarToken, verifyReativarToken } from "../scripts/lib/shared/reativar-token.ts";
import { runInjectReativarToken } from "../scripts/inject-reativar-token-brevo.ts";

const SECRET = "segredo-de-teste";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { method: string; url: string; body?: unknown };

/** Kit fake com estado: `existing` = estado prévio do e-mail (ou null). */
function fakeKit(opts: { existing: string | null; activateFormPromotes?: boolean }) {
  const calls: Call[] = [];
  let state: string | null = opts.existing;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url: u, body });
    if (method === "GET" && u.includes("/subscribers?email_address=")) {
      return jsonRes(200, { subscribers: state ? [{ id: 42, state }] : [] });
    }
    if (method === "GET" && u.endsWith("/subscribers/42")) return jsonRes(200, { subscriber: { id: 42, state } });
    if (method === "POST" && u.endsWith("/subscribers")) {
      // Upsert real do Kit: só aplica `state` a cadastro NOVO (medido ao vivo).
      const novo = state === null;
      if (novo) state = (body as { state: string }).state;
      return jsonRes(novo ? 201 : 200, { subscriber: { id: 42, state } });
    }
    if (method === "POST" && /\/forms\/\d+\/subscribers\/42$/.test(u)) {
      const promotes = opts.activateFormPromotes ?? true;
      if (u.includes("/forms/9839463/") && promotes && state === "inactive") state = "active";
      // Corpo do vínculo diz inactive mesmo quando promoveu (medido ao vivo).
      return jsonRes(201, { subscriber: { id: 42, state: "inactive" } });
    }
    return jsonRes(200, {});
  }) as typeof fetch;
  return { fetchImpl, calls, getState: () => state };
}

const env = (over: Partial<Env> = {}): Env => ({
  SUBSCRIBE_BACKEND: "kit",
  KIT_API_KEY: "k",
  KIT_API_URL: "https://kit.test/v4",
  KIT_DOI_FORM_ID: "9897918",
  KIT_ACTIVATE_FORM_ID: "9839463",
  REATIVAR_SECRET: SECRET,
  ...over,
});

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const e = mock.method(console, "error", () => {});
  const w = mock.method(console, "warn", () => {});
  try {
    return await fn();
  } finally {
    e.mock.restore();
    w.mock.restore();
  }
}

describe("reativar-token — assinatura (#8194)", () => {
  it("token do próprio e-mail valida (normaliza caixa/espaços)", async () => {
    const t = await computeReativarToken(SECRET, "Fulano@X.com");
    assert.match(t, /^[0-9a-f]{32}$/);
    assert.equal(await verifyReativarToken(SECRET, " fulano@x.com ", t), true);
  });

  it("token de outro e-mail, secret errado, ausente ou malformado → false", async () => {
    const t = await computeReativarToken(SECRET, "a@x.com");
    assert.equal(await verifyReativarToken(SECRET, "b@x.com", t), false);
    assert.equal(await verifyReativarToken("outro", "a@x.com", t), false);
    assert.equal(await verifyReativarToken(undefined, "a@x.com", t), false);
    assert.equal(await verifyReativarToken(SECRET, "a@x.com", null), false);
    assert.equal(await verifyReativarToken(SECRET, "a@x.com", "zz"), false);
  });
});

describe("activateSubscriptionKit com token (#8194)", () => {
  it("cadastro novo → nasce active, NUNCA vincula ao form de DOI", async () => {
    const kit = fakeKit({ existing: null });
    const r = await quiet(() => activateSubscriptionKit(env(), "a@x.com", kit.fetchImpl, true));
    assert.equal(r.beehiivStatus, "active");
    assert.ok(!kit.calls.some((c) => c.url.includes("/forms/9897918/")), "não pode disparar DOI");
  });

  it("já inactive → upsert não promove, vínculo ao form de sistema promove; estado lido por GET", async () => {
    const kit = fakeKit({ existing: "inactive" });
    const r = await quiet(() => activateSubscriptionKit(env(), "a@x.com", kit.fetchImpl, true));
    assert.equal(r.beehiivStatus, "active");
    assert.ok(kit.calls.some((c) => c.method === "POST" && c.url.endsWith("/forms/9839463/subscribers/42")));
    assert.ok(!kit.calls.some((c) => c.url.includes("/forms/9897918/")));
  });

  it("vínculo não promove → devolve o estado real (inactive), nunca afirma active", async () => {
    const kit = fakeKit({ existing: "inactive", activateFormPromotes: false });
    const r = await quiet(() => activateSubscriptionKit(env(), "a@x.com", kit.fetchImpl, true));
    assert.equal(r.beehiivStatus, "inactive");
  });

  for (const terminal of ["cancelled", "complained", "bounced"]) {
    it(`estado ${terminal} → não ressuscita (sem POST nenhum)`, async () => {
      const kit = fakeKit({ existing: terminal });
      const r = await quiet(() => activateSubscriptionKit(env(), "a@x.com", kit.fetchImpl, true));
      assert.equal(r.beehiivStatus, terminal);
      assert.equal(kit.calls.filter((c) => c.method === "POST").length, 0);
    });
  }

  it("SEM token, estado inactive → caminho DOI inalterado (não usa o form de sistema)", async () => {
    const kit = fakeKit({ existing: "inactive" });
    await quiet(() => activateSubscriptionKit(env(), "a@x.com", kit.fetchImpl, false));
    assert.ok(!kit.calls.some((c) => c.url.includes("/forms/9839463/")));
  });
});

describe("handleConfirm — token decide entre ativar direto e DOI (#8194)", () => {
  async function confirm(query: string, over: Partial<Env> = {}) {
    const kit = fakeKit({ existing: null });
    const res = await quiet(() => handleConfirm(new URL(`https://reativar.test/?${query}`), env(over), kit.fetchImpl));
    return { res, kit };
  }

  it("token válido → active, sem DOI", async () => {
    const t = await computeReativarToken(SECRET, "a@x.com");
    const { res, kit } = await confirm(`email=a%40x.com&t=${t}`);
    assert.equal(res.status, 200);
    assert.equal(kit.getState(), "active");
    assert.ok(!kit.calls.some((c) => c.url.includes("/forms/9897918/")));
  });

  it("t vazio (contato sem token) → fluxo DOI de sempre", async () => {
    const { kit } = await confirm("email=a%40x.com&t=");
    assert.equal(kit.getState(), "inactive");
    assert.ok(kit.calls.some((c) => c.url.includes("/forms/9897918/subscribers/42")));
  });

  it("token de OUTRO e-mail (link forjado) → DOI, nunca ativa", async () => {
    const t = await computeReativarToken(SECRET, "outro@x.com");
    const { kit } = await confirm(`email=a%40x.com&t=${t}`);
    assert.equal(kit.getState(), "inactive");
  });

  it("worker sem REATIVAR_SECRET → token ignorado, DOI", async () => {
    const t = await computeReativarToken(SECRET, "a@x.com");
    const { kit } = await confirm(`email=a%40x.com&t=${t}`, { REATIVAR_SECRET: undefined });
    assert.equal(kit.getState(), "inactive");
  });
});

describe("runInjectReativarToken (#8194)", () => {
  it("grava só quem não tem o token certo; falha vira contagem, nunca exceção", async () => {
    const certo = await computeReativarToken(SECRET, "ok@x.com");
    const puts: string[] = [];
    const r = await runInjectReativarToken({
      apiOpts: { apiKey: "k", listId: 7 },
      secret: SECRET,
      dryRun: false,
      ensure: async () => {},
      iterate: async function* () {
        yield [
          { email: "ok@x.com", attributes: { REATIVAR_TOKEN: certo } },
          { email: "novo@x.com", attributes: {} },
          { email: "falha@x.com" },
          { email: "" },
        ];
      },
      putContact: async (email) => {
        if (email === "falha@x.com") throw new Error("503");
        puts.push(email);
      },
    });
    assert.deepEqual(puts, ["novo@x.com"]);
    assert.equal(r.skipped_already_correct, 1);
    assert.equal(r.patched, 1);
    assert.deepEqual(r.failedEmails, ["falha@x.com"]);
  });
});
