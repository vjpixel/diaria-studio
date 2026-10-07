/**
 * test/channel-cohort-funnel.test.ts (#7918)
 *
 * Cobre os cenários de verificação pedidos pela issue: confirmação tardia,
 * eventos repetidos, coorte imatura, origem ausente, gasto sem
 * correspondência — mais a distinção falta-de-dado × ausência-de-evento e a
 * preservação da janela de gasto do relatório de 3 dias.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIRMACAO_JANELA_HORAS,
  LEITOR_V1_MATURACAO_DIAS,
  buildChannelCohortFunnel,
  buildCohortSpendInputs,
  computeCohortCost,
  dedupePeople,
  mondayOf,
  type FunnelPersonInput,
  type FunnelSources,
} from "../scripts/lib/metrics/channel-cohort-funnel.ts";
import { firstClickAtOrAfter, loadFunnelInputFromStore, resolveConfirmacaoFromStore } from "../scripts/lib/metrics/channel-cohort-funnel-store.ts";
import { computeRollingWindow } from "../scripts/lib/ads-rolling-window.ts";
import type { ClicksCsvRow } from "../scripts/lib/ads-test-watch.ts";
import { ensureSubscriber, openDiariaSubscribersDb, recordEvent, upsertSubscription } from "../scripts/lib/diaria-subscribers-db.ts";
import { main as cliMain } from "../scripts/channel-cohort-funnel.ts";

const NOW = "2026-10-07T15:00:00.000Z";
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * DAY).toISOString();

const SRC = (disponivel = true): FunnelSources["cadastro"] => ({ fonte: "fixture", frescor: NOW, disponivel, ...(disponivel ? {} : { motivo: "coleta falhou" }) });
const FONTES: FunnelSources = { cadastro: SRC(), confirmacao: SRC(), entrega: SRC(), engajamento: SRC() };

function person(over: Partial<FunnelPersonInput> & { personKey: string }): FunnelPersonInput {
  return {
    email: `${over.personKey}@exemplo.com.br`,
    enteredAt: daysAgo(40),
    utmSource: "meta-ads",
    utmMedium: null,
    utmCampaign: "camp-a",
    utmChannel: null,
    referringSite: null,
    destino: "home",
    reativado: false,
    confirmacao: { observavel: true, confirmado: true, confirmadoEm: null },
    entrega: { observavel: true, edicoesRecebidas: 25 },
    engajamento: {
      observavel: true,
      primeiroCliqueEm: null,
      leitor: { status: "active", totalReceived: 25, totalUniqueClicked: 0 },
    },
    ...over,
  };
}

const SPEND_BASE = { canal: "Meta Ads (teste 2608)", origens: ["meta-ads"], gasto: 300, fonte: "csv", frescor: null };

function onlyRow(people: FunnelPersonInput[], fontes = FONTES) {
  const rep = buildChannelCohortFunnel(people, { now: NOW, fontes });
  assert.equal(rep.rows.length, 1, JSON.stringify(rep.rows.map((r) => [r.periodo, r.origem, r.segmento])));
  return { rep, row: rep.rows[0] };
}

test("cadastro aceito sem sinal de confirmação NÃO conta como confirmado (ausência medida, não falta de dado)", () => {
  const { row } = onlyRow([person({ personKey: "1", confirmacao: { observavel: true, confirmado: false, confirmadoEm: null } })]);
  assert.equal(row.cadastrosAceitos, 1);
  assert.equal(row.confirmacao.numerador, 0);
  assert.equal(row.confirmacao.denominador, 1);
  assert.equal(row.confirmacao.estado, "medido");
  assert.equal(row.confirmacao.taxa, 0);
});

test("confirmação tardia conta quando chega e é contada à parte", () => {
  const entered = daysAgo(40);
  const late = new Date(Date.parse(entered) + (CONFIRMACAO_JANELA_HORAS + 24) * 3600_000).toISOString();
  const onTime = new Date(Date.parse(entered) + 3600_000).toISOString();
  const { row } = onlyRow([
    person({ personKey: "1", enteredAt: entered, confirmacao: { observavel: true, confirmado: true, confirmadoEm: late } }),
    person({ personKey: "2", enteredAt: entered, confirmacao: { observavel: true, confirmado: true, confirmadoEm: onTime } }),
  ]);
  assert.equal(row.confirmacao.numerador, 2);
  assert.equal(row.confirmadosTardios, 1);
});

test("confirmadosTardios é null (desconhecido) quando nenhum membro tem instante de confirmação", () => {
  const { row } = onlyRow([person({ personKey: "1" })]);
  assert.equal(row.confirmadosTardios, null);
});

test("evento repetido da mesma pessoa não duplica pessoa nem conversão", () => {
  const a = person({ personKey: "7", confirmacao: { observavel: true, confirmado: false, confirmadoEm: null } });
  const b = person({ personKey: "7", confirmacao: { observavel: true, confirmado: true, confirmadoEm: null } });
  const { rep, row } = onlyRow([a, b, b]);
  assert.equal(rep.resumo.duplicatasFundidas, 2);
  assert.equal(row.cadastrosAceitos, 1);
  assert.equal(row.confirmacao.numerador, 1);
  assert.equal(row.confirmacao.denominador, 1);
});

test("dedupePeople mantém o cadastro mais antigo e o 1º clique mais antigo", () => {
  const { people } = dedupePeople([
    person({ personKey: "x", enteredAt: daysAgo(10), engajamento: { observavel: true, primeiroCliqueEm: daysAgo(2), leitor: { status: "active", totalReceived: 5, totalUniqueClicked: 1 } } }),
    person({ personKey: "x", enteredAt: daysAgo(30), engajamento: { observavel: true, primeiroCliqueEm: daysAgo(20), leitor: { status: "active", totalReceived: 3, totalUniqueClicked: 1 } } }),
  ]);
  assert.equal(people.length, 1);
  assert.equal(people[0].enteredAt, daysAgo(30));
  const e = people[0].engajamento;
  assert.ok(e.observavel);
  assert.equal(e.primeiroCliqueEm, daysAgo(20));
  assert.equal(e.leitor.totalReceived, 5);
});

test("coorte imatura fica em observação — 14d e leitor-v1 não saem como taxa", () => {
  const { row } = onlyRow([
    person({
      personKey: "1",
      enteredAt: daysAgo(3),
      entrega: { observavel: true, edicoesRecebidas: 2 },
      engajamento: { observavel: true, primeiroCliqueEm: daysAgo(2), leitor: { status: "active", totalReceived: 2, totalUniqueClicked: 1 } },
    }),
  ]);
  assert.equal(row.emObservacao, true);
  assert.equal(row.idadeDias, 3);
  assert.equal(row.primeiroClique14d.estado, "em-observacao");
  assert.equal(row.primeiroClique14d.taxa, null);
  assert.equal(row.primeiroClique14d.numerador, null);
  assert.equal(row.leitorV1.estado, "em-observacao");
  assert.equal(row.leitorV1.taxa, null);
  assert.equal(row.confirmacao.estado, "medido", "3 dias > 48h: confirmação já maturou");
});

test("coorte madura: 1º clique em 14d e leitor-v1 medidos com numerador/denominador/janela/fonte/frescor", () => {
  const entered = daysAgo(LEITOR_V1_MATURACAO_DIAS + 5);
  const click = new Date(Date.parse(entered) + 3 * DAY).toISOString();
  const { row } = onlyRow([
    person({ personKey: "1", enteredAt: entered, engajamento: { observavel: true, primeiroCliqueEm: click, leitor: { status: "active", totalReceived: 25, totalUniqueClicked: 2 } } }),
    person({ personKey: "2", enteredAt: entered }),
  ]);
  assert.equal(row.emObservacao, false);
  for (const r of [row.confirmacao, row.entrega, row.primeiroClique14d, row.leitorV1]) {
    assert.equal(r.estado, "medido", r.etapa);
    assert.ok(r.janela.length > 0 && r.fonte === "fixture" && r.frescor === NOW, r.etapa);
  }
  assert.deepEqual([row.primeiroClique14d.numerador, row.primeiroClique14d.denominador], [1, 2]);
  assert.deepEqual([row.leitorV1.numerador, row.leitorV1.denominador], [1, 2]);
});

test("origem ausente fica identificada como sem atribuição (nunca orgânico implícito)", () => {
  const { rep, row } = onlyRow([person({ personKey: "1", utmSource: null, utmCampaign: null, referringSite: null })]);
  assert.equal(row.origem, null);
  assert.equal(row.atribuido, false);
  assert.equal(row.classe, "indeterminado");
  assert.equal(rep.resumo.semAtribuicao, 1);
});

test("migrados e reativados ficam em segmento próprio, separados dos novos", () => {
  const rep = buildChannelCohortFunnel(
    [
      person({ personKey: "novo" }),
      person({ personKey: "mig", utmChannel: "import" }),
      person({ personKey: "reat", reativado: true }),
      person({ personKey: "brevo", utmSource: "brevo-diaria" }),
    ],
    { now: NOW, fontes: FONTES },
  );
  const segs = rep.rows.map((r) => r.segmento).sort();
  assert.deepEqual(segs, ["migrado", "novo", "reativado", "reativado"]);
  assert.equal(rep.resumo.migrados, 1);
  assert.equal(rep.resumo.reativados, 2);
  const mig = rep.rows.find((r) => r.segmento === "migrado")!;
  assert.equal(mig.primeiroClique14d.estado, "nao-observavel");
});

test("cadastro datado do dia do import Beehiiv→Kit é migração, nunca aquisição nova (nem no custo)", () => {
  const importDay = "2026-08-24T15:00:00.000Z";
  const { row } = onlyRow([person({ personKey: "1", enteredAt: importDay })]);
  assert.equal(row.segmento, "migrado");
  const c = computeCohortCost([person({ personKey: "1", enteredAt: importDay })], { ...SPEND_BASE, de: "2026-08-24", ate: "2026-08-24" }, { now: NOW, fontes: FONTES });
  assert.equal(c.populacao, 0);
  assert.equal(c.excluidosNaoNovos, 1);
  assert.equal(c.estado, "indisponivel");
});

test("cobertura marca coortes antes/depois/atravessando a migração Kit", () => {
  const rep = buildChannelCohortFunnel(
    [
      person({ personKey: "a", enteredAt: "2026-08-10T15:00:00.000Z" }),
      person({ personKey: "b", enteredAt: "2026-09-10T15:00:00.000Z" }),
      person({ personKey: "c", enteredAt: "2026-08-23T15:00:00.000Z" }),
      person({ personKey: "d", enteredAt: "2026-08-26T15:00:00.000Z" }),
    ],
    { now: NOW, fontes: FONTES },
  );
  const byPeriodo = Object.fromEntries(rep.rows.map((r) => [r.periodo, r.cobertura]));
  assert.equal(byPeriodo["2026-08-10"], "pre-kit");
  assert.equal(byPeriodo["2026-09-07"], "kit");
  // 2026-08-23 é domingo (semana de 17/08); 2026-08-26 cai na semana de 24/08.
  assert.equal(byPeriodo["2026-08-17"], "pre-kit");
  assert.equal(byPeriodo["2026-08-24"], "kit");
});

test("falta de dado (fonte indisponível) ≠ não observável ≠ ausência de evento", () => {
  const semFonte = onlyRow([person({ personKey: "1" })], { ...FONTES, engajamento: SRC(false) }).row;
  assert.equal(semFonte.primeiroClique14d.estado, "sem-dados");
  assert.equal(semFonte.leitorV1.estado, "sem-dados");
  assert.equal(semFonte.leitorV1.numerador, null);

  const beehiivOnly = onlyRow([person({ personKey: "1", confirmacao: { observavel: false, motivo: "sem Kit" } })]).row;
  assert.equal(beehiivOnly.confirmacao.estado, "nao-observavel");
  assert.equal(beehiivOnly.confirmacao.denominador, null);

  const ninguemClicou = onlyRow([person({ personKey: "1" })]).row;
  assert.equal(ninguemClicou.primeiroClique14d.estado, "medido");
  assert.equal(ninguemClicou.primeiroClique14d.numerador, 0);
});

test("contas internas/teste ficam fora e são contadas", () => {
  const rep = buildChannelCohortFunnel([person({ personKey: "1" }), person({ personKey: "2", email: "vjpixel@gmail.com" })], {
    now: NOW,
    fontes: FONTES,
  });
  assert.equal(rep.resumo.internasOuTesteExcluidas, 1);
  assert.equal(rep.rows[0].cadastrosAceitos, 1);
});

test("granularidade semana rotula pela segunda-feira BRT e agrupa campanha/destino", () => {
  assert.equal(mondayOf("2026-10-07"), "2026-10-05");
  assert.equal(mondayOf("2026-10-05"), "2026-10-05");
  const rep = buildChannelCohortFunnel(
    [person({ personKey: "1", utmCampaign: "a" }), person({ personKey: "2", utmCampaign: "b" })],
    { now: NOW, fontes: FONTES },
  );
  assert.equal(rep.rows.length, 2);
  const agrupado = buildChannelCohortFunnel(
    [person({ personKey: "1", utmCampaign: "a" }), person({ personKey: "2", utmCampaign: "b" })],
    { now: NOW, fontes: FONTES, porCampanha: false },
  );
  assert.equal(agrupado.rows.length, 1);
  assert.equal(agrupado.rows[0].campanha, null);
});

// ---------------------------------------------------------------------------
// Custo
// ---------------------------------------------------------------------------

const SPEND = { canal: "Meta Ads (teste 2608)", origens: ["meta-ads"], gasto: 300, fonte: "csv", frescor: null };

test("gasto sem correspondência na população: custo indisponível, nunca dividido por outra coorte", () => {
  const c = computeCohortCost([person({ personKey: "1", enteredAt: daysAgo(60) })], { ...SPEND, de: "2026-09-20", ate: "2026-09-22" }, { now: NOW, fontes: FONTES });
  assert.equal(c.estado, "indisponivel");
  assert.equal(c.populacao, 0);
  assert.equal(c.custoPorConfirmado, null);
  assert.match(c.motivo ?? "", /sem correspondência/);
});

test("custo usa só a população NOVA da mesma origem e janela", () => {
  const dentro = "2026-08-20T15:00:00.000Z";
  const c = computeCohortCost(
    [
      person({ personKey: "1", enteredAt: dentro }),
      person({ personKey: "2", enteredAt: dentro, confirmacao: { observavel: true, confirmado: false, confirmadoEm: null } }),
      person({ personKey: "3", enteredAt: dentro, utmSource: "google-ads" }),
      person({ personKey: "4", enteredAt: "2026-08-25T15:00:00.000Z" }),
      person({ personKey: "5", enteredAt: dentro, reativado: true }),
      person({
        personKey: "6",
        enteredAt: dentro,
        engajamento: { observavel: true, primeiroCliqueEm: null, leitor: { status: "active", totalReceived: 25, totalUniqueClicked: 3 } },
      }),
    ],
    { ...SPEND, de: "2026-08-19", ate: "2026-08-21" },
    { now: NOW, fontes: FONTES },
  );
  assert.equal(c.populacao, 3);
  assert.equal(c.excluidosNaoNovos, 1);
  assert.equal(c.confirmados, 2);
  assert.equal(c.custoPorConfirmado, 150);
  assert.equal(c.leitores, 1);
  assert.equal(c.custoPorLeitor, 300);
  assert.equal(c.custoPorCadastro, 100);
  assert.equal(c.estado, "calculado");
});

test("custo por confirmado vira TETO declarado quando parte da população não tem estado DOI legível", () => {
  const dentro = "2026-08-20T15:00:00.000Z";
  const c = computeCohortCost(
    [person({ personKey: "1", enteredAt: dentro }), person({ personKey: "2", enteredAt: dentro, confirmacao: { observavel: false, motivo: "cancelled" } })],
    { ...SPEND, de: "2026-08-19", ate: "2026-08-21" },
    { now: NOW, fontes: FONTES },
  );
  assert.equal(c.confirmados, 1);
  assert.equal(c.custoPorConfirmado, 300);
  assert.equal(c.custoPorConfirmadoQualidade, "teto");
  assert.match(c.motivoConfirmado ?? "", /1\/2.*TETO/);
  assert.equal(c.estado, "parcial");
});

test("custo por confirmado indisponível quando ninguém da população tem confirmação observável", () => {
  const dentro = "2026-08-20T15:00:00.000Z";
  const c = computeCohortCost(
    [person({ personKey: "1", enteredAt: dentro, confirmacao: { observavel: false, motivo: "sem Kit" } })],
    { ...SPEND, de: "2026-08-19", ate: "2026-08-21" },
    { now: NOW, fontes: FONTES },
  );
  assert.equal(c.custoPorConfirmado, null);
  assert.equal(c.custoPorConfirmadoQualidade, null);
  assert.equal(c.confirmados, null);
});

test("ressalva do gasto (sem linha-base) impede o estado 'calculado' e aparece no motivo", () => {
  const dentro = "2026-08-20T15:00:00.000Z";
  const c = computeCohortCost(
    [person({ personKey: "1", enteredAt: dentro })],
    { ...SPEND, de: "2026-08-19", ate: "2026-08-21", ressalvaGasto: "sem linha-base" },
    { now: NOW, fontes: FONTES },
  );
  assert.equal(c.custoPorConfirmado, 300);
  assert.equal(c.estado, "parcial");
  assert.match(c.motivo ?? "", /sem linha-base/);
});

test("coorte de custo imatura: leitor em observação, janela com dia em curso é recusada", () => {
  const recente = daysAgo(4);
  const de = recente.slice(0, 10);
  const c = computeCohortCost([person({ personKey: "1", enteredAt: recente })], { ...SPEND, de, ate: de }, { now: NOW, fontes: FONTES });
  assert.equal(c.custoPorLeitor, null);
  assert.match(c.motivoLeitor ?? "", /observação/);
  assert.equal(c.custoPorConfirmado, 300);

  const hoje = computeCohortCost([person({ personKey: "1" })], { ...SPEND, de: "2026-10-05", ate: "2026-10-07" }, { now: NOW, fontes: FONTES });
  assert.equal(hoje.estado, "indisponivel");
  assert.match(hoje.motivo ?? "", /dia em curso/);
});

test("buildCohortSpendInputs reusa exatamente o gasto da janela do relatório de 3 dias", () => {
  const rows: ClicksCsvRow[] = [
    { canal: "Meta Ads (teste 2608)", data_apuracao: "2026-09-01", gasto_acumulado: 100 },
    { canal: "Meta Ads (teste 2608)", data_apuracao: "2026-09-02", gasto_acumulado: 150 },
    { canal: "Meta Ads (teste 2608)", data_apuracao: "2026-09-03", gasto_acumulado: 210 },
    { canal: "Meta Ads (teste 2608)", data_apuracao: "2026-09-04", gasto_acumulado: 260 },
    { canal: "Canal desconhecido", data_apuracao: "2026-09-04", gasto_acumulado: 9 },
  ] as ClicksCsvRow[];
  const out = buildCohortSpendInputs(rows, { ate: "2026-09-04", dias: 3, fonte: "csv" });
  assert.equal(out.length, 1);
  const w = computeRollingWindow(rows, { canal: "Meta Ads (teste 2608)", ate: "2026-09-04", dias: 3 });
  assert.equal(out[0].gasto, w.gastoJanela);
  assert.equal(out[0].gasto, 160);
  assert.deepEqual([out[0].de, out[0].ate, out[0].cobreUltimoDia], ["2026-09-02", "2026-09-04", true]);
  assert.deepEqual(out[0].origens, ["meta-ads"]);
  assert.equal(out[0].ressalvaGasto, null);
  const semUltimo = buildCohortSpendInputs(rows, { ate: "2026-09-05", dias: 3, fonte: "csv" });
  assert.equal(semUltimo[0].cobreUltimoDia, false);
  const semBase = buildCohortSpendInputs(rows, { ate: "2026-09-02", dias: 3, fonte: "csv" });
  assert.equal(semBase[0].gasto, 150);
  assert.match(semBase[0].ressalvaGasto ?? "", /2026-09-01/);
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

test("resolveConfirmacaoFromStore: só sinal real confirma; sem Kit ou estado de saída é não observável", () => {
  const ent = "2026-09-01T12:00:00.000Z";
  assert.deepEqual(resolveConfirmacaoFromStore([{ platform: "kit", status: "inactive", entered_at: ent }], null), { observavel: true, confirmado: false, confirmadoEm: null });
  assert.deepEqual(resolveConfirmacaoFromStore([{ platform: "kit", status: "active", entered_at: ent }], null), { observavel: true, confirmado: true, confirmadoEm: null });
  assert.deepEqual(resolveConfirmacaoFromStore([{ platform: "kit", status: "inactive", entered_at: ent }], "2026-09-01T00:00:00Z"), {
    observavel: true,
    confirmado: true,
    confirmadoEm: "2026-09-01T00:00:00Z",
  });
  assert.equal(resolveConfirmacaoFromStore([{ platform: "beehiiv", status: "active", entered_at: ent }], null).observavel, false);
  assert.equal(resolveConfirmacaoFromStore([{ platform: "kit", status: "cancelled", entered_at: ent }], null).observavel, false);
});

test("inscrição no Kit antes de KIT_SERIES_FLOOR (importação) é não observável, nunca confirmada", () => {
  for (const entered_at of ["2026-08-24T15:00:00.000Z", "2026-08-01T15:00:00.000Z"]) {
    const r = resolveConfirmacaoFromStore([{ platform: "kit", status: "active", entered_at }], null);
    assert.equal(r.observavel, false, entered_at);
    assert.ok(!r.observavel && /importação/.test(r.motivo));
  }
  // 23h BRT de 24/08 ainda é 24/08 (fronteira BRT, não UTC).
  assert.equal(resolveConfirmacaoFromStore([{ platform: "kit", status: "active", entered_at: "2026-08-25T02:00:00.000Z" }], null).observavel, false);
  // 1º dia da série nativa: observável.
  assert.equal(resolveConfirmacaoFromStore([{ platform: "kit", status: "active", entered_at: "2026-08-25T12:00:00.000Z" }], null).observavel, true);
  // entered_at ilegível: não observável (não dá pra saber se passou pelo DOI).
  assert.equal(resolveConfirmacaoFromStore([{ platform: "kit", status: "active", entered_at: null }], null).observavel, false);
  // evento confirm explícito vence a importação.
  assert.equal(resolveConfirmacaoFromStore([{ platform: "kit", status: "active", entered_at: "2026-08-24T15:00:00.000Z" }], "2026-09-02T00:00:00Z").observavel, true);
});

test("coorte pré-Kit (Beehiiv 2025 + importada no Kit 24/08 como active) não sai com confirmação de 100%", () => {
  const root = mkdtempSync(join(tmpdir(), "channel-funnel-prekit-"));
  try {
    const db = openDiariaSubscribersDb(join(root, "s.db"));
    const t = "2026-08-24T15:00:00.000Z";
    for (const [i, email] of ["a@exemplo.com.br", "b@exemplo.com.br"].entries()) {
      const id = ensureSubscriber(db, "kit", `k${i}`, email, t);
      upsertSubscription(db, id, "beehiiv", { status: "unsubscribed", enteredAt: "2025-10-01T12:00:00.000Z", exitedAt: null, source: null, utmSource: "linkedin" }, t);
      upsertSubscription(db, id, "kit", { status: "active", enteredAt: t, exitedAt: null, source: null }, t);
    }
    const { people, fontes } = loadFunnelInputFromStore(db);
    db.close();
    assert.ok(people.every((p) => !p.confirmacao.observavel));
    const rep = buildChannelCohortFunnel(people, { now: NOW, fontes: { ...fontes, entrega: SRC(), engajamento: SRC() } });
    assert.equal(rep.rows.length, 1);
    assert.equal(rep.rows[0].cobertura, "pre-kit");
    assert.equal(rep.rows[0].confirmacao.estado, "nao-observavel");
    assert.equal(rep.rows[0].confirmacao.taxa, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("firstClickAtOrAfter descarta clique anterior ao cadastro e ts malformado", () => {
  const ent = "2026-09-10T12:00:00.000Z";
  assert.equal(firstClickAtOrAfter(["2026-09-01T00:00:00Z", "lixo", "2026-09-15T00:00:00Z", "2026-09-12T00:00:00Z"], ent), "2026-09-12T00:00:00Z");
  assert.equal(firstClickAtOrAfter(["2026-09-01T00:00:00Z"], ent), null);
  assert.equal(firstClickAtOrAfter(["2026-09-12T00:00:00Z"], null), null);
});

test("clique com ts anterior ao cadastro não conta como 1º clique no dia 0", () => {
  const entered = daysAgo(40);
  const antes = daysAgo(45);
  const { row } = onlyRow([
    person({
      personKey: "1",
      enteredAt: entered,
      engajamento: { observavel: true, primeiroCliqueEm: antes, leitor: { status: "active", totalReceived: 25, totalUniqueClicked: 0 } },
    }),
  ]);
  assert.equal(row.primeiroClique14d.estado, "medido");
  assert.equal(row.primeiroClique14d.numerador, 0);
});

test("pessoa sem e-mail é excluída (não passa pelo filtro interno/teste) e contada em resumo.semEmail", () => {
  const rep = buildChannelCohortFunnel([person({ personKey: "1" }), person({ personKey: "2", email: "" }), person({ personKey: "3", email: "  " })], {
    now: NOW,
    fontes: FONTES,
  });
  assert.equal(rep.resumo.semEmail, 2);
  assert.equal(rep.rows.length, 1);
  assert.equal(rep.rows[0].cadastrosAceitos, 1);
  const c = computeCohortCost([person({ personKey: "2", email: "", enteredAt: "2026-08-20T15:00:00.000Z" })], { ...SPEND_BASE, de: "2026-08-19", ate: "2026-08-21" }, { now: NOW, fontes: FONTES });
  assert.equal(c.populacao, 0);
});

test("loadFunnelInputFromStore: 1 pessoa por subscriber, ingestão repetida não duplica, fontes com frescor", () => {
  const root = mkdtempSync(join(tmpdir(), "channel-funnel-"));
  try {
    const db = openDiariaSubscribersDb(join(root, "s.db"));
    const t = "2026-09-01T12:00:00.000Z";
    for (let i = 0; i < 2; i++) {
      const id = ensureSubscriber(db, "kit", "k1", "um@exemplo.com.br", t);
      upsertSubscription(db, id, "kit", { status: "inactive", enteredAt: t, exitedAt: null, source: null, utmSource: "meta-ads", utmCampaign: "c1", origemCadastro: "livros" }, t);
      recordEvent(db, { subscriberId: id, platform: "kit", type: "sent", externalEventId: "s1", edicao: "b1", ts: "2026-09-02T09:00:00.000Z" });
      recordEvent(db, { subscriberId: id, platform: "kit", type: "click", externalEventId: "c1", edicao: "b1", ts: "2026-09-03T09:00:00.000Z" });
      // clique com ts ANTERIOR ao cadastro: descartado pelo loader.
      recordEvent(db, { subscriberId: id, platform: "kit", type: "click", externalEventId: "c0", edicao: "b0", ts: "2026-08-20T09:00:00.000Z" });
    }
    const id2 = ensureSubscriber(db, "beehiiv", "b2", "dois@exemplo.com.br", t);
    upsertSubscription(db, id2, "beehiiv", { status: "active", enteredAt: t, exitedAt: null, source: null }, t);
    const { people, fontes } = loadFunnelInputFromStore(db);
    db.close();
    assert.equal(people.length, 2);
    const um = people.find((p) => p.email === "um@exemplo.com.br")!;
    assert.equal(um.utmSource, "meta-ads");
    assert.equal(um.utmCampaign, "c1");
    assert.equal(um.destino, "livros");
    assert.deepEqual(um.confirmacao, { observavel: true, confirmado: false, confirmadoEm: null });
    assert.ok(um.engajamento.observavel && um.engajamento.primeiroCliqueEm === "2026-09-03T09:00:00.000Z");
    assert.ok(um.entrega.observavel && um.entrega.edicoesRecebidas === 1);
    const dois = people.find((p) => p.email === "dois@exemplo.com.br")!;
    assert.equal(dois.confirmacao.observavel, false);
    assert.equal(dois.utmSource, null);
    assert.equal(fontes.entrega.disponivel, true);
    assert.equal(fontes.entrega.frescor, "2026-09-02T09:00:00.000Z");
    assert.equal(fontes.cadastro.disponivel, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: uso inválido e store ausente saem com exit 1; store válido sem CSV calcula e devolve JSON", () => {
  assert.equal(cliMain(["--granularidade", "mes"]), 1);
  assert.equal(cliMain(["--dias", "0"]), 1);
  assert.equal(cliMain(["--ate", "07/10/2026"]), 1);
  const root = mkdtempSync(join(tmpdir(), "channel-funnel-cli-"));
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  try {
    console.error = () => {};
    console.warn = () => {};
    assert.equal(cliMain(["--db", join(root, "nao-existe", "s.db")]), 1);
    const dbPath = join(root, "s.db");
    const db = openDiariaSubscribersDb(dbPath);
    const id = ensureSubscriber(db, "kit", "k1", "um@exemplo.com.br", NOW);
    upsertSubscription(db, id, "kit", { status: "active", enteredAt: "2026-09-01T12:00:00.000Z", exitedAt: null, source: null, utmSource: "meta-ads" }, NOW);
    db.close();
    console.log = (s: string) => logs.push(s);
    assert.equal(cliMain(["--db", dbPath, "--csv", join(root, "sem.csv"), "--json"]), 0);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.rows.length, 1);
    assert.equal(out.custos.length, 0);
    assert.match(out.avisos[0], /CSV de gasto ausente/);
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
    rmSync(root, { recursive: true, force: true });
  }
});

test("store vazio: fontes indisponíveis (falta de dado), não zero", () => {
  const root = mkdtempSync(join(tmpdir(), "channel-funnel-empty-"));
  try {
    const db = openDiariaSubscribersDb(join(root, "s.db"));
    const { people, fontes } = loadFunnelInputFromStore(db);
    db.close();
    assert.equal(people.length, 0);
    assert.equal(fontes.cadastro.disponivel, false);
    assert.equal(fontes.entrega.disponivel, false);
    assert.ok(fontes.entrega.motivo);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
