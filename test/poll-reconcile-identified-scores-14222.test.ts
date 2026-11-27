/**
 * #14222: reconciliação dos scores do É IA? inflados pelo re-sync de
 * `/jogar/identify`. Lógica pura com KV em memória (chaves sem o prefixo
 * `web:`) e o `--apply` com dependências injetadas; nada fala com a Cloudflare.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reconcileIdentifiedScores,
  selectKeysToRead,
  planHash,
  redactReport,
  isAnonymousWebIdentity,
  editionToMonthSlug,
  identifyMigratedKey,
  type ReconcileReport,
} from "../scripts/lib/poll-reconcile-identified-scores.ts";
import { main, applyPlan, parseArgs, BRAND_PREFIX, type ReconcileDeps } from "../scripts/poll-reconcile-identified-scores.ts";
import * as worker from "../workers/poll/src/lib.ts";
import { identifyMigratedKey as workerMigratedKey, performIdentifyMerge } from "../workers/poll/src/identify.ts";

const A1 = "11111111-1111-4111-8111-111111111111@web.eia.diaria.local";
const A2 = "22222222-2222-4222-8222-222222222222@web.eia.diaria.local";
const LOOSE = "33333333-3333-4333-8333-333333333333@web.eia.diaria.local";
const E = "leitor@example.com";

const s = (total: number, correct: number, extra: Record<string, unknown> = {}) => JSON.stringify({ total, correct, ...extra });
const vote = (correct: boolean | null) => JSON.stringify({ choice: "A", ts: "t", correct });
const kv = (entries: Record<string, string>) => new Map(Object.entries(entries));
const line = (r: ReconcileReport, email = E) => r.emails.find((e) => e.email === email)!;

/** Aplica as escritas planejadas num KV em memória (o que o --apply faz). */
function applyWrites(store: Map<string, string>, r: ReconcileReport): Map<string, string> {
  const out = new Map(store);
  for (const w of r.writes) out.set(w.key, w.new);
  return out;
}

/** Roda o `performIdentifyMerge` REAL do Worker (sync silencioso) sobre o KV em memória. */
async function workerSync(store: Map<string, string>, email: string, anonEmail: string, edition: string | null): Promise<void> {
  const POLL = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  };
  await performIdentifyMerge({ POLL } as never, { email, anonEmail, name: "", edition });
}

const total = (store: Map<string, string>, key: string) => JSON.parse(store.get(key)!).total as number;

test("paridade com o Worker: identidade anônima, mês da edição e chave do marcador", () => {
  for (const id of ["a@web.eia.diaria.local", "A@WEB.EIA.DIARIA.LOCAL", "x@example.com", "semarroba", "b@vote.eia.diaria.local"]) {
    assert.equal(isAnonymousWebIdentity(id), worker.isAnonymousWebIdentity(id), id);
  }
  for (const ed of ["261127", "260001", "261399", "2605-06", "2613-01", "abc", "26112"]) {
    assert.equal(editionToMonthSlug(ed), worker.editionToMonthSlug(ed), ed);
  }
  assert.equal(identifyMigratedKey(E, A1), workerMigratedKey(E, A1));
  assert.equal(identifyMigratedKey(E, A1, "2026-11"), workerMigratedKey(E, A1, "2026-11"));
});

test("par sem marcador: anônimo somado 4 vezes (1+2+3+4) volta a 4 e ganha o marcador", () => {
  const r = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(10, 6, { streak: 3, last_edition: "261120", nickname: "Ana" }),
    [`score:${A1}`]: s(4, 2),
    [`identify-linked:${E}:${A1}`]: "1",
  }));
  assert.equal(line(r).status, "inflado");
  assert.deepEqual(line(r).expected, { total: 4, correct: 2 });
  assert.equal(line(r).diffTotal, 6);
  const w = r.writes.find((x) => x.key === `score:${E}`)!;
  assert.deepEqual(JSON.parse(w.new), { total: 4, correct: 2, streak: 3, last_edition: "261120", nickname: "Ana" });
  const m = r.writes.find((x) => x.key === `identify-migrated:${E}:${A1}`)!;
  assert.equal(m.old, null);
  assert.deepEqual(JSON.parse(m.new), { total: 4, correct: 2 });
  // Ordem por e-mail: marcador antes do score.
  assert.ok(r.writes.indexOf(m) < r.writes.indexOf(w));
});

test("score e marcador certos: status ok, nada a gravar", () => {
  const r = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(4, 2), [`score:${A1}`]: s(4, 2),
    [`identify-linked:${E}:${A1}`]: "1", [`identify-migrated:${E}:${A1}`]: s(4, 2),
  }));
  assert.equal(line(r).status, "ok");
  assert.equal(r.writes.length, 0);
});

