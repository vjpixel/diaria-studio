/**
 * test/metrics-health.test.ts (#7172, fatia 8 — #7180)
 *
 * `scripts/lib/metrics/health.ts` — módulo puro. Cobre os 5 sinais e o
 * ciclo de issue (via `AlarmFinding` + `planAlarmReconciliation`/
 * `applyAlarmReconciliation`, `scripts/lib/alarm-issues.ts`) usando o
 * finding builder de `scripts/check-metrics-health.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MetricDef, Janela, Meta, MetaStatus } from "../scripts/lib/metrics/registry.ts";
import { METRICAS } from "../scripts/lib/metrics/registry.ts";
import {
  METRICS_HEALTH_THRESHOLDS,
  assertQuedaMinAbsCobreUnidades,
  evaluateFrescorFromCapturaLog,
  evaluateFrescorFromResult,
  evaluateIndeterminadoCrescendo,
  evaluateMetaSinal,
  evaluateQueda,
  evaluateRegistryMudo,
  metricsHealthFingerprint,
  type MedicaoDia,
  type MetricsHealthFinding,
} from "../scripts/lib/metrics/health.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmIssuesState,
} from "../scripts/lib/alarm-issues.ts";
import type { CapturaLogEntry } from "../scripts/lib/metrics/captura-log.ts";
import { toMetricsHealthAlarmFinding } from "../scripts/check-metrics-health.ts";

function janela(dia: string): Janela {
  return { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
}

function exato(dia: string, valor: number, frescor: string | null = dia): MedicaoDia {
  return { chave: dia, resultado: { valor, janela: janela(dia), frescor, qualidade: "exato", motivo: null } };
}

function indeterminadoMed(dia: string): MedicaoDia {
  return {
    chave: dia,
    resultado: { valor: null, janela: janela(dia), frescor: null, qualidade: "indeterminado", motivo: "sem coleta" },
  };
}

function capturaEntry(day: string): CapturaLogEntry {
  return {
    captura_id: `kit-${day}T04:25:00Z`,
    captured_at: `${day}T04:25:00Z`,
    total_retornado_api: 10,
    novos_gravados: 5,
    eventos_estado: 0,
    exit: 0,
  };
}

/** 14 dias `AAAA-MM-DD` consecutivos terminando em `hoje`. */
function dias14(hoje: string): string[] {
  const out: string[] = [];
  const [y, m, d] = hoje.split("-").map(Number);
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - i);
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

const CONTAGEM_DEF: Pick<MetricDef, "id" | "nome" | "direcao" | "unidade"> = {
  id: "cadastros-dia",
  nome: "Cadastros por dia",
  direcao: "maior-melhor",
  unidade: "contagem",
};

const RAZAO_MENOR_MELHOR_DEF: Pick<MetricDef, "id" | "nome" | "direcao" | "unidade"> = {
  id: "cadastros-indeterminados-dia",
  nome: "Fração indeterminados",
  direcao: "menor-melhor",
  unidade: "razao",
};

describe("assertQuedaMinAbsCobreUnidades", () => {
  it("registry real (METRICAS) passa sem lançar — toda unidade usada tem piso declarado", () => {
    assert.doesNotThrow(() => assertQuedaMinAbsCobreUnidades(METRICAS));
  });

  it("unidade sem piso declarado lança em tempo de carga", () => {
    const defs = [{ id: "m1", unidade: "brl" as const, direcao: "maior-melhor" as const }];
    assert.throws(() => assertQuedaMinAbsCobreUnidades(defs), /sem piso QUEDA_MIN_ABS/);
  });

  it("direcao neutro nunca exige piso (nunca alarma)", () => {
    const defs = [{ id: "m1", unidade: "brl" as const, direcao: "neutro" as const }];
    assert.doesNotThrow(() => assertQuedaMinAbsCobreUnidades(defs));
  });
});

/** `diasComColeta` a partir de um `capturaLog` sintético — mesma tradução
 *  que `check-metrics-health.ts` faz via `hasCaptureOnDay` antes de passar
 *  pra `evaluateQueda` (que, desde #7378, não conhece mais captura-log.jsonl
 *  diretamente — recebe a cobertura já resolvida pelo chamador). */
