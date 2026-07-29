import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  openClariceDb,
  recomputeDerived,
  resolveMailboxCoherence,
  groupByCanonicalMailbox,
  type MailboxRow,
} from "../scripts/lib/clarice-db.ts";
import { COHORT_ASSINANTES_ATIVOS } from "../scripts/lib/cohorts.ts";
import {
  computeMailboxDryrunReport,
  renderMailboxDryrunMarkdown,
} from "../scripts/lib/clarice-mailbox-dryrun.ts";

// ---------------------------------------------------------------------------
// #4249 — coerência por caixa canônica (Gmail ignora ponto/+tag no
// local-part; nome.sobrenome@gmail.com e nomesobrenome@gmail.com são a
// MESMA caixa física). Regressão do cenário real da issue: supressão vazando
// entre linhas + cohort trocado (pagante vs lead) + duplicata de envio.
// ---------------------------------------------------------------------------

const CLEAN: MailboxRow = {
  email: "leitora.exemplo@gmail.com",
  cohort: "leads-2025h2",
  priority_points: 0,
  opens_count: 0,
  sends_count: 0,
  created: null,
  email_blacklisted: false,
  unsubscribed: false,
  hard_bounced: false,
  complained: false,
  mv_bucket: "verified",
  dispute_losses: 0,
  soft_bounce_count: 0,
};

describe("groupByCanonicalMailbox (#4249)", () => {
  it("agrupa variantes de ponto do Gmail na mesma chave", () => {
    const rows = [
      { ...CLEAN, email: "nome.sobrenome@gmail.com" },
      { ...CLEAN, email: "nomesobrenome@gmail.com" },
    ];
    const groups = groupByCanonicalMailbox(rows);
    assert.equal(groups.size, 1);
    assert.equal([...groups.values()][0].length, 2);
  });

  it("domínio: mesma variação de ponto FORA de gmail.com/googlemail.com NÃO agrupa (ponto é significativo, ex: outlook.com)", () => {
    const rows = [
      { ...CLEAN, email: "nome.sobrenome@outlook.com" },
      { ...CLEAN, email: "nomesobrenome@outlook.com" },
    ];
    const groups = groupByCanonicalMailbox(rows);
    assert.equal(groups.size, 2, "outlook.com: as 2 formas continuam endereços DIFERENTES");
  });
});

