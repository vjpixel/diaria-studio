/**
 * test/metrics-registry-valor.test.ts (#8423)
 *
 * Cobertura das 7 métricas de Valor (receita, ARPU, churn, conversão em
 * apoiador, LTV, LTV÷CAC) adicionadas a `scripts/lib/metrics/registry.ts`.
 * Mesma disciplina do resto do registry: fixture only, `valor: null` nunca
 * vira `0`, `qualidade` sempre condizente com o motivo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getMetric,
  METRICAS,
  assertRegistryValido,
  type Janela,
  type ReceitaMensalDeps,
  type ArpuAtivoDeps,
  type ChurnMensalDeps,
  type ConversaoApoiadorDeps,
  type LtvCaixaDeps,
  type LtvPorOrigemDeps,
  type LtvCacRatioDeps,
} from "../scripts/lib/metrics/registry.ts";

function janelaDia(dia: string): Janela {
  return { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
}

describe("registry real — métricas de Valor presentes e válidas", () => {
  it("as 7 métricas de valor estão em METRICAS e passam assertRegistryValido", () => {
    const ids = ["receita-mensal", "arpu-ativo", "churn-mensal", "conversao-apoiador", "ltv-caixa", "ltv-por-origem", "ltv-cac-ratio"];
    for (const id of ids) {
      assert.ok(getMetric(id), `métrica ${id} deveria existir no registry`);
    }
    assert.doesNotThrow(() => assertRegistryValido(METRICAS));
  });
});

describe("receita-mensal", () => {
  const def = getMetric("receita-mensal")!;

  it("soma fontes com dado", async () => {
    const deps: ReceitaMensalDeps = { porFonte: { "apoia-se": 468, amazon: 50 } };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.valor, 518);
    assert.equal(r.qualidade, "exato");
  });

  it("PISO quando alguma fonte está sem dado — nunca 0/indeterminado", async () => {
    const deps: ReceitaMensalDeps = { porFonte: { "apoia-se": 468, amazon: null } };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.valor, 468);
    assert.equal(r.qualidade, "piso");
  });

  it("indeterminado quando NENHUMA fonte tem dado — nunca 0", async () => {
    const deps: ReceitaMensalDeps = { porFonte: { "apoia-se": null, amazon: null } };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.valor, null);
    assert.equal(r.qualidade, "indeterminado");
  });

  it("decomposicao 'fonte' devolve o valor bruto de cada fonte, incluindo null", async () => {
    const deps: ReceitaMensalDeps = { porFonte: { "apoia-se": 468, amazon: null } };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), decomposicao: "fonte", deps });
    assert.ok(r.series);
    const amazon = r.series!.find((s) => s.chave === "amazon");
    assert.equal(amazon!.valor, null);
    const apoiaSe = r.series!.find((s) => s.chave === "apoia-se");
    assert.equal(apoiaSe!.valor, 468);
  });
});

describe("arpu-ativo", () => {
  const def = getMetric("arpu-ativo")!;

  it("receita total ÷ base ativa", async () => {
    const deps: ArpuAtivoDeps = { porFonte: { "apoia-se": 468, amazon: 50 }, baseAtiva: 628 };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.ok(r.valor != null);
    assert.ok(Math.abs(r.valor - 518 / 628) < 1e-9);
    assert.equal(r.qualidade, "exato");
  });

  it("indeterminado quando base ativa ausente — nunca 0", async () => {
    const deps: ArpuAtivoDeps = { porFonte: { "apoia-se": 468 }, baseAtiva: null };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.valor, null);
    assert.equal(r.qualidade, "indeterminado");
  });
});

describe("churn-mensal", () => {
  const def = getMetric("churn-mensal")!;

  it("devolve FAIXA: piso (organico) <= teto (com limpeza)", async () => {
    const deps: ChurnMensalDeps = {
      exits: [{ email: "a@x.com" }, { email: "b@x.com" }, { email: "manual@x.com" }],
      manualCleanupEmails: new Set(["manual@x.com"]),
      periodMonths: 1,
      avgActiveBase: 100,
    };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.qualidade, "faixa");
    assert.ok(r.limites);
    assert.ok(r.limites!.min <= r.limites!.max);
  });

  it("rótulo do teto é 'com limpeza manual', nunca o de aquisição (#9023 item 3)", async () => {
    const deps: ChurnMensalDeps = {
      exits: [{ email: "a@x.com" }, { email: "manual@x.com" }],
      manualCleanupEmails: new Set(["manual@x.com"]),
      periodMonths: 1,
      avgActiveBase: 100,
    };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.limites?.rotuloMax, "com limpeza manual");
  });

  it("decomposicao 'variante' nomeia organico e com_limpeza", async () => {
    const deps: ChurnMensalDeps = {
      exits: [{ email: "a@x.com" }, { email: "manual@x.com" }],
      manualCleanupEmails: new Set(["manual@x.com"]),
      periodMonths: 1,
      avgActiveBase: 100,
    };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), decomposicao: "variante", deps });
    assert.ok(r.series);
    const organico = r.series!.find((s) => s.chave === "organico")!;
    const comLimpeza = r.series!.find((s) => s.chave === "com_limpeza")!;
    assert.ok((organico.valor as number) < (comLimpeza.valor as number));
  });

  it("indeterminado quando base ativa média ausente — nunca 0", async () => {
    const deps: ChurnMensalDeps = { exits: [], manualCleanupEmails: new Set(), periodMonths: 1, avgActiveBase: null };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.valor, null);
    assert.equal(r.qualidade, "indeterminado");
  });
});

describe("conversao-apoiador", () => {
  const def = getMetric("conversao-apoiador")!;

  it("razão apoiadores/confirmados, qualidade exato quando amostra ok", async () => {
    const deps: ConversaoApoiadorDeps = { apoiadores: 18, confirmados: 218 };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.ok(r.valor != null);
    assert.equal(r.qualidade, "exato");
  });

  it("qualidade PISO quando amostra é pequena (n < 5) — nunca escondida", async () => {
    const deps: ConversaoApoiadorDeps = { apoiadores: 1, confirmados: 194 };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.ok(r.valor != null);
    assert.equal(r.qualidade, "piso");
    assert.match(r.motivo ?? "", /amostra/);
  });

  it("indeterminado quando denominador é zero — nunca 0/NaN", async () => {
    const deps: ConversaoApoiadorDeps = { apoiadores: 0, confirmados: 0 };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.valor, null);
    assert.equal(r.qualidade, "indeterminado");
  });
});

describe("ltv-caixa", () => {
  const def = getMetric("ltv-caixa")!;

  it("devolve faixa a partir de ARPU + 2 churns", async () => {
    const deps: LtvCaixaDeps = { arpuMensal: 0.78, churnMensalOrganico: 0.024, churnMensalComLimpeza: 0.05 };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.qualidade, "faixa");
    assert.ok(r.limites!.min > 0 && r.limites!.max >= r.limites!.min);
  });

  it("rótulo do teto é 'com churn orgânico' (#9023 item 3)", async () => {
    const deps: LtvCaixaDeps = { arpuMensal: 0.78, churnMensalOrganico: 0.024, churnMensalComLimpeza: 0.05 };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.limites?.rotuloMax, "com churn orgânico");
  });

  it("respeita horizonMonths customizado", async () => {
    const deps: LtvCaixaDeps = { arpuMensal: 1, churnMensalOrganico: 0.01, churnMensalComLimpeza: 0.02, horizonMonths: 6 };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    // com churn 0.02 -> 1/0.02=50 meses, truncado em 6 -> LTV min = 6
    assert.equal(r.limites!.min, 6);
  });

  it("indeterminado quando ARPU é null — nunca 0", async () => {
    const deps: LtvCaixaDeps = { arpuMensal: null, churnMensalOrganico: 0.02, churnMensalComLimpeza: 0.05 };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.valor, null);
    assert.equal(r.qualidade, "indeterminado");
  });
});

describe("ltv-por-origem", () => {
  const def = getMetric("ltv-por-origem")!;

  it("decomposicao 'classe' devolve LTV por classe; 'valor' é média ponderada por n", async () => {
    const deps: LtvPorOrigemDeps = {
      porClasse: {
        organico: { conversaoApoiador: 0.083, valorMedioApoiadorMensal: 18, n: 18 },
        pago: { conversaoApoiador: 0.005, valorMedioApoiadorMensal: 20, outrasFontesPerAtivoMensal: 50 / 628, n: 1 },
      },
      horizonMonths: 18,
    };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), decomposicao: "classe", deps });
    assert.ok(r.series);
    const organico = r.series!.find((s) => s.chave === "organico")!;
    const pago = r.series!.find((s) => s.chave === "pago")!;
    assert.ok((organico.valor as number) > (pago.valor as number));
    assert.equal(r.qualidade, "exato");
    assert.ok(r.valor != null);
  });

  it("classe ausente do mapa não aparece como 0 — só as informadas entram na série", async () => {
    const deps: LtvPorOrigemDeps = {
      porClasse: { organico: { conversaoApoiador: 0.1, valorMedioApoiadorMensal: 10, n: 5 } },
      horizonMonths: 12,
    };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), decomposicao: "classe", deps });
    assert.equal(r.series!.length, 1);
  });

  it("indeterminado quando nenhuma classe é informada — nunca 0", async () => {
    const deps: LtvPorOrigemDeps = { porClasse: {} };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.valor, null);
    assert.equal(r.qualidade, "indeterminado");
  });

  it("indeterminado quando toda classe tem LTV não-computável — nunca 0", async () => {
    const deps: LtvPorOrigemDeps = {
      porClasse: { organico: { conversaoApoiador: null, valorMedioApoiadorMensal: null, n: 0 } },
    };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.valor, null);
    assert.equal(r.qualidade, "indeterminado");
  });
});

describe("ltv-cac-ratio", () => {
  const def = getMetric("ltv-cac-ratio")!;

  it("razão por canal, decomposicao 'canal'", async () => {
    const deps: LtvCacRatioDeps = {
      ltvPorCanal: { google_ads: 15, linkedin: 20 },
      custoPorCanal: { google_ads: 5, linkedin: 4 },
    };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), decomposicao: "canal", deps });
    assert.ok(r.series);
    const google = r.series!.find((s) => s.chave === "google_ads")!;
    assert.equal(google.valor, 3);
    assert.equal(r.qualidade, "exato");
  });

  it("canal com LTV sem CAC correspondente sai com valor null na série, nunca 0/Infinity", async () => {
    const deps: LtvCacRatioDeps = { ltvPorCanal: { google_ads: 15 }, custoPorCanal: {} };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), decomposicao: "canal", deps });
    const google = r.series!.find((s) => s.chave === "google_ads")!;
    assert.equal(google.valor, null);
  });

  it("indeterminado quando nenhum canal tem os dois lados — nunca 0", async () => {
    const deps: LtvCacRatioDeps = { ltvPorCanal: { google_ads: 15 }, custoPorCanal: {} };
    const r = await def.computar({ janela: janelaDia("2026-09-01"), deps });
    assert.equal(r.valor, null);
    assert.equal(r.qualidade, "indeterminado");
  });
});
