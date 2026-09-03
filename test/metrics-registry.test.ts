/**
 * test/metrics-registry.test.ts (#7175, #7176 — fatias 3 e 4 do épico #7172)
 *
 * Cobre o contrato (`assertRegistryValido`, `validarDecomposicao`) sobre uma
 * fixture E sobre `METRICAS` real, e o cálculo das 8 métricas com fixture —
 * nunca I/O real (nenhum teste toca `data/diaria-subscribers.db` nem faz
 * chamada de rede).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertRegistryValido,
  validarDecomposicao,
  getMetric,
  METRICAS,
  enumerarDiasInclusive,
  KIT_IMPORT_DAY,
  KIT_SERIES_FLOOR as CONVERSAO_VISITA_CADASTRO_WINDOW_FLOOR,
  type MetricDef,
  type MetricDeps,
  type Janela,
  type AcquisitionMetricDeps,
  type AcquisitionRecordInput,
  type DoiOrfaosDeps,
  type BaseAtivaDeps,
  type LeitorV1Deps,
  type Ga4TrafficMetricDeps,
  type Ga4SessionInput,
  type ConversaoVisitaCadastroDeps,
} from "../scripts/lib/metrics/registry.ts";
import type { CapturaLogEntry } from "../scripts/lib/metrics/captura-log.ts";

function janelaDia(dia: string): Janela {
  return { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
}

function capturaEm(dia: string): CapturaLogEntry {
  return {
    captura_id: `kit-${dia}T09:00:00.000Z`,
    captured_at: `${dia}T09:00:00.000Z`,
    total_retornado_api: 1,
    novos_gravados: 1,
    eventos_estado: 0,
    exit: 0,
  };
}

function record(over: Partial<AcquisitionRecordInput> = {}): AcquisitionRecordInput {
  return {
    email: over.email ?? "leitor@example.com",
    dia: over.dia ?? "2026-08-26",
    utm_source: over.utm_source ?? null,
    utm_medium: over.utm_medium ?? null,
    utm_channel: over.utm_channel ?? null,
    referring_site: over.referring_site ?? null,
    created: over.created ?? Math.floor(Date.parse("2026-08-26T12:00:00Z") / 1000),
  };
}

function baseAcquisitionDeps(over: Partial<AcquisitionMetricDeps> = {}): AcquisitionMetricDeps {
  return {
    registros: over.registros ?? (() => []),
    capturaLog: over.capturaLog ?? [capturaEm("2026-08-26")],
    subscriptionCoverageLow: over.subscriptionCoverageLow,
    subscriptionCoverageMotivo: over.subscriptionCoverageMotivo,
  };
}

describe("assertRegistryValido (#7175)", () => {
  it("aceita array vazio", () => {
    assert.doesNotThrow(() => assertRegistryValido([]));
  });

  it("lança em id vazio", () => {
    const bad: MetricDef[] = [
      {
        id: "",
        nome: "x",
        produto: "diaria",
        etapa: "aquisicao",
        definicao: "algo",
        unidade: "contagem",
        direcao: "neutro",
        fonte: "x",
        decomposicoes: [],
        async computar() {
          return { valor: 0, janela: janelaDia("2026-01-01"), frescor: null, qualidade: "exato", motivo: null };
        },
      },
    ];
    assert.throws(() => assertRegistryValido(bad), /id vazio/);
  });

  it("lança em id duplicado", () => {
    const def = (id: string): MetricDef => ({
      id,
      nome: "x",
      produto: "diaria",
      etapa: "aquisicao",
      definicao: "algo",
      unidade: "contagem",
      direcao: "neutro",
      fonte: "x",
      decomposicoes: [],
      async computar() {
        return { valor: 0, janela: janelaDia("2026-01-01"), frescor: null, qualidade: "exato", motivo: null };
      },
    });
    assert.throws(() => assertRegistryValido([def("dup"), def("dup")]), /duplicado/);
  });

  it("lança quando definicao vazia", () => {
    const bad: MetricDef[] = [
      {
        id: "exemplo-contrato",
        nome: "x",
        produto: "diaria",
        etapa: "aquisicao",
        definicao: "   ",
        unidade: "contagem",
        direcao: "neutro",
        fonte: "x",
        decomposicoes: [],
        async computar() {
          return { valor: 0, janela: janelaDia("2026-01-01"), frescor: null, qualidade: "exato", motivo: null };
        },
      },
    ];
    assert.throws(() => assertRegistryValido(bad), /definicao vazia/);
  });

  it("lança quando métrica razão/percentual não nomeia o denominador", () => {
    const bad: MetricDef[] = [
      {
        id: "ctr-generica",
        nome: "CTR",
        produto: "diaria",
        etapa: "saude",
        definicao: "cliques dividido por alguma coisa",
        unidade: "razao",
        direcao: "maior-melhor",
        fonte: "x",
        decomposicoes: [],
        async computar() {
          return { valor: 0, janela: janelaDia("2026-01-01"), frescor: null, qualidade: "exato", motivo: null };
        },
      },
    ];
    assert.throws(() => assertRegistryValido(bad), /denominador/);
  });

  it("lança quando definicao só contém a SUBSTRING 'denominador' sem nomear nada (#7175 reviewer finding 2)", () => {
    // O guard antigo era /denominador/i — satisfeito por QUALQUER texto que
    // contivesse a palavra, inclusive um que NEGA ter denominador claro.
    const negaExplicitamente: MetricDef[] = [
      {
        id: "ctr-nega-denominador",
        nome: "CTR",
        produto: "diaria",
        etapa: "saude",
        definicao: "cliques dividido por alguma coisa, sem denominador claro definido em lugar nenhum",
        unidade: "razao",
        direcao: "maior-melhor",
        fonte: "x",
        decomposicoes: [],
        async computar() {
          return { valor: 0, janela: janelaDia("2026-01-01"), frescor: null, qualidade: "exato", motivo: null };
        },
      },
    ];
    assert.throws(() => assertRegistryValido(negaExplicitamente), /denominador/);

    const todoSemNomear: MetricDef[] = [
      {
        id: "ctr-todo-denominador",
        nome: "CTR",
        produto: "diaria",
        etapa: "saude",
        definicao: "ratio TODO denominador",
        unidade: "razao",
        direcao: "maior-melhor",
        fonte: "x",
        decomposicoes: [],
        async computar() {
          return { valor: 0, janela: janelaDia("2026-01-01"), frescor: null, qualidade: "exato", motivo: null };
        },
      },
    ];
    assert.throws(() => assertRegistryValido(todoSemNomear), /denominador/);
  });

  it("aceita métrica de razão cuja definicao nomeia o denominador", () => {
    const ok: MetricDef[] = [
      {
        id: "ctr-com-denominador",
        nome: "CTR",
        produto: "diaria",
        etapa: "saude",
        definicao: "cliques ÷ recebidas (denominador = total_received)",
        unidade: "razao",
        direcao: "maior-melhor",
        fonte: "x",
        decomposicoes: [],
        async computar() {
          return { valor: 0, janela: janelaDia("2026-01-01"), frescor: null, qualidade: "exato", motivo: null };
        },
      },
    ];
    assert.doesNotThrow(() => assertRegistryValido(ok));
  });

  it("passa sobre METRICAS real (registry vazio de conteúdo real não muda — nasce com as 8 de #7176 + 2 de #7183)", () => {
    assert.doesNotThrow(() => assertRegistryValido(METRICAS));
    assert.equal(
      METRICAS.length,
      13,
      "8 métricas de #7176 + 2 de ativação por coorte de #7183 + 3 de topo de funil GA4 de #7184",
    );
  });
});

describe("validarDecomposicao", () => {
  const def = { id: "m1", decomposicoes: ["classe"] };

  it("undefined não lança", () => {
    assert.doesNotThrow(() => validarDecomposicao(def, undefined));
  });

  it("decomposicao declarada não lança", () => {
    assert.doesNotThrow(() => validarDecomposicao(def, "classe"));
  });

  it("decomposicao fora da lista lança — nunca agrega em silêncio", () => {
    assert.throws(() => validarDecomposicao(def, "produto"), /não declarada/);
  });
});

describe("getMetric", () => {
  it("acha métrica por id", () => {
    assert.ok(getMetric("cadastros-dia"));
  });
  it("undefined para id desconhecido", () => {
    assert.equal(getMetric("não-existe"), undefined);
  });
});

describe("enumerarDiasInclusive", () => {
  it("1 dia", () => {
    assert.deepEqual(enumerarDiasInclusive("2026-08-26", "2026-08-26"), ["2026-08-26"]);
  });
  it("intervalo cruzando mês", () => {
    assert.deepEqual(enumerarDiasInclusive("2026-08-30", "2026-09-01"), [
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
    ]);
  });
});

describe("cadastros-dia (#7176) — nunca 0 por dado ausente", () => {
  const def = getMetric("cadastros-dia")!;

  it("dia sem coleta em captura-log devolve indeterminado, NUNCA 0", async () => {
    const deps = baseAcquisitionDeps({
      capturaLog: [], // nenhuma execução registrada nesse dia
      registros: () => [],
    });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.equal(r.valor, null);
    assert.equal(r.qualidade, "indeterminado");
    assert.match(r.motivo ?? "", /sem coleta/);
  });

  it("dia com coleta e zero cadastros devolve 0/exato (distinto de indeterminado)", async () => {
    const deps = baseAcquisitionDeps({ registros: () => [] });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.equal(r.valor, 0);
    assert.equal(r.qualidade, "exato");
  });

  it("subscriptionCoverageLow devolve indeterminado, nunca 0 — o ponto central desta fatia", async () => {
    const deps = baseAcquisitionDeps({
      registros: () => [record()],
      subscriptionCoverageLow: true,
    });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.equal(r.valor, null);
    assert.equal(r.qualidade, "indeterminado");
    assert.ok(r.motivo && r.motivo.length > 0);
  });

  it("exclui o dia de import em massa (24/08/2026) mesmo com coleta registrada", async () => {
    const deps = baseAcquisitionDeps({
      capturaLog: [capturaEm(KIT_IMPORT_DAY)],
      registros: () => [record({ dia: KIT_IMPORT_DAY })],
    });
    const r = await def.computar({ janela: janelaDia(KIT_IMPORT_DAY), deps });
    assert.equal(r.valor, 0);
  });

  it("exclui conta interna/teste antes de contar", async () => {
    const deps = baseAcquisitionDeps({
      registros: () => [record({ email: "vjpixel@gmail.com" }), record({ email: "leitor@example.com" })],
    });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.equal(r.valor, 1);
  });

  it("decomposicao 'classe' devolve as 5 classes somando o total", async () => {
    const deps = baseAcquisitionDeps({
      registros: () => [
        record({ utm_source: "linkedin" }), // organico
        record({ utm_source: "sparkloop-upscribe" }), // iniciativa
        record({ utm_source: null, referring_site: null }), // indeterminado (direct)
      ],
    });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), decomposicao: "classe", deps });
    assert.equal(r.valor, 3);
    assert.ok(r.series);
    const total = r.series!.reduce((s, p) => s + (p.valor ?? 0), 0);
    assert.equal(total, 3);
  });

  it("decomposicao fora de decomposicoes lança", async () => {
    const deps = baseAcquisitionDeps({ registros: () => [] });
    await assert.rejects(() => def.computar({ janela: janelaDia("2026-08-26"), decomposicao: "produto", deps }));
  });
});

describe("cadastros-nao-pago-nao-reativacao-dia — o placar (#7176)", () => {
  const def = getMetric("cadastros-nao-pago-nao-reativacao-dia")!;

  it("faixa: piso organico+iniciativa, teto soma indeterminados, nunca por subtração", async () => {
    const deps = baseAcquisitionDeps({
      registros: () => [
        record({ utm_source: "linkedin" }), // organico
        record({ utm_source: "sparkloop-upscribe" }), // iniciativa
        record({ utm_source: null, referring_site: null }), // indeterminado
        record({ utm_source: "brevo-diaria" }), // reativacao — fora do placar
      ],
    });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.equal(r.qualidade, "faixa");
    assert.equal(r.valor, 2); // piso = organico(1) + iniciativa(1)
    assert.deepEqual(r.limites, { min: 2, max: 3 });
  });

  it("sem coleta devolve indeterminado", async () => {
    const deps = baseAcquisitionDeps({ capturaLog: [] });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.equal(r.qualidade, "indeterminado");
    assert.equal(r.valor, null);
  });
});

describe("cadastros-organicos-dia — orgânico estrito", () => {
  const def = getMetric("cadastros-organicos-dia")!;

  it("piso = só organico, teto soma indeterminados", async () => {
    const deps = baseAcquisitionDeps({
      registros: () => [
        record({ utm_source: "linkedin" }),
        record({ utm_source: "sparkloop-upscribe" }), // iniciativa, não conta aqui
        record({ utm_source: null, referring_site: null }),
      ],
    });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.equal(r.valor, 1);
    assert.deepEqual(r.limites, { min: 1, max: 2 });
  });
});

describe("cadastros-indeterminados-dia — razão", () => {
  const def = getMetric("cadastros-indeterminados-dia")!;

  it("razão indeterminado/total, exato quando total>0", async () => {
    const deps = baseAcquisitionDeps({
      registros: () => [
        record({ utm_source: "linkedin" }),
        record({ utm_source: null, referring_site: null }),
      ],
    });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.equal(r.qualidade, "exato");
    assert.equal(r.valor, 0.5);
  });

  it("total 0 devolve 0 exato, não NaN", async () => {
    const deps = baseAcquisitionDeps({ registros: () => [] });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.equal(r.valor, 0);
    assert.equal(r.qualidade, "exato");
  });

  it("dia sem coleta devolve indeterminado (herda do agregado)", async () => {
    const deps = baseAcquisitionDeps({ capturaLog: [] });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.equal(r.qualidade, "indeterminado");
  });
});

describe("doi-confirmacao-dia — sempre indeterminado nesta fatia (#7176)", () => {
  it("nunca calcula uma taxa — dependência dura declarada de F2", async () => {
    const def = getMetric("doi-confirmacao-dia")!;
    const deps: MetricDeps = {};
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.equal(r.valor, null);
    assert.equal(r.qualidade, "indeterminado");
    assert.match(r.motivo ?? "", /confirm/);
  });
});

describe("doi-orfaos — reusa findKitDoiOrphans (#7176)", () => {
  const def = getMetric("doi-orfaos")!;

  it("conta órfãos exatos via deps injetadas, sem I/O", async () => {
    const now = "2026-09-02T12:00:00.000Z";
    const deps: DoiOrfaosDeps = {
      inactiveSubscribers: [
        { id: 1, email_address: "orfao@example.com", state: "inactive", created_at: "2026-08-30T00:00:00.000Z" }, // > 48h, sem form
        { id: 2, email_address: "recente@example.com", state: "inactive", created_at: "2026-09-02T11:00:00.000Z" }, // < 48h
      ],
      formSubscriberIds: new Set<number>(),
      now,
    };
    const r = await def.computar({ janela: janelaDia("2026-09-02"), deps });
    assert.equal(r.qualidade, "exato");
    assert.equal(r.valor, 1);
  });

  it("deps.now inválido devolve indeterminado, nunca lança nem conta 0 silencioso", async () => {
    const deps: DoiOrfaosDeps = { inactiveSubscribers: [], formSubscriberIds: new Set(), now: "não-é-data" };
    const r = await def.computar({ janela: janelaDia("2026-09-02"), deps });
    assert.equal(r.qualidade, "indeterminado");
    assert.equal(r.valor, null);
  });
});

describe("base-ativa (#7176)", () => {
  const def = getMetric("base-ativa")!;

  it("exato quando snapshot é de hoje", async () => {
    const deps: BaseAtivaDeps = { beehiiv: { date: "2026-09-02", active: 500 }, kitActive: null, hoje: "2026-09-02" };
    const r = await def.computar({ janela: janelaDia("2026-09-02"), deps });
    assert.equal(r.qualidade, "exato");
    assert.equal(r.valor, 500);
  });

  it("piso quando snapshot é de dia anterior a hoje — nunca exato", async () => {
    const deps: BaseAtivaDeps = { beehiiv: { date: "2026-08-30", active: 500 }, kitActive: null, hoje: "2026-09-02" };
    const r = await def.computar({ janela: janelaDia("2026-09-02"), deps });
    assert.equal(r.qualidade, "piso");
    assert.match(r.motivo ?? "", /PISO/);
  });

  it("sem beehiiv nem kit devolve indeterminado, nunca 0", async () => {
    const deps: BaseAtivaDeps = { beehiiv: null, kitActive: null, hoje: "2026-09-02" };
    const r = await def.computar({ janela: janelaDia("2026-09-02"), deps });
    assert.equal(r.qualidade, "indeterminado");
    assert.equal(r.valor, null);
  });

  it("decomposicao 'plataforma' devolve as 2 séries", async () => {
    const deps: BaseAtivaDeps = { beehiiv: { date: "2026-09-02", active: 500 }, kitActive: 30, hoje: "2026-09-02" };
    const r = await def.computar({ janela: janelaDia("2026-09-02"), decomposicao: "plataforma", deps });
    assert.equal(r.valor, 530);
    assert.deepEqual(r.series, [
      { chave: "beehiiv", valor: 500 },
      { chave: "kit", valor: 30 },
    ]);
  });
});

describe("leitor-v1 — só Beehiiv (#7176)", () => {
  const def = getMetric("leitor-v1")!;

  it("snapshot vazio devolve indeterminado, nunca 0", async () => {
    const deps: LeitorV1Deps = { subscribers: [], snapshotDate: "2026-08-30" };
    const r = await def.computar({ janela: janelaDia("2026-08-30"), deps });
    assert.equal(r.qualidade, "indeterminado");
    assert.equal(r.valor, null);
  });

  it("calcula leitores-v1 sobre fixture com stats presentes", async () => {
    const deps: LeitorV1Deps = {
      subscribers: [
        { status: "active", stats: { total_received: 30, total_unique_clicked: 2 } }, // CTR 6.6% >= 2%, >=20 recebidas
        { status: "active", stats: { total_received: 5, total_unique_clicked: 1 } }, // < 20 recebidas, não conta
      ],
      snapshotDate: "2026-08-30",
    };
    const r = await def.computar({ janela: janelaDia("2026-08-30"), deps });
    assert.equal(r.qualidade, "exato");
    assert.equal(r.valor, 1);
  });

  it("snapshot majoritariamente sem stats devolve indeterminado", async () => {
    const deps: LeitorV1Deps = {
      subscribers: Array.from({ length: 10 }, () => ({ status: "active" })),
      snapshotDate: "2026-08-30",
    };
    const r = await def.computar({ janela: janelaDia("2026-08-30"), deps });
    assert.equal(r.qualidade, "indeterminado");
  });
});

// ---------------------------------------------------------------------------
// #7184 (fatia 12 do épico #7172) — topo de funil GA4
// ---------------------------------------------------------------------------

function ga4Session(over: Partial<Ga4SessionInput> = {}): Ga4SessionInput {
  return {
    dia: over.dia ?? "2026-08-26",
    sessionSource: over.sessionSource ?? "(direct)",
    sessionMedium: over.sessionMedium ?? "(none)",
    hostName: over.hostName ?? "diar.ia.br",
    sessions: over.sessions ?? 1,
  };
}

function baseGa4Deps(over: Partial<Ga4TrafficMetricDeps> = {}): Ga4TrafficMetricDeps {
  return {
    sessoes: over.sessoes ?? (() => []),
    capturaLogGa4: over.capturaLogGa4 ?? [capturaEm("2026-08-26")],
  };
}

describe("sessoes-dia (#7184) — nunca 0 por dado ausente", () => {
  const def = getMetric("sessoes-dia")!;

  it("dia sem coleta GA4 devolve indeterminado, NUNCA 0", async () => {
    const deps = baseGa4Deps({ capturaLogGa4: [], sessoes: () => [] });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.equal(r.valor, null);
    assert.equal(r.qualidade, "indeterminado");
    assert.match(r.motivo ?? "", /sem coleta GA4/);
  });

  it("host fora da allowlist é excluído do total (probe da issue: 425 → 206)", async () => {
    const deps = baseGa4Deps({
      sessoes: () =>
        Promise.resolve([
          ga4Session({ hostName: "diar.ia.br", sessions: 195 }),
          ga4Session({ hostName: "diaria.beehiiv.com", sessions: 11 }),
          ga4Session({ hostName: "eia.diar.ia.br", sessions: 98 }),
          ga4Session({ hostName: "umapenca.com", sessions: 1 }),
        ]),
    });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.equal(r.valor, 206);
    assert.equal(r.qualidade, "exato");
  });

  it("decomposicao 'classe' devolve as 5 classes somando o total", async () => {
    const deps = baseGa4Deps({
      sessoes: () => [
        ga4Session({ sessionSource: "google", sessionMedium: "cpc", sessions: 5 }), // pago
        ga4Session({ sessionSource: "linkedin", sessionMedium: "referral", sessions: 3 }), // organico
      ],
    });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), decomposicao: "classe", deps });
    assert.equal(r.valor, 8);
    assert.ok(r.series);
    const total = r.series!.reduce((s, p) => s + (p.valor ?? 0), 0);
    assert.equal(total, 8);
  });

  it("decomposicao fora de decomposicoes lança", async () => {
    const deps = baseGa4Deps();
    await assert.rejects(() => def.computar({ janela: janelaDia("2026-08-26"), decomposicao: "produto", deps }));
  });
});

describe("sessoes-por-classe-dia (#7184) — série obrigatória", () => {
  const def = getMetric("sessoes-por-classe-dia")!;

  it("sempre devolve series, mesmo sem pedir decomposicao explicitamente", async () => {
    const deps = baseGa4Deps({
      sessoes: () => [ga4Session({ sessionSource: "google", sessionMedium: "cpc", sessions: 4 })],
    });
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps });
    assert.ok(r.series);
    assert.ok(r.series!.some((p) => p.chave === "pago" && p.valor === 4));
  });
});

describe("conversao-visita-cadastro (#7184) — razão sem join por pessoa", () => {
  const def = getMetric("conversao-visita-cadastro")!;

  function deps(over: Partial<ConversaoVisitaCadastroDeps> = {}): ConversaoVisitaCadastroDeps {
    return {
      ...baseGa4Deps(over),
      ...baseAcquisitionDeps(over),
      ...over,
    } as ConversaoVisitaCadastroDeps;
  }

  it("janela anterior ao piso da série do Kit devolve indeterminado", async () => {
    const r = await def.computar({ janela: janelaDia("2026-08-01"), deps: deps() });
    assert.equal(r.valor, null);
    assert.equal(r.qualidade, "indeterminado");
    assert.match(r.motivo ?? "", new RegExp(CONVERSAO_VISITA_CADASTRO_WINDOW_FLOOR));
  });

  it("qualidade é SEMPRE 'faixa' quando há ao menos 1 classe ok — nunca 'exato' (razão sem join por pessoa)", async () => {
    const r = await def.computar({
      janela: janelaDia(CONVERSAO_VISITA_CADASTRO_WINDOW_FLOOR),
      deps: deps({
        sessoes: () => [ga4Session({ sessionSource: "google", sessionMedium: "cpc", sessions: 100 })],
        registros: () => [record({ dia: CONVERSAO_VISITA_CADASTRO_WINDOW_FLOOR, utm_source: "google-ads" })],
        capturaLog: [capturaEm(CONVERSAO_VISITA_CADASTRO_WINDOW_FLOOR)],
        capturaLogGa4: [capturaEm(CONVERSAO_VISITA_CADASTRO_WINDOW_FLOOR)],
      }),
    });
    assert.equal(r.qualidade, "faixa");
    assert.ok(r.motivo && r.motivo.length > 0);
  });

  it("classe com sessão e sem cadastro correspondente sai como série com valor null, nunca 0/Infinity", async () => {
    const r = await def.computar({
      janela: janelaDia(CONVERSAO_VISITA_CADASTRO_WINDOW_FLOOR),
      deps: deps({
        sessoes: () => [ga4Session({ sessionSource: "(direct)", sessionMedium: "(none)", sessions: 50 })],
        registros: () => [],
        capturaLog: [capturaEm(CONVERSAO_VISITA_CADASTRO_WINDOW_FLOOR)],
        capturaLogGa4: [capturaEm(CONVERSAO_VISITA_CADASTRO_WINDOW_FLOOR)],
      }),
    });
    assert.ok(r.series);
    const indeterminadoPoint = r.series!.find((p) => p.chave === "indeterminado");
    assert.ok(indeterminadoPoint);
    assert.equal(indeterminadoPoint!.valor, null);
  });

  it("sem coleta GA4 no dia devolve indeterminado (denominador ausente)", async () => {
    const r = await def.computar({
      janela: janelaDia(CONVERSAO_VISITA_CADASTRO_WINDOW_FLOOR),
      deps: deps({ capturaLogGa4: [], capturaLog: [capturaEm(CONVERSAO_VISITA_CADASTRO_WINDOW_FLOOR)] }),
    });
    assert.equal(r.qualidade, "indeterminado");
    assert.equal(r.valor, null);
  });
});
