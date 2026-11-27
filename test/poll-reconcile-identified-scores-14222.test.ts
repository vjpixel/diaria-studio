/**
 * #14222: reconciliação dos scores do É IA? inflados pelo re-sync de
 * `/jogar/identify`. Testa a lógica pura com KV em memória (chaves sem o
 * prefixo `web:`), sem falar com a Cloudflare.
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
} from "../scripts/lib/poll-reconcile-identified-scores.ts";
import * as worker from "../workers/poll/src/lib.ts";
import { identifyMigratedKey as workerMigratedKey } from "../workers/poll/src/identify.ts";

test("paridade com o Worker: identidade anônima, mês da edição e chave do marcador", () => {
  for (const id of ["a@web.eia.diaria.local", "A@WEB.EIA.DIARIA.LOCAL", "x@example.com", "semarroba", "b@vote.eia.diaria.local"]) {
    assert.equal(isAnonymousWebIdentity(id), worker.isAnonymousWebIdentity(id), id);
  }
  for (const ed of ["261127", "260001", "261399", "2605-06", "2613-01", "abc", "26112"]) {
    assert.equal(editionToMonthSlug(ed), worker.editionToMonthSlug(ed), ed);
  }
  assert.equal(identifyMigratedKey("e@x.com", "a@web.eia.diaria.local"), workerMigratedKey("e@x.com", "a@web.eia.diaria.local"));
  assert.equal(identifyMigratedKey("e@x.com", "a@web.eia.diaria.local", "2026-11"), workerMigratedKey("e@x.com", "a@web.eia.diaria.local", "2026-11"));
});

const A1 = "11111111-1111-4111-8111-111111111111@web.eia.diaria.local";
const A2 = "22222222-2222-4222-8222-222222222222@web.eia.diaria.local";
const LOOSE = "33333333-3333-4333-8333-333333333333@web.eia.diaria.local";
const E = "leitor@example.com";

const s = (total: number, correct: number, extra: Record<string, unknown> = {}) => JSON.stringify({ total, correct, ...extra });

function kv(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

test("par sem marcador: anônimo somado 4 vezes (1+2+3+4) volta a 4 e ganha o marcador", () => {
  const r = reconcileIdentifiedScores(
    kv({
      [`score:${E}`]: s(10, 6, { streak: 3, last_edition: "261120", nickname: "Ana" }),
      [`score:${A1}`]: s(4, 2),
      [`identify-linked:${E}:${A1}`]: "1",
    }),
  );
  const line = r.emails.find((e) => e.email === E)!;
  assert.equal(line.status, "inflado");
  assert.deepEqual(line.expected, { total: 4, correct: 2 });
  assert.equal(line.diffTotal, 6);
  const w = r.writes.find((x) => x.key === `score:${E}`)!;
  // Campos que não são contador ficam como estão.
  assert.deepEqual(JSON.parse(w.new), { total: 4, correct: 2, streak: 3, last_edition: "261120", nickname: "Ana" });
  const m = r.writes.find((x) => x.key === `identify-migrated:${E}:${A1}`)!;
  assert.equal(m.old, null);
  assert.deepEqual(JSON.parse(m.new), { total: 4, correct: 2 });
  assert.equal(r.totals.missingMarkers, 1);
});

test("par com marcador já certo e score certo: nada a gravar", () => {
  const r = reconcileIdentifiedScores(
    kv({
      [`score:${E}`]: s(4, 2),
      [`score:${A1}`]: s(4, 2),
      [`identify-linked:${E}:${A1}`]: "1",
      [`identify-migrated:${E}:${A1}`]: s(4, 2),
    }),
  );
  assert.equal(r.emails[0].status, "ok");
  assert.equal(r.writes.length, 0);
  assert.equal(r.totals.missingMarkers, 0);
});

test("par com marcador defasado (sync pós-deploy antes do último voto) é regravado", () => {
  const r = reconcileIdentifiedScores(
    kv({
      [`score:${E}`]: s(8, 4), // 4 inflados pelo 1º sync pós-deploy
      [`score:${A1}`]: s(4, 2),
      [`identify-linked:${E}:${A1}`]: "1",
      [`identify-migrated:${E}:${A1}`]: s(3, 1),
    }),
  );
  assert.deepEqual(r.emails[0].expected, { total: 4, correct: 2 });
  const m = r.writes.find((x) => x.kind === "identify-migrated")!;
  assert.equal(m.old, s(3, 1));
  assert.deepEqual(JSON.parse(m.new), { total: 4, correct: 2 });
});

test("vários anônimos + votos diretos: soma cada anônimo uma vez, mais os votos do e-mail", () => {
  const r = reconcileIdentifiedScores(
    kv({
      [`score:${E}`]: s(30, 20),
      [`score:${A1}`]: s(4, 2),
      [`score:${A2}`]: s(3, 3),
      [`score:${LOOSE}`]: s(9, 9), // anônimo sem vínculo com E: não entra
      [`identify-linked:${E}:${A1}`]: "1",
      [`identify-linked:${E}:${A2}`]: "1",
      [`vote:261110:${E}`]: JSON.stringify({ choice: "A", ts: "x", correct: true }),
      [`vote:261111:${E}`]: JSON.stringify({ choice: "B", ts: "x", correct: false }),
      [`vote:261111:${A1}`]: JSON.stringify({ choice: "B", ts: "x", correct: true }),
    }),
  );
  const line = r.emails.find((e) => e.email === E)!;
  assert.equal(line.linkedAnons, 2);
  assert.equal(line.ownVotes, 2);
  assert.deepEqual(line.reconstructed, { total: 9, correct: 6 });
  assert.deepEqual(line.expected, { total: 9, correct: 6 });
  assert.ok(line.needsDoPurge, "voto direto + valor alterado exige purge do DO");
  assert.deepEqual(r.doPurgeEmails, [E]);
  assert.equal(r.writes.filter((w) => w.kind === "identify-migrated").length, 2);
});

test("índice mensal: reduz por mês, marca o mês migrado e invalida o snapshot", () => {
  const r = reconcileIdentifiedScores(
    kv({
      [`score:${E}`]: s(5, 3),
      [`score:${A1}`]: s(5, 3),
      [`identify-linked:${E}:${A1}`]: "1",
      [`score-by-month:2026-10:${A1}`]: s(2, 1),
      [`score-by-month:2026-11:${A1}`]: s(3, 2),
      [`score-by-month:2026-11:${E}`]: s(6, 4, { nickname: "Ana", last_vote_ts: "t" }), // 3+3: somado 2x
      // 2026-10 nunca migrado para E: sem entrada mensal do e-mail.
    }),
  );
  const line = r.emails[0];
  assert.equal(line.status, "inflado");
  assert.deepEqual(line.months.map((m) => [m.month, m.expected]), [["2026-11", { total: 3, correct: 2 }]]);
  const w = r.writes.find((x) => x.key === `score-by-month:2026-11:${E}`)!;
  assert.deepEqual(JSON.parse(w.new), { total: 3, correct: 2, nickname: "Ana", last_vote_ts: "t" });
  assert.ok(r.writes.some((x) => x.key === `identify-migrated-month:2026-11:${E}:${A1}`));
  // Sem marcador para 2026-10: o próximo sync daquele mês migra uma vez.
  assert.ok(!r.writes.some((x) => x.key.startsWith("identify-migrated-month:2026-10")));
  assert.deepEqual(r.snapshotMonths, ["2026-11"]);
  assert.equal(r.totals.monthPointsTotalToRemove, 3);
});

test("nunca sobe: reconstruído acima do atual fica como está", () => {
  const r = reconcileIdentifiedScores(
    kv({
      [`score:${E}`]: s(2, 1),
      [`score:${A1}`]: s(5, 3),
      [`identify-linked:${E}:${A1}`]: "1",
    }),
  );
  assert.equal(r.emails[0].status, "abaixo-do-reconstruido");
  assert.deepEqual(r.emails[0].expected, { total: 2, correct: 1 });
  assert.ok(!r.writes.some((w) => w.kind === "score"));
});

test("e-mail sem vínculo registrado nem voto direto: sem-fonte, não tocado", () => {
  const r = reconcileIdentifiedScores(kv({ [`score:${E}`]: s(12, 7) }));
  assert.equal(r.emails[0].status, "sem-fonte");
  assert.equal(r.writes.length, 0);
  assert.equal(r.totals.semFonteEmails, 1);
});

test("selectKeysToRead lê só anônimos vinculados e votos de e-mails reais", () => {
  const names = [
    `score:${E}`, `score:${A1}`, `score:${LOOSE}`,
    `identify-linked:${E}:${A1}`,
    `score-by-month:2026-11:${A1}`, `score-by-month:2026-11:${LOOSE}`,
    `vote:261111:${E}`, `vote:261111:${A1}`,
    `identify-migrated:${E}:${A1}`,
  ];
  assert.deepEqual(new Set(selectKeysToRead(names)), new Set([
    `score:${E}`, `score:${A1}`, `identify-linked:${E}:${A1}`,
    `score-by-month:2026-11:${A1}`, `vote:261111:${E}`, `identify-migrated:${E}:${A1}`,
  ]));
});

test("hash do plano muda quando o KV muda e independe da ordem", () => {
  const base = { [`score:${E}`]: s(10, 6), [`score:${A1}`]: s(4, 2), [`identify-linked:${E}:${A1}`]: "1" };
  const h1 = reconcileIdentifiedScores(kv(base)).hash;
  const h2 = reconcileIdentifiedScores(kv({ ...base, [`score:${A1}`]: s(5, 2) })).hash;
  assert.notEqual(h1, h2);
  const w = reconcileIdentifiedScores(kv(base)).writes;
  assert.equal(planHash([...w].reverse()), h1);
});

test("redactReport não carrega e-mails", () => {
  const r = reconcileIdentifiedScores(kv({ [`score:${E}`]: s(10, 6), [`score:${A1}`]: s(4, 2), [`identify-linked:${E}:${A1}`]: "1" }));
  const txt = JSON.stringify(redactReport(r));
  assert.ok(!txt.includes("example.com"));
  assert.ok(!txt.includes("web.eia.diaria.local"));
});