test("score certo e só o marcador faltando: status so-marcadores", () => {
  const r = reconcileIdentifiedScores(kv({ [`score:${E}`]: s(4, 2), [`score:${A1}`]: s(4, 2), [`identify-linked:${E}:${A1}`]: "1" }));
  assert.equal(line(r).status, "so-marcadores");
  assert.deepEqual(r.writes.map((w) => w.kind), ["identify-migrated"]);
});

test("e-mail reduzido com marcador diferente do anônimo: marcador regravado", () => {
  const r = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(8, 4), [`score:${A1}`]: s(4, 2),
    [`identify-linked:${E}:${A1}`]: "1", [`identify-migrated:${E}:${A1}`]: s(3, 1),
  }));
  assert.deepEqual(line(r).expected, { total: 4, correct: 2 });
  const m = r.writes.find((x) => x.kind === "identify-migrated")!;
  assert.equal(m.old, s(3, 1));
  assert.deepEqual(JSON.parse(m.new), { total: 4, correct: 2 });
});

test("e-mail NÃO reduzido com marcador existente diferente: não sobrescreve, lista o conflito", () => {
  const r = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(4, 2), [`score:${A1}`]: s(4, 2),
    [`identify-linked:${E}:${A1}`]: "1", [`identify-migrated:${E}:${A1}`]: s(3, 1),
  }));
  assert.equal(r.writes.length, 0);
  assert.deepEqual(line(r).markerConflicts, [`identify-migrated:${E}:${A1}`]);
  assert.equal(r.totals.markerConflicts, 1);
});

test("abaixo do reconstruído com um anônimo: e-mail 2, anônimo 5 ⇒ marcador 2, e o sync real do Worker soma 3 e chega a 5", async () => {
  const store = kv({ [`score:${E}`]: s(2, 1), [`score:${A1}`]: s(5, 3), [`identify-linked:${E}:${A1}`]: "1" });
  const r = reconcileIdentifiedScores(store);
  assert.equal(line(r).status, "abaixo-do-reconstruido");
  assert.ok(!r.writes.some((w) => w.kind === "score"), "nunca sobe o score");
  const m = r.writes.find((w) => w.kind === "identify-migrated")!;
  assert.deepEqual(JSON.parse(m.new), { total: 2, correct: 1 });
  const after = applyWrites(store, r);
  await workerSync(after, E, A1, null);
  assert.deepEqual(JSON.parse(after.get(`score:${E}`)!), { total: 5, correct: 3, streak: 0, last_edition: null, nickname: null });
});

test("abaixo do reconstruído com vários anônimos: divisão ambígua, nenhum marcador, existente fica", () => {
  const r = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(3, 1), [`score:${A1}`]: s(4, 2), [`score:${A2}`]: s(3, 3),
    [`identify-linked:${E}:${A1}`]: "1", [`identify-linked:${E}:${A2}`]: "1",
    [`identify-migrated:${E}:${A1}`]: s(1, 0),
  }));
  assert.equal(r.writes.length, 0);
  assert.deepEqual(line(r).ambiguousMarkers.sort(), [identifyMigratedKey(E, A1), identifyMigratedKey(E, A2)].sort());
});

test("min() campo a campo: total reduz e correct abaixo ⇒ misto", () => {
  const r = reconcileIdentifiedScores(kv({ [`score:${E}`]: s(10, 2), [`score:${A1}`]: s(4, 3), [`identify-linked:${E}:${A1}`]: "1" }));
  assert.equal(line(r).status, "misto");
  assert.deepEqual(line(r).expected, { total: 4, correct: 2 });
  // marcador = anônimo − (reconstruído − esperado) = {4−0, 3−1}
  assert.deepEqual(JSON.parse(r.writes.find((w) => w.kind === "identify-migrated")!.new), { total: 4, correct: 2 });
});

test("vários anônimos + votos diretos: cada anônimo uma vez; voto de anônimo solto não entra; purga do DO planejada", () => {
  const r = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(30, 20), [`score:${A1}`]: s(4, 2), [`score:${A2}`]: s(3, 3), [`score:${LOOSE}`]: s(9, 9),
    [`identify-linked:${E}:${A1}`]: "1", [`identify-linked:${E}:${A2}`]: "1",
    [`vote:261110:${E}`]: vote(true), [`vote:261111:${E}`]: vote(false), [`vote:261111:${A1}`]: vote(true),
  }));
  assert.equal(line(r).ownVotes, 2);
  assert.deepEqual(line(r).expected, { total: 9, correct: 6 });
  assert.ok(line(r).conferenciaManual);
  assert.deepEqual(r.doPurgeEmails, [E]);
  assert.equal(r.writes.filter((w) => w.kind === "identify-migrated").length, 2);
});

