/**
 * test/metrics-ativacao-coorte.test.ts (#7183, fatia 11 do épico #7172)
 *
 * Cobre `scripts/lib/metrics/ativacao-coorte.ts` com fixture derivada do
 * shape real do backup Beehiiv (não sintética, não lendo `data/`) — mesma
 * disciplina de `test/acquisition-class.test.ts` (#7173). Também cobre a
 * fiação em `scripts/lib/metrics/registry.ts` (2 novas MetricDef).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeAberturaPrimeiraEdicao,
  computePrimeiroClique14d,
  derivarAberturaEClique,
  resolveCohortDayBrt,
  resolveCohortWeekBrt,
  resolveEarliestCreated,
  isBulkImport,
  applyCrossPlatformFloor,
  medianDiasAteClique,
  type AtivacaoCoorteSubscriberInput,
} from "../scripts/lib/metrics/ativacao-coorte.ts";
import {
  extractBeehiivIdentity,
  resolveOrCreateBeehiivSubscriber,
} from "../scripts/lib/beehiiv-subscribers-ingest.ts";
import { openDiariaSubscribersDb } from "../scripts/lib/diaria-subscribers-db.ts";
import { getMetric, type AtivacaoCoorteMetricDeps, type Janela } from "../scripts/lib/metrics/registry.ts";

const DAY_SECONDS = 24 * 3600;

function ymdToEpoch(ymd: string, hourUtc = 12): number {
  return Math.floor(Date.parse(`${ymd}T${String(hourUtc).padStart(2, "0")}:00:00Z`) / 1000);
}

function sub(over: Partial<AtivacaoCoorteSubscriberInput> = {}): AtivacaoCoorteSubscriberInput {
  return {
    email: over.email ?? "leitor@example.com",
    created: over.created ?? ymdToEpoch("2026-08-01"),
    utm_source: over.utm_source ?? null,
    utm_medium: over.utm_medium ?? null,
    utm_channel: over.utm_channel ?? null,
    referring_site: over.referring_site ?? null,
    recebeuAoMenosUma: over.recebeuAoMenosUma ?? true,
    primeiraEdicaoDadosDisponiveis: over.primeiraEdicaoDadosDisponiveis ?? true,
    abriuPrimeiraEdicao: over.abriuPrimeiraEdicao ?? false,
    diasAtePrimeiroClique: over.diasAtePrimeiroClique ?? null,
  };
}

// A cohort "old" enough that maturation for the click metric always passes.
const NOW_MATURE = ymdToEpoch("2026-09-01");

describe("resolveCohortDayBrt / resolveCohortWeekBrt (#7183) — fronteira BRT", () => {
  it("cadastro às 23:00 BRT (02:00 UTC do dia seguinte) cai no dia D, não D+1", () => {
    // 23:00 BRT de 2026-08-24 == 02:00 UTC de 2026-08-25.
    const created = ymdToEpoch("2026-08-25", 2);
    assert.equal(resolveCohortDayBrt(created), "2026-08-24");
  });

  it("semana rotulada pela segunda-feira", () => {
    // 2026-08-27 é uma quinta-feira; a segunda daquela semana é 2026-08-24.
    const created = ymdToEpoch("2026-08-27", 15);
    assert.equal(resolveCohortWeekBrt(created), "2026-08-24");
  });

  it("cadastro num domingo (BRT) pertence à semana que TERMINA nele", () => {
    // 2026-08-30 é um domingo; segunda daquela semana é 2026-08-24.
    const created = ymdToEpoch("2026-08-30", 15);
    assert.equal(resolveCohortWeekBrt(created), "2026-08-24");
  });
});

describe("derivarAberturaEClique (#7183) — wrapper sobre deriveBeehiivEventTypes, não reimplementa", () => {
  it("(a) status unsubscribed com total_opened>0 conta como abertura", () => {
    const { abriu, clicou } = derivarAberturaEClique({
      status: "unsubscribed",
      total_opened: 1,
      total_clicked: 0,
    });
    assert.equal(abriu, true);
    assert.equal(clicou, false);
  });

  it("status unsubscribed com total_clicked>0 conta como clique", () => {
    const { abriu, clicou } = derivarAberturaEClique({
      status: "unsubscribed",
      total_opened: 1,
      total_clicked: 1,
    });
    assert.equal(clicou, true);
  });

  it("status delivered sem contadores não conta como abertura nem clique", () => {
    const { abriu, clicou } = derivarAberturaEClique({ status: "delivered" });
    assert.equal(abriu, false);
    assert.equal(clicou, false);
  });
});

describe("(b) linha stub nunca vira assinante — reusa o guard anti-fantasma de #7181, não reimplementa", () => {
  it("registro sem subscriber_id nem email não gera identidade (extractBeehiivIdentity)", () => {
    assert.equal(extractBeehiivIdentity({ status: "opened" }), null);
  });

  it("stub sintético ({subscriber_id:'sub1'}) extrai identidade (só externalId), mas NUNCA vira subscriber novo sem alias prévio — resolveOrCreateBeehiivSubscriber devolve null (#7181)", () => {
    const identity = extractBeehiivIdentity({ subscriber_id: "sub1" });
    assert.deepEqual(identity, { externalId: "sub1", email: null });
    const db = openDiariaSubscribersDb(":memory:");
    const id = resolveOrCreateBeehiivSubscriber(db, identity!);
    assert.equal(id, null, "guard anti-fantasma #7181: sem e-mail e sem alias prévio, nunca cria subscriber");
  });

  it("mesmo stub, quando já existe um alias real pro mesmo externalId, FUNDE em vez de recusar", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const real = resolveOrCreateBeehiivSubscriber(db, { externalId: "sub1", email: "leitor@example.com" });
    const stub = resolveOrCreateBeehiivSubscriber(db, { externalId: "sub1", email: null });
    assert.equal(stub, real);
  });
});

describe("resolveEarliestCreated (#7183) — (e) reativação reseta created, entra pelo mais antigo", () => {
  it("devolve o menor epoch entre os candidatos", () => {
    const original = ymdToEpoch("2026-06-05");
    const reativado = ymdToEpoch("2026-08-30");
    assert.equal(resolveEarliestCreated([reativado, original]), original);
    assert.equal(resolveEarliestCreated([original, reativado]), original);
  });

  it("lança em array vazio — chamador não deveria ter chamado sem snapshot", () => {
    assert.throws(() => resolveEarliestCreated([]));
  });
});

describe("isBulkImport (#7183) — critério é utm_channel, nunca data hardcoded", () => {
  it("utm_channel='import' é import em massa", () => {
    assert.equal(isBulkImport("import"), true);
  });
  it("case/whitespace não importa (normalizeKey)", () => {
    assert.equal(isBulkImport(" Import "), true);
  });
  it("outro utm_channel não é import", () => {
    assert.equal(isBulkImport("api"), false);
    assert.equal(isBulkImport(null), false);
  });
});

describe("computeAberturaPrimeiraEdicao (#7183)", () => {
  it("(c) coorte cujo 1º post é 100% stub devolve indeterminado, nunca 0", () => {
    const records = [
      sub({ email: "a@example.com", primeiraEdicaoDadosDisponiveis: false }),
      sub({ email: "b@example.com", primeiraEdicaoDadosDisponiveis: false }),
    ];
    const r = computeAberturaPrimeiraEdicao(records);
    assert.equal(r.qualidade, "indeterminado");
    assert.equal(r.valor, null);
    assert.match(r.motivo ?? "", /100% stub/);
  });

  it("denominador vazio (ninguém recebeu edição) devolve indeterminado", () => {
    const records = [sub({ recebeuAoMenosUma: false })];
    const r = computeAberturaPrimeiraEdicao(records);
    assert.equal(r.qualidade, "indeterminado");
    assert.equal(r.valor, null);
  });

  it("calcula taxa exata quando todos resolvidos", () => {
    const records = [
      sub({ email: "a@example.com", abriuPrimeiraEdicao: true }),
      sub({ email: "b@example.com", abriuPrimeiraEdicao: false }),
      sub({ email: "c@example.com", abriuPrimeiraEdicao: false }),
      sub({ email: "d@example.com", abriuPrimeiraEdicao: false }),
    ];
    const r = computeAberturaPrimeiraEdicao(records);
    assert.equal(r.qualidade, "exato");
    assert.equal(r.valor, 0.25);
    assert.equal(r.denom, 4);
  });

  it("piso quando ALGUNS (não todos) não-resolvidos — taxa real só pode ser maior", () => {
    const records = [
      sub({ email: "a@example.com", abriuPrimeiraEdicao: true }),
      sub({ email: "b@example.com", primeiraEdicaoDadosDisponiveis: false }),
    ];
    const r = computeAberturaPrimeiraEdicao(records);
    assert.equal(r.qualidade, "piso");
    assert.equal(r.valor, 0.5); // denominador único = universo inteiro (2), não só resolvidos
    assert.match(r.motivo ?? "", /stub/);
  });

  it("nunca recebeu edição não entra no denominador mesmo com abertura marcada", () => {
    const records = [
      sub({ email: "a@example.com", abriuPrimeiraEdicao: true }),
      sub({ email: "b@example.com", recebeuAoMenosUma: false, abriuPrimeiraEdicao: true }),
    ];
    const r = computeAberturaPrimeiraEdicao(records);
    assert.equal(r.denom, 1);
    assert.equal(r.valor, 1);
  });

  it("exclui import em massa e conta interna/teste antes de agregar", () => {
    const records = [
      sub({ email: "a@example.com", abriuPrimeiraEdicao: true }),
      sub({ email: "import@example.com", utm_channel: "import", abriuPrimeiraEdicao: true }),
      sub({ email: "vjpixel@gmail.com", abriuPrimeiraEdicao: true }),
    ];
    const r = computeAberturaPrimeiraEdicao(records);
    assert.equal(r.denom, 1);
  });

  it("decompõe por classe de aquisição (#7173) — soma das classes bate o denom", () => {
    const records = [
      sub({ email: "a@example.com", utm_source: "linkedin", abriuPrimeiraEdicao: true }), // organico
      sub({ email: "b@example.com", utm_source: "brevo-diaria", abriuPrimeiraEdicao: false }), // reativacao
    ];
    const r = computeAberturaPrimeiraEdicao(records);
    const totalDenom = Object.values(r.porClasse).reduce((s, c) => s + c.denom, 0);
    assert.equal(totalDenom, r.denom);
    assert.equal(r.porClasse.organico.denom, 1);
    assert.equal(r.porClasse.organico.numeradorResolvido, 1);
    assert.equal(r.porClasse.reativacao.denom, 1);
  });
});

describe("computePrimeiroClique14d (#7183)", () => {
  it("(d) coorte com menos de 14 dias de maturação devolve valor: null, nunca taxa parcial", () => {
    const created = NOW_MATURE - 5 * DAY_SECONDS; // 5 dias de casa
    const records = [sub({ created, diasAtePrimeiroClique: 2 })];
    const r = computePrimeiroClique14d(records, NOW_MATURE);
    assert.equal(r.qualidade, "indeterminado");
    assert.equal(r.valor, null);
    assert.match(r.motivo ?? "", /14 dias/);
  });

  it("coorte madura (>=14 dias) calcula taxa exata", () => {
    const created = NOW_MATURE - 20 * DAY_SECONDS;
    const records = [
      sub({ email: "a@example.com", created, diasAtePrimeiroClique: 3 }), // clicou dentro de 14d
      sub({ email: "b@example.com", created, diasAtePrimeiroClique: 20 }), // clicou, mas depois de 14d — não conta
      sub({ email: "c@example.com", created, diasAtePrimeiroClique: null }), // nunca clicou
    ];
    const r = computePrimeiroClique14d(records, NOW_MATURE);
    assert.equal(r.qualidade, "exato");
    assert.equal(r.valor, 1 / 3);
  });

  it("cohort mista (1 membro imaturo) devolve indeterminado pra coorte INTEIRA", () => {
    const maduro = NOW_MATURE - 20 * DAY_SECONDS;
    const imaturo = NOW_MATURE - 3 * DAY_SECONDS;
    const records = [
      sub({ email: "a@example.com", created: maduro, diasAtePrimeiroClique: 1 }),
      sub({ email: "b@example.com", created: imaturo, diasAtePrimeiroClique: null }),
    ];
    const r = computePrimeiroClique14d(records, NOW_MATURE);
    assert.equal(r.qualidade, "indeterminado");
    assert.equal(r.valor, null);
  });

  it("denominador vazio devolve indeterminado", () => {
    const r = computePrimeiroClique14d([], NOW_MATURE);
    assert.equal(r.qualidade, "indeterminado");
  });
});

describe("applyCrossPlatformFloor (#7183) — reusa CROSS_PLATFORM_FLOOR_NOTE", () => {
  it("rebaixa exato pra piso com o aviso canônico", () => {
    const records = [sub({ abriuPrimeiraEdicao: true })];
    const r = applyCrossPlatformFloor(computeAberturaPrimeiraEdicao(records));
    assert.equal(r.qualidade, "piso");
    assert.match(r.motivo ?? "", /PISO/);
  });

  it("não altera resultado já indeterminado", () => {
    const r = applyCrossPlatformFloor(computeAberturaPrimeiraEdicao([sub({ recebeuAoMenosUma: false })]));
    assert.equal(r.qualidade, "indeterminado");
  });
});

describe("medianDiasAteClique (#7183) — complementar, só entre quem clicou em 14d", () => {
  it("mediana ímpar", () => {
    const records = [
      sub({ email: "a@example.com", diasAtePrimeiroClique: 1 }),
      sub({ email: "b@example.com", diasAtePrimeiroClique: 5 }),
      sub({ email: "c@example.com", diasAtePrimeiroClique: 9 }),
    ];
    assert.equal(medianDiasAteClique(records), 5);
  });

  it("null quando ninguém clicou (não confundir com 0)", () => {
    const records = [sub({ diasAtePrimeiroClique: null })];
    assert.equal(medianDiasAteClique(records), null);
  });

  it("clique fora da janela de 14d não entra na mediana", () => {
    const records = [
      sub({ email: "a@example.com", diasAtePrimeiroClique: 2 }),
      sub({ email: "b@example.com", diasAtePrimeiroClique: 30 }),
    ];
    assert.equal(medianDiasAteClique(records), 2);
  });
});

// ---------------------------------------------------------------------------
// Fiação em registry.ts (#7175 contrato)
// ---------------------------------------------------------------------------

function janelaDia(dia: string): Janela {
  return { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
}

function deps(over: Partial<AtivacaoCoorteMetricDeps> = {}): AtivacaoCoorteMetricDeps {
  return {
    registros: over.registros ?? (() => []),
    now: over.now ?? NOW_MATURE,
    crossPlatformFloor: over.crossPlatformFloor,
  };
}

describe("registry.ts — abertura-1a-edicao / primeiro-clique-14d (#7183)", () => {
  it("as 2 métricas estão no registry", () => {
    assert.ok(getMetric("abertura-1a-edicao"));
    assert.ok(getMetric("primeiro-clique-14d"));
  });

  it("abertura-1a-edicao: indeterminado vira MetricResult com valor null", async () => {
    const def = getMetric("abertura-1a-edicao")!;
    const r = await def.computar({ janela: janelaDia("2026-08-26"), deps: deps() });
    assert.equal(r.qualidade, "indeterminado");
    assert.equal(r.valor, null);
    assert.ok(r.motivo && r.motivo.length > 0);
  });

  it("abertura-1a-edicao: exato com decomposicao 'classe'", async () => {
    const def = getMetric("abertura-1a-edicao")!;
    const r = await def.computar({
      janela: janelaDia("2026-08-26"),
      decomposicao: "classe",
      deps: deps({ registros: () => [sub({ utm_source: "linkedin", abriuPrimeiraEdicao: true })] }),
    });
    assert.equal(r.qualidade, "exato");
    assert.equal(r.valor, 1);
    assert.ok(r.series);
  });

  it("primeiro-clique-14d: coorte madura calcula exato via deps.now injetado", async () => {
    const def = getMetric("primeiro-clique-14d")!;
    const created = NOW_MATURE - 20 * DAY_SECONDS;
    const r = await def.computar({
      janela: janelaDia("2026-08-01"),
      deps: deps({ registros: () => [sub({ created, diasAtePrimeiroClique: 3 })] }),
    });
    assert.equal(r.qualidade, "exato");
    assert.equal(r.valor, 1);
  });

  it("primeiro-clique-14d: crossPlatformFloor rebaixa qualidade pra piso", async () => {
    const def = getMetric("primeiro-clique-14d")!;
    const created = NOW_MATURE - 20 * DAY_SECONDS;
    const r = await def.computar({
      janela: janelaDia("2026-08-01"),
      deps: deps({ registros: () => [sub({ created, diasAtePrimeiroClique: 3 })], crossPlatformFloor: true }),
    });
    assert.equal(r.qualidade, "piso");
  });

  it("decomposicao fora da lista lança", async () => {
    const def = getMetric("abertura-1a-edicao")!;
    await assert.rejects(() =>
      def.computar({ janela: janelaDia("2026-08-26"), decomposicao: "produto", deps: deps() }),
    );
  });
});
