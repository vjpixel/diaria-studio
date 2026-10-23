/**
 * test/hotmart-cobertura-go-live-10991.test.ts
 *
 * #10991 item 1 — o webhook de vendas da Hotmart só entrou no ar em
 *   21/10/2026 (`hotmart.vendas_desde` em `platform.config.json`). Dia
 *   anterior ao go-live nunca conta como coberto: outubro/2026 não pode sair
 *   "completo" com só as vendas de 21/10 em diante, e mês inteiro anterior não
 *   pode sair R$ 0 real. O mês parcial sai rotulado PISO.
 * #10991 item 2 — a cobertura regride: chave inválida de um dia já coberto
 *   tira esse dia da cobertura gravada (antes a união o mantinha coberto e a
 *   venda sumia em silêncio).
 *
 * Só dados sintéticos; nenhuma chamada à Hotmart nem ao Worker.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  diasARetirarDaJanela,
  parseVendasDesde,
  periodoCoberto,
  recortarCoberturaDesde,
  registrarJanelaNoEstado,
  subtrairCobertura,
  trechosCobertosDaJanela,
  ESTADO_SYNC_VAZIO,
  type PerdasDaJanela,
} from "../scripts/lib/hotmart-vendas-espelho.ts";
import { computeHotmartMonthRevenue } from "../scripts/lib/ltv.ts";
import { loadHotmartMonthRevenue } from "../scripts/lib/hotmart-revenue-source.ts";
import { loadHotmartVendasDesde } from "../scripts/lib/hotmart-vendas-config.ts";
import type { VendaRecord } from "../scripts/lib/shared/hotmart-vendas.ts";

const GO_LIVE = "2026-10-21";
const semPerda: PerdasDaJanela = { descartados: 0, ignoradosNoKv: 0, chavesIgnoradas: [] };

function rec(over: Partial<VendaRecord> = {}): VendaRecord {
  return {
    v: 1,
    evento: "aprovada",
    evento_id: "ev-1",
    transacao: "HP0001",
    criado_em: "2026-10-22T12:00:00.000Z",
    criado_em_origem: "hotmart",
    dia: "2026-10-22",
    produto_id: 1,
    oferta: null,
    valor_liquido: 80,
    moeda_liquido: "BRL",
    valor_bruto: 100,
    moeda_bruto: "BRL",
    email_hash: null,
    src: null,
    sck: null,
    afiliado: false,
    ...over,
  };
}

describe("#10991 item 1: piso de go-live do webhook na cobertura", () => {
  it("platform.config.json do repo declara hotmart.vendas_desde = 2026-10-21", () => {
    const cfg = loadHotmartVendasDesde(resolve(import.meta.dirname, ".."));
    assert.equal(cfg.vendasDesde, GO_LIVE, cfg.motivo ?? "");
  });

  it("parseVendasDesde: só AAAA-MM-DD existente; resto vira null", () => {
    assert.equal(parseVendasDesde({ hotmart: { vendas_desde: GO_LIVE } }), GO_LIVE);
    for (const ruim of [{}, null, { hotmart: null }, { hotmart: { vendas_desde: "2026-02-30" } }, { hotmart: { vendas_desde: "21/10/2026" } }, { hotmart: { vendas_desde: 20261021 } }]) {
      assert.equal(parseVendasDesde(ruim), null, JSON.stringify(ruim));
    }
  });

  it("cenário da issue: sync de 35 dias (20/09..ontem) não cobre nada antes de 21/10", () => {
    const agora = Date.parse("2026-10-24T07:30:00Z"); // sábado 24/10, 04:30 BRT
    const janela = { de: "2026-09-20", ate: "2026-10-24" };
    assert.deepEqual(trechosCobertosDaJanela(janela, semPerda, agora, GO_LIVE), [{ de: GO_LIVE, ate: "2026-10-23" }]);
    // Janela inteira antes do go-live: nada.
    assert.deepEqual(trechosCobertosDaJanela({ de: "2026-09-01", ate: "2026-10-20" }, semPerda, agora, GO_LIVE), []);
    // Config ausente/inválida: nada entra (fail-safe), nunca "tudo coberto".
    assert.deepEqual(trechosCobertosDaJanela(janela, semPerda, agora, null), []);
  });

  it("varredura de 07/11 (93 dias) completa 31/10 e mesmo assim outubro não fecha: sai PISO, fora da soma", () => {
    const agora = Date.parse("2026-11-07T07:30:00Z");
    const janela = { de: "2026-08-07", ate: "2026-11-07" };
    const e = registrarJanelaNoEstado(ESTADO_SYNC_VAZIO, trechosCobertosDaJanela(janela, semPerda, agora, GO_LIVE), [], "t", { vendasDesde: GO_LIVE });
    assert.deepEqual(e.cobertura, [{ de: GO_LIVE, ate: "2026-11-06" }]);
    assert.equal(periodoCoberto(e.cobertura, "2026-10-01", "2026-10-31"), false);

    const registros = [rec(), rec({ transacao: "B", evento_id: "b", valor_bruto: 50, dia: "2026-10-30" })];
    const out = computeHotmartMonthRevenue({ registros, cobertura: e.cobertura, month: "2026-10", vendasDesde: GO_LIVE });
    assert.equal(out.valorBrl, null, "outubro não pode entrar no ARPU como mês completo");
    assert.equal(out.pisoBrl, 150);
    assert.equal(out.aprovadas, 2);
    assert.match(out.motivo!, /^PISO — espelho Hotmart cobre só 2026-10-21\.\.2026-10-31 de 2026-10-01\.\.2026-10-31 \(webhook de vendas no ar desde 2026-10-21/);
    assert.match(out.motivo!, /R\$ 150,00/);
  });

  it("estado gravado ANTES do fix (cobertura desde setembro) não faz outubro sair completo na leitura", () => {
    const legado = [{ de: "2026-09-20", ate: "2026-11-06" }];
    const out = computeHotmartMonthRevenue({ registros: [rec()], cobertura: legado, month: "2026-10", vendasDesde: GO_LIVE });
    assert.equal(out.valorBrl, null);
    assert.equal(out.pisoBrl, 100);
    assert.match(out.motivo!, /^PISO/);
    // Mês inteiro antes do go-live: sem dado, nunca R$ 0 real.
    const set = computeHotmartMonthRevenue({ registros: [], cobertura: legado, month: "2026-09", vendasDesde: GO_LIVE });
    assert.equal(set.valorBrl, null);
    assert.equal(set.pisoBrl, null);
    assert.match(set.motivo!, /antes do go-live/);
    // Novembro, todo depois do go-live e coberto: valor normal.
    const nov = computeHotmartMonthRevenue({
      registros: [rec({ dia: "2026-11-03" })],
      cobertura: [{ de: "2026-09-20", ate: "2026-12-01" }],
      month: "2026-11",
      vendasDesde: GO_LIVE,
    });
    assert.equal(nov.valorBrl, 100);
    assert.equal(nov.pisoBrl, null);
    assert.equal(nov.motivo, null);
    // A próxima escrita também limpa o legado.
    const e = registrarJanelaNoEstado({ ...ESTADO_SYNC_VAZIO, cobertura: legado }, [], [], "t", { vendasDesde: GO_LIVE });
    assert.deepEqual(e.cobertura, [{ de: GO_LIVE, ate: "2026-11-06" }]);
  });

  it("go-live desconhecido: sem dado com motivo", () => {
    const out = computeHotmartMonthRevenue({ registros: [rec()], cobertura: [{ de: "2026-11-01", ate: "2026-11-30" }], month: "2026-11", vendasDesde: null });
    assert.equal(out.valorBrl, null);
    assert.match(out.motivo!, /hotmart\.vendas_desde/);
  });

  it("piso com evento em outra moeda: sem valor de piso, motivo ainda PISO", () => {
    const out = computeHotmartMonthRevenue({
      registros: [rec({ moeda_bruto: "USD" })],
      cobertura: [{ de: GO_LIVE, ate: "2026-10-31" }],
      month: "2026-10",
      vendasDesde: GO_LIVE,
    });
    assert.equal(out.valorBrl, null);
    assert.equal(out.pisoBrl, null);
    assert.match(out.motivo!, /^PISO.*USD/);
  });

  it("loadHotmartMonthRevenue lê hotmart.vendas_desde do platform.config.json do root; ausente = sem dado", () => {
    const root = mkdtempSync(join(tmpdir(), "hotmart-10991-"));
    try {
      const dir = join(root, "data", "hotmart");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "vendas.jsonl"), JSON.stringify(rec()) + "\n");
      writeFileSync(join(dir, "vendas.estado.json"), JSON.stringify({ v: 1, cobertura: [{ de: "2026-09-01", ate: "2026-11-06" }], chaves_invalidas_conhecidas: [], atualizado_em: "x" }));
      const sem = loadHotmartMonthRevenue(root, "2026-10");
      assert.equal(sem.valorBrl, null);
      assert.match(sem.motivo!, /vendas_desde|platform\.config\.json/);
      writeFileSync(join(root, "platform.config.json"), JSON.stringify({ hotmart: { vendas_desde: GO_LIVE } }));
      const com = loadHotmartMonthRevenue(root, "2026-10");
      assert.equal(com.valorBrl, null);
      assert.equal(com.pisoBrl, 100);
      assert.match(com.motivo!, /^PISO/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#10991 item 2: a cobertura regride com perda num dia já coberto", () => {
  const agora = Date.parse("2026-12-05T07:30:00Z");

  it("chave inválida de novembro, que já estava coberto, tira o dia da cobertura gravada", () => {
    const coberto = { ...ESTADO_SYNC_VAZIO, cobertura: [{ de: GO_LIVE, ate: "2026-12-01" }] };
    assert.equal(periodoCoberto(coberto.cobertura, "2026-11-01", "2026-11-30"), true);
    const janela = { de: "2026-11-01", ate: "2026-12-05" };
    const chave = "hotmart:venda:2026-11-15:REENVIO:aprovada";
    const perdas: PerdasDaJanela = { descartados: 0, ignoradosNoKv: 1, chavesIgnoradas: [chave] };
    const e = registrarJanelaNoEstado(coberto, trechosCobertosDaJanela(janela, perdas, agora, GO_LIVE), [chave], "t", {
      retirar: diasARetirarDaJanela(janela, perdas),
      vendasDesde: GO_LIVE,
    });
    assert.deepEqual(e.cobertura, [
      { de: GO_LIVE, ate: "2026-11-14" },
      { de: "2026-11-16", ate: "2026-12-04" },
    ]);
    assert.equal(periodoCoberto(e.cobertura, "2026-11-01", "2026-11-30"), false, "novembro não pode seguir coberto com a venda fora do espelho");
    const nov = computeHotmartMonthRevenue({ registros: [rec({ dia: "2026-11-03" })], cobertura: e.cobertura, month: "2026-11", vendasDesde: GO_LIVE });
    assert.equal(nov.valorBrl, null);
    assert.match(nov.motivo!, /^PISO/);
    // Rodada seguinte, chave já conhecida e ainda no KV: o dia continua fora.
    const e2 = registrarJanelaNoEstado(e, trechosCobertosDaJanela(janela, perdas, agora, GO_LIVE), [], "t2", {
      retirar: diasARetirarDaJanela(janela, perdas),
      vendasDesde: GO_LIVE,
    });
    assert.equal(periodoCoberto(e2.cobertura, "2026-11-01", "2026-11-30"), false);
  });

  it("perda sem dia conhecido tira a janela inteira da cobertura gravada", () => {
    const janela = { de: "2026-11-01", ate: "2026-11-30" };
    assert.deepEqual(diasARetirarDaJanela(janela, { ...semPerda, descartados: 1 }), [janela]);
    assert.deepEqual(diasARetirarDaJanela(janela, { descartados: 0, ignoradosNoKv: 1, chavesIgnoradas: [] }), [janela]);
    assert.deepEqual(diasARetirarDaJanela(janela, { descartados: 0, ignoradosNoKv: 1, chavesIgnoradas: ["hotmart:venda:x"] }), [janela]);
    assert.deepEqual(diasARetirarDaJanela(janela, semPerda), []);
    const e = registrarJanelaNoEstado({ ...ESTADO_SYNC_VAZIO, cobertura: [{ de: GO_LIVE, ate: "2026-12-04" }] }, [], [], "t", {
      retirar: diasARetirarDaJanela(janela, { ...semPerda, descartados: 1 }),
    });
    assert.deepEqual(e.cobertura, [
      { de: GO_LIVE, ate: "2026-10-31" },
      { de: "2026-12-01", ate: "2026-12-04" },
    ]);
  });

  it("subtrairCobertura e recortarCoberturaDesde: bordas", () => {
    const cob = [{ de: "2026-11-01", ate: "2026-11-10" }];
    assert.deepEqual(subtrairCobertura(cob, [{ de: "2026-11-01", ate: "2026-11-01" }]), [{ de: "2026-11-02", ate: "2026-11-10" }]);
    assert.deepEqual(subtrairCobertura(cob, [{ de: "2026-11-10", ate: "2026-11-12" }]), [{ de: "2026-11-01", ate: "2026-11-09" }]);
    assert.deepEqual(subtrairCobertura(cob, [{ de: "2026-10-01", ate: "2026-12-01" }]), []);
    assert.deepEqual(subtrairCobertura(cob, [{ de: "2026-12-01", ate: "2026-12-02" }]), cob);
    // Fim de mês: 30/11 → 01/12 sem pular dia.
    assert.deepEqual(subtrairCobertura([{ de: "2026-11-29", ate: "2026-12-02" }], [{ de: "2026-11-30", ate: "2026-12-01" }]), [
      { de: "2026-11-29", ate: "2026-11-29" },
      { de: "2026-12-02", ate: "2026-12-02" },
    ]);
    assert.deepEqual(recortarCoberturaDesde([{ de: "2026-09-01", ate: "2026-10-20" }, { de: "2026-10-22", ate: "2026-10-30" }], GO_LIVE), [
      { de: "2026-10-22", ate: "2026-10-30" },
    ]);
    assert.deepEqual(recortarCoberturaDesde([{ de: "2026-09-01", ate: "2026-10-30" }], GO_LIVE), [{ de: GO_LIVE, ate: "2026-10-30" }]);
  });
});