test("índice mensal: reduz por mês, marca só o mês migrado e invalida o snapshot", () => {
  const r = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(5, 3), [`score:${A1}`]: s(5, 3), [`identify-linked:${E}:${A1}`]: "1",
    [`score-by-month:2026-10:${A1}`]: s(2, 1), [`score-by-month:2026-11:${A1}`]: s(3, 2),
    [`score-by-month:2026-11:${E}`]: s(6, 4, { nickname: "Ana", last_vote_ts: "t" }),
  }));
  assert.equal(line(r).status, "inflado");
  assert.deepEqual(line(r).months.map((m) => [m.month, m.expected]), [["2026-11", { total: 3, correct: 2 }]]);
  assert.deepEqual(JSON.parse(r.writes.find((x) => x.key === `score-by-month:2026-11:${E}`)!.new), { total: 3, correct: 2, nickname: "Ana", last_vote_ts: "t" });
  assert.ok(r.writes.some((x) => x.key === identifyMigratedKey(E, A1, "2026-11")));
  assert.ok(!r.writes.some((x) => x.key.startsWith("identify-migrated-month:2026-10")));
  assert.deepEqual(r.snapshotMonths, ["2026-11"]);
});

test("mês que o Worker não migrou daquele anônimo (entrada do e-mail = só votos diretos): sem marcador mensal", () => {
  const r = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(3, 2), [`score:${A1}`]: s(2, 1), [`identify-linked:${E}:${A1}`]: "1",
    [`score-by-month:2026-11:${A1}`]: s(2, 1), [`score-by-month:2026-11:${E}`]: s(1, 1),
    [`vote:261115:${E}`]: vote(true),
  }));
  assert.ok(!r.writes.some((w) => w.kind === "identify-migrated-month"));
});

test("mês só com voto direto: reduz ao número de votos diretos do mês", () => {
  const r = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(3, 2), [`score:${A1}`]: s(2, 1), [`identify-linked:${E}:${A1}`]: "1",
    [`score-by-month:2026-09:${E}`]: s(4, 3), [`vote:260915:${E}`]: vote(true),
  }));
  assert.deepEqual(line(r).months[0].expected, { total: 1, correct: 1 });
});

test("voto com edição sem mês válido conta no global e não no mensal", () => {
  const r = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(9, 9), [`score:${A1}`]: s(1, 1), [`identify-linked:${E}:${A1}`]: "1",
    [`score-by-month:2026-11:${E}`]: s(9, 9),
    [`vote:261315:${E}`]: vote(true), [`vote:261110:${E}`]: vote(false),
  }));
  assert.deepEqual(line(r).reconstructed, { total: 3, correct: 2 });
  assert.deepEqual(line(r).months[0].reconstructed, { total: 1, correct: 0 });
});

test("sem vínculo e sem voto direto: sem-fonte; sem vínculo com voto direto: so-votos-diretos, intocado e para conferência", () => {
  const r1 = reconcileIdentifiedScores(kv({ [`score:${E}`]: s(12, 7) }));
  assert.equal(line(r1).status, "sem-fonte");
  assert.equal(r1.writes.length, 0);
  const r2 = reconcileIdentifiedScores(kv({ [`score:${E}`]: s(12, 7), [`vote:261110:${E}`]: vote(true) }));
  assert.equal(line(r2).status, "so-votos-diretos");
  assert.ok(line(r2).conferenciaManual);
  assert.equal(r2.writes.length, 0);
  assert.equal(r2.doPurgeEmails.length, 0);
});

