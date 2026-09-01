/**
 * test/openrouter-billing-leak.test.ts (#6716 escopo 3)
 *
 * O caso central usa os NÚMEROS REAIS do vazamento medido (29–31/08/2026,
 * `/api/v1/activity`), não fixtures inventadas: é o vazamento que existiu
 * de verdade e que o detector antigo (`vazamento_pago`, sobre
 * `session_model_usage`) não conseguia ver. Se este guard não pegar ESSES
 * números, ele não serve pro que foi feito.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateBillingLeak,
  isBillingLeak,
  billingLeakFindingKey,
  shouldAlarmBillingLeak,
  advanceBillingLeakAlarmState,
  emptyBillingLeakAlarmState,
  buildBillingLeakAlarmEmail,
  computeExpectedDays,
  hasPartialCoverage,
  EXPECTED_PAID_MODELS,
  type BillingRow,
} from "../scripts/lib/openrouter-billing-leak.ts";
import {
  loadState,
  saveState,
  parseActivityRows,
  resolveExitCode,
  resolveFatalExitCode,
  LEAK_FOUND_EXIT_CODE,
} from "../scripts/openrouter-billing-leak-check.ts";

/** Linhas reais do `/api/v1/activity`, medidas em 01/09/2026. */
const REAL_ROWS: BillingRow[] = [
  { date: "2026-08-31", model: "anthropic/claude-sonnet-5", requests: 32, usageUsd: 0.9599 },
  { date: "2026-08-31", model: "dots-studio/dots-3-note-preview", requests: 714, usageUsd: 0 },
  { date: "2026-08-31", model: "poolside/laguna-s-2.1", requests: 121, usageUsd: 0 },
  { date: "2026-08-30", model: "anthropic/claude-sonnet-5", requests: 10, usageUsd: 0.3868 },
  { date: "2026-08-30", model: "openai/gpt-5.6-luna", requests: 7, usageUsd: 0.0783 },
  { date: "2026-08-29", model: "anthropic/claude-sonnet-5", requests: 21, usageUsd: 1.2064 },
  { date: "2026-08-29", model: "z-ai/glm-5.3-flash", requests: 402, usageUsd: 0.7145 },
];

describe("evaluateBillingLeak (#6716 escopo 3) — contra o vazamento REAL medido", () => {
  it("pega as 3 linhas de claude-sonnet-5 e soma o USD certo", () => {
    const r = evaluateBillingLeak(REAL_ROWS);
    assert.equal(r.leaks.length, 3, "as 3 linhas de sonnet (29, 30 e 31/08) são vazamento");
    assert.ok(r.leaks.every((l) => l.model === "anthropic/claude-sonnet-5"));
    assert.equal(Number(r.leakedUsd.toFixed(4)), 2.5531, "1.2064 + 0.3868 + 0.9599");
  });

  it("NÃO acusa os modelos que o repo de fato pede", () => {
    const r = evaluateBillingLeak(REAL_ROWS);
    const flagged = r.leaks.map((l) => l.model);
    assert.ok(!flagged.includes("z-ai/glm-5.3-flash"), "elo pago da cadeia é esperado");
    assert.ok(!flagged.includes("openai/gpt-5.6-luna"), "primário do job é esperado");
  });

  it("`:free` com usage 0 nunca é vazamento (custo dele é cota, não dólar)", () => {
    assert.equal(
      isBillingLeak({ date: "2026-08-31", model: "dots-studio/dots-3-note-preview:free", requests: 714, usageUsd: 0 }),
      false,
    );
  });

  it("modelo pago desconhecido com usage > 0 é vazamento, mesmo com poucas requisições", () => {
    assert.equal(isBillingLeak({ date: "2026-09-01", model: "openai/gpt-4o", requests: 1, usageUsd: 0.0001 }), true);
  });

  it("usage 0 num modelo pago não acusa — cobrança zero não é gasto não pedido", () => {
    assert.equal(isBillingLeak({ date: "2026-09-01", model: "anthropic/claude-sonnet-5", requests: 3, usageUsd: 0 }), false);
  });

  // #6983 (review, achado 3): havia um `if (model.endsWith(":free")) return false`
  // DEPOIS do teste de `usageUsd > 0` — alcançável só por um `:free` que de
  // fato cobrou dólar, que é exatamente a anomalia que interessa ver.
  it("`:free` que COBROU dólar é vazamento — o atalho por sufixo descartava justo a anomalia", () => {
    assert.equal(
      isBillingLeak({ date: "2026-09-01", model: "dots-studio/dots-3-note-preview:free", requests: 5, usageUsd: 0.42 }),
      true,
      "modelo anunciado como grátis cobrando é achado, não exceção a silenciar",
    );
  });

  it("usageUsd NaN/negativo não acusa — só gasto positivo é 'gasto não pedido'", () => {
    assert.equal(isBillingLeak({ date: "2026-09-01", model: "x/y", requests: 1, usageUsd: Number.NaN }), false);
    assert.equal(isBillingLeak({ date: "2026-09-01", model: "x/y", requests: 1, usageUsd: -0.5 }), false, "crédito/reembolso");
  });

  it("totalUsd soma tudo, leakedUsd só o que vazou", () => {
    const r = evaluateBillingLeak(REAL_ROWS);
    assert.equal(Number(r.totalUsd.toFixed(4)), 3.3459);
    assert.ok(r.leakedUsd < r.totalUsd);
  });

  it("EXPECTED_PAID_MODELS cobre as 2 formas do mesmo modelo (id puro e prefixado)", () => {
    assert.ok(EXPECTED_PAID_MODELS.has("gpt-5.6-luna"));
    assert.ok(EXPECTED_PAID_MODELS.has("openai-codex/gpt-5.6-luna"));
    assert.ok(EXPECTED_PAID_MODELS.has("openai/gpt-5.6-luna"));
  });
});

