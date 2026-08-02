/**
 * test/poll-jogar-seq-state-aggregate-4443.test.ts (#4443)
 *
 * `GET /jogar/seq-state` (jogar.ts) fazia até 1-2 gets de KV POR EDIÇÃO
 * (`vote:{edition}:{identity}`) — mês inteiro (31 pares) × até 2 identidades
 * = até 62 gets numa única chamada. O #4443 introduz um agregado MENSAL,
 * `seq:{month}:{identity}` (mapa `edição -> gabarito`, mantido pelo Durable
 * Object `ScoreCounter` no mesmo bookkeeping serializado que já grava
 * `score-by-month`, #4169), reduzindo o caminho comum pra ≤4 gets.
 *
 * Cobertura:
 * 1. `seqStateKvKey` — formato + branding (chave crua, branding aplicado
 *    pelo NAMESPACE, nunca pela string — #3600/#4035).
 * 2. `ScoreCounter` DO — `/update-month` mantém `seq:{monthSlug}` na MESMA
 *    transação serializada (sem perda sob concorrência, mesma classe do
 *    #4169) + `seqKvBaseline` seed.
 * 3. `ScoreCounter` DO — `/adjust-month-correct` propaga a correção de
 *    gabarito pra dentro do agregado quando a edição já é conhecida.
 * 4. `handleJogarSeqState` — caminho rápido (agregado presente): ≤4 gets,
 *    contrato de resposta idêntico (ordem, anti-spoiler), merge de 2
 *    identidades, resiliência a agregado corrompido.
 * 5. `handleJogarSeqState` — fallback (agregado ausente): mesmo resultado do
 *    desenho anterior ao #4443.
 * 6. Self-heal: após o fallback, a PRÓXIMA chamada custa ≤4 gets.
 * 7. Fim-a-fim via `handleVote`: um voto real popula o agregado, e dois
 *    votos concorrentes do MESMO email em edições diferentes não perdem
 *    escrita (mesma classe de regressão do #4169, agora sobre o agregado).
 * 8. REGRESSÃO (achado #1 do self-review, corrigida a pedido do coordenador
 *    da rodada overnight antes do merge): uma entry SELF-HEALED (criada por
 *    `handleJogarSeqState` sem NUNCA passar pelo DO pra aquele mês) precisa
 *    ser corrigida por `adjustScoreByMonthCorrectOnly` via um caminho
 *    KV-DIRETO — a versão anterior só corrigia via DO, e uma entry
 *    self-healed nunca tem o DO rastreando aquela edição.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  handleJogarSeqState,
  parseSeqMonthAggregate,
  SEQ_STATE_SUBREQUEST_BUDGET,
} from "../workers/poll/src/jogar.ts";
import { seqStateKvKey, brandKvPrefix } from "../workers/poll/src/lib.ts";
import { handleVote, adjustScoreByMonthCorrectOnly } from "../workers/poll/src/vote.ts";
import worker, { brandedNamespace, type Env } from "../workers/poll/src/index.ts";
import {
  ScoreCounter,
  type MonthScoreData,
  type SeqMonthMap,
  type UpdateMonthPayload,
  type AdjustMonthCorrectPayload,
} from "../workers/poll/src/score-counter.ts";
import { issueWebSessionCookie } from "../workers/poll/src/web-gate.ts";
import { makeMockDoState } from "./_helpers/make-mock-do-state.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

// ── Helpers compartilhados (mesmo padrão de test/poll-seqstate-postgate-identity-4115-4116.test.ts) ──

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

const COOKIE_SECRET = "cookie-secret-4443";
const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301@web.eia.diaria.local";
const REAL_EMAIL = "leitor-4443@example.com";

function makeEnv(seed: Record<string, string> = {}): Env {
  return {
    POLL: makeMapKV(seed),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
    COOKIE_HMAC_SECRET: COOKIE_SECRET,
  } as unknown as Env;
}

function countingEnv(seed: Record<string, string> = {}) {
  let gets = 0;
  const kv = makeMapKV(seed);
  const origGet = kv.get.bind(kv);
  kv.get = async (key: string) => {
    gets += 1;
    return origGet(key);
  };
  const env = {
    POLL: kv,
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
    COOKIE_HMAC_SECRET: COOKIE_SECRET,
  } as unknown as Env;
  return { env, kv, gets: () => gets };
}

async function seqState(env: Env, editions: string[], cookie?: string): Promise<Array<{ edition: string; voted: boolean; correct: boolean | null }>> {
  const url = `https://poll.test/jogar/seq-state?email=${encodeURIComponent(TOKEN)}&editions=${editions.join(",")}`;
  const res = await worker.fetch(
    new Request(url, cookie ? { headers: { Cookie: cookie } } : undefined),
    env,
  );
  assert.equal(res.status, 200);
  return res.json() as never;
}

const monthEditions = Array.from({ length: 31 }, (_, i) => `2606${String(i + 1).padStart(2, "0")}`);

// ── 1. seqStateKvKey — formato + branding ───────────────────────────────────

describe("seqStateKvKey (#4443)", () => {
  it("formato: seq:{month}:{identity}", () => {
    assert.equal(seqStateKvKey("2026-06", "a@b.com"), "seq:2026-06:a@b.com");
  });

  it("chave é CRUA (sem prefixo de brand embutido) — branding vem do namespace, não da string", () => {
    const key = seqStateKvKey("2026-06", REAL_EMAIL);
    assert.ok(!key.startsWith("web:"), "a própria função nunca deve embutir o prefixo do brand");
  });

  it("REGRESSÃO (#3600/#4035): usada através de um namespace branded, a chave crua no KV subjacente sai com o prefixo", async () => {
    const raw = makeMapKV();
    const branded = brandedNamespace(raw as unknown as KVNamespace, "web:");
    await branded.put(seqStateKvKey("2026-06", REAL_EMAIL), JSON.stringify({ "260601": true }));
    assert.ok(raw._map.has(`web:seq:2026-06:${REAL_EMAIL}`), "a chave crua no KV subjacente deve ter o prefixo do brand");
    assert.ok(!raw._map.has(seqStateKvKey("2026-06", REAL_EMAIL)), "a chave SEM prefixo nunca deve aparecer no KV subjacente");
  });
});

// ── 2. ScoreCounter DO — seq:{monthSlug} serializado (#4443) ────────────────

function makeScoreCounter(): ScoreCounter {
  return new ScoreCounter(makeMockDoState());
}

async function callUpdateMonth(counter: ScoreCounter, payload: UpdateMonthPayload): Promise<{ ok: boolean; month: MonthScoreData; seq: SeqMonthMap }> {
  const req = new Request("https://internal/update-month", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const resp = await counter.fetch(req);
  return await resp.json() as { ok: boolean; month: MonthScoreData; seq: SeqMonthMap };
}

async function callAdjustMonthCorrect(counter: ScoreCounter, payload: AdjustMonthCorrectPayload): Promise<{ ok: boolean; adjusted: boolean; month?: MonthScoreData; seq?: SeqMonthMap }> {
  const req = new Request("https://internal/adjust-month-correct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const resp = await counter.fetch(req);
  return await resp.json() as { ok: boolean; adjusted: boolean; month?: MonthScoreData; seq?: SeqMonthMap };
}

describe("ScoreCounter DO — agregado seq:{monthSlug} (#4443)", () => {
  it("1 update-month → seq = { [edition]: correct }", async () => {
    const counter = makeScoreCounter();
    const { seq } = await callUpdateMonth(counter, { edition: "260601", monthSlug: "2026-06", correct: true });
    assert.deepEqual(seq, { "260601": true });
  });

  it("2 updates (edições diferentes, mesmo mês) → seq acumula as duas, sem perder a 1ª", async () => {
    const counter = makeScoreCounter();
    await callUpdateMonth(counter, { edition: "260601", monthSlug: "2026-06", correct: true });
    const { seq } = await callUpdateMonth(counter, { edition: "260602", monthSlug: "2026-06", correct: false });
    assert.deepEqual(seq, { "260601": true, "260602": false });
  });

  it("correct:null (voto sem gabarito ainda conhecido) é preservado distintamente de 'não votado' — presença da chave é o sinal", async () => {
    const counter = makeScoreCounter();
    const { seq } = await callUpdateMonth(counter, { edition: "260601", monthSlug: "2026-06", correct: null });
    assert.ok(Object.hasOwn(seq, "260601"), "a chave deve existir mesmo com correct:null");
    assert.equal(seq["260601"], null);
  });

  it("REGRESSÃO (#4443, mesma classe do #4169): N updates CONCORRENTES (edições diferentes, mesmo mês/email) — seq não perde nenhuma escrita", async () => {
    const counter = makeScoreCounter();
    const N = 10;
    const updates = Array.from({ length: N }, (_, i) => ({
      edition: `26060${(i % 9) + 1}`,
      monthSlug: "2026-06",
      correct: (i % 3 !== 0) as boolean | null,
    }));
    await Promise.all(updates.map((u) => callUpdateMonth(counter, u)));

    // Probe neutro: uma edição fora do range acima, correct:null (não altera
    // as demais), só pra ler o estado consolidado.
    const { seq, month } = await callUpdateMonth(counter, { edition: "260699", monthSlug: "2026-06", correct: null });
    assert.equal(month.total, N + 1, `total mensal deve ser ${N + 1} (sem perda sob burst)`);
    const distinctEditions = new Set(updates.map((u) => u.edition));
    for (const ed of distinctEditions) {
      assert.ok(Object.hasOwn(seq, ed), `seq deve conter a edição ${ed} — updates concorrentes não podem perder escrita`);
    }
    assert.ok(Object.hasOwn(seq, "260699"), "o probe também deve estar presente");
  });

  it("meses distintos usam storage keys distintas pro agregado (sem cruzar)", async () => {
    const counter = makeScoreCounter();
    await callUpdateMonth(counter, { edition: "260601", monthSlug: "2026-06", correct: true });
    const { seq: seqJulho } = await callUpdateMonth(counter, { edition: "260701", monthSlug: "2026-07", correct: true });
    assert.deepEqual(seqJulho, { "260701": true }, "julho não deve herdar a entry de junho");
  });

  it("seqKvBaseline semeia o agregado quando o storage do DO pra este mês NUNCA foi tocado", async () => {
    const counter = makeScoreCounter();
    const seqKvBaseline: SeqMonthMap = { "260601": true, "260602": false };
    const { seq } = await callUpdateMonth(counter, { edition: "260603", monthSlug: "2026-06", correct: true, seqKvBaseline });
    assert.deepEqual(seq, { "260601": true, "260602": false, "260603": true });
  });

  it("seqKvBaseline NUNCA sobrescreve um agregado real já gravado no DO (mesmo racional de kvBaseline/MonthScoreData)", async () => {
    const counter = makeScoreCounter();
    await callUpdateMonth(counter, { edition: "260601", monthSlug: "2026-06", correct: true });
    const staleBaseline: SeqMonthMap = { "999999": true };
    const { seq } = await callUpdateMonth(counter, { edition: "260602", monthSlug: "2026-06", correct: true, seqKvBaseline: staleBaseline });
    assert.ok(!Object.hasOwn(seq, "999999"), "baseline stale não deve contaminar um agregado já real");
    assert.deepEqual(seq, { "260601": true, "260602": true });
  });

  it("seqKvBaseline malformado (shape inválido) é ignorado — cai no agregado vazio, nunca lança", async () => {
    const counter = makeScoreCounter();
    const { seq } = await callUpdateMonth(counter, {
      edition: "260601",
      monthSlug: "2026-06",
      correct: true,
      seqKvBaseline: { "260501": "not-a-boolean" } as unknown as SeqMonthMap,
    });
    assert.deepEqual(seq, { "260601": true });
  });
});

describe("ScoreCounter DO — adjust-month-correct propaga pro agregado (#4443)", () => {
  it("edition presente no agregado → seq[edition] é corrigido junto com month.correct", async () => {
    const counter = makeScoreCounter();
    await callUpdateMonth(counter, { edition: "260601", monthSlug: "2026-06", correct: false });
    const { adjusted, seq } = await callAdjustMonthCorrect(counter, {
      monthSlug: "2026-06", prevCorrect: false, newCorrect: true, edition: "260601",
    });
    assert.equal(adjusted, true);
    assert.deepEqual(seq, { "260601": true });
  });

  it("edition AUSENTE do payload (back-compat) → seq não é tocado (undefined na resposta), sem lançar", async () => {
    const counter = makeScoreCounter();
    await callUpdateMonth(counter, { edition: "260601", monthSlug: "2026-06", correct: false });
    const { adjusted, seq } = await callAdjustMonthCorrect(counter, {
      monthSlug: "2026-06", prevCorrect: false, newCorrect: true,
    });
    assert.equal(adjusted, true);
    assert.equal(seq, undefined, "sem `edition` no payload, o agregado não deve ser tocado nem retornado");
  });

  it("edition informada mas AUSENTE do agregado existente → não cria a entry (nunca inventa 'voted:true')", async () => {
    const counter = makeScoreCounter();
    await callUpdateMonth(counter, { edition: "260601", monthSlug: "2026-06", correct: false });
    const { seq } = await callAdjustMonthCorrect(counter, {
      monthSlug: "2026-06", prevCorrect: false, newCorrect: true, edition: "260602",
    });
    assert.equal(seq, undefined, "260602 nunca foi votado — o adjust não deve inventar uma entry pra ela");
  });

  it("DO nunca inicializado (mês nunca tocado) → adjusted:false, seq undefined", async () => {
    const counter = makeScoreCounter();
    const { adjusted, seq } = await callAdjustMonthCorrect(counter, {
      monthSlug: "2026-06", prevCorrect: false, newCorrect: true, edition: "260601",
    });
    assert.equal(adjusted, false);
    assert.equal(seq, undefined);
  });
});

// ── 3. handleJogarSeqState — caminho rápido (agregado presente) ────────────

describe("handleJogarSeqState — caminho rápido: agregado presente (#4443)", () => {
  it("REGRESSÃO CENTRAL: mês inteiro (31 edições) com agregado presente custa ≤4 gets", async () => {
    const seq: SeqMonthMap = {};
    for (const ed of monthEditions) seq[ed] = true;
    const { env, gets } = countingEnv({
      [`web:seq:2026-06:${REAL_EMAIL}`]: JSON.stringify(seq),
    });
    const cookie = (await issueWebSessionCookie(COOKIE_SECRET, REAL_EMAIL)).split(";")[0];
    const state = await seqState(env, monthEditions, cookie);

    assert.ok(gets() <= 4, `caminho rápido deve custar ≤4 gets — gastou ${gets()}`);
    assert.equal(state.length, monthEditions.length);
    assert.ok(state.every((e) => e.voted && e.correct === true));
  });

  it("contrato de resposta: mesma ORDEM das edições pedidas", async () => {
    const seq: SeqMonthMap = { "260601": true, "260603": false, "260602": null };
    const { env } = countingEnv({ [`web:seq:2026-06:${REAL_EMAIL}`]: JSON.stringify(seq) });
    const cookie = (await issueWebSessionCookie(COOKIE_SECRET, REAL_EMAIL)).split(";")[0];
    const state = await seqState(env, ["260603", "260601", "260602"], cookie);
    assert.deepEqual(state.map((e) => e.edition), ["260603", "260601", "260602"]);
  });

  it("anti-spoiler: correct:null no agregado (voto sem gabarito na hora) sai como voted:true, correct:null — nunca 'não votado'", async () => {
    const seq: SeqMonthMap = { "260601": null };
    const { env } = countingEnv({ [`web:seq:2026-06:${REAL_EMAIL}`]: JSON.stringify(seq) });
    const cookie = (await issueWebSessionCookie(COOKIE_SECRET, REAL_EMAIL)).split(";")[0];
    const state = await seqState(env, ["260601"], cookie);
    assert.deepEqual(state, [{ edition: "260601", voted: true, correct: null }]);
  });

  it("edição ausente do agregado → voted:false, correct:null", async () => {
    const seq: SeqMonthMap = { "260601": true };
    const { env } = countingEnv({ [`web:seq:2026-06:${REAL_EMAIL}`]: JSON.stringify(seq) });
    const cookie = (await issueWebSessionCookie(COOKIE_SECRET, REAL_EMAIL)).split(";")[0];
    const state = await seqState(env, ["260601", "260602"], cookie);
    assert.deepEqual(state, [
      { edition: "260601", voted: true, correct: true },
      { edition: "260602", voted: false, correct: null },
    ]);
  });

  it("merge de 2 identidades: primária resolve o que tem, secundária preenche o resto (rodada livre sob o token)", async () => {
    const { env } = countingEnv({
      [`web:seq:2026-06:${REAL_EMAIL}`]: JSON.stringify({ "260602": true }),
      [`web:seq:2026-06:${TOKEN}`]: JSON.stringify({ "260601": false }),
    });
    const cookie = (await issueWebSessionCookie(COOKIE_SECRET, REAL_EMAIL)).split(";")[0];
    const state = await seqState(env, ["260601", "260602"], cookie);
    assert.deepEqual(state, [
      { edition: "260601", voted: true, correct: false },
      { edition: "260602", voted: true, correct: true },
    ]);
  });

  it("conflito entre identidades na MESMA edição — a primária (sessão) vence", async () => {
    const { env } = countingEnv({
      [`web:seq:2026-06:${REAL_EMAIL}`]: JSON.stringify({ "260601": true }),
      [`web:seq:2026-06:${TOKEN}`]: JSON.stringify({ "260601": false }),
    });
    const cookie = (await issueWebSessionCookie(COOKIE_SECRET, REAL_EMAIL)).split(";")[0];
    const state = await seqState(env, ["260601"], cookie);
    assert.deepEqual(state, [{ edition: "260601", voted: true, correct: true }]);
  });

  it("agregado CORROMPIDO (JSON ilegível) não derruba o endpoint — cai no fallback em vez de 'não votado' em massa", async () => {
    const env = makeEnv({
      [`web:seq:2026-06:${TOKEN}`]: "isto não é json",
      [`web:vote:260601:${TOKEN}`]: JSON.stringify({ choice: "A", correct: true }),
    });
    const state = await seqState(env, ["260601"]);
    assert.deepEqual(state, [{ edition: "260601", voted: true, correct: true }], "deve recuperar via fallback, não reportar falso 'não votado'");
  });

  it("agregado com 1 ENTRADA de shape inválido — só ELA degrada, o resto do mapa sobrevive", () => {
    const parsed = parseSeqMonthAggregate(JSON.stringify({ "260601": true, "260602": "banana" }));
    assert.ok(parsed !== null);
    assert.equal(parsed!["260601"], true);
    assert.ok(!Object.hasOwn(parsed!, "260602"), "valor de shape inválido deve ser descartado, não propagado");
  });

  it("parseSeqMonthAggregate: array ou não-objeto no top-level retorna null (corrupção total)", () => {
    assert.equal(parseSeqMonthAggregate("[1,2,3]"), null);
    assert.equal(parseSeqMonthAggregate("42"), null);
    assert.equal(parseSeqMonthAggregate("not json at all"), null);
  });
});

// ── 4. handleJogarSeqState — fallback (agregado ausente) ────────────────────

describe("handleJogarSeqState — fallback: agregado ausente (#4443)", () => {
  it("mês SEM agregado funciona e devolve o mesmo resultado do desenho por-edição", async () => {
    const env = makeEnv({
      [`web:vote:260601:${TOKEN}`]: JSON.stringify({ choice: "A", correct: true }),
      [`web:vote:260602:${TOKEN}`]: JSON.stringify({ choice: "B", correct: false }),
    });
    const state = await seqState(env, ["260601", "260602", "260603"]);
    assert.deepEqual(state, [
      { edition: "260601", voted: true, correct: true },
      { edition: "260602", voted: true, correct: false },
      { edition: "260603", voted: false, correct: null },
    ]);
  });

  it("orçamento total do fallback (1 get de agregado + fases por edição) cabe em SEQ_STATE_SUBREQUEST_BUDGET", async () => {
    const { env, gets } = countingEnv();
    const cookie = (await issueWebSessionCookie(COOKIE_SECRET, REAL_EMAIL)).split(";")[0];
    await seqState(env, monthEditions, cookie);
    assert.ok(gets() <= SEQ_STATE_SUBREQUEST_BUDGET, `orçamento estourado: ${gets()} > ${SEQ_STATE_SUBREQUEST_BUDGET}`);
  });
});

// ── 5. Self-heal ─────────────────────────────────────────────────────────────

describe("handleJogarSeqState — self-heal (#4443)", () => {
  it("após o fallback, o agregado fica gravado no KV (branded) pra cada identidade que teve voto encontrado", async () => {
    const { env, kv } = countingEnv({
      [`web:vote:260601:${TOKEN}`]: JSON.stringify({ choice: "A", correct: true }),
    });
    await seqState(env, ["260601"]);
    const healed = kv._map.get(`web:seq:2026-06:${TOKEN}`);
    assert.ok(healed, "o agregado deve ter sido gravado após o fallback");
    assert.deepEqual(JSON.parse(healed!), { "260601": true });
  });

  it("REGRESSÃO CENTRAL: após o self-heal, a chamada SEGUINTE (mesmo mês/identidade) custa ≤4 gets", async () => {
    const seed: Record<string, string> = {};
    for (const ed of monthEditions) {
      seed[`web:vote:${ed}:${TOKEN}`] = JSON.stringify({ choice: "A", correct: true });
    }
    const { env, gets } = countingEnv(seed);

    // 1ª chamada: fallback (agregado ainda não existe) — self-heal grava.
    const first = await seqState(env, monthEditions);
    assert.ok(first.every((e) => e.voted && e.correct === true));

    // 2ª chamada: deve cair no caminho rápido.
    const getsBeforeSecond = gets();
    const second = await seqState(env, monthEditions);
    const getsInSecondCall = gets() - getsBeforeSecond;

    assert.ok(getsInSecondCall <= 4, `2ª chamada (self-heal já aplicado) deve custar ≤4 gets — gastou ${getsInSecondCall}`);
    assert.deepEqual(second, first, "resposta idêntica antes/depois do self-heal");
  });

  it("self-heal separa corretamente por identidade (rodada livre sob token não vaza pro agregado do e-mail real)", async () => {
    const seed: Record<string, string> = {
      [`web:vote:260601:${TOKEN}`]: JSON.stringify({ choice: "A", correct: true }),
      [`web:vote:260602:${REAL_EMAIL}`]: JSON.stringify({ choice: "B", correct: false }),
    };
    const { env, kv } = countingEnv(seed);
    const cookie = (await issueWebSessionCookie(COOKIE_SECRET, REAL_EMAIL)).split(";")[0];
    await seqState(env, ["260601", "260602"], cookie);

    const tokenAgg = JSON.parse(kv._map.get(`web:seq:2026-06:${TOKEN}`) ?? "{}");
    const emailAgg = JSON.parse(kv._map.get(`web:seq:2026-06:${REAL_EMAIL}`) ?? "{}");
    assert.deepEqual(tokenAgg, { "260601": true }, "voto sob o token deve virar agregado do TOKEN, não do e-mail real");
    assert.deepEqual(emailAgg, { "260602": false }, "voto sob o e-mail real deve virar agregado do e-mail real, não do token");
  });
});

// ── 6. Fim-a-fim via handleVote ──────────────────────────────────────────────

function makeRealCtx(): { ctx: ExecutionContext; scheduled: Promise<unknown>[] } {
  const scheduled: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) { scheduled.push(p); },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { ctx, scheduled };
}

async function flush(scheduled: Promise<unknown>[]): Promise<void> {
  await Promise.all(scheduled);
}

const voteUrl = (email: string, edition: string, choice: string, brand?: string): URL => {
  const u = new URL("https://poll.test/vote");
  u.searchParams.set("email", email);
  u.searchParams.set("edition", edition);
  u.searchParams.set("choice", choice);
  if (brand) u.searchParams.set("brand", brand);
  return u;
};

function makeScoreCounterNs(): { ns: DurableObjectNamespace } {
  const instances = new Map<string, ScoreCounter>();
  const ns: DurableObjectNamespace = {
    idFromName: (name: string): DurableObjectId => ({ name, toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId): DurableObjectStub => {
      const name = id.toString();
      if (!instances.has(name)) instances.set(name, new ScoreCounter(makeMockDoState()));
      const inst = instances.get(name)!;
      return { fetch: (url: RequestInfo, init?: RequestInit) => inst.fetch(new Request(url as string, init)) } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return { ns };
}

describe("Fim-a-fim: handleVote popula o agregado seq:{month}:{email} (#4443)", () => {
  it("1 voto real (brand diaria) grava seq:{month}:{email} no KV — chave BRANDED (sem prefixo pra diaria, que é o brand default sem prefixo)", async () => {
    const email = "e2e-seq-4443@x.com";
    const kv = makeTrackedKv({ "correct:260601": "A" });
    const { ns: scoreNs } = makeScoreCounterNs();
    const env: Env = { POLL: kv as unknown as KVNamespace, SCORE_COUNTER: scoreNs, POLL_SECRET: "s", ADMIN_SECRET: "a", ALLOWED_ORIGINS: "*" };

    const req = makeRealCtx();
    await handleVote(voteUrl(email, "260601", "A"), env, "diaria", env, req.ctx);
    await flush(req.scheduled);

    const seqRaw = await kv.get(`seq:2026-06:${email}`);
    assert.ok(seqRaw, "o agregado deve ter sido gravado no KV após o voto");
    assert.deepEqual(JSON.parse(seqRaw!), { "260601": true });
  });

  it("1 voto real (brand clarice, via worker.fetch — mesmo wiring de produção) grava a chave BRANDED clarice:seq:{month}:{email}", async () => {
    // #1905: o wrapping `bEnv = brandedEnv(env, brand)` acontece no ROUTER
    // (`fetch()`, index.ts) ANTES de chamar `handleVote` — chamar `handleVote`
    // direto com o mesmo `env` cru nos dois slots (como as demais unidades
    // deste arquivo fazem) NUNCA exercitaria o branding real pra um brand
    // não-default. Por isso este teste específico passa por `worker.fetch`
    // (dispatch completo, `?brand=clarice` incluso), igual a uma request real.
    const email = "e2e-seq-clarice-4443@x.com";
    // Ciclo Clarice YYMM-MM (#2115): "2606-07" = conteúdo de junho/2026,
    // enviado em julho → editionToMonthSlug resolve pro mês de CONTEÚDO,
    // "2026-06".
    const kv = makeTrackedKv({ "correct:2606-07": "A" });
    const { ns: scoreNs } = makeScoreCounterNs();
    const env: Env = { POLL: kv as unknown as KVNamespace, SCORE_COUNTER: scoreNs, POLL_SECRET: "s", ADMIN_SECRET: "a", ALLOWED_ORIGINS: "*" };

    const url = voteUrl(email, "2606-07", "A", "clarice");
    const req = makeRealCtx();
    const res = await worker.fetch(new Request(url.toString()), env, req.ctx);
    assert.equal(res.status, 200);
    await flush(req.scheduled);

    // #1905: brandedEnv prefixa TODA chave escrita por runVoteBookkeeping —
    // a chave crua NUNCA deve aparecer sem o prefixo do brand.
    assert.equal(await kv.get(`seq:2026-06:${email}`), null, "a chave SEM prefixo não deve existir");
    const seqRaw = await kv.get(`clarice:seq:2026-06:${email}`);
    assert.ok(seqRaw, "a chave BRANDED (clarice:) deve existir");
    assert.deepEqual(JSON.parse(seqRaw!), { "2606-07": true });
  });

  it("REGRESSÃO (#4443, mesma classe do #4169): 2 votos concorrentes do MESMO email em edições diferentes não perdem escrita no agregado", async () => {
    const email = "e2e-seq-concurrent-4443@x.com";
    const kv = makeTrackedKv({ "correct:260601": "A", "correct:260602": "A" });
    const { ns: scoreNs } = makeScoreCounterNs();
    const env: Env = { POLL: kv as unknown as KVNamespace, SCORE_COUNTER: scoreNs, POLL_SECRET: "s", ADMIN_SECRET: "a", ALLOWED_ORIGINS: "*" };

    const reqA = makeRealCtx();
    const reqB = makeRealCtx();
    await Promise.all([
      handleVote(voteUrl(email, "260601", "A"), env, "diaria", env, reqA.ctx),
      handleVote(voteUrl(email, "260602", "A"), env, "diaria", env, reqB.ctx),
    ]);
    await flush([...reqA.scheduled, ...reqB.scheduled]);

    const seqRaw = await kv.get(`seq:2026-06:${email}`);
    assert.ok(seqRaw, "o agregado deve existir");
    const seq = JSON.parse(seqRaw!);
    assert.deepEqual(seq, { "260601": true, "260602": true }, "AMBOS os votos devem sobreviver no agregado — nenhum pode sumir por causa da concorrência");
  });

  it("handleAdminCorrect (via adjustScoreByMonthCorrectOnly) propaga a correção de gabarito pro agregado", async () => {
    const email = "e2e-seq-admin-correct-4443@x.com";
    const kv = makeTrackedKv({ "correct:260601": "A" });
    const { ns: scoreNs } = makeScoreCounterNs();
    const env: Env = { POLL: kv as unknown as KVNamespace, SCORE_COUNTER: scoreNs, POLL_SECRET: "s", ADMIN_SECRET: "a", ALLOWED_ORIGINS: "*" };

    const req = makeRealCtx();
    await handleVote(voteUrl(email, "260601", "B"), env, "diaria", env, req.ctx); // errou (gabarito A)
    await flush(req.scheduled);

    let seq = JSON.parse((await kv.get(`seq:2026-06:${email}`))!);
    assert.equal(seq["260601"], false, "sanity: voto B contra gabarito A → correct:false no agregado");

    // Editor corrige o gabarito pra B — o voto (B) agora vira correto.
    await adjustScoreByMonthCorrectOnly(env, email, "260601", false, true, "diaria");

    seq = JSON.parse((await kv.get(`seq:2026-06:${email}`))!);
    assert.equal(seq["260601"], true, "REGRESSÃO: o agregado deve refletir a correção de gabarito, não ficar stale");
  });

  it("REGRESSÃO (achado #1 do self-review, exigida pelo coordenador): entry SELF-HEALED (DO nunca tocado pro mês) É corrigida por adjustScoreByMonthCorrectOnly via caminho KV-direto", async () => {
    // Cenário exato: um voto ANTERIOR ao deploy do #4443 já tinha
    // score-by-month:{month}:{identity} gravado (aqui simulado via seed
    // direto — nenhum /update-month passou pelo DO pra este mês/identidade).
    // Depois do deploy, o jogador visita /jogar e handleJogarSeqState
    // (agregado ausente) cai no fallback e SELF-HEALA seq:{month}:{identity}
    // DIRETO no KV — sem nunca tocar o DO. Só ENTÃO o editor corrige o
    // gabarito. Antes do fix, essa entry self-healed nunca era corrigida (o
    // sync via DO em adjustScoreByMonthCorrectOnly só age quando o DO já
    // rastreia a edição — não é o caso aqui).
    const identity = TOKEN;
    const monthSlug = "2026-06";
    const webPrefix = brandKvPrefix("web");
    const seed: Record<string, string> = {
      // Vote original: escolheu B, gabarito era A → correct:false.
      [`${webPrefix}vote:260601:${identity}`]: JSON.stringify({ choice: "B", correct: false }),
      // score-by-month PRÉ-EXISTENTE (simula um voto de antes do #4443 — o DO
      // nunca processou este mês/identidade, só o KV tem o registro).
      [`${webPrefix}score-by-month:${monthSlug}:${identity}`]: JSON.stringify({
        total: 1, correct: 0, last_edition: "260601", nickname: null,
      }),
    };
    const { env, kv } = countingEnv(seed);
    const { ns: scoreNs } = makeScoreCounterNs(); // presente, mas NUNCA tocado pra este mês/identidade

    // 1. Self-heal via handleJogarSeqState (fallback: agregado ausente) —
    //    grava web:seq:2026-06:{TOKEN} DIRETO no KV, sem tocar o DO.
    const beforeCorrect = await seqState(env, ["260601"]);
    assert.deepEqual(beforeCorrect, [{ edition: "260601", voted: true, correct: false }], "sanity: self-heal resolveu o voto original (errado)");

    // sanity: o self-heal realmente não tocou o DO — o mesmo DO id usado por
    // adjustScoreByMonthCorrectOnly abaixo (web:{identity}) nunca foi
    // inicializado (nenhuma chamada a /update-month aconteceu).
    const doId = scoreNs.idFromName(`web:${identity}`);
    const doStub = scoreNs.get(doId);
    const probeResp = await doStub.fetch(new Request("https://internal/adjust-month-correct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monthSlug, prevCorrect: false, newCorrect: true, edition: "260601" } satisfies AdjustMonthCorrectPayload),
    }));
    const probeBody = await probeResp.json() as { adjusted: boolean; seq?: SeqMonthMap };
    assert.equal(probeBody.adjusted, false, "sanity: o DO não tem este mês rastreado — adjust é no-op nele");
    assert.equal(probeBody.seq, undefined, "sanity: sem month: no DO, ele nem chega a olhar pro seq — confirma que o DO não pode ser quem corrige aqui");

    // 2. Editor corrige o gabarito (A → B): o voto B agora vira correto.
    //    `env.POLL` (countingEnv) é CRU — precisa embrulhar com o prefixo do
    //    brand aqui, mesmo padrão de `bEnv = brandedEnv(env, brand)` que o
    //    ROUTER (index.ts) monta antes de chamar esta função em produção.
    const bEnv = { ...env, POLL: brandedNamespace(kv as unknown as KVNamespace, webPrefix), SCORE_COUNTER: scoreNs } as unknown as Env;
    await adjustScoreByMonthCorrectOnly(bEnv, identity, "260601", false, true, "web");

    // 3. REGRESSÃO CENTRAL: o agregado self-healed deve refletir a correção,
    //    mesmo o DO nunca tendo rastreado esta edição.
    const seqRaw = kv._map.get(`${webPrefix}seq:${monthSlug}:${identity}`);
    assert.ok(seqRaw, "o agregado self-healed deve continuar existindo");
    const seq = JSON.parse(seqRaw!);
    assert.equal(seq["260601"], true, "REGRESSÃO: entry self-healed deve ser corrigida via caminho KV-direto, não só via DO");
  });
});