const INFLATED = { [`score:${E}`]: s(10, 6), [`score:${A1}`]: s(4, 2), [`identify-linked:${E}:${A1}`]: "1" };
for (const [nome, extra, opts, reason] of [
  ["anônimo vinculado sem score:{anon}", { [`score:${A1}`]: undefined }, {}, "score-anonimo-ausente"],
  ["chave listada que não voltou na leitura", {}, { listedKeys: [`score-by-month:2026-11:${A1}`] }, "ausente"],
  ["JSON ilegível no score do e-mail", { [`score:${E}`]: "{nope" }, {}, "json-ilegivel"],
  ["contador negativo", { [`score:${A1}`]: s(-1, 0) }, {}, "contador-invalido"],
  ["contador não inteiro", { [`score:${A1}`]: s(4.5, 2) }, {}, "contador-invalido"],
  ["contador não numérico", { [`score:${A1}`]: JSON.stringify({ total: "4", correct: 2 }) }, {}, "contador-invalido"],
  ["score-by-month ilegível", { [`score-by-month:2026-11:${E}`]: "[]" }, {}, "json-ilegivel"],
  ["voto ilegível", { [`vote:261110:${E}`]: "x" }, {}, "json-ilegivel"],
  ["marcador ilegível", { [`identify-migrated:${E}:${A1}`]: "x" }, {}, "json-ilegivel"],
  ["sufixo de identify-linked que não é anônimo", { [`identify-linked:${E}:outro@example.com`]: "1" }, {}, "identidade-invalida"],
  ["marcador de par sem identify-linked", { [`identify-migrated:${E}:${A2}`]: s(1, 1) }, {}, "vinculo-ausente"],
  ["marcador mensal de par sem identify-linked", { [`identify-migrated-month:2026-11:${E}:${A2}`]: s(1, 1) }, {}, "vinculo-ausente"],
  ["correct do voto fora de true/false/null", { [`vote:261110:${E}`]: JSON.stringify({ choice: "A", ts: "t", correct: "sim" }) }, {}, "contador-invalido"],
] as const) {
  test(`fonte incompleta nunca reduz: ${nome}`, () => {
    const entries: Record<string, string> = { ...INFLATED };
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete entries[k];
      else entries[k] = v;
    }
    const r = reconcileIdentifiedScores(kv(entries), opts);
    assert.equal(line(r).status, "fonte-ilegivel");
    assert.equal(r.writes.length, 0, "nem score nem marcador");
    assert.ok(r.unreadableKeys.some((u) => u.reason === reason), JSON.stringify(r.unreadableKeys));
    assert.equal(redactReport(r).unreadableByReason[reason], r.unreadableKeys.filter((u) => u.reason === reason).length);
  });
}

test("idempotência: aplicar o plano e reconciliar de novo dá 0 escritas, e o sync real do Worker soma 0", async () => {
  const store = kv({
    ...INFLATED,
    [`score-by-month:2026-11:${A1}`]: s(4, 2), [`score-by-month:2026-11:${E}`]: s(10, 6),
  });
  const r = reconcileIdentifiedScores(store);
  assert.ok(r.writes.length > 0);
  const after = applyWrites(store, r);
  assert.equal(reconcileIdentifiedScores(after).writes.length, 0);
  await workerSync(after, E, A1, "261120");
  assert.equal(total(after, `score:${E}`), 4);
  assert.equal(total(after, `score-by-month:2026-11:${E}`), 4);
});

test("selectKeysToRead lê só anônimos vinculados e votos de e-mails reais", () => {
  const names = [
    `score:${E}`, `score:${A1}`, `score:${LOOSE}`, `identify-linked:${E}:${A1}`,
    `score-by-month:2026-11:${A1}`, `score-by-month:2026-11:${LOOSE}`,
    `vote:261111:${E}`, `vote:261111:${A1}`, `identify-migrated:${E}:${A1}`,
  ];
  assert.deepEqual(new Set(selectKeysToRead(names)), new Set([
    `score:${E}`, `score:${A1}`, `identify-linked:${E}:${A1}`,
    `score-by-month:2026-11:${A1}`, `vote:261111:${E}`, `identify-migrated:${E}:${A1}`,
  ]));
});

test("hash do plano: 16 hex, muda quando o KV muda e independe da ordem", () => {
  const h1 = reconcileIdentifiedScores(kv(INFLATED)).hash;
  assert.match(h1, /^[0-9a-f]{16}$/);
  assert.notEqual(h1, reconcileIdentifiedScores(kv({ ...INFLATED, [`score:${A1}`]: s(5, 2) })).hash);
  assert.equal(planHash([...reconcileIdentifiedScores(kv(INFLATED)).writes].reverse()), h1);
});

test("redactReport não carrega e-mails", () => {
  const txt = JSON.stringify(redactReport(reconcileIdentifiedScores(kv(INFLATED))));
  assert.ok(!txt.includes("example.com"));
  assert.ok(!txt.includes("web.eia.diaria.local"));
});

// ── CLI (`main`/`applyPlan`) com dependências injetadas ──

interface Harness {
  deps: ReconcileDeps;
  store: Map<string, string>; // chaves COM prefixo web:
  events: string[];
  files: Map<string, string>;
  logs: string[];
}

/** Uma chave por família obrigatória (anônimo solto: nunca lido, não muda o plano). */
const FAMILY_FILLER = {
  [`score:${LOOSE}`]: s(1, 1),
  [`score-by-month:2026-11:${LOOSE}`]: s(1, 1),
  [`vote:261101:${LOOSE}`]: vote(true),
  [`identify-linked:outra@example.com:${LOOSE}`]: "1",
};

