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
 *
 * Self-review: `formatEditionDateForBrand` só tratava AAMMDD (6 dígitos) —
 * mas o `edition` real que chega em `handleVote` pro brand `clarice` é o
 * CICLO `YYMM-MM` (ex: "2605-06", ver `close-poll.ts --brand clarice`), não
 * AAMMDD. Sem o fix, a mensagem "já votou" mostraria o slug cru ("2605-06")
 * em vez de "junho de 2026". Testado tanto isolado (pure) quanto e2e.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatEditionDateForBrand } from "../workers/poll/src/lib.ts";
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

describe("#3113 item 13 (self-review) — formatEditionDateForBrand aceita o ciclo Clarice YYMM-MM", () => {
  it("brand clarice, edition no formato de ciclo real (\"2605-06\") → 'maio de 2026' (mês do CONTEÚDO, não o mês de ENVIO nem o slug cru)", () => {
    // "2605-06": YY=26, MM-conteúdo=05 (maio — o digest é SOBRE maio),
    // MM-envio=06 (junho — quando o e-mail sai). formatEditionDateForBrand usa
    // o mês do CONTEÚDO (mesmo bucket de editionToMonthSlug), não o de envio.
    assert.equal(formatEditionDateForBrand("2605-06", "clarice"), "maio de 2026");
  });

  it("brand clarice, ciclo com mês inválido → retorna o input cru (mesmo fallback de sempre)", () => {
    assert.equal(formatEditionDateForBrand("2613-14", "clarice"), "2613-14");
  });

  it("brand diaria (leaderboardPeriod 'month') não é afetado pelo ramo de ciclo — cai no formatEditionDate normal", () => {
    // "2605-06" não é AAMMDD (6 dígitos), então formatEditionDate (chamado
    // pro brand diaria) retorna o input cru — comportamento pré-existente,
    // não regredido pela adição do ramo de ciclo (que só roda pro brand anual).
    assert.equal(formatEditionDateForBrand("2605-06", "diaria"), "2605-06");
  });

  it("e2e: voto via /vote com edition em formato de ciclo (brand clarice) — 'já votou' cita o mês, não o slug cru", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv();
    const env: Env = { POLL: kv as unknown as KVNamespace, POLL_SECRET: "s", ADMIN_SECRET: "a", ALLOWED_ORIGINS: "*" };
    const vote = (choice: string) => {
      const u = new URL("https://poll.diaria.workers.dev/vote");
      u.searchParams.set("email", "ciclo@x.com");
      u.searchParams.set("edition", "2605-06"); // ciclo real (close-poll.ts --brand clarice)
      u.searchParams.set("choice", choice);
      u.searchParams.set("brand", "clarice");
      return worker.fetch(new Request(u.toString()), env, {} as ExecutionContext);
    };
    await vote("A");
    const res2 = await vote("B");
    const html = await res2.text();
    assert.match(html, /já votou na edição de maio de 2026/i);
    assert.doesNotMatch(html, /2605-06/, "não deve vazar o slug interno cru pro leitor");
  });
});
