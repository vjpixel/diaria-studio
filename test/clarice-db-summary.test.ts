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
  // Coluna "verified" (260702): a (verified, 0 pts) e b (verified, 60 pts) —
  // por bucket do histograma; buckets sem verificado ficam ausentes (= 0).
  const vHist = s.priority_points_histogram_verified;
  assert.equal(vHist["0"], 1, "a: verified com 0 pontos");
  assert.equal(vHist["60"], 1, "b: verified com 60 pontos");
  assert.equal(vHist["40"], undefined, "e: optin sem MV → ausente");
  assert.equal(vHist["-20"], undefined, "c: sem MV → ausente");
  // by_tier_verified: universo firstSend ∩ verified — só a (tier 1, nunca
  // enviado, verified). e é firstSend mas sem MV; b é verified mas reSend.
  assert.deepEqual(s.by_tier_verified, { "1": 1 });
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

  // elegível, nunca enviado, tier 3, mv verified — DEVE contar
  ins("INSERT INTO clarice_users (email, status, tier, mv_bucket) VALUES ('ok@x.com','active',3,'verified')");
  // disputado, nunca enviado (sends_count implícito 0), tier 3 — NÃO deve contar
  ins("INSERT INTO clarice_users (email, tier, dispute_losses) VALUES ('disputa@x.com',3,10)");
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  assert.equal(s.by_tier["3"], 1); // só ok@x.com
  db.close();
});

test("computeStoreSummary: emails internos fora do bloco priority_points, mas dentro do resto (#2809)", () => {
  // vjpixel@gmail.com abre tudo por ofício (score alto) — NÃO pode aparecer no
  // histograma/faixas de priority_points; mas segue no total/mv/engagement
  // (só exibição: continua no store e na fila de envio).
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // interno engajado: 4 opens de 4 → +80 (seria o topo do histograma)
  ins("INSERT INTO clarice_users (email, opens_count, clicks_count, sends_count, mv_bucket) VALUES ('vjpixel@gmail.com',4,2,4,'verified')");
  // interno com optin: +40 — também não conta no `optin` filtrado
  ins("INSERT INTO clarice_users (email, status) VALUES ('felipe@clarice.ai','active')");
  ins("INSERT INTO priority_optin (email, added_at) VALUES ('felipe@clarice.ai','2026-06-01T00:00:00Z')");
  // assinante real: 3 opens de 3 → +60
  ins("INSERT INTO clarice_users (email, tier, opens_count, sends_count) VALUES ('real@x.com',1,3,3)");
  recomputeDerived(db);

  const s = computeStoreSummary(db);

  // total NÃO filtra internos (eles existem no store)
  assert.equal(s.total, 3);
  assert.equal(s.priority_points.internal_excluded, 2);

  // histograma: só o assinante real (60); o 80 do interno NÃO aparece
  const hist = s.priority_points_histogram;
  assert.equal(hist["60"], 1, "real@x.com: 3 opens ×20");
  assert.equal(hist["80"], undefined, "interno +80 excluído do histograma");
  assert.equal(hist["40"], undefined, "interno optin +40 excluído do histograma");

  // faixas: só o real (41–80); optin filtrado (o único optin é interno)
  assert.equal(s.priority_points.p41_80, 1);
  assert.equal(s.priority_points.p1_40, 0);
  assert.equal(s.priority_points.optin, 0, "optin interno não conta na exibição");

  // invariante ajustado (#2809): faixas/histograma particionam total - internal_excluded
  const pp = s.priority_points;
  assert.equal(
    pp.lt0 + pp.eq0 + pp.p1_40 + pp.p41_80 + pp.gt80,
    s.total - pp.internal_excluded,
  );
  assert.equal(
    Object.values(hist).reduce((s2, v) => s2 + v, 0),
    s.total - pp.internal_excluded,
  );

  // demais agregações seguem contando os internos (sem filtro)
  assert.equal(s.engagement.with_opens, 2, "interno + real");
  assert.equal(s.engagement.with_clicks, 1, "interno");
  assert.equal(s.mv["verified"], 1, "interno verified conta no mv");

  db.close();
});

test("computeStoreSummary: filtro de internos é case-insensitive (#2809)", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, opens_count, sends_count) VALUES ('VJPixel@Gmail.com',2,2)").run();
  recomputeDerived(db);
  const s = computeStoreSummary(db);
  assert.equal(s.priority_points.internal_excluded, 1);
  assert.equal(s.priority_points_histogram["40"], undefined, "variação de caixa também excluída");
  db.close();
});

// ---------------------------------------------------------------------------
// by_cohort (#2817) — agregado total+verified por safra mensal
// ---------------------------------------------------------------------------

test("computeStoreSummary: by_cohort agrega total+verified por safra (universo = store inteiro, não só firstSend)", () => {
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // maio: 2 contatos, 1 verified
  ins("INSERT INTO clarice_users (email, created, mv_bucket) VALUES ('a@x.com','2026-05-01T00:00:00Z','verified')");
  ins("INSERT INTO clarice_users (email, created) VALUES ('b@x.com','2026-05-15T00:00:00Z')");
  // junho: 1 contato, verified, JÁ ENVIADO (sends_count>0 → fora do firstSend/by_tier,
  // mas DEVE contar no by_cohort — universo é o store inteiro, não firstSend)
  ins("INSERT INTO clarice_users (email, created, mv_bucket, sends_count) VALUES ('c@x.com','2026-06-01T00:00:00Z','verified',3)");
  // sem safra (created ausente)
  ins("INSERT INTO clarice_users (email) VALUES ('d@x.com')");
  recomputeDerived(db);

  const s = computeStoreSummary(db);

  // #2857 fase A: cohort agora guarda o slug ('leads-YYYY-MM'), não a safra crua.
  assert.deepEqual(s.by_cohort, { "leads-2026-05": 2, "leads-2026-06": 1, null: 1 });
  assert.deepEqual(s.by_cohort_verified, { "leads-2026-05": 1, "leads-2026-06": 1 }); // b sem MV → ausente (0)
  // invariante: a soma do by_cohort particiona o total
  assert.equal(Object.values(s.by_cohort).reduce((acc, v) => acc + v, 0), s.total);

  db.close();
});

test("computeStoreSummary: by_cohort — chave 'null' quando created ausente ou anterior a 2026-05", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, created) VALUES ('velho@x.com','2025-11-01T00:00:00Z')").run();
  db.prepare("INSERT INTO clarice_users (email) VALUES ('sem@x.com')").run();
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  assert.equal(s.by_cohort["null"], 2);
  db.close();
});