function harness(entries: Record<string, string>, over: Partial<ReconcileDeps> = {}, env: Record<string, string> = { ADMIN_SECRET: "x" }, filler = true): Harness {
  const store = new Map(Object.entries({ ...(filler ? FAMILY_FILLER : {}), ...entries }).map(([k, v]) => [BRAND_PREFIX + k, v]));
  const events: string[] = [];
  const files = new Map<string, string>();
  const logs: string[] = [];
  const deps: ReconcileDeps = {
    ops: {
      list: async (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)),
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => {
        events.push(`put ${k}`);
        store.set(k, v);
      },
      delete: async (k) => {
        events.push(`delete ${k}`);
        store.delete(k);
      },
    },
    bulkGet: async (keys) => new Map(keys.map((k) => [k, store.get(k) ?? null])),
    purge: async (email) => {
      events.push(`purge ${email}`);
      return { ok: true, status: 200 };
    },
    fs: {
      mkdir: () => {},
      writeFile: (p, d) => {
        events.push(`write ${p}`);
        files.set(p, d);
      },
      readFile: (p) => {
        if (!files.has(p)) throw new Error(`ENOENT ${p}`);
        return files.get(p)!;
      },
    },
    env,
    sleep: async () => {},
    log: (l) => logs.push(l),
    out: () => {},
    now: () => new Date("2026-11-27T10:00:00Z"),
    ...over,
  };
  return { deps, store, events, files, logs };
}

const DIRECT = { ...INFLATED, [`vote:261110:${E}`]: vote(true) }; // 1 voto direto ⇒ purga do DO
const hashOf = (entries: Record<string, string>) => reconcileIdentifiedScores(kv(entries)).hash;
const BK = ["--backup-dir", "bk"];

test("parseArgs: flag desconhecida e flag de valor sem valor abortam com 2", async () => {
  assert.equal(parseArgs(["--foo"]).ok, false);
  assert.equal(parseArgs(["--out"]).ok, false);
  assert.equal(parseArgs(["--confirm-dry-run-hash", "--apply"]).ok, false);
  const h = harness(INFLATED);
  assert.equal(await main(["--bogus"], h.deps), 2);
  assert.equal(h.events.length, 0);
});

test("--apply sem --confirm-dry-run-hash: 2, sem ler nem gravar", async () => {
  let listed = 0;
  const h = harness(INFLATED);
  h.deps.ops.list = async () => (listed++, []);
  assert.equal(await main(["--apply"], h.deps), 2);
  assert.equal(listed, 0);
});

test("--apply com hash divergente: 1, nenhuma escrita, --out com mode honesto", async () => {
  const h = harness(INFLATED);
  assert.equal(await main(["--apply", "--confirm-dry-run-hash", "0000000000000000", "--out", "o.json", ...BK], h.deps), 1);
  assert.ok(!h.events.some((e) => e.startsWith("put") || e.startsWith("delete") || e.startsWith("purge")));
  const out = [...h.files.entries()].find(([p]) => p.endsWith("o.json"))![1];
  assert.equal(JSON.parse(out).mode, "apply-recusado-hash");
});

test("--apply com chave listada sem valor: plano abortado", async () => {
  const h = harness(INFLATED);
  h.deps.bulkGet = async (keys) => new Map(keys.map((k) => [k, k.endsWith(A1) && k.includes("score:") ? null : h.store.get(k) ?? null]));
  h.deps.ops.get = async (k) => (k === `${BRAND_PREFIX}score:${A1}` ? null : h.store.get(k) ?? null);
  const hash = reconcileIdentifiedScores(kv({ [`score:${E}`]: s(10, 6), [`identify-linked:${E}:${A1}`]: "1" }), { listedKeys: [`score:${A1}`] }).hash;
  assert.equal(await main(["--apply", "--confirm-dry-run-hash", hash, ...BK], h.deps), 1);
  assert.ok(!h.events.some((e) => e.startsWith("put")));
  assert.ok(h.logs.some((l) => l.includes("chave(s) listada(s) sem valor")));
});

test("--apply: backup gravado e relido antes do 1º put; ordem marcador → score → purga; verificação limpa ⇒ 0", async () => {
  const h = harness(DIRECT);
  const code = await main(["--apply", "--confirm-dry-run-hash", hashOf(DIRECT), ...BK], h.deps);
  assert.equal(code, 0, h.logs.join("\n"));
  const backupIdx = h.events.findIndex((e) => e.startsWith("write") && /\dZ\.json$/.test(e));
  const firstPut = h.events.findIndex((e) => e.startsWith("put"));
  assert.ok(backupIdx >= 0 && backupIdx < firstPut);
  const backup = JSON.parse([...h.files.entries()].find(([p]) => /poll-reconcile-14222-[\dT-]+Z\.json$/.test(p))![1]);
  assert.equal(backup.entries.length, reconcileIdentifiedScores(kv(DIRECT)).writes.length);
  const iMarker = h.events.indexOf(`put ${BRAND_PREFIX}identify-migrated:${E}:${A1}`);
  const iScore = h.events.indexOf(`put ${BRAND_PREFIX}score:${E}`);
  const iPurge = h.events.indexOf(`purge ${E}`);
  assert.ok(iMarker >= 0 && iMarker < iScore && iScore < iPurge, h.events.join("\n"));
  assert.equal(JSON.parse(h.store.get(`${BRAND_PREFIX}score:${E}`)!).total, 5);
});

