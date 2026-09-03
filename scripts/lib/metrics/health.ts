/**
 * scripts/lib/metrics/health.ts (#7172, fatia 8 — #7180)
 *
 * Módulo PURO (sem I/O) que deriva os sinais de saúde do alarme UM alarme,
 * N sinais — nunca um alarme por métrica (decisão da própria issue). Opera
 * sobre `MetricResult`/`MetaStatus` já computados por `registry.ts`/`metas.ts`
 * (F3/F5) — nenhuma fórmula é recalculada aqui, só limiares de ALARME.
 *
 * ## Prestação de contas ao #6798
 *
 * A #6798 (fechada) mediu 12% de retorno em 29 alarmes — 117 issues, 14 com
 * correção real — e cortou 3 alarmes de baixo retorno. Este alarme nasce
 * DEPOIS dessa auditoria e tenta aprender com ela, em vez de repetir o
 * padrão que ela mediu:
 *
 *   - **Por que este alarme existe**: nenhum alarme deste repo cobre
 *     FRESCOR de insumo de métrica de negócio hoje. `beehiiv-backup-
 *     staleness-alarm.ts` cobre só o backup semanal da Beehiiv; nada cobre o
 *     Kit, nem os insumos DERIVADOS (ex.: `data/aquisicao/origem-
 *     original.json` congelado em 14/08 enquanto o snapshot mais recente é
 *     30/08, sem nenhum alarme acusando). Série que para de ser gravada em
 *     silêncio é pior que métrica caindo — daí o sinal de frescor ser
 *     tratado como o principal (ver `evaluateFrescorFromResult` e
 *     `evaluateFrescorFromCapturaLog` abaixo).
 *   - **Que pergunta ele responde que o painel (F6) não responde sozinho**:
 *     o painel é PASSIVO — o editor precisa abrir e olhar a zona "Queda"
 *     pra notar. Este alarme é o modo ATIVO: avisa sem que ninguém precise
 *     checar. A mesma condição, duas superfícies — nunca duas fontes de
 *     verdade (os limiares aqui são de ALARME, os do painel são de
 *     EXIBIÇÃO; a fórmula que decide "caiu" é sempre `registry.ts`/
 *     `metas.ts`).
 *   - **Sob que condição ele deve ser aposentado**: se, depois de um volume
 *     razoável de execuções (mesmo critério do `ALARM_RETIREMENT_THRESHOLD`
 *     de `scripts/lib/alarm-retirement-candidates.ts`), as issues que ele
 *     abre forem fechadas `not planned` sem ação — repetindo o padrão que a
 *     #6798 já cortou 3 vezes. `check-alarm-retirement-candidates.ts` já
 *     varre TODO alarme com label `alarm` automaticamente; este não precisa
 *     de exceção nem allowlist pra ser candidato.
 *   - **Eixo de veracidade (proposto na #6798, ainda não mecanizado em
 *     lugar nenhum do repo)**: o teste barato aqui é conferir à mão o
 *     achado mais recente contra a fonte primária citada no `motivo` (o
 *     próprio `MetricResult`/`MedicaoDia` que gerou o finding) — um achado
 *     de `queda`/`frescor` que a checagem manual não confirma é sinal de
 *     bug NESTE módulo (ou no registry a montante), prioridade mais alta
 *     que qualquer feature nova. Nenhum finding é fabricado a partir de
 *     nada além de `MetricResult`/`MetaStatus` já produzidos por F3/F5 —
 *     não há caminho de "afirmar sem checar" neste código.
 *
 * ## Os 5 sinais
 *
 *   1. `queda`      — métrica com `qualidade` exato/piso/faixa movendo na
 *      direção RUIM (`MetricDef.direcao`) além dos DOIS pisos (relativo E
 *      absoluto por `Unidade`), com série mínima de `MIN_DIAS_SERIE` dias
 *      COM COLETA (não dias corridos).
 *   2. `frescor`     — o sinal PRINCIPAL desta fatia (ver acima). Duas
 *      fontes independentes, nunca inventadas aqui: `MetricResult.frescor`
 *      envelhecido (`evaluateFrescorFromResult`) e buraco de captura em
 *      `captura-log.jsonl` (`evaluateFrescorFromCapturaLog`, F2).
 *   3. `meta-nao-atingida` — `MetaStatus.estado` virou `"nao-atingida"`
 *      (só possível com `prazo` não-nulo — ver docstring de `metas.ts`).
 *   4. `indeterminado-alto` — `MetaStatus.dias_indeterminados` acima de
 *      `INDETERMINADO_MAX_FRACAO` da janela.
 *   5. `registry-mudo` — o registry declara N métricas (N > 0) mas ZERO
 *      foram avaliáveis nesta execução — a classe de defeito que a #6798
 *      aponta como a mais cara (indistinguível de "0 findings, tudo bem").
 *
 * ## Por que "queda" nunca recalcula a fórmula
 *
 * `MetricResult.valor` já É o piso pra qualidade `'faixa'`/`'piso'` (ver
 * `registry.ts`) — comparar `valor` diretamente contra a baseline, sem
 * ramo especial por `qualidade`, já implementa "faixa não vira sinal por
 * movimento dentro dos próprios limites" (o movimento do TETO nunca entra
 * na conta) e "piso alarma só quando o PISO CAI" (o piso É o valor
 * comparado). Nenhum código extra necessário — é a razão de o contrato de
 * F3 devolver o piso como `valor`, não os limites inteiros.
 */

