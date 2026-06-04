import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  classifyT1,
  suppressBlacklisted,
  assignQuartiles,
  representativeSplit,
  brevoGet,
  fetchBrevoEngagement,
  type Engagement,
} from "../scripts/clarice-build-waves.ts";

// --- fetch mock ---------------------------------------------------------
const realFetch = globalThis.fetch;
function mockFetch(handler: (url: string) => { status: number; text?: string }) {
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    const { status, text } = handler(url);
    return {
      status,
      ok: status >= 200 && status < 300,
      body: { cancel: async () => {} },
      text: async () => text ?? "",
    } as any;
  }) as any;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

function rows(emails: string[]): Record<string, string>[] {
  return emails.map((e, i) => ({ email: e, NOME: `N${i}`, OPEN_PROBABILITY: "24" }));
}

describe("classifyT1", () => {
  const eng = new Map<string, Engagement>([
    ["a@x.com", { opened: true, blacklisted: false }],
    ["b@x.com", { opened: false, blacklisted: false }],
    ["c@x.com", { opened: true, blacklisted: true }], // unsub → suprimir mesmo tendo aberto
    ["d@x.com", { opened: false, blacklisted: true }],
  ]);

  it("separa abriu / não-abriu / suprimido / não-encontrado", () => {
    const r = rows(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "z@x.com"]);
    const out = classifyT1(r, "email", eng);
    assert.deepEqual(out.openers.map((x) => x.email), ["a@x.com"]);
    assert.deepEqual(out.nonOpeners.map((x) => x.email), ["b@x.com"]);
    assert.deepEqual(out.suppressed.map((x) => x.email), ["c@x.com", "d@x.com"]);
    assert.deepEqual(out.notFound.map((x) => x.email), ["z@x.com"]); // sem registro Brevo
  });

  it("blacklisted NUNCA entra em openers/nonOpeners (regra: excluir unsubs)", () => {
    const out = classifyT1(rows(["c@x.com"]), "email", eng);
    assert.equal(out.openers.length, 0);
    assert.equal(out.nonOpeners.length, 0);
    assert.equal(out.suppressed.length, 1);
  });

  it("normaliza email (case/whitespace)", () => {
    const out = classifyT1([{ email: " A@X.com " }], "email", eng);
    assert.equal(out.openers.length, 1);
  });
});

describe("suppressBlacklisted", () => {
  it("remove emails na blacklist", () => {
    const { kept, dropped } = suppressBlacklisted(
      rows(["a@x.com", "b@x.com", "c@x.com"]),
      "email",
      new Set(["b@x.com"]),
    );
    assert.deepEqual(kept.map((r) => r.email), ["a@x.com", "c@x.com"]);
    assert.deepEqual(dropped.map((r) => r.email), ["b@x.com"]);
  });
});

describe("assignQuartiles", () => {
  it("Q1 = mais recentes (topo), Q4 = mais antigos (fim)", () => {
    const out = assignQuartiles(rows(Array.from({ length: 8 }, (_, i) => `e${i}@x.com`)));
    assert.equal(out[0].RECENCY_QUARTIL, "Q1");
    assert.equal(out[0].RECENCY_RANK, "1");
    assert.equal(out[2].RECENCY_QUARTIL, "Q2");
    assert.equal(out[4].RECENCY_QUARTIL, "Q3");
    assert.equal(out[7].RECENCY_QUARTIL, "Q4");
    assert.equal(out[7].RECENCY_RANK, "8");
  });

  it("nunca passa de Q4 (último elemento)", () => {
    const out = assignQuartiles(rows(["a@x.com", "b@x.com", "c@x.com"]));
    assert.ok(out.every((r) => ["Q1", "Q2", "Q3", "Q4"].includes(r.RECENCY_QUARTIL)));
  });
});

