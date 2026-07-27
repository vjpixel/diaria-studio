/**
 * test/poll-archive-clarice-branded-leak-4117.test.ts (#4117)
 *
 * Regressão: o arquivo retroativo do leaderboard (#2867) despachava com
 * `bEnv` (env BRANDED pelo brand da query string) pros dois handlers de
 * arquivo — `handleLeaderboardArchive` (listagem) e `handleArchiveVotePage`
 * (voto de 1 edição). Ambos só tocam KV pra ler `correct:{edition}`/
 * `correct:{yy}*` — o GABARITO, que é sempre uma chave COMPARTILHADA/CRUA
 * (nunca prefixada por brand — `close-poll.ts`/`handleAdminCorrect` sempre
 * gravam em `correct:{edition}` sem prefixo, ver #3600/#4038).
 *
 * Bug: `bEnv` do brand `clarice` prefixa toda leitura com `clarice:` — a
 * listagem fazia `list({prefix: "clarice:correct:26"})` (0 resultados) e a
 * página de voto individual fazia `get("clarice:correct:260101")` (sempre
 * null) mesmo com `correct:260101` presente no KV. Resultado: arquivo do
 * brand clarice — o ÚNICO que expõe esse link publicamente, ver #3615 —
 * sempre renderizava vazio, e a página de voto de qualquer edição arquivada
 * sempre voltava 404.
 *
 * `brand: "diaria"` NUNCA teria pego esse bug — o prefixo de diaria é vazio
 * (`brandKvPrefix`), então `bEnv` e o env cru leem exatamente a mesma chave.
 * Por isso os testes abaixo usam `brand: "clarice"` explicitamente (única
 * forma de expor a divergência bEnv vs env cru neste código).
 *
 * Fix: index.ts agora despacha os dois handlers com o `env` CRU (mesmo
 * padrão já usado por `handleVote`/`handleAdminCorrect` — `rawEnv`/#3600/
 * #4038); `brand` continua threadeado separadamente pra branding cosmético
 * do HTML (copy, links, título).
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

describe("GET /leaderboard/{YYYY}/arquivo?brand=clarice (#4117)", () => {
  it("lista edições do ano mesmo com brand=clarice — antes vinha sempre vazio (lia clarice:correct:* em vez de correct:*)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "correct:260101": "A", // chave CRUA — close-poll.ts nunca prefixa por brand
      "correct:260615": "B",
    });
    const env = makeEnvWithDo(kv);

    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo?brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /Nenhuma edição disponível/i, "regressão #4117: listagem vinha vazia pro brand clarice");
    assert.match(html, /260615|junho/i);
    assert.match(html, /260101|janeiro/i);
  });
});

describe("GET /leaderboard/{YYYY}/arquivo/{AAMMDD}?brand=clarice (#4117)", () => {
  it("edição com gabarito fechado → 200 (antes: 404 — get('clarice:correct:{edition}') sempre null)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({ "correct:260101": "A" }); // chave CRUA
    const env = makeEnvWithDo(kv);

    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo/260101?brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200, "regressão #4117: página de voto do arquivo dava 404 pro brand clarice mesmo com gabarito fechado");
    const html = await res.text();
    assert.match(html, /img-260101-01-eia-A\.jpg/);
    assert.match(html, /img-260101-01-eia-B\.jpg/);
  });

  it("brand=diaria (default) continuava funcionando antes do fix — guarda de não-regressão", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({ "correct:260101": "A" });
    const env = makeEnvWithDo(kv);

    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo/260101"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
  });
});