function diasComColetaFrom(dias: readonly string[], capturaLog: readonly CapturaLogEntry[]): string[] {
  const captured = new Set(capturaLog.map((e) => e.captured_at.slice(0, 10)));
  return dias.filter((d) => captured.has(d));
}

describe("evaluateQueda", () => {
  it("direcao neutro nunca alarma, sempre skip", () => {
    const def = { ...CONTAGEM_DEF, direcao: "neutro" as const };
    const dias = dias14("2026-09-01");
    const medicoes = dias.map((d) => exato(d, 10));
    const { finding, skipMotivo } = evaluateQueda(def, medicoes, dias);
    assert.equal(finding, null);
    assert.match(skipMotivo!, /neutro/);
  });

  it("série curta (menos de MIN_DIAS_SERIE dias com insumo disponível) — skip, nunca alarma", () => {
    const dias = dias14("2026-09-01");
    const medicoes = dias.map((d, i) => exato(d, i < 10 ? 10 : 2));
    // só os últimos 5 dias têm insumo disponível
    const { finding, skipMotivo } = evaluateQueda(CONTAGEM_DEF, medicoes, dias.slice(-5));
    assert.equal(finding, null);
    assert.match(skipMotivo!, /série curta/);
  });

  it("ruído dentro do piso não gera nada (nem finding, nem skip)", () => {
    const dias = dias14("2026-09-01");
    // baseline ~10, último dia 9 — 10% de queda, abaixo de QUEDA_MIN_PCT (15%)
    const medicoes = dias.map((d, i) => exato(d, i === dias.length - 1 ? 9 : 10));
    const { finding, skipMotivo } = evaluateQueda(CONTAGEM_DEF, medicoes, dias);
    assert.equal(finding, null);
    assert.equal(skipMotivo, null);
  });

  it("queda real (maior-melhor, contagem) cruza os dois pisos — gera finding", () => {
    const dias = dias14("2026-09-01");
    // baseline 10, último dia 2 — 80% de queda, delta absoluto 8 (>= piso 2)
    const medicoes = dias.map((d, i) => exato(d, i === dias.length - 1 ? 2 : 10));
    const { finding, skipMotivo } = evaluateQueda(CONTAGEM_DEF, medicoes, dias);
    assert.equal(skipMotivo, null);
    assert.ok(finding);
    assert.equal(finding!.sinal, "queda");
    assert.equal(finding!.metrica_id, "cadastros-dia");
  });

  it("métrica menor-melhor (razão) alarma ao SUBIR, não ao cair", () => {
    const dias = dias14("2026-09-01");
    // baseline 0.05, último dia CAI pra 0.01 — bom pra menor-melhor, nunca alarma
    const caindo = dias.map((d, i) => exato(d, i === dias.length - 1 ? 0.01 : 0.05));
    const resultCaindo = evaluateQueda(RAZAO_MENOR_MELHOR_DEF, caindo, dias);
    assert.equal(resultCaindo.finding, null);

    // baseline 0.05, último dia SOBE pra 0.20 — ruim pra menor-melhor, alarma
    const subindo = dias.map((d, i) => exato(d, i === dias.length - 1 ? 0.2 : 0.05));
    const resultSubindo = evaluateQueda(RAZAO_MENOR_MELHOR_DEF, subindo, dias);
    assert.ok(resultSubindo.finding);
    assert.equal(resultSubindo.finding!.sinal, "queda");
  });

  it("faixa não vira sinal por movimento dentro dos próprios limites — comparação usa `valor` (o piso), nunca `limites.max`", () => {
    const dias = dias14("2026-09-01");
    // MetricResult.valor já É o piso pra 'faixa' — teto oscilando não entra
    // na conta porque nunca é lido por evaluateQueda.
    const medicoes: MedicaoDia[] = dias.map((d, i) => ({
      chave: d,
      resultado: {
        valor: 5, // piso estável
        janela: janela(d),
        frescor: d,
        qualidade: "faixa",
        motivo: "faixa",
        limites: { min: 5, max: i === dias.length - 1 ? 50 : 8 }, // teto oscila muito, min nunca muda
      },
    }));
    const { finding } = evaluateQueda(CONTAGEM_DEF, medicoes, dias);
    assert.equal(finding, null);
  });

  it("piso alarma só quando o PISO CAI (qualidade 'piso' usa o mesmo `valor`)", () => {
    const dias = dias14("2026-09-01");
    const medicoesSubindo: MedicaoDia[] = dias.map((d, i) => ({
      chave: d,
      resultado: {
        valor: i === dias.length - 1 ? 20 : 10,
        janela: janela(d),
        frescor: d,
        qualidade: "piso",
        motivo: "piso subindo — não prova nada",
      },
    }));
    assert.equal(evaluateQueda(CONTAGEM_DEF, medicoesSubindo, dias).finding, null);

    const medicoesCaindo: MedicaoDia[] = dias.map((d, i) => ({
      chave: d,
      resultado: {
        valor: i === dias.length - 1 ? 2 : 10,
        janela: janela(d),
        frescor: d,
        qualidade: "piso",
        motivo: "piso caindo — sinal real",
      },
    }));
    const resultCaindo = evaluateQueda(CONTAGEM_DEF, medicoesCaindo, dias);
    assert.ok(resultCaindo.finding);
  });

  it("fingerprint estável entre 2 execuções com o mesmo dado (nunca inclui números)", () => {
    const dias = dias14("2026-09-01");
    const medicoes = dias.map((d, i) => exato(d, i === dias.length - 1 ? 2 : 10));
    const r1 = evaluateQueda(CONTAGEM_DEF, medicoes, dias).finding!;
    const r2 = evaluateQueda(CONTAGEM_DEF, medicoes, dias).finding!;
    assert.equal(metricsHealthFingerprint(r1), metricsHealthFingerprint(r2));
    assert.equal(metricsHealthFingerprint(r1), "queda:cadastros-dia");
  });

  it("cobertura via captura-log.jsonl (tradução que check-metrics-health.ts faz) — mesmo resultado do gate por dias diretos", () => {
    const dias = dias14("2026-09-01");
    const medicoes = dias.map((d, i) => exato(d, i === dias.length - 1 ? 2 : 10));
    const capturaLog = dias.map(capturaEntry);
    const { finding } = evaluateQueda(CONTAGEM_DEF, medicoes, diasComColetaFrom(dias, capturaLog));
    assert.ok(finding);
  });

  it("#7378 (type-design-analyzer): medicoes fora de ordem cronológica lança, nunca silenciosamente troca baseline/atual", () => {
    const dias = dias14("2026-09-01");
    const medicoes = dias.map((d, i) => exato(d, i === dias.length - 1 ? 2 : 10));
    const foraDeOrdem = [medicoes[1], medicoes[0], ...medicoes.slice(2)];
    assert.throws(() => evaluateQueda(CONTAGEM_DEF, foraDeOrdem, dias), /fora de ordem cronológica/);
  });
});

