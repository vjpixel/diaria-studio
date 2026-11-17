/**
 * test/metrics-health-referencia-queda-13336.test.ts (#13336)
 *
 * Desde 12/11/2026 a `Diaria-Kit-Roster-Ingest` (04:25 BRT) leva ~3h20 e só
 * grava a linha de HOJE no `captura-log.jsonl` depois das 04:40 do
 * `Diaria-Metrics-Health-Alarm`. O gate de série da queda de aquisição
 * (#10667) contava hoje: saía 13/14 toda execução, a queda era pulada, e o
 * congelamento do #10662 deixava #8223/#8225/#8226 abertas para sempre — o
 * "fecha depois de 2 execuções sem reproduzir" nunca acontecia.
 *
 * Fix: `referenciaQuedaAquisicao` recua a referência um dia quando a coleta
 * de hoje não tem linha (atual = anteontem, provado completo pela coleta de
 * ontem). Este teste reproduz duas execuções seguidas do cenário real e
 * exige que a issue aberta feche.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MetricDef, Janela } from "../scripts/lib/metrics/registry.ts";
import {
  evaluateQueda,
  referenciaQuedaAquisicao,
  serieQuedaSemDiaCorrente,
  METRICS_HEALTH_THRESHOLDS,
  type MedicaoDia,
} from "../scripts/lib/metrics/health.ts";
import type { CapturaLogEntry } from "../scripts/lib/metrics/captura-log.ts";
import { planAlarmReconciliation, type AlarmIssuesState } from "../scripts/lib/alarm-issues.ts";
import { quedaNaoAvaliadaKeys, toMetricsHealthAlarmFinding } from "../scripts/check-metrics-health.ts";

const DEF: Pick<MetricDef, "id" | "nome" | "direcao" | "unidade"> = {
  id: "cadastros-dia",
  nome: "Cadastros por dia",
  direcao: "maior-melhor",
  unidade: "contagem",
};
const KEY = "metrics-health:queda:cadastros-dia";
const CLOSE_AFTER_RUNS = 2;

function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function janela14(hoje: string): string[] {
  const out: string[] = [];
  for (let i = 13; i >= 0; i--) out.push(addDays(hoje, -i));
  return out;
}

function janela(dia: string): Janela {
  return { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
}

function exato(dia: string, valor: number): MedicaoDia {
  return { chave: dia, resultado: { valor, janela: janela(dia), frescor: dia, qualidade: "exato", motivo: null } };
}

/** Linha `kit-vivo` bem-sucedida às 04:25 BRT (07:25 UTC) do dia. */
function coleta(dia: string, exit = 0): CapturaLogEntry {
  const captured_at = `${dia}T07:25:07.000Z`;
  return {
    captura_id: `kit-${captured_at}`,
    captured_at,
    total_retornado_api: 1660,
    novos_gravados: 2,
    eventos_estado: 3,
    exit,
    origem_serie: "kit-vivo",
  } as CapturaLogEntry;
}

/** Log como o do 300 às 04:40: todo dia tem linha, menos HOJE (ainda rodando). */
function logSemHoje(hoje: string): CapturaLogEntry[] {
  return janela14(addDays(hoje, -1)).concat([addDays(hoje, -14)]).map((d) => coleta(d));
}

/** Série estável (3 cadastros/dia, nunca zero) — a queda NÃO reproduz. */
function serieEstavel(hoje: string): MedicaoDia[] {
  return janela14(hoje).map((d) => exato(d, d === hoje ? 0 : 3));
}

function rodada(hoje: string, state: AlarmIssuesState) {
  const dias = janela14(hoje);
  const log = logSemHoje(hoje);
  const ref = referenciaQuedaAquisicao(hoje, dias, log);
  const { finding, skipMotivo } = evaluateQueda(
    DEF,
    serieQuedaSemDiaCorrente(serieEstavel(hoje), ref.corte),
    ref.diasComInsumo,
    METRICS_HEALTH_THRESHOLDS,
  );
  const naoAvaliadas = quedaNaoAvaliadaKeys([{ metricaId: DEF.id, skipMotivo }]);
  const actions = planAlarmReconciliation(
    finding ? [toMetricsHealthAlarmFinding(finding)] : [],
    state,
    CLOSE_AFTER_RUNS,
    [],
    (key) => naoAvaliadas.has(key),
  );
  return { ref, finding, skipMotivo, actions };
}