test("--apply: backup falha ⇒ nenhum put", async () => {
  const h = harness(DIRECT);
  const orig = h.deps.fs.writeFile;
  h.deps.fs.writeFile = (p, d) => {
    if (/\dZ\.json$/.test(p)) throw new Error("disco cheio");
    orig(p, d);
  };
  assert.equal(await main(["--apply", "--confirm-dry-run-hash", hashOf(DIRECT), ...BK], h.deps), 1);
  assert.ok(!h.events.some((e) => e.startsWith("put")));
});

test("--apply sem ADMIN_SECRET com purga pendente: aborta antes do backup", async () => {
  const h = harness(DIRECT, {}, {});
  assert.equal(await main(["--apply", "--confirm-dry-run-hash", hashOf(DIRECT), ...BK], h.deps), 1);
  assert.ok(!h.events.some((e) => e.startsWith("write") || e.startsWith("put")));
});

test("--apply sem purga planejada não exige ADMIN_SECRET", async () => {
  const h = harness(INFLATED, {}, {});
  assert.equal(await main(["--apply", "--confirm-dry-run-hash", hashOf(INFLATED), ...BK], h.deps), 0, h.logs.join("\n"));
});

test("--apply: chave que mudou desde o dry-run é pulada e reportada (exit 1)", async () => {
  const h = harness(INFLATED);
  const r = reconcileIdentifiedScores(kv(INFLATED));
  h.store.set(`${BRAND_PREFIX}score:${E}`, s(11, 6)); // voto concorrente
  assert.equal(await applyPlan(r, h.deps, { backupDir: "bk" }), 1);
  assert.ok(!h.events.includes(`put ${BRAND_PREFIX}score:${E}`));
  assert.ok(h.logs.some((l) => l.includes("puladas por mudança concorrente")));
});

test("--apply: erro no meio ⇒ done/total + chave, snapshots invalidados e DO purgado de quem já teve score gravado", async () => {
  const entries = { ...DIRECT, [`score-by-month:2026-11:${E}`]: s(10, 6), [`score-by-month:2026-11:${A1}`]: s(4, 2) };
  const h = harness(entries);
  const origPut = h.deps.ops.put;
  h.deps.ops.put = async (k, v) => {
    if (k.includes("score-by-month")) throw new Error("HTTP 400 — boom");
    await origPut(k, v);
  };
  assert.equal(await main(["--apply", "--confirm-dry-run-hash", hashOf(entries), ...BK], h.deps), 1);
  assert.ok(h.logs.some((l) => /gravadas; falhou em score-by-month:2026-11:/.test(l)));
  assert.ok(h.events.includes(`purge ${E}`));
  assert.ok(h.events.includes(`delete ${BRAND_PREFIX}leaderboard-snapshot:2026-11`));
  const progress = JSON.parse([...h.files.entries()].find(([p]) => p.endsWith("-progress.json"))![1]);
  assert.equal(progress.failed.key, `score-by-month:2026-11:${E}`);
});

test("purga do DO que falha: retry, lista no backupDir (não no terminal) e retomada por --purge-do-from", async () => {
  let calls = 0;
  const h = harness(DIRECT, { purge: async () => (calls++, { ok: false, status: 503, error: "x" }) });
  assert.equal(await main(["--apply", "--confirm-dry-run-hash", hashOf(DIRECT), ...BK], h.deps), 1);
  assert.equal(calls, 4, "retry em 5xx");
  const [path, body] = [...h.files.entries()].find(([p]) => p.endsWith("-pending-do-purge.json"))!;
  assert.deepEqual(JSON.parse(body).emails, [E]);
  assert.ok(!h.logs.some((l) => l.includes(E)), "e-mail fora do terminal");
  h.deps.purge = async (email) => (h.events.push(`purge ${email}`), { ok: true, status: 200 });
  assert.equal(await main(["--purge-do-from", path], h.deps), 0);
  assert.ok(h.events.includes(`purge ${E}`));
});

// ── Volta final do review da #14319 ──