describe("idempotência do alarme (#6716)", () => {
  it("mesmo conjunto de vazamentos não re-alarma", () => {
    const ev = evaluateBillingLeak(REAL_ROWS);
    const st = advanceBillingLeakAlarmState(ev, new Date());
    assert.equal(shouldAlarmBillingLeak(st, ev), false);
  });

  it("vazamento em DIA NOVO re-alarma, mesmo sendo o mesmo modelo", () => {
    const ev1 = evaluateBillingLeak(REAL_ROWS);
    const st = advanceBillingLeakAlarmState(ev1, new Date());
    const ev2 = evaluateBillingLeak([
      ...REAL_ROWS,
      { date: "2026-09-02", model: "anthropic/claude-sonnet-5", requests: 5, usageUsd: 0.2 },
    ]);
    assert.equal(shouldAlarmBillingLeak(st, ev2), true, "dia novo é achado novo, não repetição");
  });

  it("sem vazamento → nunca alarma e re-arma o cursor", () => {
    const clean = evaluateBillingLeak([{ date: "2026-09-01", model: "z-ai/glm-5.3-flash", requests: 10, usageUsd: 0.05 }]);
    assert.equal(shouldAlarmBillingLeak(emptyBillingLeakAlarmState(), clean), false);
    assert.equal(advanceBillingLeakAlarmState(clean, new Date()).lastAlarmedFingerprint, null);
  });

  it("fingerprint é estável independente da ordem das linhas", () => {
    const a = billingLeakFindingKey(evaluateBillingLeak(REAL_ROWS));
    const b = billingLeakFindingKey(evaluateBillingLeak([...REAL_ROWS].reverse()));
    assert.equal(a, b);
  });
});

describe("buildBillingLeakAlarmEmail (#6716)", () => {
  it("assunto traz o valor vazado; corpo lista cada achado e explica por que lê o gateway", () => {
    const { subject, body } = buildBillingLeakAlarmEmail(evaluateBillingLeak(REAL_ROWS), new Date("2026-09-01T21:00:00Z"));
    assert.match(subject, /2\.5531/);
    assert.match(body, /anthropic\/claude-sonnet-5/);
    assert.match(body, /session_model_usage/, "o corpo tem que dizer por que a tabela local não serve");
    assert.match(body, /EXPECTED_PAID_MODELS/, "tem que dizer como legitimar um modelo, pra ninguém silenciar de outro jeito");
  });
});

