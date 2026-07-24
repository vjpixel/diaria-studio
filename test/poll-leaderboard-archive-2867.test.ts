/**
 * test/poll-leaderboard-archive-2867.test.ts (#2867)
 *
 * Testes de regressão para o arquivo retroativo do leaderboard anual "É IA?".
 *
 * Decisão de produto (issue #2867, comentário do editor 260703):
 *   1. Votos retroativos PONTUAM no ranking anual (não é só arquivo estático).
 *   2. Mecânica: página-arquivo `/leaderboard/{YYYY}/arquivo` lista as edições
 *      do ano (data + link); o assinante digita o e-mail, vota, e o voto é
 *      registrado com dedup por email+edição reusando o Durable Object
 *      `VoteDedup` já existente (via o `/vote` normal).
 *   3. Anti-gaming: (a) não exibir a resposta correta antes do voto;
 *      (b) 1 voto por edição via o dedup DO existente; (c) escopo restrito
 *      às edições do ano pedido.
 *
 * O que quebrava antes do #2867: `handleVote` rejeitava (410) qualquer voto
 * em edição fora da janela recente de `valid_editions` (só cobre os últimos
 * N dias, #1233) — mesmo quando a edição tinha gabarito fechado
 * (`correct:{edition}`, setado por close-poll.ts pós-publicação real). Isso
 * bloqueava QUALQUER voto retroativo, arquivo ou não.
 *
 * Fix: o gate em vote.ts agora aceita a edição quando `correct:{edition}`
 * já está definido, mesmo fora da janela — e os novos handlers de arquivo
 * (`handleLeaderboardArchive`, `handleArchiveVotePage`) expõem a listagem +
 * página de voto sem revelar o gabarito antes do voto.
 *
 * Estrutura:
 * 1. Funções puras: extractEditionsForYear, archiveHref.
 * 2. Rota de listagem `/leaderboard/{YYYY}/arquivo`.
 * 3. Rota de voto `/leaderboard/{YYYY}/arquivo/{AAMMDD}` — anti-gaming (não
 *    revela gabarito) + 404 em edição sem gabarito / ano incompatível.
 * 4. Integração ponta-a-ponta: voto retroativo via /vote pontua no ranking
 *    anual (score-by-month) MESMO fora da janela de valid_editions.
 * 5. Dedup: 2º voto do mesmo email+edição é bloqueado (DO reusado).
 * 6. Guarda de regressão: edição SEM gabarito e fora da janela continua 410.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractEditionsForYear,
  archiveHref,
} from "../workers/poll/src/leaderboard-routes.ts";
import { VoteDedup } from "../workers/poll/src/vote-dedup.ts";
import { makeMockDoState } from "./_helpers/make-mock-do-state.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import type { Env } from "../workers/poll/src/index.ts";

// ── 1. Funções puras ──────────────────────────────────────────────────────

describe("extractEditionsForYear (#2867)", () => {
  it("filtra chaves correct:{edition} pelo ano exato e ordena DESC", () => {
    const keys = [
      "correct:260101",
      "correct:260615",
      "correct:250101", // ano diferente — excluída
      "correct:260320",
    ];
    assert.deepEqual(
      extractEditionsForYear(keys, "2026"),
      ["260615", "260320", "260101"],
    );
  });

  it("ignora chaves malformadas ou de outro schema (ex: ciclo mensal Clarice)", () => {
    const keys = ["correct:2605-06", "correct:abc123", "correct:26010", "correct:260101"];
    assert.deepEqual(extractEditionsForYear(keys, "2026"), ["260101"]);
  });

  it("dedup de chaves repetidas", () => {
    const keys = ["correct:260101", "correct:260101"];
    assert.deepEqual(extractEditionsForYear(keys, "2026"), ["260101"]);
  });

  it("nenhuma edição do ano → array vazio", () => {
    assert.deepEqual(extractEditionsForYear(["correct:250101"], "2026"), []);
  });

  it("aceita nomes de chave já sem o prefixo 'correct:'", () => {
    assert.deepEqual(extractEditionsForYear(["260101"], "2026"), ["260101"]);
  });
});

describe("archiveHref (#2867)", () => {
  it("brand diaria (default) → sem query param", () => {
    assert.equal(archiveHref("diaria", "2026"), "/leaderboard/2026/arquivo");
    assert.equal(archiveHref("diaria", "2026", "260101"), "/leaderboard/2026/arquivo/260101");
  });

  it("brand não-default → preserva ?brand=", () => {
    assert.equal(archiveHref("clarice", "2026"), "/leaderboard/2026/arquivo?brand=clarice");
    assert.equal(archiveHref("clarice", "2026", "260101"), "/leaderboard/2026/arquivo/260101?brand=clarice");
  });
});

// ── helpers de integração (mesmo padrão de test/poll-vote-dedup-2187.test.ts) ─

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

// ── 2. Rota de listagem ────────────────────────────────────────────────────

describe("GET /leaderboard/{YYYY}/arquivo (#2867)", () => {
  it("lista edições de 2026 com gabarito fechado, mais recente primeiro", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "correct:260101": "A",
      "correct:260615": "B",
      "correct:250101": "A", // outro ano — não deve aparecer
    });
    const env = makeEnvWithDo(kv);

    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /260615|15 de junho/i);
    assert.match(html, /260101|1 de janeiro/i);
    assert.doesNotMatch(html, /250101/);

    // Ordem: 260615 (mais recente) deve aparecer antes de 260101 no HTML.
    const idx615 = html.indexOf("/leaderboard/2026/arquivo/260615");
    const idx101 = html.indexOf("/leaderboard/2026/arquivo/260101");
    assert.ok(idx615 >= 0 && idx101 >= 0 && idx615 < idx101, "edição mais recente deve vir primeiro");
  });

  it("ano sem nenhuma edição → lista vazia, ainda 200", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const env = makeEnvWithDo(makeTrackedKv());
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2099/arquivo"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Nenhuma edição disponível/i);
  });
});

// ── 3. Rota de voto — anti-gaming ──────────────────────────────────────────

describe("GET /leaderboard/{YYYY}/arquivo/{AAMMDD} (#2867)", () => {
  it("edição com gabarito → 200, mostra as 2 imagens, NÃO revela qual é a IA", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({ "correct:260101": "A" });
    const env = makeEnvWithDo(kv);

    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo/260101"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /img-260101-01-eia-A\.jpg/);
    assert.match(html, /img-260101-01-eia-B\.jpg/);
    // Anti-gaming: a página de VOTO não pode rotular NENHUM lado especificamente
    // como a resposta (o rótulo por-lado só existe na página de RESULTADO pós-voto,
    // ver renderResultImagesHtml/votePageHtml — "🤖 Gerada por IA" / "📷 Foto real").
    assert.doesNotMatch(html, /🤖/, "não deve usar o emoji-rótulo de IA da página de resultado");
    assert.doesNotMatch(html, /📷/, "não deve usar o emoji-rótulo de foto real da página de resultado");
    assert.doesNotMatch(html, /clicked|"you"/i, "não deve conter marcação de resultado (classe 'clicked'/'you' da página pós-voto)");
    // Os dois botões de escolha devem ter o mesmo texto (simetria — nenhum lado
    // é destacado como "a resposta").
    const buttonTexts = [...html.matchAll(/<button type="submit" name="choice" value="[AB]">([^<]+)<\/button>/g)]
      .map((m) => m[1].replace(/\s*\([AB]\)$/, "").trim());
    assert.equal(buttonTexts.length, 2);
    assert.equal(buttonTexts[0], buttonTexts[1], "os 2 botões devem ter o mesmo rótulo — sem dica de qual é a IA");
  });

  it("form de voto submete via GET para /vote, sem `sig` (merge-tag mode)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({ "correct:260101": "A" });
    const env = makeEnvWithDo(kv);
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo/260101"),
      env,
      {} as ExecutionContext,
    );
    const html = await res.text();
    assert.match(html, /<form action="\/vote" method="GET">/);
    assert.match(html, /<input type="hidden" name="edition" value="260101">/);
    assert.match(html, /<input type="email" name="email"/);
    assert.doesNotMatch(html, /name="sig"/, "não deve incluir campo sig — merge-tag mode sem HMAC");
  });

  it("edição sem gabarito fechado → 404", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const env = makeEnvWithDo(makeTrackedKv());
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo/260101"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 404);
  });

  it("edição de outro ano que não o da URL → 404 (escopo restrito ao ano, #2867 item 3c)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({ "correct:250101": "A" });
    const env = makeEnvWithDo(kv);
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo/250101"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 404);
  });
});

// ── 4. Voto retroativo PONTUA no ranking anual (#2867 item 1) ─────────────

describe("Voto retroativo via /vote pontua no ranking anual mesmo fora da janela de valid_editions (#2867)", () => {
  it("edição de janeiro com gabarito, FORA da valid_editions (só tem edições de julho) → voto aceito, não 410", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "correct:260115": "A", // edição arquivada de 2026-01-15, gabarito = A
      // valid_editions só cobre a janela recente (#1233) — NÃO inclui 260115.
      "valid_editions": JSON.stringify(["260701", "260702"]),
    });
    const env = makeEnvWithDo(kv);

    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "retro@x.com");
    url.searchParams.set("edition", "260115");
    url.searchParams.set("choice", "A"); // acertou

    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 200, "voto retroativo NÃO deve ser rejeitado (410) mesmo fora da janela de valid_editions");
    const html = await res.text();
    assert.doesNotMatch(html, /não aceita mais votos/i);
    assert.match(html, /Acertou/i);

    // O voto foi de fato gravado
    const voteRaw = await kv.get("vote:260115:retro@x.com");
    assert.ok(voteRaw !== null, "voto deve ter sido gravado no KV");

    // Pontuou no bucket mensal de JANEIRO/2026 (que alimenta o ranking anual
    // /leaderboard/2026 via mergeYearEntries).
    const monthRaw = await kv.get("score-by-month:2026-01:retro@x.com");
    assert.ok(monthRaw !== null, "voto retroativo deve criar entry em score-by-month:2026-01");
    const monthEntry = JSON.parse(monthRaw!);
    assert.equal(monthEntry.total, 1);
    assert.equal(monthEntry.correct, 1, "acertou o gabarito — correct deve ser 1");
  });

  it("o voto retroativo aparece no /leaderboard/2026 anual (agregação dos 12 meses)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "correct:260115": "A",
      "valid_editions": JSON.stringify(["260701", "260702"]),
    });
    const env = makeEnvWithDo(kv);

    const voteUrl = new URL("https://poll.diaria.workers.dev/vote");
    voteUrl.searchParams.set("email", "retro2@x.com");
    voteUrl.searchParams.set("edition", "260115");
    voteUrl.searchParams.set("choice", "A");
    await worker.fetch(new Request(voteUrl.toString()), env, {} as ExecutionContext);

    // #2006: /leaderboard/{YYYY} agrega score-by-month:2026-01..2026-{mês atual}.
    // currentMonthSlugBrt(new Date()) no ambiente de teste é "real" — usamos o
    // ano 2026 e confiamos que o mês corrente >= janeiro (sempre verdade).
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    // Sem nickname, aparece como email mascarado — local-part truncado pros 3
    // primeiros chars desde #4008 item 1 ("ret…@***", não mais "retro2@***").
    // Único voto do mês (total=1, abaixo de MIN_ATTEMPTS_FOR_LEADERBOARD_LISTING)
    // — mas o fallback anti-leaderboard-vazio de partitionLeaderboardForDisplay
    // (#4008 item 2) mantém a linha visível quando NINGUÉM atinge o mínimo.
    assert.match(html, /ret…@\*\*\*/, "voto retroativo de janeiro deve aparecer agregado no leaderboard anual de 2026");
  });
});