describe("representativeSplit", () => {
  it("W3 tem o tamanho pedido, W4 o resto", () => {
    const { w3, w4 } = representativeSplit(rows(Array.from({ length: 100 }, (_, i) => `e${i}@x.com`)), 30);
    assert.equal(w3.length, 30);
    assert.equal(w4.length, 70);
  });

  it("W3 é representativo de recência — NÃO os 30 mais recentes", () => {
    const r = rows(Array.from({ length: 100 }, (_, i) => `e${i}@x.com`));
    const { w3 } = representativeSplit(r, 30);
    // amostragem sistemática espalha a seleção: o último escolhido vem do fim da lista,
    // não da posição 29. Confirma que não é só o topo.
    const idxs = w3.map((x) => parseInt(x.email.slice(1), 10));
    assert.ok(Math.max(...idxs) >= 90, `esperava amostra perto do fim, max=${Math.max(...idxs)}`);
    assert.ok(Math.min(...idxs) <= 5, `esperava amostra perto do topo, min=${Math.min(...idxs)}`);
  });

  it("preserva o total (W3 + W4 = entrada) sem duplicar", () => {
    const r = rows(Array.from({ length: 57 }, (_, i) => `e${i}@x.com`));
    const { w3, w4 } = representativeSplit(r, 17);
    const all = new Set([...w3, ...w4].map((x) => x.email));
    assert.equal(w3.length + w4.length, 57);
    assert.equal(all.size, 57); // sem overlap
  });

  it("edge: w3Size 0 → tudo em W4; w3Size ≥ n → tudo em W3", () => {
    const r = rows(["a@x.com", "b@x.com"]);
    assert.equal(representativeSplit(r, 0).w4.length, 2);
    assert.equal(representativeSplit(r, 5).w3.length, 2);
  });
});

describe("brevoGet (falha alto, não silencia — regressão)", () => {
  it("200 JSON → retorna body", async () => {
    mockFetch(() => ({ status: 200, text: JSON.stringify({ x: 1 }) }));
    const r = await brevoGet("K", "/account");
    assert.deepEqual(r.body, { x: 1 });
  });

  it("401 (auth) → LANÇA (antes engolia e retornava body vazio)", async () => {
    mockFetch(() => ({ status: 401, text: '{"message":"bad key"}' }));
    await assert.rejects(() => brevoGet("K", "/contacts"), /401/);
  });

  it("404 → não-fatal, retorna body vazio (contato sumido)", async () => {
    mockFetch(() => ({ status: 404, text: "" }));
    const r = await brevoGet("K", "/contacts/999");
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, {});
  });

  it("200 com corpo não-JSON → LANÇA", async () => {
    mockFetch(() => ({ status: 200, text: "<<html>>" }));
    await assert.rejects(() => brevoGet("K", "/account"), /não-JSON/);
  });
});

describe("fetchBrevoEngagement OR-merge", () => {
  it("dois registros do mesmo email: blacklist/opened de qualquer um prevalece", async () => {
    mockFetch((url) => {
      if (url.includes("/contacts?")) {
        return {
          status: 200,
          text: JSON.stringify({
            contacts: [
              { id: 1, email: "a@x.com", emailBlacklisted: false },
              { id: 2, email: "a@x.com", emailBlacklisted: true }, // unsub no 2º registro
              { id: 3, email: "b@x.com", emailBlacklisted: false },
            ],
          }),
        };
      }
      if (url.endsWith("/contacts/1")) return { status: 200, text: JSON.stringify({ statistics: { opened: [{ campaignId: 1 }] } }) };
      return { status: 200, text: JSON.stringify({ statistics: {} }) };
    });
    const m = await fetchBrevoEngagement("K", 3);
    // a@x.com: abriu (id1) E blacklisted (id2) → ambos true (conservador)
    assert.deepEqual(m.get("a@x.com"), { opened: true, blacklisted: true });
    assert.deepEqual(m.get("b@x.com"), { opened: false, blacklisted: false });
  });
});
