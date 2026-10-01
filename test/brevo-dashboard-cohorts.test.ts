/**
 * #2426: coortes de engajamento por contato no clarice-dashboard.
 *
 * Cobre:
 *  - computeCohorts: partição mutuamente exclusiva + precedência de saída
 *    (bounce/unsub ganha de open), bucketing por (recebido, aberto), universo,
 *    maxReceived e breakdown disjunto (bounced + optedOut = exits).
 *  - renderEngagementCohortsSection: stub gracioso (null), contagens, rótulo "2+".
 *  - renderDashboardHtml injeta a seção.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCohorts,
  type ContactEngagement,
} from "../scripts/lib/engagement-cohorts.ts";
import {
  renderEngagementCohortsSection,
  renderDashboardHtml,
  type EngagementCohorts,
} from "../workers/brevo-dashboard/src/index.ts";

const GEN = "2026-06-19T12:00:00Z";

function eng(p: Partial<ContactEngagement>): ContactEngagement {
  return { received: 0, opened: 0, bounced: false, optedOut: false, ...p };
}

test("computeCohorts: bucketiza por (recebido, aberto) sem saídas", () => {
  const r = computeCohorts(
    [
      eng({ received: 2, opened: 2 }), // opened2plus
      eng({ received: 3, opened: 5 }), // opened2plus (>=2)
      eng({ received: 2, opened: 1 }), // opened1
      eng({ received: 1, opened: 1 }), // opened1
      eng({ received: 1, opened: 0 }), // received1_opened0
      eng({ received: 2, opened: 0 }), // received2_opened0
      eng({ received: 4, opened: 0 }), // received2_opened0 (>=2)
    ],
    GEN,
  );
  assert.equal(r.opened2plus, 2);
  assert.equal(r.opened1, 2);
  assert.equal(r.received1_opened0, 1);
  assert.equal(r.received2_opened0, 2);
  assert.equal(r.exits, 0);
  assert.equal(r.universe, 7);
  assert.equal(r.maxReceived, 4);
});

test("computeCohorts: saída tem precedência — bounce/unsub nunca conta em coorte de open", () => {
  const r = computeCohorts(
    [
      eng({ received: 2, opened: 2, bounced: true }), // saída (não opened2plus)
      eng({ received: 1, opened: 1, optedOut: true }), // saída (não opened1)
      eng({ received: 0, opened: 0, bounced: true }), // saída via bounce sem entrega
      eng({ received: 2, opened: 2 }), // opened2plus
    ],
    GEN,
  );
  assert.equal(r.exits, 3);
  assert.equal(r.opened2plus, 1);
  assert.equal(r.opened1, 0);
  // breakdown disjunto: 2 bounce + 1 optedOut = 3 exits
  assert.equal(r.exitsBreakdown.bounced, 2);
  assert.equal(r.exitsBreakdown.optedOut, 1);
  assert.equal(
    r.exitsBreakdown.bounced + r.exitsBreakdown.optedOut,
    r.exits,
  );
});

test("computeCohorts: partição completa — cada contato em exatamente uma coorte", () => {
  const contacts = [
    eng({ received: 2, opened: 2 }),
    eng({ received: 1, opened: 1 }),
    eng({ received: 1, opened: 0 }),
    eng({ received: 2, opened: 0 }),
    eng({ received: 2, opened: 1, bounced: true }),
    eng({ received: 5, opened: 3 }),
  ];
  const r = computeCohorts(contacts, GEN);
  const sum =
    r.opened2plus + r.opened1 + r.received1_opened0 + r.received2_opened0 + r.exits;
  assert.equal(sum, r.universe);
  assert.equal(r.universe, contacts.length);
});

test("computeCohorts: contatos fora do universo (received 0, opened 0, sem saída) são ignorados", () => {
  const r = computeCohorts(
    [eng({ received: 0, opened: 0 }), eng({ received: 1, opened: 0 })],
    GEN,
  );
  assert.equal(r.universe, 1);
  assert.equal(r.received1_opened0, 1);
});

test("computeCohorts: opened>0 com received=0 (anomalia Brevo) é contado, não descartado", () => {
  const r = computeCohorts(
    [eng({ received: 0, opened: 2 }), eng({ received: 0, opened: 1 })],
    GEN,
  );
  assert.equal(r.universe, 2);
  assert.equal(r.opened2plus, 1);
  assert.equal(r.opened1, 1);
});

const SAMPLE: EngagementCohorts = {
  generatedAt: GEN,
  universe: 1000,
  opened2plus: 100,
  opened1: 200,
  received1_opened0: 300,
  received2_opened0: 250,
  exits: 150,
  exitsBreakdown: { bounced: 90, optedOut: 60 },
  maxReceived: 2,
};

test("renderEngagementCohortsSection: stub gracioso quando null", () => {
  const html = renderEngagementCohortsSection(null);
  assert.match(html, /Coortes de engajamento/);
  assert.match(html, /clarice-engagement-cohorts/);
});

test("renderEngagementCohortsSection: renderiza contagens e universo", () => {
  const html = renderEngagementCohortsSection(SAMPLE);
  // #2429: rótulo atualizado para "pessoas únicas alcançadas" (≠ eventos de envio)
  assert.match(html, /1\.000 pessoas únicas alcançadas/);
  assert.match(html, /100/); // opened2plus
  assert.match(html, /Saídas/);
  assert.match(html, /exatamente uma/); // explica exclusividade
});

// #2429: testa novos rótulos e tooltips que distinguem pessoas únicas de eventos de envio
test("renderEngagementCohortsSection: #2429 rótulo 'Pessoas únicas alcançadas' e tooltip de dedupagem", () => {
  const html = renderEngagementCohortsSection(SAMPLE);
  // Rótulo principal do universo
  assert.match(html, /pessoas únicas alcançadas/i, "deve usar rótulo 'pessoas únicas alcançadas'");
  // Tooltip com explicação de dedupagem
  assert.match(html, /title="[^"]*únicos dedupados[^"]*"/, "deve ter tooltip explicando deduplicação");
  // Coluna da tabela deve ser "Pessoas únicas", não apenas "Pessoas"
  assert.match(html, /Pessoas únicas<\/th>/, "coluna deve ser 'Pessoas únicas'");
});

test("renderEngagementCohortsSection: rótulos dos buckets ≥2 são sempre '2+' (independente de maxReceived)", () => {
  // O bucket é definido como ≥2, então "2+" é sempre exato — não acopla a maxReceived.
  assert.match(renderEngagementCohortsSection(SAMPLE), /Abriu 2\+ e-mails/);
  assert.match(renderEngagementCohortsSection(SAMPLE), /Recebeu 2\+, não abriu/);
  const big = { ...SAMPLE, maxReceived: 4 };
  assert.match(renderEngagementCohortsSection(big), /Abriu 2\+ e-mails/);
});

test("renderDashboardHtml: injeta a seção de coortes quando fornecida", () => {
  const html = renderDashboardHtml([], [], SAMPLE);
  assert.match(html, /id="engagement-cohorts"/);
  // #2429: rótulo atualizado para "pessoas únicas alcançadas"
  assert.match(html, /1\.000 pessoas únicas alcançadas/);
});

test("renderDashboardHtml: seção mostra stub quando cohorts ausente (default null)", () => {
  const html = renderDashboardHtml([]);
  assert.match(html, /id="engagement-cohorts"/);
  assert.match(html, /clarice-engagement-cohorts/);
});

// ─── #2441: tfoot de totalização nas Coortes de engajamento ──────────────────

test("#2441 renderEngagementCohortsSection: tfoot presente com total = universe", () => {
  const html = renderEngagementCohortsSection(SAMPLE);
  // Deve ter <tfoot>
  assert.match(html, /<tfoot>/, "deve ter <tfoot>");
  // Linha de total deve exibir o universe formatado (1.000 para 1000 em pt-BR)
  assert.match(html, /1\.000/, "deve exibir universe (1000) formatado em pt-BR no tfoot");
  // Percentual deve ser 100%
  assert.match(html, /100%/, "tfoot deve exibir 100% em % do universo");
});

test("#2441 renderEngagementCohortsSection: tfoot sem alerta quando soma == universe", () => {
  // SAMPLE: 100+200+300+250+150 = 1000 = universe — sem mismatch
  const html = renderEngagementCohortsSection(SAMPLE);
  // Não deve ter o badge de alerta ⚠️
  assert.doesNotMatch(html, /⚠️/, "não deve ter alerta ⚠️ quando soma == universe");
});

test("#2441 renderEngagementCohortsSection: tfoot com alerta quando soma != universe", () => {
  // Criar cohorts com universe artificialmente maior (mismatch intencional)
  const mismatch: EngagementCohorts = {
    ...SAMPLE,
    universe: 1001, // soma real = 1000, universe = 1001 → mismatch
  };
  const html = renderEngagementCohortsSection(mismatch);
  // Deve ter badge de alerta ⚠️
  assert.match(html, /⚠️/, "deve ter alerta ⚠️ quando soma != universe");
});

// ─── #2446 (reaberta): tooltips EXCLUEM MPP ──

test("#2446 computeCohorts: contato com opened=0 (sem trackable, mesmo com MPP externo) cai em 'Recebeu 1, não abriu'", () => {
  // As coortes usam statistics.opened (trackable, EXCLUI MPP). Contato com 0
  // aberturas trackable cai em "não abriu", mesmo que tenha MPP em nível de campanha.
  const contacts: ContactEngagement[] = [
    eng({ received: 1, opened: 1 }), // abertura trackable real
    eng({ received: 1, opened: 0 }), // sem abertura trackable (MPP não conta)
  ];
  const r = computeCohorts(contacts, GEN);
  assert.equal(r.opened1, 1, "contato com opened=1 trackable deve cair em opened1");
  assert.equal(r.received1_opened0, 1, "contato com opened=0 deve cair em received1_opened0 (MPP não conta)");
});

test("#2446 renderEngagementCohortsSection: tooltips de 'Abriu 2+' E 'Abriu 1' mencionam EXCLUI MPP / trackable", () => {
  const html = renderEngagementCohortsSection(SAMPLE);
  // Os tooltips devem usar semântica de EXCLUI MPP (não 'Inclui aberturas MPP/machine').
  assert.doesNotMatch(
    html,
    /Inclui aberturas MPP\/machine/,
    "tooltips NÃO devem dizer 'Inclui aberturas MPP/machine' (era falso — corrigido em #2446)",
  );
  // Ancorar nos ATRIBUTOS title= das DUAS linhas de abertura — não no blob inteiro
  // (self-review #2446): a nota da seção menciona EXCLUI MPP mas é <p>, não title=.
  // Contar title="...trackable/EXCLUI MPP..." pega só as linhas 'Abriu 2+' e 'Abriu 1';
  // uma regressão que tire o texto de uma/ambas é capturada (antes passava verde).
  const rowTooltips = html.match(/title="[^"]*(?:trackable|EXCLUI MPP)[^"]*"/gi) ?? [];
  assert.ok(
    rowTooltips.length >= 2,
    `ambas as linhas 'Abriu 2+' e 'Abriu 1' devem ter tooltip trackable/EXCLUI MPP (achou ${rowTooltips.length})`,
  );
});

test("#2446 renderEngagementCohortsSection: nota da seção diz EXCLUI MPP e diferencia de Totais por mês", () => {
  const html = renderEngagementCohortsSection(SAMPLE);
  assert.match(
    html,
    /EXCLUI MPP/,
    "nota da seção deve explicar que aberturas EXCLUEM MPP (corrigido em #2446)",
  );
  assert.match(
    html,
    /Totais por m/,
    "nota da seção deve mencionar 'Totais por mês' para contextualizar a diferença",
  );
});
