/**
 * test/purge-leaderboard-plan.test.ts (#4433)
 *
 * Regressão: `purge-leaderboard.ts --email X` apagava só as chaves keyed pelo
 * e-mail (`score:`, `score-by-month:`, `vote:`, `counted:`). No brand `web`
 * (jogo público `/jogar`), a partida real é jogada sob uma identidade
 * ANÔNIMA (`{uuid}@web.eia.diaria.local`), vinculada depois via
 * `identify-linked:{email}:{uuid}@web.eia.diaria.local` — o merge nunca apaga
 * `score`/`vote` da identidade anônima. Purgar só pelo e-mail deixava os
 * votos de verdade (sob a identidade anônima) intactos no leaderboard
 * (achado 260801).
 *
 * `buildPurgePlan`/`resolveLinkedAnonymousIdentities` (scripts/lib/
 * purge-leaderboard-plan.ts) são as peças puras testadas aqui — nunca
 * invocam wrangler/KV real (ops é um KV em memória, mesmo padrão de KvSyncOps
 * em sync-cursos-subscribers-kv.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildPurgePlan,
  resolveLinkedAnonymousIdentities,
  resolveTargetEmails,
  type PurgeKvOps,
} from "../scripts/lib/purge-leaderboard-plan.ts";

/** KV em memória — nunca toca wrangler/rede. `list(prefix)` faz prefix-match
 * simples (mesma semântica de `wrangler kv key list --prefix`). */
function makeMemoryKv(initial: Record<string, string> = {}): PurgeKvOps & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    list: async (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix)),
    get: async (key: string) => store.get(key) ?? null,
  };
}

describe("resolveLinkedAnonymousIdentities (#4433)", () => {
  it("resolve a identidade anônima ligada a partir de identify-linked:{email}:{anonEmail}", async () => {
    const anon = "da39ec1f-1234-4abc-9def-000000000001@web.eia.diaria.local";
    const kv = makeMemoryKv({
      [`identify-linked:teste@example.com:${anon}`]: "1",
    });

    const { linkKeys, anonEmails } = await resolveLinkedAnonymousIdentities(kv, "", "teste@example.com");

    assert.deepEqual(linkKeys, [`identify-linked:teste@example.com:${anon}`]);
    assert.deepEqual(anonEmails, [anon]);
  });

  it("resolve MÚLTIPLAS identidades ligadas ao mesmo e-mail (várias sessões/devices)", async () => {
    const anon1 = "aaaaaaaa-1111-4abc-9def-000000000001@web.eia.diaria.local";
    const anon2 = "bbbbbbbb-2222-4abc-9def-000000000002@web.eia.diaria.local";
    const kv = makeMemoryKv({
      [`identify-linked:teste@example.com:${anon1}`]: "1",
      [`identify-linked:teste@example.com:${anon2}`]: "1",
      // e-mail de OUTRO usuário não deve vazar pro resultado
      [`identify-linked:outro@example.com:cccccccc-3333-4abc-9def-000000000003@web.eia.diaria.local`]: "1",
    });

    const { anonEmails } = await resolveLinkedAnonymousIdentities(kv, "", "teste@example.com");

    assert.deepEqual(new Set(anonEmails), new Set([anon1, anon2]));
  });

  it("sem nenhum link → listas vazias (nunca lança)", async () => {
    const kv = makeMemoryKv({});
    const { linkKeys, anonEmails } = await resolveLinkedAnonymousIdentities(kv, "", "sem-link@example.com");
    assert.deepEqual(linkKeys, []);
    assert.deepEqual(anonEmails, []);
  });

  it("respeita o prefixo de brand (BP) — 'web:' não vaza pra 'clarice:' nem vice-versa", async () => {
    const anonWeb = "aaaaaaaa-1111-4abc-9def-000000000001@web.eia.diaria.local";
    const kv = makeMemoryKv({
      [`web:identify-linked:teste@example.com:${anonWeb}`]: "1",
      [`clarice:identify-linked:teste@example.com:outra-identidade@web.eia.diaria.local`]: "1",
    });

    const { anonEmails } = await resolveLinkedAnonymousIdentities(kv, "web:", "teste@example.com");
    assert.deepEqual(anonEmails, [anonWeb]);
  });
});

