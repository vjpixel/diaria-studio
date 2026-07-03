import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStoreSummary, deriveCycleStart } from "../scripts/clarice-db-summary.ts";
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

test("computeStoreSummary: histograma agrega total/verified/brevo/eligible juntos NUM SÓ SCAN (#2875 — groupCountsMulti generalizado a N colunas)", () => {
  // Prova a generalização de groupCountsWithVerifiedAndBrevo (2 colunas fixas
  // nv/nb + o extra nl tackado depois) pra groupCountsMulti (N colunas
  // parametrizadas): as 3 colunas condicionais devem agregar corretamente
  // JUNTAS, na mesma linha/bucket, num único scan — não só isoladamente
  // (os testes de #2880/#2865 acima já cobrem cada coluna em separado).
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // Bucket 0 pts: a = verified + brevo + elegível (as 3 condições juntas);
  // b = nenhuma das 3 (mesmo bucket 0, testa que não vaza pra outras linhas).
  ins(
    "INSERT INTO clarice_users (email, tier, mv_bucket, brevo_list_ids) VALUES ('a@x.com',1,'verified','[1]')",
  );
  ins("INSERT INTO clarice_users (email, tier, unsubscribed) VALUES ('b@x.com',1,1)"); // inelegível → fora de `eligible`
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  assert.equal(s.priority_points_histogram["0"], 2, "a,b — total do bucket 0 correto (COUNT não quebrou)");
  assert.equal(s.priority_points_histogram_verified["0"], 1, "só a — verified");
  assert.equal(s.priority_points_histogram_brevo["0"], 1, "só a — brevo");
  assert.equal(s.priority_points_histogram_eligible["0"], 1, "só a — elegível (b descadastrou)");

  db.close();
});

// ---------------------------------------------------------------------------
// #2864 — cohort_stats: comparativo de envio/engajamento por cohort
// ---------------------------------------------------------------------------

test("computeStoreSummary: cohort_stats agrega contatos/elegíveis/recebeu/envios/abriu/clicou/saiu/mv por cohort (#2864)", () => {
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // assinantes-ativos (tier 1):
  //   a: elegível, recebeu 3, abriu (opens=2), clicou (clicks=1), verified.
  ins(`INSERT INTO clarice_users
        (email, tier, sends_count, opens_count, clicks_count, mv_bucket)
        VALUES ('a@x.com',1,3,2,1,'verified')`);
  //   b: elegível, NUNCA recebeu (sends=0) — fora do universo "recebeu", mas conta em contacts/eligible
  ins("INSERT INTO clarice_users (email, tier) VALUES ('b@x.com',1)");
  // ex-assinantes (tier 2):
  //   c: recebeu 2, não abriu, unsub → inelegível E "saiu" (unsub).
  ins("INSERT INTO clarice_users (email, tier, sends_count, unsubscribed) VALUES ('c@x.com',2,2,1)");
  //   d: recebeu 1, não abriu, hard bounce → inelegível E "saiu" (hard_bounce,
  //   #2880 — distinto de c/unsub, prova que unsub e hard_bounce NÃO se
  //   confundem no mesmo cohort).
  ins("INSERT INTO clarice_users (email, tier, sends_count, hard_bounced) VALUES ('d@x.com',2,1,1)");
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  const cs = s.cohort_stats;

  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].contacts, 2, "a,b");
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].eligible, 2, "a,b ambos elegíveis (nunca enviado ≠ inelegível)");
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].received, 1, "só a (sends_count>0)");
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].opened, 1, "a abriu");
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].clicked, 1, "a clicou");
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].unsub, 0);
  assert.equal(cs[COHORT_ASSINANTES_ATIVOS].hard_bounce, 0);
  // #2909: sends_sum e mv_verified saíram do payload.
  assert.equal(
    Object.prototype.hasOwnProperty.call(cs[COHORT_ASSINANTES_ATIVOS], "sends_sum"),
    false,
    "sends_sum removido do payload (#2909)",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(cs[COHORT_ASSINANTES_ATIVOS], "mv_verified"),
    false,
    "mv_verified removido do payload (#2909)",
  );

  assert.equal(cs[COHORT_EX_ASSINANTES].contacts, 2, "c,d");
  assert.equal(cs[COHORT_EX_ASSINANTES].eligible, 0, "c e d inelegíveis (unsub / hard bounce)");
  assert.equal(cs[COHORT_EX_ASSINANTES].received, 2, "c e d recebem antes de sair");
  assert.equal(cs[COHORT_EX_ASSINANTES].opened, 0);
  assert.equal(cs[COHORT_EX_ASSINANTES].unsub, 1, "só c descadastrou (#2880: separado de hard_bounce)");
  assert.equal(cs[COHORT_EX_ASSINANTES].hard_bounce, 1, "só d deu hard bounce (#2880: separado de unsub)");

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

