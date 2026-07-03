import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStoreSummary } from "../scripts/clarice-db-summary.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";
import { COHORT_ASSINANTES_ATIVOS, COHORT_EX_ASSINANTES } from "../scripts/lib/cohorts.ts";

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
  // mv: verified (a,b)=2; none (c,d,e)=3
  assert.equal(s.mv["verified"], 2);
  assert.equal(s.mv["none"], 3);
  // engajamento
  assert.equal(s.engagement.with_opens, 1);
  assert.equal(s.engagement.with_clicks, 1);

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

test("computeStoreSummary: ti@clarice.ai é interno — excluído de priority_points e cohort_stats, mas segue no total/mv (#2880)", () => {
  // #2880: ti@clarice.ai (equipe Clarice, sem registro Stripe) entrou em
  // INTERNAL_EMAILS — mesmo tratamento de exibição dos demais internos.
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // ti@ engajado (4 opens de 4 → +80) — não pode aparecer no histograma nem no cohort_stats
  ins("INSERT INTO clarice_users (email, tier, opens_count, clicks_count, sends_count, mv_bucket) VALUES ('ti@clarice.ai',1,4,2,4,'verified')");
  // assinante real: 3 opens de 3 → +60
  ins("INSERT INTO clarice_users (email, tier, opens_count, sends_count) VALUES ('real@x.com',1,3,3)");
  recomputeDerived(db);

  const s = computeStoreSummary(db);

  // total conta os dois (ti@ segue no store); só a exibição exclui
  assert.equal(s.total, 2);
  assert.equal(s.priority_points.internal_excluded, 1, "ti@clarice.ai contado como interno");
  assert.equal(s.priority_points_histogram["80"], undefined, "ti@ +80 fora do histograma");
  assert.equal(s.priority_points_histogram["60"], 1, "só o assinante real");
  // cohort_stats: ti@ era o único cohort assinantes-ativos com +80; excluído →
  // só o real permanece no cohort. Um único contact (real).
  assert.equal(s.cohort_stats["assinantes-ativos"].contacts, 1, "ti@ excluído do cohort_stats");
  // mv NÃO filtra internos — ti@ verified conta
  assert.equal(s.mv["verified"], 1, "ti@ verified segue no mv");

  db.close();
});

// ---------------------------------------------------------------------------
// #2880 — coluna "elegíveis" (send_eligible=1) no histograma de priority_points
// ---------------------------------------------------------------------------

test("computeStoreSummary: priority_points_histogram_eligible — subconjunto enviável por faixa (#2880)", () => {
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // a: tier 1, elegível, 0 pts
  ins("INSERT INTO clarice_users (email, tier) VALUES ('a@x.com',1)");
  // b: tier 1, INELEGÍVEL (unsub) — mesma faixa que a (0 pts após recompute?).
  //    unsub sem sends → priority_points 0. Conta no histograma total mas NÃO no eligible.
  ins("INSERT INTO clarice_users (email, tier, unsubscribed) VALUES ('b@x.com',1,1)");
  recomputeDerived(db);

  const s = computeStoreSummary(db);

  // linha 0: a (elegível) + b (inelegível) → contatos=2, elegíveis=1
  assert.equal(s.priority_points_histogram["0"], 2, "a,b ambos na faixa 0");
  assert.equal(s.priority_points_histogram_eligible["0"], 1, "só a é send_eligible=1");

  db.close();
});

test("computeStoreSummary: histograma_eligible — faixa sem nenhum elegível → chave AUSENTE (semântica esparsa, #2880)", () => {
  const db = openClariceDb(":memory:");
  // único contato é inelegível (dispute) → faixa 0 tem contato mas 0 elegíveis
  db.prepare("INSERT INTO clarice_users (email, tier, dispute_losses) VALUES ('a@x.com',1,10)").run();
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  assert.equal(s.priority_points_histogram["0"], 1, "1 contato na faixa 0");
  assert.equal(s.priority_points_histogram_eligible["0"], undefined, "nenhum elegível → chave ausente, não 0");

  db.close();
});

