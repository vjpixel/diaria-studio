/**
 * test/poll-jogar-quiz-3520.test.ts (#3520)
 *
 * Quiz relâmpago do "É IA?" standalone (EPIC #3514, construído sobre #3516
 * (identidade anônima) + #3519 (arquivo de pares fechados) + #3517 (motor de
 * share)). Cobre:
 *   - resolveQuizSize / extractAllClosedEditions / pickQuizEditions (pure)
 *   - renderJogarQuizPageHtml (pure) — anti-spoiler, estado vazio, noscript
 *   - GET /jogar/quiz — sorteio, `?n=`, edições insuficientes
 *   - GET /jogar/quiz/answer — guard crítico anti-spoiler (edição de hoje
 *     NUNCA revelada, mesmo com gabarito já no KV), 404/400
 *   - GET /jogar/quiz/result + resolveQuizResultParams — validação de
 *     score/total, token compartilhável
 *   - GET /quiz-og/{token} e GET /quiz-share/{token}
 *   - Regressão: quiz nunca escreve `vote:`/`score:` no KV (não contamina o
 *     ranking) e o resto do #3516/#3517/#3518/#3519 continua intacto.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractAllClosedEditions,
  handleJogarQuizPage,
  handleQuizAnswer,
  handleQuizResult,
  pickQuizEditions,
  QUIZ_DEFAULT_N,
  QUIZ_MAX_N,
  QUIZ_MIN_N,
  renderJogarQuizPageHtml,
  resolveQuizResultParams,
  resolveQuizSize,
} from "../workers/poll/src/jogar.ts";
import { decodeQuizShareToken } from "../workers/poll/src/share.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async getWithMetadata(key: string) {
      const v = m.get(key);
      return { value: v ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    _map: m,
  };
}

const makeEnv = (seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
  POLL: makeMapKV(seed),
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
});

// ── resolveQuizSize (pure) ───────────────────────────────────────────────────

describe("resolveQuizSize (#3520)", () => {
  it("sem ?n= → default", () => {
    assert.equal(resolveQuizSize(null), QUIZ_DEFAULT_N);
  });

  it("abaixo do mínimo clampa pra QUIZ_MIN_N", () => {
    assert.equal(resolveQuizSize("1"), QUIZ_MIN_N);
    assert.equal(resolveQuizSize("0"), QUIZ_MIN_N);
    assert.equal(resolveQuizSize("-5"), QUIZ_MIN_N);
  });

  it("acima do máximo clampa pra QUIZ_MAX_N", () => {
    assert.equal(resolveQuizSize("999"), QUIZ_MAX_N);
    assert.equal(resolveQuizSize("11"), QUIZ_MAX_N);
  });

  it("dentro do range é respeitado", () => {
    assert.equal(resolveQuizSize("7"), 7);
    assert.equal(resolveQuizSize(String(QUIZ_MIN_N)), QUIZ_MIN_N);
    assert.equal(resolveQuizSize(String(QUIZ_MAX_N)), QUIZ_MAX_N);
  });

  it("malformado (não-inteiro, NaN, string arbitrária) cai no default — nunca lança", () => {
    assert.equal(resolveQuizSize("abc"), QUIZ_DEFAULT_N);
    assert.equal(resolveQuizSize("5.5"), QUIZ_DEFAULT_N);
    assert.equal(resolveQuizSize(""), QUIZ_DEFAULT_N);
    assert.equal(resolveQuizSize("5;DROP TABLE"), QUIZ_DEFAULT_N);
  });
});

// ── extractAllClosedEditions (pure) ─────────────────────────────────────────

describe("extractAllClosedEditions (#3520)", () => {
  it("inclui edições passadas com gabarito, de qualquer ano", () => {
    const now = new Date("2026-07-16T12:00:00Z"); // 260716 em BRT
    const keys = ["correct:260101", "correct:250615", "correct:241231"];
    const out = extractAllClosedEditions(keys, now);
    assert.deepEqual(new Set(out), new Set(["260101", "250615", "241231"]));
  });

  it("exclui a edição de HOJE mesmo com gabarito já definido (anti-spoiler)", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const keys = ["correct:260716", "correct:260101"];
    const out = extractAllClosedEditions(keys, now);
    assert.ok(!out.includes("260716"), "hoje nunca deve entrar no pool do quiz");
    assert.ok(out.includes("260101"));
  });

  it("exclui edições futuras", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const out = extractAllClosedEditions(["correct:270101"], now);
    assert.deepEqual(out, []);
  });

  it("ignora chaves malformadas e dedup", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const out = extractAllClosedEditions(["correct:not-a-date", "correct:260101", "correct:260101"], now);
    assert.deepEqual(out, ["260101"]);
  });
});

// ── pickQuizEditions (pure) ──────────────────────────────────────────────────

describe("pickQuizEditions (#3520)", () => {
  it("sorteia exatamente n itens sem repetição quando há disponibilidade suficiente", () => {
    const available = ["a", "b", "c", "d", "e"];
    const picked = pickQuizEditions(available, 3, () => 0); // rng determinístico
    assert.equal(picked.length, 3);
    assert.equal(new Set(picked).size, 3, "sem repetição de par na sessão");
    for (const p of picked) assert.ok(available.includes(p));
  });

  it("edições insuficientes: retorna só o que existe, nunca lança/duplica", () => {
    const available = ["a", "b"];
    const picked = pickQuizEditions(available, 5, () => 0);
    assert.equal(picked.length, 2);
    assert.deepEqual(new Set(picked), new Set(["a", "b"]));
  });

  it("pool vazio → retorna array vazio", () => {
    assert.deepEqual(pickQuizEditions([], 5), []);
  });

  it("n=0 → array vazio mesmo com pool disponível", () => {
    assert.deepEqual(pickQuizEditions(["a", "b"], 0), []);
  });

  it("determinístico com rng injetado (mesma seed → mesmo resultado)", () => {
    const available = ["a", "b", "c", "d"];
    const rngSeq = [0.1, 0.5, 0.9];
    let i = 0;
    const rng = () => rngSeq[i++ % rngSeq.length];
    const picked1 = pickQuizEditions(available, 3, rng);
    i = 0;
    const picked2 = pickQuizEditions(available, 3, rng);
    assert.deepEqual(picked1, picked2);
  });
});

// ── resolveQuizResultParams (pure) ───────────────────────────────────────────

describe("resolveQuizResultParams (#3520)", () => {
  it("score/total válidos dentro do range → payload", () => {
    assert.deepEqual(resolveQuizResultParams("3", "5"), { score: 3, total: 5 });
    assert.deepEqual(resolveQuizResultParams("0", String(QUIZ_MIN_N)), { score: 0, total: QUIZ_MIN_N });
    assert.deepEqual(resolveQuizResultParams(String(QUIZ_MAX_N), String(QUIZ_MAX_N)), {
      score: QUIZ_MAX_N,
      total: QUIZ_MAX_N,
    });
  });

  it("score > total é rejeitado", () => {
    assert.equal(resolveQuizResultParams("6", "5"), null);
  });

  it("score negativo é rejeitado", () => {
    assert.equal(resolveQuizResultParams("-1", "5"), null);
  });

  it("total acima de QUIZ_MAX_N é rejeitado (teto contra forja de placar absurdo)", () => {
    assert.equal(resolveQuizResultParams("1", "999"), null);
  });

  it("total=0 é rejeitado (quiz sem nenhuma rodada não é um resultado válido)", () => {
    assert.equal(resolveQuizResultParams("0", "0"), null);
  });

  // Self-review #2038 (achado corrigido — ver rationale em resolveQuizResultParams
  // no jogar.ts): total ABAIXO de QUIZ_MIN_N precisa continuar válido, porque
  // pickQuizEditions pode devolver menos rodadas que QUIZ_MIN_N quando o pool
  // de edições fechadas é pequeno (cenário "edições insuficientes", critério
  // de aceite #3520). Usar QUIZ_MIN_N como piso aqui quebraria o card de
  // compartilhamento justamente nesse cenário.
  it("total < QUIZ_MIN_N (1 ou 2) é ACEITO — quiz jogado com menos rodadas por falta de edições disponíveis ainda precisa gerar card de compartilhamento", () => {
    assert.deepEqual(resolveQuizResultParams("1", "1"), { score: 1, total: 1 });
    assert.deepEqual(resolveQuizResultParams("0", "1"), { score: 0, total: 1 });
    assert.deepEqual(resolveQuizResultParams("2", "2"), { score: 2, total: 2 });
  });

  it("não-numérico/ausente/decimal nunca lança, retorna null", () => {
    assert.equal(resolveQuizResultParams(null, "5"), null);
    assert.equal(resolveQuizResultParams("3", null), null);
    assert.equal(resolveQuizResultParams("abc", "5"), null);
    assert.equal(resolveQuizResultParams("3.5", "5"), null);
    assert.equal(resolveQuizResultParams("3", "5;DROP"), null);
  });
});

// ── renderJogarQuizPageHtml (pure render) ────────────────────────────────────

describe("renderJogarQuizPageHtml (#3520)", () => {
  it("lista vazia → mensagem amigável, sem quiz JS quebrado", () => {
    const html = renderJogarQuizPageHtml([]);
    assert.match(html, /ainda não há edições fechadas suficientes/i);
    assert.match(html, /href="\/jogar"/);
    assert.doesNotMatch(html, /var editions = \[/);
  });

  it("com edições: embute o array de edições (JSON, sem gabarito) e o noscript fallback", () => {
    const html = renderJogarQuizPageHtml(["260101", "260201"]);
    assert.match(html, /var editions = \["260101","260201"\]/);
    assert.match(html, /<noscript>/);
    assert.match(html, /Jogue o par de hoje sem JavaScript/);
  });

  it("anti-spoiler: nunca rotula A/B, nunca revela 'Gerada por IA' na página inicial", () => {
    const html = renderJogarQuizPageHtml(["260101", "260201"]);
    assert.doesNotMatch(html, /Gerada por IA/);
    assert.doesNotMatch(html, /🤖|📷/);
  });

  it("links de volta pro /jogar, /jogar/arquivo e leaderboard brand=web", () => {
    const html = renderJogarQuizPageHtml(["260101"]);
    assert.match(html, /href="\/jogar">/);
    assert.match(html, /href="\/jogar\/arquivo"/);
    assert.match(html, /\/leaderboard\?brand=web/);
  });

  it("CTA de assinatura (#3518) presente e hidden por padrão", () => {
    const html = renderJogarQuizPageHtml(["260101"]);
    assert.match(html, /id="jogar-subscribe-cta" class="subscribe-cta" hidden/);
  });
});

// ── GET /jogar/quiz ───────────────────────────────────────────────────────────

describe("GET /jogar/quiz (#3520)", () => {
  it("sorteia edições fechadas passadas, exclui hoje mesmo com gabarito", async () => {
    const now = new Date();
    const { todayAammddBrt } = await import("../workers/poll/src/lib.ts");
    const today = todayAammddBrt(now);
    const env = makeEnv({
      [`correct:${today}`]: "A",
      "correct:200101": "A",
      "correct:200102": "B",
      "correct:200103": "A",
    });
    const res = await worker.fetch(new Request("https://poll.test/jogar/quiz"), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    const html = await res.text();
    assert.doesNotMatch(html, new RegExp(`"${today}"`), "edição de hoje nunca deve entrar no quiz");
  });

  it("?n= respeitado (clamped) quando há disponibilidade suficiente", async () => {
    const env = makeEnv({
      "correct:200101": "A",
      "correct:200102": "B",
      "correct:200103": "A",
      "correct:200104": "B",
      "correct:200105": "A",
    });
    const res = await worker.fetch(new Request("https://poll.test/jogar/quiz?n=3"), env);
    const html = await res.text();
    const match = /var editions = (\[[^\]]*\])/.exec(html);
    assert.ok(match);
    const editions = JSON.parse(match![1]);
    assert.equal(editions.length, 3);
  });

  it("edições insuficientes: quiz mais curto, nunca erro", async () => {
    const env = makeEnv({ "correct:200101": "A" });
    const res = await worker.fetch(new Request("https://poll.test/jogar/quiz?n=5"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    const match = /var editions = (\[[^\]]*\])/.exec(html);
    assert.ok(match);
    assert.deepEqual(JSON.parse(match![1]), ["200101"]);
  });

  it("zero edições fechadas → 200, estado vazio amigável", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar/quiz"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /ainda não há edições fechadas suficientes/i);
  });

  it("endpoints 404 listam /jogar/quiz", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/rota-inexistente"), env);
    const body = (await res.json()) as { endpoints: string[] };
    assert.ok(body.endpoints.includes("/jogar/quiz"));
  });
});

// ── GET /jogar/quiz/answer ────────────────────────────────────────────────────

describe("GET /jogar/quiz/answer (#3520) — guard crítico de anti-spoiler", () => {
  it("edição passada fechada → 200 com o gabarito", async () => {
    const env = makeEnv({ "correct:200101": "A" });
    const res = await handleQuizAnswer(new URL("https://poll.test/jogar/quiz/answer?edition=200101"), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { edition: string; correct: string };
    assert.deepEqual(body, { edition: "200101", correct: "A" });
  });

  it("edição de HOJE é SEMPRE rejeitada (403), mesmo com gabarito já no KV — não pode vazar o par do dia", async () => {
    const now = new Date();
    const { todayAammddBrt } = await import("../workers/poll/src/lib.ts");
    const today = todayAammddBrt(now);
    const env = makeEnv({ [`correct:${today}`]: "B" });
    const res = await handleQuizAnswer(new URL(`https://poll.test/jogar/quiz/answer?edition=${today}`), env);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.doesNotMatch(JSON.stringify(body), /"correct":"[AB]"/, "resposta 403 não pode vazar o gabarito");
  });

  it("edição futura é rejeitada (403)", async () => {
    const env = makeEnv({ "correct:990101": "A" });
    const res = await handleQuizAnswer(new URL("https://poll.test/jogar/quiz/answer?edition=990101"), env);
    assert.equal(res.status, 403);
  });

  it("edição sem gabarito (nunca fechada) → 404", async () => {
    const env = makeEnv();
    const res = await handleQuizAnswer(new URL("https://poll.test/jogar/quiz/answer?edition=200101"), env);
    assert.equal(res.status, 404);
  });

  it("edition ausente/malformado → 400, nunca lança", async () => {
    const env = makeEnv();
    const res1 = await handleQuizAnswer(new URL("https://poll.test/jogar/quiz/answer"), env);
    assert.equal(res1.status, 400);
    const res2 = await handleQuizAnswer(new URL("https://poll.test/jogar/quiz/answer?edition=not-a-date"), env);
    assert.equal(res2.status, 400);
  });

  it("via router completo: mesmo guard de hoje aplicado", async () => {
    const now = new Date();
    const { todayAammddBrt } = await import("../workers/poll/src/lib.ts");
    const today = todayAammddBrt(now);
    const env = makeEnv({ [`correct:${today}`]: "A" });
    const res = await worker.fetch(new Request(`https://poll.test/jogar/quiz/answer?edition=${today}`), env);
    assert.equal(res.status, 403);
  });
});

// ── GET /jogar/quiz/result ────────────────────────────────────────────────────

describe("GET /jogar/quiz/result (#3520)", () => {
  it("score/total válidos → 200 HTML com card de compartilhamento e token decodificável", async () => {
    const env = makeEnv();
    const res = await handleQuizResult(new URL("https://poll.test/jogar/quiz/result?score=4&total=5"), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /id="jogar-quiz-share-card"/);
    assert.match(html, /Acertei 4 de 5/);
    const match = /data-share-url="https:\/\/poll\.diaria\.workers\.dev\/quiz-share\/([^"?]+)\?utm_medium=social"/.exec(html);
    assert.ok(match, "share URL com token não encontrada");
    const token = decodeURIComponent(match![1]);
    const decoded = await decodeQuizShareToken(env.POLL_SECRET, token);
    assert.deepEqual(decoded, { score: 4, total: 5 });
  });

  it("#3679: card inclui botão WhatsApp com utm_medium próprio (não reusa 'social')", async () => {
    const env = makeEnv();
    const res = await handleQuizResult(new URL("https://poll.test/jogar/quiz/result?score=4&total=5"), env);
    const html = await res.text();
    assert.match(html, /data-share-action="whatsapp"/);
    assert.match(html, /\/quiz-share\/[^"?]+\?utm_medium=whatsapp/);
  });

  it("score/total inválidos → 400", async () => {
    const env = makeEnv();
    const res = await handleQuizResult(new URL("https://poll.test/jogar/quiz/result?score=10&total=5"), env);
    assert.equal(res.status, 400);
  });

  // Self-review #2038 (achado corrigido): reproduz o cenário e2e de "edições
  // insuficientes" ponta a ponta — só 1 edição fechada disponível (ex: dia
  // seguinte ao lançamento do produto), quiz pedido com n=5 mas jogável com
  // 1 rodada só. O card de compartilhamento final PRECISA funcionar mesmo
  // com total=1 (abaixo de QUIZ_MIN_N) — sem isso, o critério de aceite
  // "edições insuficientes tratado" ficaria quebrado só no passo de share.
  it("quiz jogado com só 1 rodada (edições insuficientes) ainda gera card de compartilhamento — não falha silenciosamente", async () => {
    const env = makeEnv({ "correct:200101": "A" });
    const pageRes = await handleJogarQuizPage(new URL("https://poll.test/jogar/quiz?n=5"), env);
    const html = await pageRes.text();
    const match = /var editions = (\[[^\]]*\])/.exec(html);
    const editions = JSON.parse(match![1]);
    assert.equal(editions.length, 1, "só 1 edição fechada disponível — quiz mais curto que o pedido");

    const resultRes = await handleQuizResult(
      new URL(`https://poll.test/jogar/quiz/result?score=1&total=${editions.length}`),
      env,
    );
    assert.equal(resultRes.status, 200, "share do resultado não pode falhar quando o quiz teve menos rodadas que QUIZ_MIN_N");
    const resultHtml = await resultRes.text();
    assert.match(resultHtml, /Acertei 1 de 1/);
  });

  it("via router completo", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar/quiz/result?score=2&total=3"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Acertei 2 de 3/);
  });
});

// ── GET /quiz-og/{token} e GET /quiz-share/{token} ───────────────────────────

describe("GET /quiz-og/{token} e GET /quiz-share/{token} (#3520)", () => {
  it("GET /quiz-og/{token válido} → 200 SVG com o placar", async () => {
    const env = makeEnv();
    const { encodeQuizShareToken } = await import("../workers/poll/src/share.ts");
    const token = await encodeQuizShareToken(env.POLL_SECRET, { score: 7, total: 10 });
    const res = await worker.fetch(new Request(`https://poll.test/quiz-og/${token}`), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /image\/svg\+xml/);
    const svg = await res.text();
    assert.match(svg, /7\/10/);
  });

  it("GET /quiz-og/{token inválido} → 404", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/quiz-og/lixo-invalido"), env);
    assert.equal(res.status, 404);
  });

  it("GET /quiz-share/{token válido} → 200 HTML com og:image", async () => {
    const env = makeEnv();
    const { encodeQuizShareToken } = await import("../workers/poll/src/share.ts");
    const token = await encodeQuizShareToken(env.POLL_SECRET, { score: 3, total: 5 });
    const res = await worker.fetch(new Request(`https://poll.test/quiz-share/${token}`), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /property="og:image"/);
    assert.match(html, /quiz-og\//);
  });

  it("GET /quiz-share/{token inválido} → 302 pra /jogar/quiz (nunca dead-end)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/quiz-share/lixo-invalido"), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/jogar/quiz");
  });

  it("endpoints 404 listam /quiz-og/{token} e /quiz-share/{token}", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/rota-inexistente"), env);
    const body = (await res.json()) as { endpoints: string[] };
    assert.ok(body.endpoints.some((e) => e.startsWith("/quiz-og/")));
    assert.ok(body.endpoints.some((e) => e.startsWith("/quiz-share/")));
  });
});

// ── Regressão: quiz nunca contamina score/leaderboard/vote (#3520 aceite) ───

describe("Score do quiz não escreve NADA no KV — não contamina o ranking (#3520 aceite)", () => {
  it("jogar uma rodada completa (answer) + gerar resultado (result) não grava vote:/score: no KV", async () => {
    const env = makeEnv({ "correct:200101": "A" });
    const keysBefore = [...env.POLL._map.keys()];

    await handleQuizAnswer(new URL("https://poll.test/jogar/quiz/answer?edition=200101"), env);
    await handleQuizResult(new URL("https://poll.test/jogar/quiz/result?score=1&total=1"), env);

    const keysAfter = [...env.POLL._map.keys()];
    assert.deepEqual(keysAfter.sort(), keysBefore.sort(), "quiz não deve escrever nenhuma chave nova no KV");
    assert.ok(!keysAfter.some((k) => k.startsWith("vote:")), "nenhum voto gravado");
    assert.ok(!keysAfter.some((k) => k.startsWith("score:")), "nenhum score gravado");
    assert.ok(!keysAfter.some((k) => k.startsWith("score-by-month:")), "nenhum score mensal gravado");
  });
});

// ── Regressão: resto do #3516/#3517/#3518/#3519 continua intacto ────────────

describe("Regressão — /jogar, /jogar/arquivo, /share, /og seguem intactos (#3520 não altera nada existente)", () => {
  it("/jogar (par do dia) continua funcionando normalmente", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /action="\/vote"/);
  });

  it("/jogar/arquivo continua funcionando normalmente", async () => {
    const env = makeEnv({ "correct:260101": "A" });
    const res = await worker.fetch(new Request("https://poll.test/jogar/arquivo?year=2026"), env);
    assert.equal(res.status, 200);
  });

  it("/vote?brand=web ainda embute o card de voto único (#3517), não o do quiz", async () => {
    const env = makeEnv();
    const { anonEmailForToken } = await import("../workers/poll/src/jogar.ts");
    const anonEmail = anonEmailForToken("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(anonEmail)}&edition=260531&choice=A&brand=web`),
      env,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /id="jogar-share-card"/);
    assert.doesNotMatch(html, /id="jogar-quiz-share-card"/);
  });
});