test("computeStoreSummary: cohort_stats NÃO tem mais priority_points_sum (#2884 — dado morto, sem leitor no render desde #2880)", () => {
  const db = openClariceDb(":memory:");
  db.prepare(
    "INSERT INTO clarice_users (email, tier, cohort, sends_count) VALUES ('a@x.com',1,'assinantes-ativos',1)",
  ).run();
  recomputeDerived(db);

  const s = computeStoreSummary(db);
  const row = s.cohort_stats[COHORT_ASSINANTES_ATIVOS];
  assert.ok(row, "cohort presente");
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, "priority_points_sum"),
    false,
    "priority_points_sum removido do payload (#2884)",
  );
  db.close();
});

// ---------------------------------------------------------------------------
// #2909 — cycle_start + received_this_cycle (planejar envio do mês sem repetir)
// ---------------------------------------------------------------------------

test("computeStoreSummary: cycle_start é propagado ao payload (injetável); default null", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, tier) VALUES ('a@x.com',1)").run();
  recomputeDerived(db);

  assert.equal(computeStoreSummary(db).cycle_start, null, "default = null (sem ciclo)");
  assert.equal(
    computeStoreSummary(db, "2026-06-01T00:00:00Z").cycle_start,
    "2026-06-01T00:00:00Z",
    "cycleStart injetado propaga ao payload",
  );
  db.close();
});

test("computeStoreSummary: received_this_cycle conta last_sent_at >= cycle_start (boundary inclusivo) por cohort (#2909)", () => {
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);
  const cycleStart = "2026-06-01T00:00:00Z";

  // assinantes-ativos (tier 1):
  //   a: enviado DENTRO do ciclo (depois do início) → conta
  ins("INSERT INTO clarice_users (email, tier, sends_count, last_sent_at) VALUES ('a@x.com',1,1,'2026-06-10T00:00:00Z')");
  //   d: enviado EXATAMENTE no início do ciclo → conta (>= é inclusivo)
  ins("INSERT INTO clarice_users (email, tier, sends_count, last_sent_at) VALUES ('d@x.com',1,1,'2026-06-01T00:00:00Z')");
  //   b: enviado ANTES do ciclo → recebeu (sends>0) mas NÃO neste ciclo
  ins("INSERT INTO clarice_users (email, tier, sends_count, last_sent_at) VALUES ('b@x.com',1,1,'2026-05-31T23:59:59Z')");
  //   c: nunca enviado (last_sent_at NULL) → não conta em nenhum
  ins("INSERT INTO clarice_users (email, tier) VALUES ('c@x.com',1)");
  recomputeDerived(db);

  const s = computeStoreSummary(db, cycleStart);
  const row = s.cohort_stats[COHORT_ASSINANTES_ATIVOS];
  assert.equal(row.contacts, 4, "a,b,c,d");
  assert.equal(row.received, 3, "a,b,d têm sends_count>0");
  assert.equal(row.received_this_cycle, 2, "só a e d (last_sent_at >= cycle_start; b é anterior, c null)");
  // "falta enviar" = eligible − received_this_cycle é calculado no render; aqui
  // só validamos os insumos (eligible dos 4 — todos elegíveis, nenhum saiu).
  assert.equal(row.eligible, 4, "nenhum inelegível");

  db.close();
});

test("computeStoreSummary: cycleStart=null → received_this_cycle=0 pra todos (last_sent_at >= NULL é NULL/0), sem quebrar (#2909)", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, tier, sends_count, last_sent_at) VALUES ('a@x.com',1,1,'2026-06-10T00:00:00Z')").run();
  recomputeDerived(db);

  const s = computeStoreSummary(db, null);
  assert.equal(s.cycle_start, null);
  assert.equal(s.cohort_stats[COHORT_ASSINANTES_ATIVOS].received_this_cycle, 0, "sem ciclo → 0 (render mostra —)");
  db.close();
});

// #2923: deriveCycleStart passou a ser o 1º dia do mês CALENDÁRIO corrente (UTC Z),
// não mais o scan de send-plan (que o fluxo manual/waves não gera → cycle_start=null
// e a coluna "Recebeu neste ciclo" em branco). Decisão do editor 260703: mês calendário.
test("deriveCycleStart: 1º dia do mês corrente em UTC Z (#2923)", () => {
  assert.equal(deriveCycleStart(new Date("2026-07-15T12:34:56Z")), "2026-07-01T00:00:00.000Z");
  assert.equal(deriveCycleStart(new Date("2026-01-31T23:59:59Z")), "2026-01-01T00:00:00.000Z");
  assert.equal(deriveCycleStart(new Date("2026-12-01T00:00:00Z")), "2026-12-01T00:00:00.000Z");
});

test("deriveCycleStart: default (agora) → sempre um mês-1º, NUNCA null (coluna sempre popula) (#2923)", () => {
  assert.match(deriveCycleStart(), /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
});

test("deriveCycleStart: envio real (~06:00 BRT = 09:00 UTC do dia 1) conta no ciclo (#2923)", () => {
  const cs = deriveCycleStart(new Date("2026-07-03T09:00:00Z"));
  assert.equal(cs, "2026-07-01T00:00:00.000Z");
  // last_sent_at >= cycle_start via string-compare (ambos ISO Z) — como o SQL faz.
  assert.ok("2026-07-03T09:02:12.548Z" >= cs);
  assert.ok(!("2026-06-30T09:00:00.000Z" >= cs)); // envio do mês passado NÃO conta
});
