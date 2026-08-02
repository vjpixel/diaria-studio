/**
 * test/sync-pending-to-brevo-4266.test.ts (#4266, fila de tamanho fixo +
 * backfill adicionados no #4476 item 5)
 *
 * Triagem Pending(Beehiiv)→Brevo. Cobre: paginação/reconciliação da leitura
 * Beehiiv, diff puro (dedup pelo store, nunca pela Beehiiv), a ingestão real
 * (mock de fetch — nunca rede real), e a seleção da fila de tamanho fixo com
 * backfill priorizado por score de origem (#4476 item 5).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  fetchPendingBeehiivSubscriptions,
  computeContactsToIngest,
  ingestContactToBrevo,
  computeAvailableSlots,
  selectContactsForBackfill,
  loadOriginScores,
  assertMvGuardAcknowledged,
  type BeehiivPendingSubscription,
  type PendingToIngestEntry,
} from "../scripts/sync-pending-to-brevo.ts";
import type { BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchPendingBeehiivSubscriptions — paginação (#4266)", () => {
  it("agrega várias páginas até total_results", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string | URL) => {
      calls++;
      // #4266 review: "per_page=100" contém "page=1" como substring — usar o
      // query param real (não string.includes ingênuo) pra não confundir
      // page=1 com per_page=100&page=2 etc.
      const pageParam = new URL(String(url)).searchParams.get("page");
      if (pageParam === "1") {
        return jsonRes(200, {
          data: [
            { id: "sub_1", email: "a@b.com" },
            { id: "sub_2", email: "b@b.com" },
          ],
          total_results: 3,
          limit: 2,
        });
      }
      return jsonRes(200, { data: [{ id: "sub_3", email: "C@B.com" }], total_results: 3, limit: 2 });
    }) as typeof fetch;

    const out = await fetchPendingBeehiivSubscriptions("pub_1", "key", fetchImpl);
    assert.equal(out.length, 3);
    assert.equal(out[2].email, "c@b.com", "email normalizado (lowercase)");
    assert.equal(calls, 2);
  });

  it("página truncada (total_results maior que o coletado) → lança (nunca ingestão incompleta silenciosa)", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: [{ id: "sub_1", email: "a@b.com" }], total_results: 5, limit: 1 })) as typeof fetch;
    // hasMorePages vai continuar pedindo (gotLength >= limit), mas simulando
    // uma resposta vazia na 2ª página sem bater o total:
    let page = 0;
    const truncating = (async () => {
      page++;
      if (page === 1) return jsonRes(200, { data: [{ id: "sub_1", email: "a@b.com" }], total_results: 5, limit: 1 });
      return jsonRes(200, { data: [], total_results: 5, limit: 1 });
    }) as typeof fetch;
    await assert.rejects(() => fetchPendingBeehiivSubscriptions("pub_1", "key", truncating), /terminou cedo/);
    void fetchImpl;
  });

  it("!ok em qualquer página → lança (fail loud)", async () => {
    const fetchImpl = (async () => jsonRes(500, { message: "boom" })) as typeof fetch;
    await assert.rejects(() => fetchPendingBeehiivSubscriptions("pub_1", "key", fetchImpl), /Beehiiv API 500/);
  });
});

describe("computeContactsToIngest — dedup pelo store, nunca pela Beehiiv (#4266)", () => {
  it("contato Pending ausente do store → entra na lista de ingestão", () => {
    const pending: BeehiivPendingSubscription[] = [{ id: "sub_1", email: "a@b.com" }];
    const store: BrevoDiariaStore = { contacts: [] };
    const out = computeContactsToIngest(pending, store);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { email: "a@b.com", beehiiv_subscription_id: "sub_1" });
  });

  it("contato já no store (qualquer status) → NUNCA re-ingerido", () => {
    const pending: BeehiivPendingSubscription[] = [
      { id: "sub_1", email: "a@b.com" },
      { id: "sub_2", email: "b@b.com" },
      { id: "sub_3", email: "c@b.com" },
    ];
    const store: BrevoDiariaStore = {
      contacts: [
        { email: "a@b.com", beehiiv_subscription_id: "sub_1", status: "in_brevo", opens_count: 0, sends_count: 0, last_open_rate: null, added_at: "x", last_evaluated_at: null },
        { email: "b@b.com", beehiiv_subscription_id: "sub_2", status: "promoted_beehiiv", opens_count: 3, sends_count: 3, last_open_rate: 1, added_at: "x", last_evaluated_at: "y", promoted_at: "z" },
      ],
    };
    const out = computeContactsToIngest(pending, store);
    assert.equal(out.length, 1);
    assert.equal(out[0].email, "c@b.com");
  });

  it("dedup interno da própria página Pending (mesmo email 2x na resposta)", () => {
    const pending: BeehiivPendingSubscription[] = [
      { id: "sub_1", email: "a@b.com" },
      { id: "sub_1b", email: "a@b.com" },
    ];
    const out = computeContactsToIngest(pending, { contacts: [] });
    assert.equal(out.length, 1);
  });
});

describe("ingestContactToBrevo — cria + verifica por releitura (#4266)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("sucesso: POST cria, GET confirma listIds inclui o list_id", async () => {
    let posted: unknown;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") {
        posted = JSON.parse(init.body as string);
        return jsonRes(201, {});
      }
      return jsonRes(200, { email: "a@b.com", listIds: [7] });
    }) as typeof fetch;
    try {
      await ingestContactToBrevo("key", 7, "a@b.com");
      assert.deepEqual(posted, { email: "a@b.com", listIds: [7], updateEnabled: true });
    } finally {
      restore();
    }
  });

  it("releitura sem o list_id esperado → lança (mutação não confirmada)", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonRes(201, {});
      return jsonRes(200, { email: "a@b.com", listIds: [999] });
    }) as typeof fetch;
    try {
      await assert.rejects(() => ingestContactToBrevo("key", 7, "a@b.com"), /NÃO confere/);
    } finally {
      restore();
    }
  });

  it("releitura com status != 200 → lança", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonRes(201, {});
      return jsonRes(404, {});
    }) as typeof fetch;
    try {
      await assert.rejects(() => ingestContactToBrevo("key", 7, "a@b.com"), /releitura pós-criação falhou/);
    } finally {
      restore();
    }
  });
});

describe("assertMvGuardAcknowledged — guard de MillionVerifier antes de --push (#4476 achado silent-failure-hunter)", () => {
  it("sem --i-know-this-skips-mv → lança erro explícito nomeando a issue e a flag", () => {
    assert.throws(() => assertMvGuardAcknowledged([]), /MV batch script ainda não existe.*--i-know-this-skips-mv/s);
  });

  it("sem a flag mesmo com --push presente → ainda lança (a flag exata é o que importa, não --push)", () => {
    assert.throws(() => assertMvGuardAcknowledged(["--push"]), /--i-know-this-skips-mv/);
  });

  it("com --i-know-this-skips-mv → não lança", () => {
    assert.doesNotThrow(() => assertMvGuardAcknowledged(["--push", "--i-know-this-skips-mv"]));
  });
});

describe("computeAvailableSlots — fila de tamanho fixo (#4476 item 5)", () => {
  it("fila vazia, cap 300 → 300 slots livres", () => {
    assert.equal(computeAvailableSlots(0, 300), 300);
  });

  it("fila cheia (300/300) → 0 slots livres", () => {
    assert.equal(computeAvailableSlots(300, 300), 0);
  });

  it("fila parcialmente ocupada → cap - ocupados", () => {
    assert.equal(computeAvailableSlots(280, 300), 20);
  });

  it("população acima do cap (ex: cap reduzido depois do fato) → 0, nunca negativo", () => {
    assert.equal(computeAvailableSlots(310, 300), 0);
  });
});

describe("selectContactsForBackfill — priorização por score de origem (#4476 item 5)", () => {
  const candidates: PendingToIngestEntry[] = [
    { email: "low@b.com", beehiiv_subscription_id: "s1" },
    { email: "high@b.com", beehiiv_subscription_id: "s2" },
    { email: "mid@b.com", beehiiv_subscription_id: "s3" },
  ];

  it("0 slots livres → seleção vazia (fila cheia, sem backfill)", () => {
    const scores = new Map([["low@b.com", 10], ["high@b.com", 90], ["mid@b.com", 50]]);
    assert.deepEqual(selectContactsForBackfill(candidates, 0, scores), []);
  });

  it("com scoreByEmail → ordena DESCENDENTE e corta em availableSlots", () => {
    const scores = new Map([["low@b.com", 10], ["high@b.com", 90], ["mid@b.com", 50]]);
    const out = selectContactsForBackfill(candidates, 2, scores);
    assert.deepEqual(out.map((c) => c.email), ["high@b.com", "mid@b.com"], "os 2 melhores scores, na ordem certa");
  });

  it("availableSlots >= candidatos → devolve todos, ordenados", () => {
    const scores = new Map([["low@b.com", 10], ["high@b.com", 90], ["mid@b.com", 50]]);
    const out = selectContactsForBackfill(candidates, 100, scores);
    assert.deepEqual(out.map((c) => c.email), ["high@b.com", "mid@b.com", "low@b.com"]);
  });

  it("scoreByEmail null (arquivo ainda não gerado) → fallback FIFO (ordem original), só corta em availableSlots", () => {
    const out = selectContactsForBackfill(candidates, 2, null);
    assert.deepEqual(out.map((c) => c.email), ["low@b.com", "high@b.com"], "ordem original preservada, sem priorização");
  });

  it("candidato sem score individual (ausente do CSV) ordena por ÚLTIMO, nunca à frente de quem tem score", () => {
    const scores = new Map([["high@b.com", 90]]); // low@b.com e mid@b.com sem score
    const out = selectContactsForBackfill(candidates, 3, scores);
    assert.equal(out[0].email, "high@b.com", "único com score vai primeiro");
    // os 2 sem score entram depois, em qualquer ordem relativa entre si — o
    // que importa é nenhum deles vir ANTES do candidato pontuado.
    assert.deepEqual(new Set(out.slice(1).map((c) => c.email)), new Set(["low@b.com", "mid@b.com"]));
  });
});

describe("loadOriginScores — leitura fail-soft do CSV de score-pending-origin.ts (#4476 item 5)", () => {
  it("arquivo ausente → null (nunca lança), loga aviso", () => {
    const logs: string[] = [];
    const result = loadOriginScores(resolve(tmpdir(), "nao-existe-4476-" + Date.now() + ".csv"), (m) => logs.push(m));
    assert.equal(result, null);
    assert.ok(logs.some((l) => l.includes("não encontrado")));
  });

  it("CSV bem-formado → Map email→score", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "origin-scores-"));
    try {
      const path = resolve(dir, "scores.csv");
      writeFileSync(path, "email,origin,score\na@b.com,x,87\nb@b.com,y,17.5\n", "utf8");
      const result = loadOriginScores(path);
      assert.ok(result);
      assert.equal(result!.get("a@b.com"), 87);
      assert.equal(result!.get("b@b.com"), 17.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("email normalizado (lowercase/trim) na leitura", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "origin-scores-"));
    try {
      const path = resolve(dir, "scores.csv");
      writeFileSync(path, "email,origin,score\n  Foo@Bar.COM  ,x,50\n", "utf8");
      const result = loadOriginScores(path);
      assert.equal(result!.get("foo@bar.com"), 50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("linha com score não-numérico → ignorada (não quebra as demais)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "origin-scores-"));
    try {
      const path = resolve(dir, "scores.csv");
      writeFileSync(path, "email,origin,score\na@b.com,x,abc\nb@b.com,y,10\n", "utf8");
      const result = loadOriginScores(path);
      assert.equal(result!.has("a@b.com"), false);
      assert.equal(result!.get("b@b.com"), 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