describe("parseActivityRows (#6716) — I/O", () => {
  it("payload válido vira BillingRow[]", () => {
    const { rows, skipped } = parseActivityRows({
      data: [{ date: "2026-08-31", model: "anthropic/claude-sonnet-5", requests: 32, usage: 0.9599 }],
    });
    assert.equal(rows.length, 1);
    assert.equal(skipped, 0);
    assert.equal(rows[0].usageUsd, 0.9599);
  });

  it("linha com usage não-numérico é DESCARTADA e contada — nunca coagida pra 0", () => {
    const { rows, skipped } = parseActivityRows({
      data: [
        { date: "2026-08-31", model: "x/y", requests: 1, usage: "não é número" },
        { date: "2026-08-31", model: "a/b", requests: 1, usage: 0.5 },
      ],
    });
    assert.equal(rows.length, 1, "só a linha íntegra entra");
    assert.equal(skipped, 1, "a descartada é contada — resultado parcial é sinalizado, não silenciado");
  });

  // #6983 (review, CRÍTICO): `Number(null)`, `Number(false)` e `Number("")`
  // são TODOS `0`, e `0` passa por `Number.isFinite`. A 1ª versão fazia
  // `Number(o.usage)` cru e transformava essas linhas em `usageUsd: 0` — que
  // `isBillingLeak` trata como "nunca é vazamento". Um modelo pago vazando
  // com o campo de custo nulo era relatado como LIMPO, e nem contava em
  // `skipped`. É o mesmo falso "ok" que este guard existe pra não repetir,
  // reintroduzido pela porta do parsing. Cada valor abaixo tem que ser
  // DESCARTADO e CONTADO, nunca coagido.
  for (const [nome, usage] of [
    ["null", null],
    ["false", false],
    ["string vazia", ""],
    ["string só de espaço", "   "],
    ["array vazio", []],
    ["objeto", {}],
    ["undefined (campo ausente)", undefined],
  ] as const) {
    it(`usage \`${nome}\` é descartado e contado — nunca vira 0 silencioso`, () => {
      const { rows, skipped } = parseActivityRows({
        data: [{ date: "2026-08-31", model: "anthropic/claude-sonnet-5", requests: 32, usage }],
      });
      assert.deepEqual(rows, [], `usage ${nome} não pode virar linha com usageUsd 0`);
      assert.equal(skipped, 1, `usage ${nome} tem que contar como descartado`);
    });
  }

  it("usage numérico 0 legítimo NÃO é descartado — é `:free` normal, dado íntegro", () => {
    const { rows, skipped } = parseActivityRows({
      data: [{ date: "2026-08-31", model: "dots-studio/dots-3-note-preview:free", requests: 714, usage: 0 }],
    });
    assert.equal(rows.length, 1, "0 numérico é medição real, não shape inválido");
    assert.equal(skipped, 0);
    assert.equal(rows[0].usageUsd, 0);
  });

  it("usage numérico em STRING é aceito — o gateway já mandou assim", () => {
    const { rows, skipped } = parseActivityRows({
      data: [{ date: "2026-08-31", model: "x/y", requests: 1, usage: "0.9599" }],
    });
    assert.equal(skipped, 0);
    assert.equal(rows[0].usageUsd, 0.9599);
  });

  it("payload sem data[] → vazio, nunca lança", () => {
    assert.doesNotThrow(() => parseActivityRows({}));
    assert.deepEqual(parseActivityRows({}), { rows: [], skipped: 0 });
    assert.deepEqual(parseActivityRows(null), { rows: [], skipped: 0 });
  });

  // #6983 (pr-test-analyzer, P2 CRÍTICO): itens null/undefined ou não-objeto
  // no array `data` faziam `o.date` lançar TypeError — crash silencioso antes
  // de chegar ao skip-count, matando o guard por completo.
  for (const [nome, item] of [
    ["null", null],
    ["undefined", undefined],
    ["string", "não é objeto"],
    ["número", 42],
    ["boolean", true],
  ] as const) {
    it(`item \`${nome}\` no array data é descartado e contado — nunca lança TypeError`, () => {
      const { rows, skipped } = parseActivityRows({
        data: [item, { date: "2026-08-31", model: "x/y", requests: 1, usage: 0.5 }],
      });
      assert.equal(rows.length, 1, "só a linha íntegra sobrevive");
      assert.equal(rows[0].model, "x/y");
      assert.equal(skipped, 1, `item ${nome} deve contar como descartado`);
    });
  }
});