describe("resolveMailboxCoherence: supressão propaga pela caixa canônica (#4249 — Problema 1, caso real da issue)", () => {
  it("linha A blacklisted+unsub (send_eligible=0) → linha B da MESMA caixa (elegível, já recebeu) vira inelegível com razão mailbox_suppressed", () => {
    const a: MailboxRow = {
      ...CLEAN,
      email: "lucas.pedido@gmail.com",
      email_blacklisted: true,
      unsubscribed: true,
    };
    const b: MailboxRow = {
      ...CLEAN,
      email: "lucaspedido@gmail.com", // mesma caixa (sem ponto)
      sends_count: 1,
      priority_points: -10,
    };
    const resolved = resolveMailboxCoherence([a, b]);

    assert.equal(resolved.get(a.email)!.send_eligible, false);
    // razão da PRÓPRIA linha suprimida continua a razão de consentimento real
    // (não "mailbox_suppressed" — essa é só pra quem NÃO tem sinal próprio).
    assert.equal(resolved.get(a.email)!.ineligible_reason, "unsubscribed");
    assert.equal(resolved.get(a.email)!.mailbox_suppressed, false);

    assert.equal(resolved.get(b.email)!.send_eligible, false, "supressão vazou — a pessoa pediu pra sair e a linha B continuaria recebendo antes do fix");
    assert.equal(resolved.get(b.email)!.ineligible_reason, "mailbox_suppressed");
    assert.equal(resolved.get(b.email)!.mailbox_suppressed, true);
  });

  it("par de caixas DIFERENTES com nome parecido NÃO se contamina", () => {
    const a: MailboxRow = { ...CLEAN, email: "ana.silva@gmail.com", unsubscribed: true };
    const b: MailboxRow = { ...CLEAN, email: "anasilva2@gmail.com" }; // NÃO é a mesma caixa (sufixo "2")
    const resolved = resolveMailboxCoherence([a, b]);
    assert.equal(resolved.get(b.email)!.send_eligible, true);
    assert.equal(resolved.get(b.email)!.mailbox_suppressed, false);
  });

  it("hard_bounce PROPAGA pra caixa inteira (#4249, decisão do editor 260729 — mesma caixa física)", () => {
    const a: MailboxRow = { ...CLEAN, email: "a.b@gmail.com", hard_bounced: true };
    const b: MailboxRow = { ...CLEAN, email: "ab@gmail.com" };
    const resolved = resolveMailboxCoherence([a, b]);
    assert.equal(resolved.get(a.email)!.send_eligible, false);
    assert.equal(resolved.get(a.email)!.ineligible_reason, "hard_bounce", "linha com o sinal próprio mantém a razão própria, não mailbox_suppressed");
    assert.equal(resolved.get(b.email)!.send_eligible, false, "mesma caixa física — se a.b@ quicou, ab@ também quicaria");
    assert.equal(resolved.get(b.email)!.ineligible_reason, "mailbox_suppressed");
    assert.equal(resolved.get(b.email)!.mailbox_suppressed, true);
  });

  it("linha já inelegível por conta própria (ex: mv_rejected) mantém a PRÓPRIA razão, não mailbox_suppressed", () => {
    const a: MailboxRow = { ...CLEAN, email: "a.b@gmail.com", unsubscribed: true };
    const b: MailboxRow = { ...CLEAN, email: "ab@gmail.com", mv_bucket: "rejected" };
    const resolved = resolveMailboxCoherence([a, b]);
    assert.equal(resolved.get(b.email)!.send_eligible, false);
    assert.equal(resolved.get(b.email)!.ineligible_reason, "mv_rejected");
    assert.equal(resolved.get(b.email)!.mailbox_suppressed, false, "já era inelegível por conta própria — supressão da irmã não é a CAUSA aqui");
  });
});

describe("resolveMailboxCoherence: coerência de cohort (#4249 — Problema 2)", () => {
  it("caixa com assinantes-ativos + leads-2025h2 → AMBAS resolvem assinantes-ativos", () => {
    const payer: MailboxRow = { ...CLEAN, email: "joao.paga@gmail.com", cohort: COHORT_ASSINANTES_ATIVOS };
    const lead: MailboxRow = { ...CLEAN, email: "joaopaga@gmail.com", cohort: "leads-2025h2" };
    const resolved = resolveMailboxCoherence([payer, lead]);
    assert.equal(resolved.get(payer.email)!.cohort, COHORT_ASSINANTES_ATIVOS);
    assert.equal(resolved.get(lead.email)!.cohort, COHORT_ASSINANTES_ATIVOS);
    assert.equal(resolved.get(lead.email)!.cohort_corrected, true);
    assert.equal(resolved.get(payer.email)!.cohort_corrected, false, "já era assinantes-ativos — não é uma 'correção'");
  });

  it("linha promovida a assinantes-ativos herda a isenção de MV (#3819) mesmo vindo de mv_unverified/mv_rejected como lead", () => {
    const payer: MailboxRow = { ...CLEAN, email: "maria.paga@gmail.com", cohort: COHORT_ASSINANTES_ATIVOS };
    // priority_points mais alto pra sobreviver ao dedup DETERMINISTICAMENTE
    // (sem isso, as 2 ficariam elegíveis e empatadas — o ponto deste teste é
    // a isenção de MV, não o desempate; o dedup em si é coberto à parte).
    const lead: MailboxRow = {
      ...CLEAN,
      email: "mariapaga@gmail.com",
      cohort: "ex-assinantes",
      mv_bucket: "rejected",
      priority_points: 40,
    };
    const resolved = resolveMailboxCoherence([payer, lead]);
    assert.equal(resolved.get(lead.email)!.cohort, COHORT_ASSINANTES_ATIVOS);
    assert.equal(
      resolved.get(lead.email)!.send_eligible,
      true,
      "isenção de MV do cohort assinantes-ativos se aplica após a correção",
    );
    assert.equal(resolved.get(lead.email)!.ineligible_reason, null);
  });

  it("caixas diferentes não se contaminam de cohort", () => {
    const a: MailboxRow = { ...CLEAN, email: "x.y@gmail.com", cohort: COHORT_ASSINANTES_ATIVOS };
    const b: MailboxRow = { ...CLEAN, email: "xy2@gmail.com", cohort: "leads-2025h2" }; // caixa DIFERENTE
    const resolved = resolveMailboxCoherence([a, b]);
    assert.equal(resolved.get(b.email)!.cohort, "leads-2025h2");
    assert.equal(resolved.get(b.email)!.cohort_corrected, false);
  });

  it("divergência SEM assinantes-ativos não é corrigida automaticamente — só sinalizada", () => {
    const a: MailboxRow = { ...CLEAN, email: "carlos.lead@gmail.com", cohort: "leads-2025h2" };
    const b: MailboxRow = { ...CLEAN, email: "carloslead@gmail.com", cohort: "ex-assinantes" };
    const resolved = resolveMailboxCoherence([a, b]);
    assert.equal(resolved.get(a.email)!.cohort, "leads-2025h2", "não corrigido — sem precedência óbvia entre 2 cohorts de lead/ex-assinante");
    assert.equal(resolved.get(a.email)!.cohort_diverged_unresolved, true);
    assert.equal(resolved.get(b.email)!.cohort_diverged_unresolved, true);
  });
});