import type { MetricDef, MetricResult, Unidade } from "./registry.ts";
import type { Meta, MetaStatus } from "./metas.ts";
import { hasCaptureOnDay, type CapturaLogEntry } from "./captura-log.ts";

// ---------------------------------------------------------------------------
// Limiares (documentados, ajustáveis via CLI — ver check-metrics-health.ts)
// ---------------------------------------------------------------------------

export interface MetricsHealthThresholds {
  /** Piso RELATIVO (0..1) — variação vs a baseline precisa ser >= este
   *  valor, na direção ruim, ALÉM do piso absoluto abaixo. */
  QUEDA_MIN_PCT: number;
  /** Piso ABSOLUTO por `Unidade` — `unidade` sem entrada aqui é erro em
   *  tempo de carga (`assertQuedaMinAbsCobreUnidades`), nunca piso 0. */
  QUEDA_MIN_ABS: Partial<Record<Unidade, number>>;
  /** Idade máxima (dias corridos) do `MetricResult.frescor` mais recente da
   *  série antes de virar sinal de frescor. */
  FRESCOR_MAX_DIAS: number;
  /** Dias COM COLETA (não corridos) mínimos na janela pro sinal de queda
   *  ser avaliado — gate mecânico, não recomendação: abaixo disso, o motivo
   *  do skip é registrado, nunca um "0 findings" silencioso. */
  MIN_DIAS_SERIE: number;
  /** Fração máxima (0..1) de `MetaStatus.dias_indeterminados` sobre os dias
   *  da janela antes de virar sinal `indeterminado-alto`. */
  INDETERMINADO_MAX_FRACAO: number;
}

/** Defaults v1 — documentados na issue #7180: `contagem` com base de ~5/dia
 *  não distingue ruído de ±1 (piso 2); `razao` usa 0,05 (5 pontos
 *  percentuais). `percentual`/`brl`/`dias` NÃO têm piso na v1 — nenhuma
 *  métrica do registry hoje usa essas unidades (só `contagem` e `razao`,
 *  ver `scripts/lib/metrics/registry.ts` — `METRICAS`); adicionar uma
 *  métrica com `unidade` diferente sem estender este mapa é erro em tempo
 *  de carga (`assertQuedaMinAbsCobreUnidades`), nunca piso 0 silencioso. */
export const METRICS_HEALTH_THRESHOLDS: MetricsHealthThresholds = {
  QUEDA_MIN_PCT: 0.15,
  QUEDA_MIN_ABS: { contagem: 2, razao: 0.05 },
  FRESCOR_MAX_DIAS: 2,
  MIN_DIAS_SERIE: 14,
  INDETERMINADO_MAX_FRACAO: 0.3,
};

// ---------------------------------------------------------------------------
// O contrato do achado
// ---------------------------------------------------------------------------

export type MetricsHealthSinal = "queda" | "frescor" | "meta-nao-atingida" | "indeterminado-alto" | "registry-mudo";

export interface MetricsHealthFinding {
  sinal: MetricsHealthSinal;
  /** id da métrica (`MetricDef.id`) — `"registry"` só pro sinal
   *  `registry-mudo`, que não é sobre 1 métrica específica. */
  metrica_id: string;
  motivo: string;
}

/** Fingerprint estável — usado por `alarm-issues.ts` pra dedup/streak. Não
 *  inclui números (esses vão no `motivo`/`contentSignature`, nunca aqui —
 *  senão cada variação diária do achado abriria issue nova). */