describe("#13336 — referenciaQuedaAquisicao", () => {
  it("pré-condição: com o gate antigo (janela até hoje), a coleta atrasada pula a queda (13/14)", () => {
    const hoje = "2026-11-16";
    const dias = janela14(hoje);
    const log = logSemHoje(hoje);
    const antigo = dias.filter((d) => log.some((e) => e.captured_at.startsWith(d)));
    assert.equal(antigo.length, 13);
    const { skipMotivo } = evaluateQueda(DEF, serieQuedaSemDiaCorrente(serieEstavel(hoje), hoje), antigo, METRICS_HEALTH_THRESHOLDS);
    assert.match(skipMotivo ?? "", /série curta \(13\/14/);
  });

  it("sem coleta de hoje: recua um dia, gate 14/14, atual = anteontem", () => {
    const hoje = "2026-11-16";
    const ref = referenciaQuedaAquisicao(hoje, janela14(hoje), logSemHoje(hoje));
    assert.equal(ref.deslocada, true);
    assert.equal(ref.corte, "2026-11-15");
    assert.equal(ref.diasComInsumo.length, 14);
    assert.equal(ref.diasComInsumo[0], "2026-11-02");
    assert.equal(ref.diasComInsumo[13], "2026-11-15");
    const serie = serieQuedaSemDiaCorrente(serieEstavel(hoje), ref.corte);
    assert.equal(serie[serie.length - 1].chave, "2026-11-14");
  });

  it("com coleta de hoje: referência normal (atual = ontem), sem recuo", () => {
    const hoje = "2026-11-16";
    const log = [...logSemHoje(hoje), coleta(hoje)];
    const ref = referenciaQuedaAquisicao(hoje, janela14(hoje), log);
    assert.equal(ref.deslocada, false);
    assert.equal(ref.corte, hoje);
    assert.equal(ref.diasComInsumo.length, 14);
  });

  it("linha de FALHA hoje não prova nada: recua igual (completude vem da coleta de ontem)", () => {
    const hoje = "2026-11-16";
    const log = [...logSemHoje(hoje), coleta(hoje, 1)];
    const ref = referenciaQuedaAquisicao(hoje, janela14(hoje), log);
    assert.equal(ref.deslocada, true);
    assert.equal(ref.corte, "2026-11-15");
  });

  it("sem coleta de hoje NEM de ontem: janela recuada sai curta e a queda continua congelada", () => {
    const hoje = "2026-11-16";
    const log = logSemHoje(hoje).filter((e) => !e.captured_at.startsWith("2026-11-15"));
    const ref = referenciaQuedaAquisicao(hoje, janela14(hoje), log);
    assert.equal(ref.diasComInsumo.length, 13);
    const { skipMotivo } = evaluateQueda(
      DEF,
      serieQuedaSemDiaCorrente(serieEstavel(hoje), ref.corte),
      ref.diasComInsumo,
      METRICS_HEALTH_THRESHOLDS,
    );
    assert.ok(skipMotivo, "ontem sem coleta: anteontem não está provado completo");
  });
});

describe("#13336 — duas execuções seguidas sem reproduzir fecham a issue aberta", () => {
  it("rodadas de 16/11 e 17/11 (coleta de hoje sempre atrasada): comenta, depois fecha", () => {
    let state: AlarmIssuesState = {
      [KEY]: { issueNumber: 8223, url: "https://example.invalid/8223", missingStreak: 0, closedAt: null, family: "estado" },
    };

    const r1 = rodada("2026-11-16", state);
    assert.equal(r1.skipMotivo, null, "a queda precisa ser avaliada, não pulada");
    assert.equal(r1.finding, null);
    assert.deepEqual(r1.actions, [{ kind: "comment_resolved", key: KEY, issueNumber: 8223 }]);
    state = { [KEY]: { ...state[KEY], missingStreak: 1 } };

    const r2 = rodada("2026-11-17", state);
    assert.equal(r2.skipMotivo, null);
    assert.deepEqual(r2.actions, [{ kind: "close", key: KEY, issueNumber: 8223 }]);
  });
});