// ── 5. Dedup por email+edição bloqueia voto duplo (#2867 item 3b) ─────────

describe("Dedup email+edição bloqueia voto duplo em edição arquivada (#2867)", () => {
  it("2º voto do mesmo email na mesma edição retroativa → rejeitado, score.total continua 1", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "correct:260115": "A",
      "valid_editions": JSON.stringify(["260701"]),
    });
    const env = makeEnvWithDo(kv);

    const makeUrl = (choice: string) => {
      const u = new URL("https://poll.diaria.workers.dev/vote");
      u.searchParams.set("email", "dup-archive@x.com");
      u.searchParams.set("edition", "260115");
      u.searchParams.set("choice", choice);
      return u.toString();
    };

    const res1 = await worker.fetch(new Request(makeUrl("A")), env, {} as ExecutionContext);
    assert.equal(res1.status, 200);
    const html1 = await res1.text();
    assert.doesNotMatch(html1, /já votou/i, "primeiro voto não deve ser tratado como duplicado");

    const res2 = await worker.fetch(new Request(makeUrl("B")), env, {} as ExecutionContext);
    assert.equal(res2.status, 200, "2º request retorna 200 (página 'já votou'), não erro");
    const html2 = await res2.text();
    assert.match(html2, /já votou/i, "2º voto do mesmo email+edição deve ser bloqueado pelo dedup DO");

    const scoreRaw = await kv.get("score:dup-archive@x.com");
    const score = JSON.parse(scoreRaw!);
    assert.equal(score.total, 1, `dedup deve impedir double-count (got total=${score.total})`);

    const monthRaw = await kv.get("score-by-month:2026-01:dup-archive@x.com");
    const monthEntry = JSON.parse(monthRaw!);
    assert.equal(monthEntry.total, 1, `dedup deve impedir double-count no bucket mensal (got total=${monthEntry.total})`);
  });

  it("mesmo email pode votar em DUAS edições arquivadas diferentes (dedup é por email+edição, não só email)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "correct:260101": "A",
      "correct:260201": "B",
      "valid_editions": JSON.stringify(["260701"]),
    });
    const env = makeEnvWithDo(kv);

    const vote = async (edition: string, choice: string) => {
      const u = new URL("https://poll.diaria.workers.dev/vote");
      u.searchParams.set("email", "multi@x.com");
      u.searchParams.set("edition", edition);
      u.searchParams.set("choice", choice);
      return worker.fetch(new Request(u.toString()), env, {} as ExecutionContext);
    };

    const res1 = await vote("260101", "A");
    const res2 = await vote("260201", "B");
    const html1 = await res1.text();
    const html2 = await res2.text();
    assert.doesNotMatch(html1, /já votou/i);
    assert.doesNotMatch(html2, /já votou/i);

    const scoreRaw = await kv.get("score:multi@x.com");
    const score = JSON.parse(scoreRaw!);
    assert.equal(score.total, 2, "2 edições distintas = 2 votos válidos, dedup não deve bloquear");
  });
});

// ── 6. Guarda de regressão: gate original continua funcionando ────────────

describe("Guarda de regressão — edição SEM gabarito e fora da janela continua 410 (#2867 não afrouxa o gate geral)", () => {
  it("edition inexistente (sem correct:, fora de valid_editions) → 410", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "valid_editions": JSON.stringify(["260701", "260702"]),
      // SEM correct:999999 — edição nunca existiu / poll nunca fechou.
    });
    const env = makeEnvWithDo(kv);

    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "spam@x.com");
    url.searchParams.set("edition", "999999");
    url.searchParams.set("choice", "A");

    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 410, "edição sem gabarito e fora da janela deve continuar rejeitada (410)");
  });
});