export function metricsHealthFingerprint(f: Pick<MetricsHealthFinding, "sinal" | "metrica_id">): string {
  return `${f.sinal}:${f.metrica_id}`;
}

/** 1 dia já medido — par (`chave` = `AAAA-MM-DD`, `resultado` já computado
 *  por `MetricDef.computar`). Mesmo shape de `MedicaoDia` (`metas.ts`), mas
 *  reexportado aqui pra este módulo não depender de `metas.ts` só por um
 *  alias de tipo — os dois evoluem por PRs diferentes. */
export interface MedicaoDia {
  chave: string;
  resultado: MetricResult;
}

// ---------------------------------------------------------------------------
// Guard de carga — toda unidade usada por uma métrica ALARMÁVEL precisa de
// piso QUEDA_MIN_ABS declarado (métricas `direcao: 'neutro'` nunca alarmam,
// então ficam de fora da exigência).
// ---------------------------------------------------------------------------

export function assertQuedaMinAbsCobreUnidades(
  defs: readonly Pick<MetricDef, "id" | "unidade" | "direcao">[],
  thresholds: MetricsHealthThresholds = METRICS_HEALTH_THRESHOLDS,
): void {
  for (const def of defs) {
    if (def.direcao === "neutro") continue;
    if (thresholds.QUEDA_MIN_ABS[def.unidade] === undefined) {
      throw new Error(
        `[metrics/health] unidade "${def.unidade}" (métrica "${def.id}") sem piso QUEDA_MIN_ABS declarado — ` +
          "adicionar ao mapa antes de avaliar queda para esta métrica.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Sinal 1 — queda
// ---------------------------------------------------------------------------

export interface EvaluateQuedaResult {
  finding: MetricsHealthFinding | null;
  /** Motivo de SKIP (série curta, direção neutra, dado insuficiente) —
   *  registrado sempre que não avaliou, nunca um "sem achado" silencioso
   *  indistinguível de "avaliou e está tudo bem". `null` quando avaliou
   *  normalmente (com ou sem achado). */
  skipMotivo: string | null;
}

/**
 * Avalia queda pra 1 métrica: baseline = média dos valores numéricos da
 * série MENOS o mais recente; atual = valor mais recente. Alarma só quando
 * o movimento na direção RUIM (`direcao`) cruza os DOIS pisos — relativo
 * (`QUEDA_MIN_PCT`) E absoluto (`QUEDA_MIN_ABS[unidade]`).
 *
 * `medicoes` e `dias` devem estar na MESMA ordem (mais antigo primeiro, mais
 * recente por último) e cobrir a mesma janela — `dias` é usado só pro gate
 * de `MIN_DIAS_SERIE` via `captura-log.jsonl` (dias COM COLETA, não dias
 * corridos: um feriado sem execução não conta pro mínimo).
 */
export function evaluateQueda(
  def: Pick<MetricDef, "id" | "nome" | "direcao" | "unidade">,
  medicoes: readonly MedicaoDia[],
  capturaLog: readonly CapturaLogEntry[],
  dias: readonly string[],
  thresholds: MetricsHealthThresholds = METRICS_HEALTH_THRESHOLDS,
): EvaluateQuedaResult {
  if (def.direcao === "neutro") {
    return { finding: null, skipMotivo: `"${def.id}": direcao neutro (decomposição pura) — queda nunca avaliada` };
  }
  const diasComColeta = dias.filter((d) => hasCaptureOnDay(capturaLog, d));
  if (diasComColeta.length < thresholds.MIN_DIAS_SERIE) {
    return {
      finding: null,
      skipMotivo:
        `"${def.id}": série curta (${diasComColeta.length}/${thresholds.MIN_DIAS_SERIE} dias com coleta em ` +
        "captura-log.jsonl) — sinal de queda não avaliado, gate mecânico, não recomendação",
    };
  }
  const valores = medicoes.map((m) => m.resultado.valor).filter((v): v is number => v !== null);
  if (valores.length < 2) {
    return {
      finding: null,
      skipMotivo: `"${def.id}": menos de 2 medições com valor numérico na série — sinal de queda não avaliado`,
    };
  }
  const pisoAbs = thresholds.QUEDA_MIN_ABS[def.unidade];
  if (pisoAbs === undefined) {
    // assertQuedaMinAbsCobreUnidades já deveria ter pego isso no load — se
    // chegou aqui é chamador que não rodou o guard, erro duro, não skip.
    throw new Error(`[metrics/health] "${def.id}": unidade "${def.unidade}" sem piso QUEDA_MIN_ABS declarado`);
  }

  const atual = valores[valores.length - 1];
  const anteriores = valores.slice(0, -1);
  const baseline = anteriores.reduce((a, b) => a + b, 0) / anteriores.length;

  // Movimento na direção RUIM: positivo = ruim, independente de `direcao`.
  const deltaAbs = def.direcao === "maior-melhor" ? baseline - atual : atual - baseline;
  if (deltaAbs <= 0) return { finding: null, skipMotivo: null };

  const deltaPct = baseline !== 0 ? deltaAbs / Math.abs(baseline) : Infinity;
  const cruzaAbs = deltaAbs >= pisoAbs;
  const cruzaPct = deltaPct >= thresholds.QUEDA_MIN_PCT;
  if (!cruzaAbs || !cruzaPct) return { finding: null, skipMotivo: null };

  return {
    finding: {
      sinal: "queda",
      metrica_id: def.id,
      motivo:
        `"${def.nome}" moveu na direção ruim ${(deltaPct * 100).toFixed(1)}% (delta absoluto ${deltaAbs.toFixed(2)} ` +
        `${def.unidade}, baseline=${baseline.toFixed(2)}, atual=${atual}) — acima dos pisos QUEDA_MIN_PCT=` +
        `${thresholds.QUEDA_MIN_PCT} e QUEDA_MIN_ABS[${def.unidade}]=${pisoAbs}`,
    },
    skipMotivo: null,
  };
}

// ---------------------------------------------------------------------------
// Sinal 2 — frescor (o principal desta fatia)
// ---------------------------------------------------------------------------

/** Diferença em dias corridos entre duas datas `AAAA-MM-DD` (fronteira UTC
 *  — datas já resolvidas em BRT pelo chamador, mesma convenção do resto do
 *  épico). `null` se qualquer uma for inválida. @pure */
function diffDiasCorridos(dataYmd: string, hojeYmd: string): number | null {
  const a = Date.parse(`${dataYmd}T00:00:00Z`);
  const b = Date.parse(`${hojeYmd}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Fonte 1 do sinal de frescor: `MetricResult.frescor` da série. Usa o
 * frescor NÃO-NULO mais recente de toda a série (não só o último dia) —
 * uma métrica cuja série NUNCA teve frescor não-nulo (ex.: `doi-
 * confirmacao-dia`, sempre `indeterminado` por dependência dura declarada
 * em `registry.ts`) não gera achado aqui: é ausência CONHECIDA e já
 * documentada no `motivo` da própria métrica, não uma coleta que PAROU —
 * gerar um achado permanente e inevitável pra ela seria exatamente o ruído
 * que a #6798 (eixo de veracidade) pede pra nunca acontecer. O sinal É
 * sobre REGRESSÃO (tinha dado fresco, parou de ter), nunca sobre "nunca
 * teve".
 */
export function evaluateFrescorFromResult(
  metricaId: string,
  medicoes: readonly MedicaoDia[],
  hoje: string,
  maxDias: number = METRICS_HEALTH_THRESHOLDS.FRESCOR_MAX_DIAS,
): MetricsHealthFinding | null {
  let latestFrescor: string | null = null;
  for (const m of medicoes) {
    const f = m.resultado.frescor;
    if (f !== null && (!latestFrescor || f > latestFrescor)) latestFrescor = f;
  }
  if (latestFrescor === null) return null;

  const idadeDias = diffDiasCorridos(latestFrescor.slice(0, 10), hoje);
  if (idadeDias === null || idadeDias <= maxDias) return null;

  return {
    sinal: "frescor",
    metrica_id: metricaId,
    motivo:
      `insumo mais recente de "${metricaId}" é de ${latestFrescor.slice(0, 10)} — ${idadeDias} dia(s) atrás, ` +
      `acima do limiar FRESCOR_MAX_DIAS=${maxDias}`,
  };
}

/**
 * Fonte 2 do sinal de frescor: buraco em `data/metrics/captura-log.jsonl`
 * (F2) — dia dentro da janela SEM nenhuma execução registrada, distinto de
 * "execução rodou e achou 0" (ver docstring de `hasCaptureOnDay`,
 * `captura-log.ts`). Escopo intencional: só as métricas cujo insumo vem
 * diretamente da ingestão que grava este log (as 4 de aquisição hoje —
 * `ACQUISITION_METRIC_IDS` em `check-metrics-health.ts`) — aplicar isto a
 * `doi-confirmacao-dia` duplicaria, com um vocabulário diferente, o MESMO
 * achado permanente que `evaluateFrescorFromResult` já evita gerar pra ela.
 */
export function evaluateFrescorFromCapturaLog(
  metricaId: string,
  dias: readonly string[],
  capturaLog: readonly CapturaLogEntry[],
): MetricsHealthFinding | null {
  const faltando = dias.filter((d) => !hasCaptureOnDay(capturaLog, d));
  if (faltando.length === 0) return null;
  return {
    sinal: "frescor",
    metrica_id: metricaId,
    motivo: `sem execução registrada em data/metrics/captura-log.jsonl (F2) para: ${faltando.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Sinal 3 — meta-nao-atingida
// ---------------------------------------------------------------------------

/**
 * Achado quando `MetaStatus.estado === "nao-atingida"` — só ocorre com
 * `meta.prazo` não-nulo (`evaluateMeta`, `metas.ts`, nunca reavaliado
 * aqui). A única meta da v1 (`ativacao-placar-5-por-dia`) nasce com `prazo:
 * null`, então este sinal fica INERTE até existir meta com prazo —
 * declarado assim de propósito, testado como inércia (nunca como
 * disparo), não como lacuna.
 */
export function evaluateMetaSinal(meta: Pick<Meta, "id" | "metrica_id">, status: MetaStatus): MetricsHealthFinding | null {
  if (status.estado !== "nao-atingida") return null;
  return {
    sinal: "meta-nao-atingida",
    metrica_id: meta.metrica_id,
    motivo:
      `meta "${meta.id}" (métrica "${meta.metrica_id}") passou para nao-atingida — streak_atual=` +
      `${status.streak_atual}/${status.streak_necessario}, dias_indeterminados=${status.dias_indeterminados}`,
  };
}

// ---------------------------------------------------------------------------
// Sinal 4 — indeterminado-alto
// ---------------------------------------------------------------------------

/** Lê `MetaStatus.dias_indeterminados` (F5) — NUNCA recomputa a partir da
 *  série: se o alarme e o painel discordarem sobre quantos dias faltaram, a
 *  métrica é a mesma e a divergência é bug, não interpretação (issue
 *  #7180). */
export function evaluateIndeterminadoCrescendo(
  meta: Pick<Meta, "id" | "metrica_id">,
  status: MetaStatus,
  diasJanela: number,
  maxFracao: number = METRICS_HEALTH_THRESHOLDS.INDETERMINADO_MAX_FRACAO,
): MetricsHealthFinding | null {
  if (diasJanela <= 0) return null;
  const fracao = status.dias_indeterminados / diasJanela;
  if (fracao <= maxFracao) return null;
  return {
    sinal: "indeterminado-alto",
    metrica_id: meta.metrica_id,
    motivo:
      `meta "${meta.id}": ${status.dias_indeterminados}/${diasJanela} dias indeterminados ` +
      `(${(fracao * 100).toFixed(0)}%) acima do limiar INDETERMINADO_MAX_FRACAO=${(maxFracao * 100).toFixed(0)}%`,
  };
}

// ---------------------------------------------------------------------------
// Sinal 5 — registry-mudo (#6798 — a classe de defeito mais cara)
// ---------------------------------------------------------------------------

/**
 * Registry não-vazio (`registrySize > 0`) mas ZERO métricas avaliáveis
 * (`avaliadas === 0`) nesta execução é sinal PRÓPRIO — nunca "0 findings"
 * indistinguível de "tudo normal". `registrySize === 0` (registry
 * genuinamente vazio) não é este sinal — seria erro de carga do módulo
 * (`assertRegistryValido` já lança antes de chegar aqui).
 */
export function evaluateRegistryMudo(registrySize: number, avaliadas: number): MetricsHealthFinding | null {
  if (registrySize === 0) return null;
  if (avaliadas > 0) return null;
  return {
    sinal: "registry-mudo",
    metrica_id: "registry",
    motivo:
      `registry declara ${registrySize} métrica(s), mas 0 foram avaliáveis nesta execução — dessincronia entre ` +
      "declaração e execução (#6798), nunca tratada como '0 findings, tudo ok'",
  };
}