describe("resolveMailboxCoherence: dedup de duplicata na mesma caixa (#4249 — Problema 3)", () => {
  it("2 linhas elegíveis da mesma caixa → mantém só 1 (maior priority_points sobrevive)", () => {
    const strong: MailboxRow = { ...CLEAN, email: "bia.forte@gmail.com", priority_points: 40 };
    const weak: MailboxRow = { ...CLEAN, email: "biaforte@gmail.com", priority_points: 0 };
    const resolved = resolveMailboxCoherence([strong, weak]);
    assert.equal(resolved.get(strong.email)!.send_eligible, true);
    assert.equal(resolved.get(weak.email)!.send_eligible, false);
    assert.equal(resolved.get(weak.email)!.ineligible_reason, "duplicate_mailbox");
    assert.equal(resolved.get(weak.email)!.duplicate_loser, true);
    assert.equal(resolved.get(weak.email)!.tie_break_criterion, "priority_points");
    assert.equal(resolved.get(weak.email)!.survivor_email, strong.email);
  });

  it("empate em priority_points → desempate por opens_count, depois sends_count, depois created", () => {
    const older: MailboxRow = {
      ...CLEAN,
      email: "z.antiga@gmail.com",
      priority_points: 20,
      opens_count: 1,
      created: "2025-01-01T00:00:00.000Z",
    };
    const newer: MailboxRow = {
      ...CLEAN,
      email: "zantiga@gmail.com",
      priority_points: 20,
      opens_count: 1,
      created: "2026-01-01T00:00:00.000Z",
    };
    const resolved = resolveMailboxCoherence([older, newer]);
    assert.equal(resolved.get(newer.email)!.send_eligible, true, "created mais recente sobrevive quando os demais critérios empatam");
    assert.equal(resolved.get(older.email)!.tie_break_criterion, "created");
  });

  it("empate em TODOS os critérios → tie_break_criterion='arbitrary' (desempate final determinístico por e-mail, exatamente 1 sobrevive)", () => {
    // "cccc" e "cc.cc" canonicalizam pra MESMA caixa (dot ignorado no Gmail)
    // — só o ponto interno distingue as 2 linhas, tudo o mais idêntico.
    const a: MailboxRow = { ...CLEAN, email: "cccc@gmail.com", priority_points: 0 };
    const b: MailboxRow = { ...CLEAN, email: "cc.cc@gmail.com", priority_points: 0 };
    const resolved = resolveMailboxCoherence([a, b]);
    const ra = resolved.get(a.email)!;
    const rb = resolved.get(b.email)!;
    // exatamente 1 sobrevive, 1 perde — desempate determinístico (não testa
    // QUAL das 2 vence, só que a resolução é total e o critério é 'arbitrary').
    assert.notEqual(ra.send_eligible, rb.send_eligible);
    const loserRes = ra.duplicate_loser ? ra : rb;
    assert.equal(loserRes.tie_break_criterion, "arbitrary");
    assert.equal(loserRes.ineligible_reason, "duplicate_mailbox");
  });

  it("dedup só considera quem sobra elegível DEPOIS da supressão/cohort (linha já inelegível por conta própria não compete no dedup)", () => {
    // mv_rejected é um veredito PRÓPRIO da linha (não propaga pra caixa —
    // diferente de unsubscribed/blacklist/complaint/hard_bounce, #4249) — com
    // priority_points: 0 (sem override por engajamento, #2876) fica
    // inelegível só por conta própria, isolando o dedup da propagação de
    // supressão do Problema 1, testada à parte.
    const alreadyIneligible: MailboxRow = { ...CLEAN, email: "d.e@gmail.com", mv_bucket: "rejected", priority_points: 0 };
    const survivor: MailboxRow = { ...CLEAN, email: "de@gmail.com", priority_points: 0 };
    const resolved = resolveMailboxCoherence([alreadyIneligible, survivor]);
    assert.equal(resolved.get(alreadyIneligible.email)!.send_eligible, false);
    assert.equal(resolved.get(alreadyIneligible.email)!.ineligible_reason, "mv_rejected");
    assert.equal(resolved.get(alreadyIneligible.email)!.duplicate_loser, false, "não é duplicata — nunca chegou a ser candidata (já inelegível por conta própria)");
    assert.equal(resolved.get(survivor.email)!.send_eligible, true, "única elegível remanescente — não é uma 'duplicata perdedora'");
    assert.equal(resolved.get(survivor.email)!.duplicate_loser, false);
  });
});