test("purga do DO só para quem vota direto E tem score/mensal no plano; e-mails da purga entram no hash", () => {
  const soMarcador = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(5, 3), [`score:${A1}`]: s(4, 2), [`identify-linked:${E}:${A1}`]: "1", [`vote:261110:${E}`]: vote(true),
  }));
  assert.equal(line(soMarcador).status, "so-marcadores");
  assert.deepEqual(soMarcador.doPurgeEmails, []);
  const soMensal = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(5, 3), [`score:${A1}`]: s(4, 2), [`identify-linked:${E}:${A1}`]: "1", [`vote:261110:${E}`]: vote(true),
    [`identify-migrated:${E}:${A1}`]: s(4, 2), [`score-by-month:2026-11:${E}`]: s(9, 3),
  }));
  assert.deepEqual(soMensal.writes.map((w) => w.kind), ["score-by-month"]);
  assert.deepEqual(soMensal.doPurgeEmails, [E]);
  assert.notEqual(planHash(soMensal.writes, []), planHash(soMensal.writes, [E]));
  assert.equal(soMensal.hash, planHash(soMensal.writes, [E]));
});

test("vários anônimos, e-mail reduzido (misto), sem marcador prévio: marcador = anônimo inteiro em cada um", () => {
  const r = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(20, 3), [`score:${A1}`]: s(4, 2), [`score:${A2}`]: s(3, 3),
    [`identify-linked:${E}:${A1}`]: "1", [`identify-linked:${E}:${A2}`]: "1",
  }));
  assert.equal(line(r).status, "misto");
  assert.deepEqual(line(r).expected, { total: 7, correct: 3 });
  assert.deepEqual(JSON.parse(r.writes.find((w) => w.key === identifyMigratedKey(E, A1))!.new), { total: 4, correct: 2 });
  assert.deepEqual(JSON.parse(r.writes.find((w) => w.key === identifyMigratedKey(E, A2))!.new), { total: 3, correct: 3 });
  assert.deepEqual(line(r).ambiguousMarkers, []);
  // Com marcador prévio num deles: ambíguo, nada de marcador.
  const r2 = reconcileIdentifiedScores(kv({
    [`score:${E}`]: s(20, 3), [`score:${A1}`]: s(4, 2), [`score:${A2}`]: s(3, 3),
    [`identify-linked:${E}:${A1}`]: "1", [`identify-linked:${E}:${A2}`]: "1", [`identify-migrated:${E}:${A1}`]: s(1, 1),
  }));
  assert.ok(!r2.writes.some((w) => w.kind === "identify-migrated"));
  assert.equal(line(r2).ambiguousMarkers.length, 2);
});

test("família obrigatória com 0 chaves: --apply recusado; dry-run reporta a contagem por família", async () => {
  const h = harness(INFLATED, {}, { ADMIN_SECRET: "x" }, false);
  assert.equal(await main(["--apply", "--confirm-dry-run-hash", hashOf(INFLATED), "--out", "o.json", ...BK], h.deps), 1);
  assert.ok(!h.events.some((e) => e.startsWith("put")));
  const out = JSON.parse([...h.files.entries()].find(([p]) => p.endsWith("o.json"))![1]);
  assert.equal(out.mode, "apply-recusado-familia-vazia");
  assert.equal(out.familyCounts["vote:"], 0);
  const h2 = harness(INFLATED, {}, {}, false);
  let printed = "";
  h2.deps.out = (l) => (printed = l);
  assert.equal(await main([], h2.deps), 0);
  assert.equal(JSON.parse(printed).familyCounts["score:"], 2);
});

test("verificação final só é limpa com 0 chaves ilegíveis", async () => {
  const entries = { ...INFLATED, ["score:outro@example.com"]: "{quebrado" };
  const h = harness(entries);
  assert.equal(await main(["--apply", "--confirm-dry-run-hash", hashOf(entries), ...BK], h.deps), 1);
  assert.ok(h.events.includes(`put ${BRAND_PREFIX}score:${E}`), "o plano dos demais é aplicado");
  assert.ok(h.logs.some((l) => /1 chave\(s\) ilegível/.test(l)));
  assert.ok(h.logs.some((l) => /1 e-mail\(s\) fonte-ilegivel/.test(l)));
});

const WITH_MONTH = { ...DIRECT, [`score-by-month:2026-11:${E}`]: s(10, 6), [`score-by-month:2026-11:${A1}`]: s(4, 2) };