// ---------------------------------------------------------------------------
// #2865 — coluna "Brevo" (brevo_list_ids IS NOT NULL) no histograma de
// priority_points
// ---------------------------------------------------------------------------

test("computeStoreSummary: priority_points_histogram_brevo — contatos com brevo_list_ids (#2865)", () => {
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // a: tier 1 (assinantes-ativos), nunca enviado, NA Brevo, 0 pts
  ins("INSERT INTO clarice_users (email, tier, brevo_list_ids) VALUES ('a@x.com',1,'[1]')");
  // b: tier 1, nunca enviado, SEM brevo_list_ids, 0 pts
  ins("INSERT INTO clarice_users (email, tier) VALUES ('b@x.com',1)");
  // c: tier 2 (ex-assinantes), 3 opens de 3 (+60 pts), NA Brevo
  ins("INSERT INTO clarice_users (email, tier, opens_count, sends_count, brevo_list_ids) VALUES ('c@x.com',2,3,3,'[2]')");
  recomputeDerived(db);

  const s = computeStoreSummary(db);

  // histograma: linha 0 tem a(brevo) e b(sem brevo) → brevo=1; linha 60 tem c(brevo) → brevo=1
  assert.equal(s.priority_points_histogram_brevo["0"], 1, "só a@x.com (b sem brevo_list_ids)");
  assert.equal(s.priority_points_histogram_brevo["60"], 1, "c@x.com");
  // total/verified do histograma continuam corretos (regressão de shape)
  assert.equal(s.priority_points_histogram["0"], 2, "a,b");
  assert.equal(s.priority_points_histogram["60"], 1, "c");

  db.close();
});

test("computeStoreSummary: KV/payload sem contatos na Brevo → chave AUSENTE (semântica esparsa, não 0 explícito)", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, tier) VALUES ('a@x.com',1)").run();
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  assert.equal(s.priority_points_histogram_brevo["0"], undefined, "nenhum contato na Brevo → chave ausente");

  db.close();
});

// ---------------------------------------------------------------------------
// #2864 — cohort_stats: comparativo de envio/engajamento por cohort
// ---------------------------------------------------------------------------

test("computeStoreSummary: cohort_stats — priority_points NULL em quem recebeu não anula o pp_sum do cohort (COALESCE; review #2872)", () => {
  const db = openClariceDb(":memory:");
  // Linha que recebeu envio mas com priority_points NULL direto (sem
  // recomputeDerived — simula linha legada/parcial). Pré-fix: SUM(CASE WHEN
  // sends>0 THEN priority_points ...) = NULL → payload violava o tipo number
  // e o Worker renderizava "0.0" fake.
  db.prepare(
    "INSERT INTO clarice_users (email, tier, cohort, sends_count, priority_points) VALUES ('nullpp@x.com',1,'assinantes-ativos',2,NULL)",
  ).run();
  const s = computeStoreSummary(db);
  const row = s.cohort_stats[COHORT_ASSINANTES_ATIVOS];
  assert.equal(typeof row.priority_points_sum, "number", "SUM com COALESCE nunca é null");
  assert.equal(row.priority_points_sum, 0);
  db.close();
});