describe("recomputeDerived: integra coerência de caixa canônica end-to-end via SQLite real (#4249)", () => {
  it("cenário real da issue: unsub numa linha suprime a linha irmã da mesma caixa", () => {
    const db = openClariceDb(":memory:");
    db.prepare(
      "INSERT INTO clarice_users (email, unsubscribed, email_blacklisted) VALUES (?, 1, 1)",
    ).run("lucas.saiu@gmail.com");
    // mv_bucket='verified' — sem isso a linha já seria inelegível por conta
    // própria (mv_unverified), o que mascararia o efeito que este teste
    // quer provar (a PROPAGAÇÃO da supressão da linha irmã).
    db.prepare(
      "INSERT INTO clarice_users (email, sends_count, opens_count, mv_bucket) VALUES (?, 1, 0, 'verified')",
    ).run("lucassaiu@gmail.com");

    recomputeDerived(db);

    const sibling = db
      .prepare("SELECT send_eligible, ineligible_reason FROM clarice_users WHERE email = ?")
      .get("lucassaiu@gmail.com") as { send_eligible: number; ineligible_reason: string | null };
    assert.equal(sibling.send_eligible, 0, "supressão da linha unsub propagou pra caixa canônica");
    assert.equal(sibling.ineligible_reason, "mailbox_suppressed");

    db.close();
  });

  it("2 linhas elegíveis da mesma caixa → só 1 fica send_eligible=1 após recompute", () => {
    const db = openClariceDb(":memory:");
    db.prepare(
      "INSERT INTO clarice_users (email, opens_count, sends_count, mv_bucket) VALUES (?, 2, 2, 'verified')",
    ).run("dupla.a@gmail.com");
    db.prepare(
      "INSERT INTO clarice_users (email, opens_count, sends_count, mv_bucket) VALUES (?, 0, 0, 'verified')",
    ).run("duplaa@gmail.com");

    recomputeDerived(db);

    const rows = db
      .prepare("SELECT email, send_eligible FROM clarice_users ORDER BY email")
      .all() as Array<{ email: string; send_eligible: number }>;
    const eligibleCount = rows.filter((r) => r.send_eligible === 1).length;
    assert.equal(eligibleCount, 1, "dedup: só 1 linha da mesma caixa fica elegível");

    db.close();
  });

  it("caixa com assinantes-ativos (tier 1) + lead (tier 4) na mesma caixa → lead herda cohort assinantes-ativos", () => {
    const db = openClariceDb(":memory:");
    db.prepare(
      "INSERT INTO clarice_users (email, tier, cohort) VALUES (?, 1, ?)",
    ).run("paga.conta@gmail.com", COHORT_ASSINANTES_ATIVOS);
    // opens_count alto: sobrevive ao dedup DETERMINISTICAMENTE (maior
    // priority_points) — sem isso as 2 linhas empatariam (ambas elegíveis
    // pós-correção) e o desempate arbitrário poderia escolher a outra,
    // mascarando o que este teste quer provar (a isenção de MV herdada).
    db.prepare(
      "INSERT INTO clarice_users (email, tier, mv_bucket, opens_count, sends_count) VALUES (?, 4, 'rejected', 2, 2)",
    ).run("pagaconta@gmail.com");

    recomputeDerived(db);

    const lead = db
      .prepare("SELECT cohort, send_eligible, ineligible_reason FROM clarice_users WHERE email = ?")
      .get("pagaconta@gmail.com") as { cohort: string; send_eligible: number; ineligible_reason: string | null };
    assert.equal(lead.cohort, COHORT_ASSINANTES_ATIVOS);
    assert.equal(lead.send_eligible, 1, "herdou a isenção de MV do cohort assinantes-ativos");
    assert.equal(lead.ineligible_reason, null);

    db.close();
  });
});

