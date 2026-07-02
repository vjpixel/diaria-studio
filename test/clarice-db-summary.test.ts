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
  // #2732: by_cohort_first_send (#2857 fase B, sucessor de by_tier) espelha o
  // universo `firstSend` de segmentFromStore — send_eligible=1 E sends_count=0.
  // tier 1 → cohort assinantes-ativos: a,e (2, ambos elegíveis e nunca
  // enviados); tier 2 → cohort ex-assinantes: b(sends=3, já enviado)+c(sends=2
  // mas unsub → inelegível) EXCLUÍDOS; null → d (dispute → inelegível, mesmo
  // com sends_count=0) também EXCLUÍDO — nunca-enviado NÃO basta, precisa ser
  // elegível (senão nunca vai pra fila real de 1º envio).
  assert.equal(s.by_cohort_first_send[COHORT_ASSINANTES_ATIVOS], 2);
  assert.equal(s.by_cohort_first_send[COHORT_EX_ASSINANTES], undefined);
  assert.equal(s.by_cohort_first_send["null"], undefined);
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
  // by_cohort_first_send_verified: universo firstSend ∩ verified — só a
  // (tier 1 → cohort assinantes-ativos, nunca enviado, verified). e é
  // firstSend mas sem MV; b é verified mas reSend.
  assert.deepEqual(s.by_cohort_first_send_verified, { [COHORT_ASSINANTES_ATIVOS]: 1 });
  // mv: verified (a,b)=2; none (c,d,e)=3
  assert.equal(s.mv["verified"], 2);
  assert.equal(s.mv["none"], 3);
  // engajamento
  assert.equal(s.engagement.with_opens, 1);
  assert.equal(s.engagement.with_clicks, 1);

  db.close();
});

test("computeStoreSummary: by_cohort_first_send exclui nunca-enviado MAS inelegível (dispute/unsub) — só firstSend real (#2732, #2857 fase B)", () => {
  // Regressão: a 1ª versão do fix filtrava by_tier só por sends_count=0, sem
  // checar send_eligible. Um contato nunca-enviado mas permanentemente
  // bloqueado (disputa, mv_rejected, unsub antes do 1º envio) tem
  // sends_count=0 e passaria no filtro antigo — mas segmentFromStore roteia
  // esse contato pra `excluded`, nunca `firstSend`. by_cohort_first_send tinha
  // que acompanhar isso ou infla a contagem "1º envio" com gente que nunca vai
  // ser enviada.
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // elegível, nunca enviado, tier 3 (cohort leads-2026-jan-abr), mv verified — DEVE contar
  ins("INSERT INTO clarice_users (email, status, tier, mv_bucket) VALUES ('ok@x.com','active',3,'verified')");
  // disputado, nunca enviado (sends_count implícito 0), tier 3 — NÃO deve contar
  ins("INSERT INTO clarice_users (email, tier, dispute_losses) VALUES ('disputa@x.com',3,10)");
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  assert.equal(s.by_cohort_first_send["leads-2026-jan-abr"], 1); // só ok@x.com
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

// ---------------------------------------------------------------------------
// #2865 — coluna "Brevo" (brevo_list_ids IS NOT NULL) no histograma de
// priority_points e no breakdown de 1º envio por cohort
// ---------------------------------------------------------------------------

test("computeStoreSummary: priority_points_histogram_brevo e by_cohort_first_send_brevo — contatos com brevo_list_ids (#2865)", () => {
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

  // breakdown de 1º envio (firstSend: send_eligible=1 AND sends_count<=0) —
  // só a,b (c já foi enviado, sends_count=3 → fora do firstSend).
  assert.equal(s.by_cohort_first_send[COHORT_ASSINANTES_ATIVOS], 2, "a,b");
  assert.equal(s.by_cohort_first_send_brevo[COHORT_ASSINANTES_ATIVOS], 1, "só a@x.com tem brevo_list_ids");

  db.close();
});

test("computeStoreSummary: KV/payload sem contatos na Brevo → chave AUSENTE (semântica esparsa, não 0 explícito)", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, tier) VALUES ('a@x.com',1)").run();
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  assert.equal(s.priority_points_histogram_brevo["0"], undefined, "nenhum contato na Brevo → chave ausente");
  assert.equal(s.by_cohort_first_send_brevo[COHORT_ASSINANTES_ATIVOS], undefined);

  db.close();
});

// ---------------------------------------------------------------------------
// #2864 — cohort_stats: comparativo de envio/engajamento por cohort
// ---------------------------------------------------------------------------

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

test("computeStoreSummary: by_cohort — leads pré-epoch usam o semestre REAL do created; só created ausente vira 'null' (#2857 fase B.1)", () => {
  // #2857 fase B.1: created presente mas ANTERIOR ao epoch da safra (2026-05)
  // não vira mais 'null' — deriva o semestre real via `deriveLeadCohort`
  // (rótulo verdadeiro por construção, ver test/clarice-db.test.ts
  // `computeCohort`). Só `created` genuinamente ausente cai em 'null'.
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, created) VALUES ('velho@x.com','2025-11-01T00:00:00Z')").run();
  db.prepare("INSERT INTO clarice_users (email) VALUES ('sem@x.com')").run();
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  assert.equal(s.by_cohort["leads-2025h2"], 1, "created 2025-11 (pré-epoch) deriva o semestre real (não mais 'null')");
  assert.equal(s.by_cohort["null"], 1, "só sem@x.com (created ausente) cai em 'null'");
  db.close();
});