describe("evaluateFrescorFromResult — sinal principal desta fatia", () => {
  it("dia sem coleta (frescor nulo em toda a série) — NUNCA gera sinal de frescor a partir do resultado (ausência conhecida, não regressão)", () => {
    const dias = dias14("2026-09-01");
    const medicoes = dias.map((d) => indeterminadoMed(d));
    const finding = evaluateFrescorFromResult("doi-confirmacao-dia", medicoes, dias[dias.length - 1]);
    assert.equal(finding, null);
  });

  it("dia sem coleta gera sinal de FRESCOR (via captura-log), nunca de QUEDA — série que tinha frescor e o mais recente ficou velho", () => {
    const dias = dias14("2026-09-01");
    const hoje = dias[dias.length - 1];
    // frescor congelado 5 dias atrás (> FRESCOR_MAX_DIAS=2)
    const frescorVelho = dias[dias.length - 6];
    const medicoes = dias.map((d, i) => exato(d, 10, i <= dias.length - 6 ? frescorVelho : null));
    const finding = evaluateFrescorFromResult("cadastros-dia", medicoes, hoje);
    assert.ok(finding);
    assert.equal(finding!.sinal, "frescor");
  });

  it("frescor recente (dentro do limiar) — sem achado", () => {
    const dias = dias14("2026-09-01");
    const hoje = dias[dias.length - 1];
    const medicoes = dias.map((d) => exato(d, 10, d));
    const finding = evaluateFrescorFromResult("cadastros-dia", medicoes, hoje);
    assert.equal(finding, null);
  });
});