test("computeStoreSummary: cohort_stats agrega contatos/elegíveis/recebeu/envios/abriu/clicou/saiu/mv/pontos por cohort (#2864)", () => {
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // assinantes-ativos (tier 1):
  //   a: elegível, recebeu 3, abriu (opens=2), clicou (clicks=1), verified.
  //   priority_points é RECOMPUTADO por recomputeDerived (o literal inserido
  //   abaixo é ignorado) — fórmula: 20*opens - 10*notOpened = 20*2-10*1 = 30
  //   (notOpened = max(0, sends-opens) = 3-2 = 1).
  ins(`INSERT INTO clarice_users
        (email, tier, sends_count, opens_count, clicks_count, mv_bucket)
        VALUES ('a@x.com',1,3,2,1,'verified')`);
  //   b: elegível, NUNCA recebeu (sends=0) — fora do universo "recebeu", mas conta em contacts/eligible
  ins("INSERT INTO clarice_users (email, tier) VALUES ('b@x.com',1)");
  // ex-assinantes (tier 2):
  //   c: recebeu 2, não abriu, unsub → inelegível E "saiu" (unsub_bounce).
  //   priority_points recomputado: notOpened=2, 0 - 10*2 = -20.
  ins("INSERT INTO clarice_users (email, tier, sends_count, unsubscribed) VALUES ('c@x.com',2,2,1)");
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  const cs = s.cohort_stats;

  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].contacts, 2, "a,b");
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].eligible, 2, "a,b ambos elegíveis (nunca enviado ≠ inelegível)");
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].received, 1, "só a (sends_count>0)");
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].sends_sum, 3);
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].opened, 1, "a abriu");
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].clicked, 1, "a clicou");
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].unsub_bounce, 0);
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].mv_verified, 1, "a verified");
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].priority_points_sum, 30, "só a conta (recebeu); b tem sends=0");

  assert.equal(cs[COHORT_EX_ASSINANTES].contacts, 1);
  assert.equal(cs[COHORT_EX_ASSINANTES].eligible, 0, "c inelegível (unsub)");
  assert.equal(cs[COHORT_EX_ASSINANTES].received, 1, "c recebeu 2 envios antes de sair");
  assert.equal(cs[COHORT_EX_ASSINANTES].opened, 0);
  assert.equal(cs[COHORT_EX_ASSINANTES].unsub_bounce, 1, "c descadastrou");
  assert.equal(cs[COHORT_EX_ASSINANTES].priority_points_sum, -20);

  db.close();
});

test("computeStoreSummary: cohort_stats — sem cohort vira chave 'null'; e-mails internos EXCLUÍDOS (#2809)", () => {
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  ins("INSERT INTO clarice_users (email) VALUES ('sem-cohort@x.com')");
  // interno engajado — não pode poluir a leitura de comportamento por cohort
  ins("INSERT INTO clarice_users (email, tier, opens_count, sends_count) VALUES ('vjpixel@gmail.com',1,4,4)");
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  assert.equal(s.cohort_stats["null"].contacts, 1, "só sem-cohort@x.com — interno excluído mesmo tendo cohort");
  assert.equal(s.cohort_stats[COHORT_ASSINANTES_ATIVOS], undefined, "interno era o único do cohort assinantes-ativos → cohort some do agregado");
  // invariante: soma de contacts do cohort_stats = total - internal_excluded
  const totalCohortContacts = Object.values(s.cohort_stats).reduce((acc, c) => acc + c.contacts, 0);
  assert.equal(totalCohortContacts, s.total - s.priority_points.internal_excluded);

  db.close();
});

test("computeStoreSummary: cohort_stats[cohort].brevo — contagem de brevo_list_ids IS NOT NULL por cohort (#2880)", () => {
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // assinantes-ativos: a NA Brevo, b SEM brevo_list_ids
  ins("INSERT INTO clarice_users (email, tier, brevo_list_ids) VALUES ('a@x.com',1,'[1]')");
  ins("INSERT INTO clarice_users (email, tier) VALUES ('b@x.com',1)");
  // ex-assinantes: c NA Brevo
  ins("INSERT INTO clarice_users (email, tier, brevo_list_ids) VALUES ('c@x.com',2,'[2]')");
  // interno NA Brevo — deve ficar de fora (mesma exclusão de internos do cohort_stats)
  ins("INSERT INTO clarice_users (email, tier, brevo_list_ids) VALUES ('vjpixel@gmail.com',1,'[1]')");
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  const cs = s.cohort_stats;

  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].brevo, 1, "só a@x.com — b sem brevo_list_ids, interno excluído");
  assert.equal(cs[COHORT_EX_ASSINANTES].brevo, 1, "c@x.com");

  db.close();
});