describe("computeExpectedDays (#6992) — dias esperados na janela", () => {
  it("retorna N dias de calendário UTC terminando ontem — nunca inclui hoje", () => {
    // now = 2026-09-01 12:00 UTC → ontem = 2026-08-31
    const now = new Date("2026-09-01T12:00:00Z");
    const expected = computeExpectedDays(3, now);
    assert.equal(expected.length, 3);
    assert.deepEqual(expected, ["2026-08-29", "2026-08-30", "2026-08-31"]);
    assert.ok(!expected.includes("2026-09-01"), "nunca inclui o dia corrente (endpoint não cobre)");
  });

  it("é consistente ao longo do dia — o cutoff UTC não muda o conjunto de dias", () => {
    // O cutoff em main() é `Date.now() - days*24h` em UTC; os dois lados da
    // comparação (filtro e expected days) devem produzir o mesmo conjunto.
    const base = new Date("2026-09-01T00:30:00Z");
    const mid = new Date("2026-09-01T12:00:00Z");
    const late = new Date("2026-09-01T23:59:00Z");
    assert.deepEqual(computeExpectedDays(3, base), computeExpectedDays(3, mid));
    assert.deepEqual(computeExpectedDays(3, mid), computeExpectedDays(3, late));
  });

  it("days=1 retorna só ontem", () => {
    const now = new Date("2026-09-01T12:00:00Z");
    assert.deepEqual(computeExpectedDays(1, now), ["2026-08-31"]);
  });

  it("days<=0 retorna vazio", () => {
    assert.deepEqual(computeExpectedDays(0), []);
    assert.deepEqual(computeExpectedDays(-1), []);
  });

  it("ordenado ascendente", () => {
    const now = new Date("2026-09-05T12:00:00Z");
    const expected = computeExpectedDays(5, now);
    assert.deepEqual(expected, ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
  });
});

describe("hasPartialCoverage (#6992) — presença parcial ≠ cobertura completa", () => {
  const expected3 = ["2026-08-29", "2026-08-30", "2026-08-31"];

  it("todos os dias presentes → false (cobertura completa)", () => {
    assert.equal(hasPartialCoverage(["2026-08-29", "2026-08-30", "2026-08-31"], expected3), false);
  });

  // #6992 — O CENÁRIO CENTRAL: só o dia mais velho (D-3) presente, faltando
  // D-1 e D-2 (justamente onde um vazamento fresco seria visível). O guard
  // original lia isso como "sem vazamento" porque daysCovered.length > 0.
  it("apenas D-3 presente, D-1 e D-2 ausentes → true (o bug do #6992)", () => {
    assert.equal(hasPartialCoverage(["2026-08-29"], expected3), true);
  });

  it("D-1 (mais recente) ausente → true — é onde o vazamento fresco seria", () => {
    assert.equal(hasPartialCoverage(["2026-08-29", "2026-08-30"], expected3), true);
  });

  it("D-1 ausente mas D-3 presente → true", () => {
    assert.equal(hasPartialCoverage(["2026-08-29"], expected3), true);
  });

  it("daysCovered vazio → true (mas main() já pega isso como emptyWindow antes)", () => {
    assert.equal(hasPartialCoverage([], expected3), true);
  });

  it("dias fora da janela esperado não preenchem os que faltam", () => {
    // Um dia fora da janela não salva a cobertura
    assert.equal(hasPartialCoverage(["2026-08-28", "2026-08-31"], expected3), true);
  });
});

// #6983 (pr-test-analyzer, P2): verifica que o cutoff usado em main()
// (Date.now() - days*86400000, convertido pra date-string) e o conjunto
// retornado por computeExpectedDays — que usa Date.UTC(year, month, day-i) —
// cobrem OS MESMOS dias. Divergência entre os dois é o que faria um dia
// "esperado" ser filtrado antes de chegar no daysCovered, gerando
// partialCoverage=true por engano, ou pior, um dia "extra" passar sem ser
// contabilizado.
describe("cutoff ⇄ computeExpectedDays alinhamento (#6983 pr-test-analyzer P2)", () => {
  it("em 4 momentos distintos do dia UTC, os dias esperados sempre passam pelo cutoff", () => {
    // Replica a fórmula de cutoff de main():
    //   new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
    for (const now of [
      new Date("2026-09-01T00:00:00.001Z"),
      new Date("2026-09-01T03:30:00Z"),
      new Date("2026-09-01T12:00:00Z"),
      new Date("2026-09-01T23:59:59.999Z"),
    ]) {
      for (const days of [1, 2, 3, 7]) {
        const cutoff = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const expectedDays = computeExpectedDays(days, now);
        for (const d of expectedDays) {
          assert.ok(
            d >= cutoff,
            `dia esperado ${d} deveria passar pelo cutoff ${cutoff} (days=${days}, now=${now.toISOString()})`,
          );
        }
      }
    }
  });

  it("cutoff é sempre estritamente antes de hoje — dia corrente não está na janela esperada", () => {
    for (const now of [
      new Date("2026-09-01T00:00:00.001Z"),
      new Date("2026-09-01T23:59:59.999Z"),
    ]) {
      for (const days of [1, 3, 7]) {
        const cutoff = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const today = now.toISOString().slice(0, 10);
        assert.equal(cutoff < today, true, `cutoff ${cutoff} deveria ser antes de hoje ${today}`);
      }
    }
  });

  it("corte de main() + computeExpectedDays na prática: 3 dias de rows reais cabem na janela", () => {
    // Simula o que main() faz: cutoff filtra, depois computeExpectedDays checa cobertura.
    const now = new Date("2026-09-01T12:00:00Z");
    const days = 3;
    const cutoff = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const expectedDays = computeExpectedDays(days, now);

    // Rows cobrindo todos os 3 dias esperados → passam pelo cutoff e preenchem a janela
    const rows = [
      { date: "2026-08-29T10:00:00Z", model: "x/y", requests: 1, usageUsd: 0.1 },
      { date: "2026-08-30T10:00:00Z", model: "x/y", requests: 1, usageUsd: 0.1 },
      { date: "2026-08-31T10:00:00Z", model: "x/y", requests: 1, usageUsd: 0.1 },
    ];
    const filtered = rows.filter((r) => r.date.slice(0, 10) >= cutoff);
    const daysCovered = [...new Set(filtered.map((r) => r.date.slice(0, 10)))].sort();
    assert.deepEqual(daysCovered, expectedDays, "todos os dias esperados passam pelo cutoff");
    assert.equal(hasPartialCoverage(daysCovered, expectedDays), false, "cobertura completa → sem partialCoverage");
  });
});

describe("resolveExitCode (#6992) — presença parcial da janela nunca sai 0", () => {
  // #6992 — o guard original só tratava janela 100% vazia como indeterminado.
  // Presença parcial (ex: só D-3 presente) passava despercebida e o processo
  // saía 0 ("sem vazamento") sobre medição incompleta.
  it("sem vazamento MAS cobertura parcial → 1, nunca 0", () => {
    assert.equal(
      resolveExitCode({ hasLeaks: false, partialRead: false, emptyWindow: false, partialCoverage: true }),
      1,
      "ausência de dias recentes é indeterminado — não cobertura completa",
    );
  });

  it("vazamento ENCONTRADO vence sobre cobertura parcial → 3", () => {
    // Mesmo dado incompleto, um vazamento achado é informação concreta.
    assert.equal(
      resolveExitCode({ hasLeaks: true, partialRead: false, emptyWindow: false, partialCoverage: true }),
      LEAK_FOUND_EXIT_CODE,
    );
  });

  it("sem vazamento, cobertura COMPLETA, leitura íntegra → 0", () => {
    assert.equal(
      resolveExitCode({ hasLeaks: false, partialRead: false, emptyWindow: false, partialCoverage: false }),
      0,
    );
  });

  it("cobertura parcial E leitura parcial → 1", () => {
    assert.equal(
      resolveExitCode({ hasLeaks: false, partialRead: true, emptyWindow: false, partialCoverage: true }),
      1,
    );
  });
});

describe("resolveExitCode (#6716) — o que não foi medido nunca sai 0", () => {
  it("sem vazamento, leitura íntegra, janela POVOADA e cobertura COMPLETA → 0", () => {
    assert.equal(resolveExitCode({ hasLeaks: false, partialRead: false, emptyWindow: false, partialCoverage: false }), 0);
  });

  // Levantado pela peer no review do #6983: o `/api/v1/activity` agrega por
  // dias UTC COMPLETOS e não cobre o dia corrente — uma janela que só
  // pergunte por "hoje" volta vazia SEMPRE. Se zero linhas pudesse virar
  // exit 0, o guard reportaria "sem vazamento" por ausência de dado, não por
  // ausência de gasto. É a 3ª vez que esta família de detector aparece com o
  // silêncio cego indistinguível de saúde (#6966: `LIKE` casando zero linhas
  // com o watchdog imprimindo "tick ok"; #6927: sinal que some quando o
  // updater desliga). Aqui isso é impossível por construção.
  it("JANELA VAZIA nunca sai 0 — zero linhas é indeterminado, não 'limpo'", () => {
    assert.equal(
      resolveExitCode({ hasLeaks: false, partialRead: false, emptyWindow: true, partialCoverage: false }),
      1,
      "endpoint sem consolidar e gasto zero real são indistinguíveis daqui — não afirmar nenhum dos dois",
    );
  });

  it("janela vazia E leitura parcial → 1 (as duas são ausência de dado)", () => {
    assert.equal(resolveExitCode({ hasLeaks: false, partialRead: true, emptyWindow: true, partialCoverage: false }), 1);
  });

  // #6983 (review, CRÍTICO): antes disso, `skipped > 0` era só um
  // `console.error` — com as linhas sobreviventes limpas, o processo saía 0 e
  // implicava "sem vazamento" sobre uma medição admitidavelmente incompleta.
  it("sem vazamento MAS leitura parcial → 1, nunca 0", () => {
    assert.equal(
      resolveExitCode({ hasLeaks: false, partialRead: true, emptyWindow: false, partialCoverage: false }),
      1,
      "não medi ≠ está limpo — é a falha que este guard existe pra não repetir",
    );
  });

  it("vazamento → 3, e continua 3 mesmo com leitura parcial", () => {
    assert.equal(resolveExitCode({ hasLeaks: true, partialRead: false, emptyWindow: false, partialCoverage: false }), LEAK_FOUND_EXIT_CODE);
    assert.equal(resolveExitCode({ hasLeaks: true, partialRead: true, emptyWindow: true, partialCoverage: false }), LEAK_FOUND_EXIT_CODE);
  });

  // #6983 (review independente, P1 REPRODUZIDO POR EXECUÇÃO): o catch de topo
  // fazia `process.exitCode = 1` incondicional e apagava o 3 que `main()`
  // tinha setado antes de alarmar. Com vazamento real + Gmail sem credencial
  // (token expirado em produção), o script logava `achados=1 vazado=US$1.2064`
  // e SAÍA 1 — o vazamento visível no log, invisível no canal autoritativo.
  it("throw depois de achar vazamento PRESERVA o 3 — não colapsa em 'quebrou'", () => {
    assert.equal(
      resolveFatalExitCode(LEAK_FOUND_EXIT_CODE),
      LEAK_FOUND_EXIT_CODE,
      "Gmail/disco falhando não apaga o fato de haver gasto não pedido a olhar",
    );
  });

  it("throw sem vazamento pendente → 1", () => {
    assert.equal(resolveFatalExitCode(0), 1);
    assert.equal(resolveFatalExitCode(1), 1);
    assert.equal(resolveFatalExitCode(undefined), 1, "exitCode ainda não setado");
    assert.equal(resolveFatalExitCode(null), 1, "`process.exitCode` é tipado com null no Node");
    assert.equal(resolveFatalExitCode("3"), 1, "string '3' não é o nosso 3 — só o número exato preserva");
  });

  it("3 é distinto de 1 — o runner precisa separar 'achou' de 'quebrou'", () => {
    assert.notEqual(LEAK_FOUND_EXIT_CODE, 1);
    assert.notEqual(LEAK_FOUND_EXIT_CODE, 0);
  });
});

describe("loadState/saveState (#6716) — I/O", () => {
  it("ausente → estado vazio; roundtrip preserva; JSON corrompido → vazio sem lançar", () => {
    const dir = mkdtempSync(join(tmpdir(), "billing-leak-"));
    try {
      const p = join(dir, "state.json");
      assert.deepEqual(loadState(p), emptyBillingLeakAlarmState());

      const st = { lastAlarmedFingerprint: "2026-08-31:anthropic/claude-sonnet-5", lastCheckedAt: "2026-09-01T00:00:00.000Z" };
      saveState(st, p);
      assert.ok(existsSync(p));
      assert.deepEqual(loadState(p), st);

      writeFileSync(p, "não é json{{{");
      assert.doesNotThrow(() => loadState(p));
      assert.deepEqual(loadState(p), emptyBillingLeakAlarmState());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
