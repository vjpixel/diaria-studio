/**
 * test/metrics-health-weekend-12475.test.ts (#12475)
 *
 * A diária só sai de segunda a sexta e o cadastro orgânico acompanha a
 * edição. Num sábado, `cadastros-dia` cai para 0 contra uma baseline que
 * misturava dias úteis e fins de semana, e `evaluateQueda` reabria as
 * #8223/#8224/#8225 toda semana. Com `baselineMesmoTipoDia: tipoDiaEdicao`
 * a baseline usa só dias do mesmo tipo do ponto atual.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MetricDef, Janela } from "../scripts/lib/metrics/registry.ts";
import {
  METRICS_HEALTH_THRESHOLDS,
  evaluateQueda,
  tipoDiaEdicao,
  type MedicaoDia,
} from "../scripts/lib/metrics/health.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function janela(dia: string): Janela {
  return { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
}

function exato(dia: string, valor: number): MedicaoDia {
  return { chave: dia, resultado: { valor, janela: janela(dia), frescor: dia, qualidade: "exato", motivo: null } };
}

const CADASTROS_DEF: Pick<MetricDef, "id" | "nome" | "direcao" | "unidade"> = {
  id: "cadastros-dia",
  nome: "Cadastros por dia",
  direcao: "maior-melhor",
  unidade: "contagem",
};

/** Série de queda como `check-metrics-health.ts` monta numa execução de
 *  domingo 08/11/2026: 13 pontos (o dia corrente sai, #10647), terminando no
 *  sábado 07/11. 31/10-06/11 são os valores do Kit citados na issue; 26-30/10
 *  (seg-sex) são dias úteis típicos. */
const SERIE_SABADO: Array<[string, number]> = [
  ["2026-10-26", 4],
  ["2026-10-27", 5],
  ["2026-10-28", 4],
  ["2026-10-29", 3],
  ["2026-10-30", 4],
  ["2026-10-31", 0], // sáb
  ["2026-11-01", 0], // dom
  ["2026-11-02", 1],
  ["2026-11-03", 7],
  ["2026-11-04", 9],
  ["2026-11-05", 9],
  ["2026-11-06", 3],
  ["2026-11-07", 0], // sáb — o "atual" que reabria as issues
];
const medicoesSabado = SERIE_SABADO.map(([d, v]) => exato(d, v));
// O gate de MIN_DIAS_SERIE conta também o dia corrente (#10667).
const diasComInsumo = [...SERIE_SABADO.map(([d]) => d), "2026-11-08"];

describe("tipoDiaEdicao (#12475)", () => {
  it("sábado e domingo são fim de semana; segunda a sexta são dias úteis", () => {
    assert.equal(tipoDiaEdicao("2026-11-07"), "fim-de-semana");
    assert.equal(tipoDiaEdicao("2026-11-08"), "fim-de-semana");
    assert.equal(tipoDiaEdicao("2026-10-31"), "fim-de-semana");
    assert.equal(tipoDiaEdicao("2026-11-02"), "util");
    assert.equal(tipoDiaEdicao("2026-11-06"), "util");
  });

  it("chave inválida lança em vez de classificar em silêncio", () => {
    assert.throws(() => tipoDiaEdicao("nao-e-data"), /chave inválida/);
  });
});

describe("evaluateQueda — baselineMesmoTipoDia (#12475)", () => {
  it("REGRESSÃO: sem a opção, o sábado zerado dispara queda contra a baseline mista", () => {
    const { finding } = evaluateQueda(CADASTROS_DEF, medicoesSabado, diasComInsumo);
    assert.ok(finding, "comportamento antigo: sábado = 0 vira queda");
    assert.match(finding!.motivo, /atual=0/);
  });

  it("com tipoDiaEdicao, o sábado zerado não vira queda (baseline de fim de semana curta = skip explícito)", () => {
    const { finding, skipMotivo } = evaluateQueda(CADASTROS_DEF, medicoesSabado, diasComInsumo, METRICS_HEALTH_THRESHOLDS, {
      baselineMesmoTipoDia: tipoDiaEdicao,
    });
    assert.equal(finding, null);
    assert.match(skipMotivo!, /dia "fim-de-semana"/);
    assert.match(skipMotivo!, /2\/5 dias/);
  });

  it("fim de semana zerado contra fins de semana zerados não alarma quando a baseline basta", () => {
    const { finding, skipMotivo } = evaluateQueda(CADASTROS_DEF, medicoesSabado, diasComInsumo, {
      ...METRICS_HEALTH_THRESHOLDS,
      MIN_DIAS_BASELINE: 2,
    }, { baselineMesmoTipoDia: tipoDiaEdicao });
    assert.equal(skipMotivo, null);
    assert.equal(finding, null);
  });

  it("queda real num dia útil continua alarmando, comparada só com dias úteis", () => {
    // Termina na sexta 06/11 com 0: a média dos 9 dias úteis anteriores é 5,11.
    const serie = SERIE_SABADO.slice(0, -1).map(([d, v]) => exato(d, d === "2026-11-06" ? 0 : v));
    const { finding, skipMotivo } = evaluateQueda(CADASTROS_DEF, serie, diasComInsumo, METRICS_HEALTH_THRESHOLDS, {
      baselineMesmoTipoDia: tipoDiaEdicao,
    });
    assert.equal(skipMotivo, null);
    assert.ok(finding);
    assert.match(finding!.motivo, /baseline=5\.11/);
    assert.match(finding!.motivo, /baseline só com dias "util": 2 dia\(s\) de outro tipo/);
  });

  it("série só de dias úteis: opção não muda nada nem anexa nota", () => {
    const uteis = SERIE_SABADO.filter(([d]) => tipoDiaEdicao(d) === "util").map(([d, v]) => exato(d, v));
    const semOpcao = evaluateQueda(CADASTROS_DEF, uteis, diasComInsumo);
    const comOpcao = evaluateQueda(CADASTROS_DEF, uteis, diasComInsumo, METRICS_HEALTH_THRESHOLDS, {
      baselineMesmoTipoDia: tipoDiaEdicao,
    });
    assert.deepEqual(comOpcao, semOpcao);
  });

  it("check-metrics-health.ts passa tipoDiaEdicao na avaliação de queda da aquisição", () => {
    const src = readFileSync(resolve(ROOT, "scripts", "check-metrics-health.ts"), "utf8");
    assert.match(src, /baselineMesmoTipoDia:\s*tipoDiaEdicao/);
  });
});