test("purga que falha: arquivo de pendências gravado ANTES da invalidação do snapshot", async () => {
  const h = harness(WITH_MONTH, { purge: async () => ({ ok: false, status: 500, error: "x" }) });
  assert.equal(await main(["--apply", "--confirm-dry-run-hash", hashOf(WITH_MONTH), ...BK], h.deps), 1);
  const iPending = h.events.findIndex((e) => e.startsWith("write") && e.endsWith("-pending-do-purge.json"));
  const iDelete = h.events.indexOf(`delete ${BRAND_PREFIX}leaderboard-snapshot:2026-11`);
  assert.ok(iPending >= 0 && iPending < iDelete, h.events.join("\n"));
});

test("falha ao invalidar snapshot é logada por chave e a execução não sai limpa", async () => {
  const h = harness(WITH_MONTH);
  h.deps.ops.delete = async () => {
    throw new Error("HTTP 403 — sem permissão");
  };
  assert.equal(await main(["--apply", "--confirm-dry-run-hash", hashOf(WITH_MONTH), ...BK], h.deps), 1);
  assert.ok(h.logs.some((l) => l.includes("não invalidou web:leaderboard-snapshot:2026-11")));
  assert.ok(h.events.includes(`purge ${E}`));
});

test("progresso que não grava marca falha sem relançar e mantém a limpeza (purga, espera, 2ª invalidação)", async () => {
  const sleeps: number[] = [];
  const h = harness(WITH_MONTH, { sleep: async (ms) => void sleeps.push(ms) });
  const orig = h.deps.fs.writeFile;
  let n = 0;
  h.deps.fs.writeFile = (p, d) => {
    if (p.endsWith("-progress.json") && ++n === 3) throw new Error("EIO") // 3º save = logo após o put do score:;
    orig(p, d);
  };
  assert.equal(await main(["--apply", "--confirm-dry-run-hash", hashOf(WITH_MONTH), ...BK], h.deps), 1);
  assert.ok(h.logs.some((l) => l.includes("falhou em (arquivo de progresso)")));
  assert.ok(h.events.includes(`purge ${E}`), "quem teve score gravado é purgado");
  assert.ok(sleeps.includes(90_000));
  assert.equal(h.events.filter((e) => e === `delete ${BRAND_PREFIX}leaderboard-snapshot:2026-11`).length, 2);
});

test("chave do e-mail que mudou: pula as escritas restantes daquele e-mail", async () => {
  const h = harness(WITH_MONTH);
  const r = reconcileIdentifiedScores(kv(WITH_MONTH));
  h.store.set(`${BRAND_PREFIX}${identifyMigratedKey(E, A1)}`, s(1, 1)); // 1ª escrita do grupo mudou
  assert.equal(await applyPlan(r, h.deps, { backupDir: "bk" }), 1);
  assert.ok(!h.events.some((e) => e.startsWith("put")), h.events.join("\n"));
  assert.ok(!h.events.includes(`purge ${E}`), "nada gravado ⇒ sem purga");
  const progress = JSON.parse([...h.files.entries()].find(([p]) => p.endsWith("-progress.json"))![1]);
  assert.equal(progress.skipped.length, r.writes.length);
});

test("put de score: que falha após os retries mas pode ter gravado: e-mail com voto direto é purgado mesmo assim", async () => {
  const h = harness(DIRECT);
  const origPut = h.deps.ops.put;
  h.deps.ops.put = async (k, v) => {
    await origPut(k, v); // o KV gravou...
    if (k === `${BRAND_PREFIX}score:${E}`) throw new Error("HTTP 504 — timeout"); // ...mas a resposta falhou
  };
  assert.equal(await main(["--apply", "--confirm-dry-run-hash", hashOf(DIRECT), ...BK], h.deps), 1);
  assert.ok(h.events.includes(`purge ${E}`), h.events.join("\n"));
  const progress = JSON.parse([...h.files.entries()].find(([p]) => p.endsWith("-progress.json"))![1]);
  assert.equal(progress.failed.key, `score:${E}`);
  assert.deepEqual(progress.pendingPurge, [], "purga ok tira o e-mail da pendência");
});

test("crash entre o put e a purga: progress guarda a purga pendente e --purge-do-from retoma a partir dele", async () => {
  const h = harness(DIRECT, {
    purge: async () => {
      throw new Error("processo morto");
    },
  });
  await assert.rejects(main(["--apply", "--confirm-dry-run-hash", hashOf(DIRECT), ...BK], h.deps), /processo morto/);
  assert.ok(h.events.includes(`put ${BRAND_PREFIX}score:${E}`));
  const [path, body] = [...h.files.entries()].find(([p]) => p.endsWith("-progress.json"))!;
  assert.deepEqual(JSON.parse(body).pendingPurge, [E]);
  h.deps.purge = async (email) => (h.events.push(`purge ${email}`), { ok: true, status: 200 });
  assert.equal(await main(["--purge-do-from", path], h.deps), 0);
  assert.ok(h.events.includes(`purge ${E}`));
});
