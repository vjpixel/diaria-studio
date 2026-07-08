/**
 * test/poll-ja-votou-edition-name-3113.test.ts (#3113 item 13)
 *
 * Regressão: a mensagem "já votou" do brand anual (`clarice` —
 * `BRAND_INFO.leaderboardPeriod === "year"`) era genérica ("Você já votou
 * NESTA edição") e nunca dizia QUAL edição — ambíguo pra quem votou
 * retroativamente em mais de uma edição arquivada (#2867). Fix: cita a
 * edição nos 2 brands via `formatEditionDateForBrand` (já resolve o #2006 —
 * mostra só "Mês de AAAA" pro brand anual, sem o dia — "o dia do AAMMDD é
 * artefato do código, não dado real" pra quem publica mensal).
 *
 * Cobre os 2 caminhos que servem essa mensagem: com VOTE_DEDUP (DO) e o
 * fallback sem DO (KV puro).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VoteDedup } from "../workers/poll/src/vote-dedup.ts";
import { makeMockDoState } from "./_helpers/make-mock-do-state.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import type { Env } from "../workers/poll/src/index.ts";

function makeEnvWithDo(kv: ReturnType<typeof makeTrackedKv>, overrides: Partial<Env> = {}): Env {
  const doInstances = new Map<string, VoteDedup>();
  const mockDurableObjectNamespace = {
    idFromName: (name: string) => ({ name, toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId): DurableObjectStub => {
      const name = id.toString();
      if (!doInstances.has(name)) doInstances.set(name, new VoteDedup(makeMockDoState()));
      const instance = doInstances.get(name)!;
      return {
        fetch: (url: RequestInfo, init?: RequestInit) => instance.fetch(new Request(url as string, init)),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;

  return {
    POLL: kv as unknown as KVNamespace,
    VOTE_DEDUP: mockDurableObjectNamespace,
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin-secret",
    ALLOWED_ORIGINS: "*",
    ...overrides,
  };
}

async function voteTwice(email: string, edition: string, brand: "diaria" | "clarice", env: Env) {
  const { default: worker } = await import("../workers/poll/src/index.ts");
  const vote = (choice: string) => {
    const u = new URL("https://poll.diaria.workers.dev/vote");
    u.searchParams.set("email", email);
    u.searchParams.set("edition", edition);
    u.searchParams.set("choice", choice);
    if (brand !== "diaria") u.searchParams.set("brand", brand);
    return worker.fetch(new Request(u.toString()), env, {} as ExecutionContext);
  };
  await vote("A");
  const res2 = await vote("B");
  return res2.text();
}

describe("#3113 item 13 — mensagem 'já votou' cita a edição (brand anual, via DO)", () => {
  it("brand clarice (anual): 2º voto mostra 'Mês de AAAA', não 'nesta edição' genérico", async () => {
    const kv = makeTrackedKv();
    const env = makeEnvWithDo(kv);
    const html = await voteTwice("leitor@x.com", "260701", "clarice", env);
    assert.match(html, /já votou na edição de julho de 2026/i);
    assert.doesNotMatch(html, /já votou nesta edição/i, "mensagem genérica antiga não deve mais aparecer");
    assert.doesNotMatch(html, /\d+\s+de\s+julho/i, "brand anual não deve mostrar o dia (só mês/ano, #2006)");
  });

  it("brand diaria (mensal): 2º voto continua mostrando a data completa (comportamento inalterado)", async () => {
    const kv = makeTrackedKv();
    const env = makeEnvWithDo(kv);
    const html = await voteTwice("leitor2@x.com", "260701", "diaria", env);
    assert.match(html, /já votou na edição de 1 de julho de 2026/i);
  });
});

describe("#3113 item 13 — mensagem 'já votou' cita a edição (fallback KV, sem VOTE_DEDUP)", () => {
  it("brand clarice sem DO binding: mesma mensagem citando o mês/ano", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv();
    const env: Env = { POLL: kv as unknown as KVNamespace, POLL_SECRET: "s", ADMIN_SECRET: "a", ALLOWED_ORIGINS: "*" };
    const vote = (choice: string) => {
      const u = new URL("https://poll.diaria.workers.dev/vote");
      u.searchParams.set("email", "fallback@x.com");
      u.searchParams.set("edition", "260615");
      u.searchParams.set("choice", choice);
      u.searchParams.set("brand", "clarice");
      return worker.fetch(new Request(u.toString()), env, {} as ExecutionContext);
    };
    await vote("A");
    const res2 = await vote("B");
    const html = await res2.text();
    assert.match(html, /já votou na edição de junho de 2026/i);
  });
});