describe("evaluateFrescorFromCapturaLog — buraco em captura-log.jsonl (F2)", () => {
  it("sinal de frescor disparando ao apagar um dia do captura-log.jsonl (critério de aceite (b) da issue)", () => {
    const dias = dias14("2026-09-01");
    const capturaLogCompleto = dias.map(capturaEntry);
    assert.equal(evaluateFrescorFromCapturaLog("cadastros-dia", dias, capturaLogCompleto), null);

    const diaApagado = dias[dias.length - 3];
    const capturaLogComBuraco = capturaLogCompleto.filter((e) => e.captured_at.slice(0, 10) !== diaApagado);
    const finding = evaluateFrescorFromCapturaLog("cadastros-dia", dias, capturaLogComBuraco);
    assert.ok(finding);
    assert.equal(finding!.sinal, "frescor");
    assert.match(finding!.motivo, new RegExp(diaApagado));
  });

  it("execução que rodou e achou 0 (linha presente) não é buraco", () => {
    const dias = dias14("2026-09-01");
    const capturaLog = dias.map((d) => ({ ...capturaEntry(d), novos_gravados: 0 }));
    assert.equal(evaluateFrescorFromCapturaLog("cadastros-dia", dias, capturaLog), null);
  });
});

describe("evaluateMetaSinal", () => {
  const meta: Pick<Meta, "id" | "metrica_id"> = { id: "ativacao-placar-5-por-dia", metrica_id: "cadastros-nao-pago-nao-reativacao-dia" };

  it("estado nao-atingida gera achado", () => {
    const status: MetaStatus = {
      meta_id: meta.id,
      estado: "nao-atingida",
      progresso: 0.4,
      streak_atual: 2,
      streak_necessario: 5,
      dias_indeterminados: 0,
    };
    const finding = evaluateMetaSinal(meta, status);
    assert.ok(finding);
    assert.equal(finding!.sinal, "meta-nao-atingida");
  });

  it("prazo null nunca produz 'nao-atingida' (inércia declarada, #7180) — nenhum achado", () => {
    // Espelha exatamente o estado que `evaluateMeta` produz quando
    // `meta.prazo === null` (metas.ts: resolveEstado nunca emite
    // 'nao-atingida' sem prazo vencido) — o teste garante a INÉRCIA do
    // sinal, nunca um disparo que a máquina de estados de F5 não produz.
    const status: MetaStatus = {
      meta_id: meta.id,
      estado: "em-curso",
      progresso: 0.4,
      streak_atual: 2,
      streak_necessario: 5,
      dias_indeterminados: 0,
    };
    assert.equal(evaluateMetaSinal(meta, status), null);
  });

  for (const estado of ["atingida", "em-curso", "indeterminado"] as const) {
    it(`estado ${estado} nunca gera achado (só nao-atingida)`, () => {
      const status: MetaStatus = {
        meta_id: meta.id,
        estado,
        progresso: 1,
        streak_atual: 5,
        streak_necessario: 5,
        dias_indeterminados: 0,
      };
      assert.equal(evaluateMetaSinal(meta, status), null);
    });
  }
});

describe("evaluateIndeterminadoCrescendo", () => {
  const meta: Pick<Meta, "id" | "metrica_id"> = { id: "m1", metrica_id: "cadastros-dia" };

  it("fração acima do limiar gera achado", () => {
    const status: MetaStatus = {
      meta_id: meta.id,
      estado: "indeterminado",
      progresso: 0,
      streak_atual: 0,
      streak_necessario: 1,
      dias_indeterminados: 6,
    };
    const finding = evaluateIndeterminadoCrescendo(meta, status, 14, 0.3);
    assert.ok(finding);
    assert.equal(finding!.sinal, "indeterminado-alto");
  });

  it("fração dentro do limiar — sem achado", () => {
    const status: MetaStatus = {
      meta_id: meta.id,
      estado: "em-curso",
      progresso: 0.5,
      streak_atual: 2,
      streak_necessario: 5,
      dias_indeterminados: 2,
    };
    assert.equal(evaluateIndeterminadoCrescendo(meta, status, 14, 0.3), null);
  });

  it("diasJanela <= 0 nunca divide por zero — sem achado (guard defensivo)", () => {
    const status: MetaStatus = {
      meta_id: meta.id,
      estado: "indeterminado",
      progresso: 0,
      streak_atual: 0,
      streak_necessario: 1,
      dias_indeterminados: 5,
    };
    assert.equal(evaluateIndeterminadoCrescendo(meta, status, 0, 0.3), null);
  });
});