describe("buildPurgePlan — modo --email resolve identidades ligadas (#4433)", () => {
  it("achado 260801: score do e-mail com poucos/zero votos, votos DE VERDADE sob a identidade anônima ligada — o plano inclui as keys da identidade ligada", async () => {
    const email = "vjpixel+teste@gmail.com";
    const anon = "da39ec1f-1234-4abc-9def-000000000001@web.eia.diaria.local";
    const kv = makeMemoryKv({
      // e-mail tem score (a "casca") mas ZERO vote:* — reflete o achado real
      [`score:${email}`]: JSON.stringify({ total: 26, nickname: null }),
      [`identify-linked:${email}:${anon}`]: "1",
      // os votos DE VERDADE estão sob a identidade anônima
      [`vote:260801:${anon}`]: JSON.stringify({ choice: "A", ts: "2026-08-01T00:00:00Z", correct: true }),
      [`vote:260802:${anon}`]: JSON.stringify({ choice: "B", ts: "2026-08-02T00:00:00Z", correct: false }),
      [`score:${anon}`]: JSON.stringify({ total: 40, nickname: null }),
      [`score-by-month:2608:${anon}`]: JSON.stringify({ nickname: null }),
    });

    const plan = await buildPurgePlan(kv, "", email, null);

    // a identidade anônima entra no plano
    assert.ok(plan.matchedEmails.includes(anon), "identidade anônima ligada deveria estar no plano");
    const anonEntry = plan.plans.find((p) => p.email === anon);
    assert.ok(anonEntry, "deveria existir uma entry de plano pra identidade anônima");
    assert.deepEqual(new Set(anonEntry!.voteKeys), new Set([`vote:260801:${anon}`, `vote:260802:${anon}`]));
    assert.equal(anonEntry!.scoreExists, true);
    // marcado como vindo de link, não match direto
    assert.deepEqual(anonEntry!.linkedVia, [email]);

    // a entry do e-mail original continua sem votos (a "casca")
    const emailEntry = plan.plans.find((p) => p.email === email);
    assert.ok(emailEntry);
    assert.deepEqual(emailEntry!.voteKeys, []);
    assert.equal(emailEntry!.linkedVia, undefined, "o target original não deveria estar marcado como 'via link'");

    // a própria chave identify-linked entra na lista de limpeza final
    assert.deepEqual(plan.identifyLinkedKeys, [`identify-linked:${email}:${anon}`]);
  });

  it("sem nenhum identify-linked — comportamento idêntico ao pré-#4433 (só o e-mail no plano)", async () => {
    const email = "sem-link@example.com";
    const kv = makeMemoryKv({
      [`score:${email}`]: JSON.stringify({ total: 5, nickname: null }),
      [`vote:260801:${email}`]: JSON.stringify({ choice: "A", ts: "2026-08-01T00:00:00Z", correct: true }),
    });

    const plan = await buildPurgePlan(kv, "", email, null);

    assert.deepEqual(plan.matchedEmails, [email]);
    assert.equal(plan.identifyLinkedKeys.length, 0);
    assert.equal(plan.plans[0].voteKeys.length, 1);
  });

  it("modo --nickname NUNCA resolve identify-linked (só --email tem uma identidade única de origem)", async () => {
    const kv = makeMemoryKv({
      [`score-by-month:2026-08:alguem@example.com`]: JSON.stringify({ nickname: "Teste" }),
      [`identify-linked:alguem@example.com:zzzzzzzz-0000-4abc-9def-000000000009@web.eia.diaria.local`]: "1",
    });

    const plan = await buildPurgePlan(kv, "", null, "teste");

    assert.deepEqual(plan.matchedEmails, ["alguem@example.com"]);
    assert.equal(plan.identifyLinkedKeys.length, 0, "modo --nickname não deve tocar identify-linked");
  });

  it("counted:* guard-keys (#3976) são derivadas também pra identidade resolvida via link", async () => {
    const email = "vjpixel+eiateste260728@gmail.com";
    const anon = "a4d9e0cb-5678-4abc-9def-000000000002@web.eia.diaria.local";
    const kv = makeMemoryKv({
      [`score:${email}`]: JSON.stringify({ total: 44, nickname: null }),
      [`identify-linked:${email}:${anon}`]: "1",
      [`vote:260801:${anon}`]: JSON.stringify({ choice: "A", ts: "2026-08-01T00:00:00Z", correct: true }),
    });

    const plan = await buildPurgePlan(kv, "", email, null);
    const anonEntry = plan.plans.find((p) => p.email === anon)!;

    assert.deepEqual(
      new Set(anonEntry.countedKeys),
      new Set([`counted:260801:${anon}:stats`, `counted:260801:${anon}:score`, `counted:260801:${anon}:month`]),
    );
  });

  it("não-recursivo por construção: uma identidade anônima resolvida via link NUNCA é usada como origem de um 2º nível de resolução", async () => {
    // Mesmo que exista (por engano/dado corrompido) um identify-linked cuja
    // chave da esquerda seja uma identidade anônima, buildPurgePlan só chama
    // resolveLinkedAnonymousIdentities para os emails do match ORIGINAL —
    // nunca itera de novo sobre os anonEmails recém-adicionados.
    const email = "real@example.com";
    const anon1 = "aaaaaaaa-1111-4abc-9def-000000000001@web.eia.diaria.local";
    const anon2 = "bbbbbbbb-2222-4abc-9def-000000000002@web.eia.diaria.local";
    const kv = makeMemoryKv({
      [`identify-linked:${email}:${anon1}`]: "1",
      // cadeia hipotética anon1 -> anon2 (não deveria existir na prática, ver
      // docstring de resolveLinkedAnonymousIdentities — mas o teste garante
      // que MESMO SE existisse, o plano não seguiria a cadeia)
      [`identify-linked:${anon1}:${anon2}`]: "1",
    });

    const plan = await buildPurgePlan(kv, "", email, null);

    assert.ok(plan.matchedEmails.includes(anon1));
    assert.equal(plan.matchedEmails.includes(anon2), false, "não deveria seguir uma 2ª cadeia de identify-linked");
    assert.deepEqual(plan.identifyLinkedKeys, [`identify-linked:${email}:${anon1}`]);
  });
});

