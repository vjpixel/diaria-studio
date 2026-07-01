import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStoreSummary } from "../scripts/clarice-db-summary.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";

test("computeStoreSummary: agrega tier/elegibilidade/pontos/mv/engajamento", () => {
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // ativo, 1º envio, tier 1, mv verified
  ins("INSERT INTO clarice_users (email, status, tier, mv_bucket) VALUES ('a@x.com','active',1,'verified')");
  // veterano engajado: tier 2, 3 opens de 3, 2 clicks
  ins("INSERT INTO clarice_users (email, tier, opens_count, clicks_count, sends_count, mv_bucket) VALUES ('b@x.com',2,3,2,3,'verified')");
  // descadastrado → inelegível
  ins("INSERT INTO clarice_users (email, tier, unsubscribed, sends_count) VALUES ('c@x.com',2,1,2)");
  // disputado → inelegível dispute, tier null
  ins("INSERT INTO clarice_users (email, tier, dispute_losses) VALUES ('d@x.com',NULL,10)");
  // optin → priority_optin + boost
  ins("INSERT INTO clarice_users (email, status, tier) VALUES ('e@x.com','active',1)");
  ins("INSERT INTO priority_optin (email, added_at) VALUES ('e@x.com','2026-06-01T00:00:00Z')");
  recomputeDerived(db);

  const s = computeStoreSummary(db);

  assert.equal(s.total, 5);
  // #2732: by_tier espelha o universo `firstSend` de segmentFromStore —
  // send_eligible=1 E sends_count=0. tier 1 → a,e (2, ambos elegíveis e
  // nunca enviados); tier 2 → b(sends=3, já enviado)+c(sends=2 mas unsub →
  // inelegível) EXCLUÍDOS; null → d (dispute → inelegível, mesmo com
  // sends_count=0) também EXCLUÍDO — nunca-enviado NÃO basta, precisa ser
  // elegível (senão nunca vai pra fila real de 1º envio).
  assert.equal(s.by_tier["1"], 2);
  assert.equal(s.by_tier["2"], undefined);
  assert.equal(s.by_tier["null"], undefined);
  // elegibilidade: c (unsub) e d (dispute) cortados → 3 elegíveis, 2 inelegíveis
  assert.equal(s.eligibility.eligible, 3);
  assert.equal(s.eligibility.ineligible, 2);
  assert.equal(s.eligibility.by_reason["unsubscribed"], 1);
  assert.equal(s.eligibility.by_reason["dispute"], 1);
  // priority_points: e tem optin (+40) → faixa 1–40 (prova que o boost propagou);
  // b tem 3 opens (+60) → 41–80; a,d → 0 (eq0); c recebeu 2 não abriu → -20 (lt0)
  assert.equal(s.priority_points.optin, 1);
  assert.equal(s.priority_points.p1_40, 1); // e: optin +40 propagado pra clarice_users
  assert.equal(s.priority_points.p41_80, 1); // b: 20×3=60
  assert.equal(s.priority_points.eq0, 2); // a, d
  assert.equal(s.priority_points.lt0, 1); // c
  // invariante: as 5 faixas particionam o total (nenhuma linha cai fora — pega NULL)
  const pp = s.priority_points;
  assert.equal(pp.lt0 + pp.eq0 + pp.p1_40 + pp.p41_80 + pp.gt80, s.total);
  // #2731: distribuição por VALOR EXATO — e:+40 (optin), b:+60 (3×20), a,d:0, c:-20.
  const hist = s.priority_points_histogram;
  assert.equal(hist["40"], 1, "e: optin +40");
  assert.equal(hist["60"], 1, "b: 3 opens ×20");
  assert.equal(hist["0"], 2, "a, d");
  assert.equal(hist["-20"], 1, "c");
  // invariante: a soma do histograma também particiona o total.
  assert.equal(Object.values(hist).reduce((s2, v) => s2 + v, 0), s.total);
  // mv: verified (a,b)=2; none (c,d,e)=3
  assert.equal(s.mv["verified"], 2);
  assert.equal(s.mv["none"], 3);
  // engajamento
  assert.equal(s.engagement.with_opens, 1);
  assert.equal(s.engagement.with_clicks, 1);

  db.close();
});

test("computeStoreSummary: by_tier exclui nunca-enviado MAS inelegível (dispute/unsub) — só firstSend real (#2732)", () => {
  // Regressão: a 1ª versão do fix filtrava by_tier só por sends_count=0, sem
  // checar send_eligible. Um contato nunca-enviado mas permanentemente
  // bloqueado (disputa, mv_rejected, unsub antes do 1º envio) tem
  // sends_count=0 e passaria no filtro antigo — mas segmentFromStore roteia
  // esse contato pra `excluded`, nunca `firstSend`. by_tier tinha que
  // acompanhar isso ou infla a contagem "1º envio" com gente que nunca vai
  // ser enviada.
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // elegível, nunca enviado, tier 3 — DEVE contar
  ins("INSERT INTO clarice_users (email, status, tier) VALUES ('ok@x.com','active',3)");
  // disputado, nunca enviado (sends_count implícito 0), tier 3 — NÃO deve contar
  ins("INSERT INTO clarice_users (email, tier, dispute_losses) VALUES ('disputa@x.com',3,10)");
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  assert.equal(s.by_tier["3"], 1); // só ok@x.com
  db.close();
});
