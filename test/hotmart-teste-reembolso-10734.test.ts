/**
 * test/hotmart-teste-reembolso-10734.test.ts (#10734, item 3)
 *
 * 1. Evento de TESTE da Hotmart (payload de exemplo do botão "Enviar teste":
 *    produto id 0, oferta `test`, transação `HP16015479281022`) não é venda.
 *    Regressão do achado de 26/10/2026: os 4 eventos de teste de 21/10
 *    estavam no espelho `data/hotmart/vendas.jsonl` e entravam no saldo
 *    (bruto e líquido) e no cruzamento com o store. Com aprovação e reembolso
 *    o saldo fechava em zero por acaso; um teste só de compra aprovada somava
 *    R$ 1.500 de receita inexistente ao ARPU.
 * 2. Conferência da premissa do reembolso (a reversão traz a comissão do
 *    produtor da aprovação?): veredito sobre as reversões REAIS, nunca sobre
 *    as de teste, que "confirmariam" a premissa sem venda nenhuma.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isVendaDeTeste, saldoLiquido, saldoReceita, type VendaRecord } from "../scripts/lib/shared/hotmart-vendas.ts";
import { computeHotmartMonthRevenue } from "../scripts/lib/ltv.ts";
import { conferirPremissaReembolso, cruzarVendas } from "../scripts/lib/hotmart-vendas-cruzamento.ts";
import { formatarConferencia } from "../scripts/hotmart-vendas-cruzamento.ts";

function rec(over: Partial<VendaRecord> = {}): VendaRecord {
  return {
    v: 1,
    evento: "aprovada",
    evento_id: `ev-${over.transacao ?? "T"}-${over.evento ?? "aprovada"}`,
    transacao: "HP0001",
    criado_em: "2026-11-05T12:00:00.000Z",
    criado_em_origem: "hotmart",
    dia: "2026-11-05",
    produto_id: 8596324,
    oferta: "of1",
    valor_liquido: 48.87,
    moeda_liquido: "BRL",
    valor_bruto: 57,
    moeda_bruto: "BRL",
    email_hash: "a".repeat(64),
    src: null,
    sck: null,
    afiliado: true,
    ...over,
  };
}

/** Os 4 eventos de teste exatamente como estavam no espelho em 26/10. */
function testes(dia = "2026-11-03"): VendaRecord[] {
  return (["reembolsada", "chargeback", "cancelada", "aprovada"] as const).map((evento) =>
    rec({ evento, dia, transacao: "HP16015479281022", produto_id: 0, oferta: "test", valor_liquido: 1350.5, valor_bruto: 1500 }),
  );
}

const COBERTURA_NOV = [{ de: "2026-10-21", ate: "2026-11-30" }];

describe("#10734 item 3 — evento de teste da Hotmart fora da receita", () => {
  it("isVendaDeTeste reconhece só produto id 0", () => {
    assert.equal(isVendaDeTeste({ produto_id: 0 }), true);
    assert.equal(isVendaDeTeste({ produto_id: 8596324 }), false);
    assert.equal(isVendaDeTeste({ produto_id: null }), false);
  });

  it("saldo bruto e líquido ignoram os eventos de teste", () => {
    const reais = [rec({ transacao: "HP1" }), rec({ transacao: "HP2", valor_bruto: 39.9, valor_liquido: 33.46 })];
    const comTestes = [...testes(), ...reais];
    assert.deepEqual(saldoReceita(comTestes, "bruto"), saldoReceita(reais, "bruto"));
    assert.deepEqual(saldoLiquido(comTestes), saldoLiquido(reais));
    assert.deepEqual(saldoReceita(comTestes, "bruto").porMoeda, [{ moeda: "BRL", liquido: 96.9, aprovadas: 2, estornos: 0 }]);
  });

  it("regressão: teste só de compra aprovada não vira R$ 1.500 de receita no mês", () => {
    const soAprovadaDeTeste = testes().filter((r) => r.evento === "aprovada");
    const m = computeHotmartMonthRevenue({ registros: [...soAprovadaDeTeste, rec()], cobertura: COBERTURA_NOV, month: "2026-11", vendasDesde: "2026-10-21" });
    assert.equal(m.valorBrl, 57);
    assert.equal(m.aprovadas, 1);
    assert.equal(m.motivo, null);
  });

  it("mês só com eventos de teste é R$ 0 (coberto, sem venda), não receita", () => {
    const m = computeHotmartMonthRevenue({ registros: testes(), cobertura: COBERTURA_NOV, month: "2026-11", vendasDesde: "2026-10-21" });
    assert.equal(m.valorBrl, 0);
    assert.equal(m.aprovadas, 0);
    assert.equal(m.estornos, 0);
  });

  it("cruzarVendas deixa o teste fora e conta quantos ignorou", () => {
    const r = cruzarVendas([...testes(), rec({ transacao: "HP1", email_hash: null })], new Map());
    assert.equal(r.totalEventos, 1);
    assert.equal(r.testesIgnorados, 4);
    assert.equal(r.vendas.some((v) => v.transacao === "HP16015479281022"), false);
    assert.equal(r.aprovadas["sem-email"].eventos, 1);
  });
});

describe("#10734 item 3 — conferirPremissaReembolso", () => {
  it("só eventos de teste: aguardando (o reembolso de teste não confirma nada)", () => {
    const c = conferirPremissaReembolso([...testes(), rec({ transacao: "HP1" })]);
    assert.equal(c.veredito, "aguardando");
    assert.equal(c.reversoes, 0);
    assert.equal(c.testesIgnorados, 4);
    assert.match(formatarConferencia(c), /aguardando o 1º reembolso\/chargeback real/);
  });

  it("reversão real com a mesma comissão da aprovação: confirmada", () => {
    const c = conferirPremissaReembolso([rec({ transacao: "HP1" }), rec({ transacao: "HP1", evento: "reembolsada", dia: "2026-11-09" })]);
    assert.equal(c.veredito, "confirmada");
    assert.equal(c.porSituacao["liquido-igual-aprovada"], 1);
  });

  it("reversão sem comissão, com comissão diferente ou sem aprovação no espelho: conferir", () => {
    const c = conferirPremissaReembolso([
      rec({ transacao: "HP1" }),
      rec({ transacao: "HP1", evento: "reembolsada", valor_liquido: null, moeda_liquido: null }),
      rec({ transacao: "HP2" }),
      rec({ transacao: "HP2", evento: "chargeback", valor_liquido: 57 }),
      rec({ transacao: "HP3", evento: "reembolsada" }),
      rec({ transacao: "HP4" }),
      rec({ transacao: "HP4", evento: "reembolsada" }),
    ]);
    assert.equal(c.veredito, "conferir");
    assert.equal(c.reversoes, 4);
    assert.deepEqual(c.porSituacao, {
      "liquido-igual-aprovada": 1,
      "liquido-difere-aprovada": 1,
      "sem-liquido": 1,
      "sem-aprovada-no-espelho": 1,
    });
    const txt = formatarConferencia(c);
    assert.match(txt, /CONFERIR/);
    assert.match(txt, /sem-liquido\s+1 reversão/);
  });
});