describe("computeMailboxDryrunReport (#4249) — mesma função de resolução do caminho real, só contabilidade", () => {
  it("conta transições elegível→inelegível por causa e reporta cohort-corrigido à parte", () => {
    const rows: MailboxRow[] = [
      // Problema 1: supressão propaga (mesma caixa: "supressor" com/sem ponto interno).
      { ...CLEAN, email: "supressor@gmail.com", unsubscribed: true },
      { ...CLEAN, email: "supres.sor@gmail.com", priority_points: 10, sends_count: 1 },
      // Problema 2: cohort corrigido. NOTA: como a linha promovida a
      // assinantes-ativos e a linha PAGANTE ficam AMBAS elegíveis pós-correção
      // (nenhuma supressão as separa), esta mesma dupla TAMBÉM entra em dedup
      // (Problema 3) — cohort-corrigido e duplicata-mesma-caixa não são
      // independentes num grupo de 2 linhas sem supressão. A transição real
      // (perde elegibilidade) é atribuída à causa duplicata, nunca à correção
      // de cohort em si (que só AUMENTA elegibilidade, nunca reduz).
      { ...CLEAN, email: "assinante.dup@gmail.com", cohort: COHORT_ASSINANTES_ATIVOS },
      { ...CLEAN, email: "assinantedup@gmail.com", cohort: "leads-2025h2" },
      // Problema 3: dedup (desempate determinístico por priority_points).
      { ...CLEAN, email: "gemea.a@gmail.com", priority_points: 50 },
      { ...CLEAN, email: "gemeaa@gmail.com", priority_points: 5 },
    ];
    const report = computeMailboxDryrunReport(rows);

    assert.equal(report.groups_with_collision, 3);
    assert.equal(report.eligible_to_ineligible.supressao_propagada, 1);
    assert.equal(report.eligible_to_ineligible.duplicata_mesma_caixa, 2, "inclui a dupla assinante+lead — ver nota acima");
    assert.equal(report.eligible_to_ineligible.total, 3);
    assert.equal(report.cohort_correction.groups_corrected, 1);
    assert.equal(report.cohort_correction.rows_corrected, 1);
    assert.equal(report.cohort_correction.diverged_unresolved.length, 0);

    const md = renderMailboxDryrunMarkdown(report);
    assert.match(md, /Dry-run — coerência por caixa canônica \(#4249\)/);
    assert.match(md, /READ-ONLY/);
  });
});
