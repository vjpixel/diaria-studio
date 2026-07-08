/**
 * test/poll-vote-again-message-edition-3113.test.ts (#3113 item 13)
 *
 * A mensagem "já votou" no brand `year` (clarice) dizia sempre "Você já votou
 * nesta edição" — sem citar QUAL edição. Ambíguo pra quem votou em mais de
 * uma edição arquivada retroativamente (#2867 permite votar em qualquer
 * edição do ano, não só a corrente). Fix: unifica com o brand `month`
 * (diaria) — sempre cita a edição, usando `formatEditionDateForBrand` (#3112)
 * pra formatar certo por brand (mês/ano pro `year`, data completa pro `month`).
 *
 * Cobre os 2 caminhos que constroem a mensagem em vote.ts (via DO VoteDedup
 * e via fallback KV direto, sem DO).
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

async function voteTwice(edition: string, brand: "diaria" | "clarice", email: string) {
  const { default: worker } = await import("../workers/poll/src/index.ts");
  const kv = makeTrackedKv({ [`${brand === "clarice" ? "clarice:" : ""}correct:${edition}`]: "A" });
  const env = makeEnvWithDo(kv);
  const makeUrl = () => {
    const u = new URL("https://poll.diaria.workers.dev/vote");
    u.searchParams.set("email", email);
    u.searchParams.set("edition", edition);
    u.searchParams.set("choice", "A");
    if (brand === "clarice") u.searchParams.set("brand", "clarice");
    return u.toString();
  };
  await worker.fetch(new Request(makeUrl()), env, {} as ExecutionContext);
  const dup = await worker.fetch(new Request(makeUrl()), env, {} as ExecutionContext);
  return dup.text();
}

describe("mensagem 'já votou' cita a edição — brand diaria (#3113 item 13, guarda de regressão)", () => {
  it("cita a data completa da edição", async () => {
    const html = await voteTwice("260701", "diaria", "diaria-repeat@x.com");
    assert.match(html, /Você já votou na edição de 1 de julho de 2026/);
  });
});

describe("mensagem 'já votou' cita a edição — brand clarice/year (#3113 item 13, fix)", () => {
  it('NÃO usa mais o genérico "nesta edição"', async () => {
    const html = await voteTwice("260701", "clarice", "clarice-repeat@x.com");
    assert.doesNotMatch(html, /já votou nesta edição/);
  });

  it("cita 'mês de ano' (sem o dia — formatEditionDateForBrand, #3112) em vez de ficar ambíguo", async () => {
    const html = await voteTwice("260701", "clarice", "clarice-repeat2@x.com");
    assert.match(html, /Você já votou na edição de julho de 2026/);
  });

  it("2 edições diferentes do mesmo ano produzem mensagens DIFERENTES (a edição citada muda)", async () => {
    const htmlJuly = await voteTwice("260701", "clarice", "clarice-multi@x.com");
    const htmlJune = await voteTwice("260601", "clarice", "clarice-multi@x.com");
    assert.match(htmlJuly, /edição de julho de 2026/);
    assert.match(htmlJune, /edição de junho de 2026/);
  });
});