describe("evaluateRegistryMudo (#6798 — a classe de defeito mais cara)", () => {
  it("registry não-vazio + zero avaliáveis -> achado registry-mudo", () => {
    const finding = evaluateRegistryMudo(8, 0);
    assert.ok(finding);
    assert.equal(finding!.sinal, "registry-mudo");
    assert.equal(finding!.metrica_id, "registry");
  });

  it("registry não-vazio + pelo menos 1 avaliável -> nenhum achado", () => {
    assert.equal(evaluateRegistryMudo(8, 1), null);
  });

  it("registry genuinamente vazio (0 declaradas) não é este sinal", () => {
    assert.equal(evaluateRegistryMudo(0, 0), null);
  });
});

// ─── Ciclo de issue — via alarm-issues.ts (mesmo mecanismo genérico do resto
// do repo), usando o finding builder REAL de check-metrics-health.ts (#7378,
// achado do review: a versão anterior deste teste reimplementava um builder
// LOCAL simplificado — title/body/labels do issue de verdade nunca eram
// exercitados por nenhum teste). ──────────────────────────────────────────

describe("ciclo de issue (planAlarmReconciliation/applyAlarmReconciliation) sobre findings de metrics-health", () => {
  const FINDING: MetricsHealthFinding = {
    sinal: "frescor",
    metrica_id: "cadastros-dia",
    motivo: "insumo mais recente é de 2026-08-20 — 12 dia(s) atrás",
  };

  it("dois runs com o mesmo finding reusam a issue pelo marcador (mesmo fingerprint) em vez de abrir 2ª issue", () => {
    const finding = toMetricsHealthAlarmFinding(FINDING);
    const state: AlarmIssuesState = {
      "metrics-health:frescor:cadastros-dia": {
        issueNumber: 100,
        url: "https://github.com/x/y/issues/100",
        missingStreak: 0,
        closedAt: null,
        family: "estado",
      },
    };
    const actions = planAlarmReconciliation([finding], state, 2);
    assert.deepEqual(actions, [{ kind: "ensure", finding }]);
  });

  it("finding que some por 2 runs consecutivos fecha com 'not planned' (via applyAlarmReconciliation)", () => {
    const finding = toMetricsHealthAlarmFinding(FINDING);
    const key = `metrics-health:${finding.fingerprint}`;
    let state: AlarmIssuesState = {
      [key]: { issueNumber: 100, url: "https://x/100", missingStreak: 0, closedAt: null, family: "estado" },
    };
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };

    // 1ª ausência: comment_resolved
    ({ nextState: state } = applyAlarmReconciliation([], state, { cwd: ".", closeAfterRuns: 2, run }));
    assert.equal(state[key].missingStreak, 1);
    assert.equal(state[key].closedAt, null);

    // 2ª ausência: close (--reason "not planned")
    ({ nextState: state } = applyAlarmReconciliation([], state, { cwd: ".", closeAfterRuns: 2, run }));
    assert.equal(state[key].missingStreak, 2);
    assert.ok(state[key].closedAt);
    const closeCall = calls.find((c) => c.includes("close"));
    assert.ok(closeCall);
    assert.ok(closeCall!.includes("not planned"));
  });

  it("finding que volta a reproduzir depois de fechado reabre a issue em vez de criar nova (#5978)", () => {
    const finding = toMetricsHealthAlarmFinding(FINDING);
    const key = `metrics-health:${finding.fingerprint}`;
    const state: AlarmIssuesState = {
      [key]: {
        issueNumber: 100,
        url: "https://x/100",
        missingStreak: 2,
        closedAt: "2026-08-20T00:00:00.000Z",
        family: "estado",
      },
    };
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };
    const { nextState, findingOutcomes } = applyAlarmReconciliation([finding], state, { cwd: ".", closeAfterRuns: 2, run });
    assert.equal(findingOutcomes[0].action, "reopened");
    assert.equal(nextState[key].closedAt, null);
    assert.ok(calls.some((c) => c.includes("reopen")));
  });
});