describe("buildPurgePlan — agregado seq:{month}:{identity} (#4470)", () => {
  it("inclui seq:{month}:{email} do alvo direto E da identidade linkada via identify-linked", async () => {
    const email = "vjpixel+seqteste@gmail.com";
    const anon = "cccccccc-4444-4abc-9def-000000000004@web.eia.diaria.local";
    const kv = makeMemoryKv({
      [`score:${email}`]: JSON.stringify({ total: 10, nickname: null }),
      [`identify-linked:${email}:${anon}`]: "1",
      [`score:${anon}`]: JSON.stringify({ total: 30, nickname: null }),
      // agregado mensal presente pro e-mail direto E pra identidade linkada
      [`seq:2026-08:${email}`]: JSON.stringify({ "260801": { choice: "A", correct: true } }),
      [`seq:2026-08:${anon}`]: JSON.stringify({ "260801": { choice: "B", correct: false } }),
      // outro usuário não deve vazar pro plano
      [`seq:2026-08:outro@example.com`]: JSON.stringify({ "260801": { choice: "A", correct: true } }),
    });

    const plan = await buildPurgePlan(kv, "", email, null);

    const emailEntry = plan.plans.find((p) => p.email === email)!;
    const anonEntry = plan.plans.find((p) => p.email === anon)!;

    assert.deepEqual(emailEntry.seqKeys, [`seq:2026-08:${email}`]);
    assert.deepEqual(anonEntry.seqKeys, [`seq:2026-08:${anon}`]);
    // não deve vazar a seq de outro usuário pra nenhuma das duas entries
    assert.ok(!emailEntry.seqKeys.some((k) => k.includes("outro@example.com")));
    assert.ok(!anonEntry.seqKeys.some((k) => k.includes("outro@example.com")));
  });

  it("respeita o prefixo de brand (BP) — seq: de 'web:' não vaza pra plano sem brand", async () => {
    const email = "teste@example.com";
    const kv = makeMemoryKv({
      [`web:score:${email}`]: JSON.stringify({ total: 5, nickname: null }),
      [`web:seq:2026-08:${email}`]: JSON.stringify({ "260801": { choice: "A", correct: true } }),
      // mesma chave lógica sem o prefixo de brand — não deveria aparecer no plano "web:"
      [`seq:2026-08:${email}`]: JSON.stringify({ "260801": { choice: "B", correct: false } }),
    });

    const plan = await buildPurgePlan(kv, "web:", email, null);
    const entry = plan.plans.find((p) => p.email === email)!;

    assert.deepEqual(entry.seqKeys, [`web:seq:2026-08:${email}`]);
  });

  it("sem nenhum seq: presente → seqKeys vazio (nunca lança)", async () => {
    const email = "sem-seq@example.com";
    const kv = makeMemoryKv({
      [`score:${email}`]: JSON.stringify({ total: 1, nickname: null }),
    });

    const plan = await buildPurgePlan(kv, "", email, null);
    assert.deepEqual(plan.plans[0].seqKeys, []);
  });

  it("simulação de execução: deletar as keys do plano remove seq: junto com score:/vote:", async () => {
    const email = "vjpixel+seqexec@gmail.com";
    const kv = makeMemoryKv({
      [`score:${email}`]: JSON.stringify({ total: 10, nickname: null }),
      [`vote:260801:${email}`]: JSON.stringify({ choice: "A", ts: "2026-08-01T00:00:00Z", correct: true }),
      [`seq:2026-08:${email}`]: JSON.stringify({ "260801": { choice: "A", correct: true } }),
    });

    const plan = await buildPurgePlan(kv, "", email, null);
    const entry = plan.plans[0];

    // simula a execução real (purge-leaderboard.ts --execute): apaga score +
    // vote + seq da entry, mesmo padrão de loop do script.
    kv.store.delete(entry.scoreKey);
    for (const k of entry.voteKeys) kv.store.delete(k);
    for (const k of entry.seqKeys) kv.store.delete(k);

    assert.equal(kv.store.has(`score:${email}`), false);
    assert.equal(kv.store.has(`vote:260801:${email}`), false);
    assert.equal(kv.store.has(`seq:2026-08:${email}`), false);
    assert.equal(kv.store.size, 0, "nenhuma key deveria sobrar após a purga simulada");
  });
});

describe("resolveTargetEmails (baseline, não tocado pelo #4433)", () => {
  it("modo --email: o próprio email é o target, sem scan", async () => {
    const kv = makeMemoryKv({});
    const matched = await resolveTargetEmails(kv, "", [], "alvo@example.com", null);
    assert.deepEqual(matched, new Set(["alvo@example.com"]));
  });

  it("modo --nickname: resolve via score-by-month:* case-insensitive", async () => {
    const kv = makeMemoryKv({
      "score-by-month:2026-08:alguem@example.com": JSON.stringify({ nickname: "Teste" }),
    });
    const matched = await resolveTargetEmails(
      kv,
      "",
      ["score-by-month:2026-08:alguem@example.com"],
      null,
      "teste",
    );
    assert.deepEqual(matched, new Set(["alguem@example.com"]));
  });
});
