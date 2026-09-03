/**
 * scripts/lib/metrics/metas.ts (#7172, fatia 5 — #7177)
 *
 * Módulo PURO (sem I/O) que avalia o estado de uma meta contra uma série de
 * medições diárias já computadas via `MetricDef.computar` (`registry.ts`).
 * Nunca lê disco — `metas-store.ts` é quem carrega `data/metas.json`.
 *
 * ## `INDETERMINADO` é estado de primeira classe (decisão 14 do épico #7172)
 *
 * Dia sem coleta (detectado via `data/metrics/captura-log.jsonl`, F2 —
 * refletido aqui como `qualidade: 'indeterminado'`/`valor: null` no
 * `MetricResult` daquele dia) quebra o streak como INDETERMINADO, nunca
 * como zero e nunca como sucesso. **Dia medido que falha o alvo é
 * CONCLUSIVO e vence o buraco de coleta** — se a janela mistura um dia que
 * falhou com dias sem coleta, o resultado é `em-curso`, não
 * `indeterminado`. Só existe `indeterminado` quando o buraco de coleta é a
 * ÚNICA razão de não saber.
 *
 * ## Meta em `faixa` — sempre decidida pelo limite INFERIOR
 *
 * Decisão 7 do épico: `direct` + sem-atribuição nunca entram no número da
 * meta. Quando a métrica devolve `qualidade: 'faixa'` (`MetricResult.valor`
 * já É o piso, por construção do registry), o estado principal usa esse
 * piso; o limite superior nunca decide — entra só como
 * `status_no_limite_superior` (mesmos 4 valores), pra o painel poder
 * renderizar "não-atingida (seria atingida contando os não-atribuídos)".
 *
 * ## `atingida` é TERMINAL
 *
 * Uma vez atingida, a meta grava `atingida_em` e recomputação/backfill
 * posterior (F7) nunca reverte esse estado — passe `atingidaEmAnterior`
 * (não-nulo) para preservar o veredito anterior sem reavaliar a série.
 */

import type { MetricResult, Qualidade } from "./registry.ts";

export type Operador = ">=" | "<=";
export type JanelaMeta = "dia" | "semana" | "mes";

export interface Meta {
  id: string;
  metrica_id: string;
  produto: string;
  alvo: number;
  operador: Operador;
  janela: JanelaMeta;
  /** Nº de dias/semanas/meses consecutivos exigido. Default 1 quando ausente. */
  consecutivos?: number;
  /** `AAAA-MM-DD` ou `null` — com `null`, `nao-atingida` nunca é emitido. */
  prazo: string | null;
  criada_em: string;
  motivo: string;
  dono: string;
}

export type EstadoMeta = "atingida" | "em-curso" | "nao-atingida" | "indeterminado";

export interface MetaStatus {
  meta_id: string;
  estado: EstadoMeta;
  /** 0..1+ — `streak_atual / streak_necessario` (pode passar de 1). */
  progresso: number;
  streak_atual: number;
  streak_necessario: number;
  dias_indeterminados: number;
  /** Presente e sticky só quando `estado === 'atingida'`. */
  atingida_em?: string | null;
  /** Presente só quando ao menos 1 dia da janela tinha `qualidade: 'faixa'`. */
  status_no_limite_superior?: EstadoMeta;
  faixa?: { min: number; max: number };
}

/** 1 dia (ou 1 unidade de `janela`) já medido — o `MetricResult` vem de
 *  `MetricDef.computar` (registry.ts), nunca recomputado aqui. */
export interface MedicaoDia {
  chave: string;
  resultado: MetricResult;
}

function comparaOperador(valor: number, operador: Operador, alvo: number): boolean {
  return operador === ">=" ? valor >= alvo : valor <= alvo;
}

/** Núcleo da máquina de estados — opera sobre uma série já ordenada
 *  (mais antiga primeiro, mais recente por último) de valores numéricos ou
 *  `null` (indeterminado). Reusado tanto para o valor principal (piso, em
 *  métrica `faixa`) quanto para o limite superior. @pure */
function evaluateSeries(
  valores: readonly (number | null)[],
  meta: Pick<Meta, "operador" | "alvo">,
  consecutivos: number,
): { streak: number; diasIndeterminados: number; failEncountered: boolean } {
  let streak = 0;
  let diasIndeterminados = 0;
  let failEncountered = false;
  for (let i = valores.length - 1; i >= 0; i--) {
    const v = valores[i];
    if (v === null) {
      diasIndeterminados++;
      continue;
    }
    if (comparaOperador(v, meta.operador, meta.alvo)) {
      streak++;
      if (streak >= consecutivos) break;
    } else {
      failEncountered = true;
      break;
    }
  }
  return { streak, diasIndeterminados, failEncountered };
}

function resolveEstado(
  streak: number,
  consecutivos: number,
  failEncountered: boolean,
  diasIndeterminados: number,
  prazo: string | null,
  hoje: string,
): EstadoMeta {
  if (streak >= consecutivos) return "atingida";
  if (prazo !== null && prazo < hoje) return "nao-atingida";
  if (failEncountered) return "em-curso";
  if (diasIndeterminados > 0) return "indeterminado";
  return "em-curso";
}

/**
 * Avalia 1 meta contra a série de medições mais recentes (a última entrada
 * é o dia mais atual). `medicoes` deve cobrir pelo menos
 * `meta.consecutivos` unidades — cobrir mais não muda o resultado (a
 * varredura para assim que acumula o streak necessário ou encontra o
 * primeiro desfecho conclusivo).
 *
 * `atingidaEmAnterior` — quando não-nulo, o estado é forçado a `atingida`
 * com esse `atingida_em`, sem reavaliar a série: a meta é TERMINAL uma vez
 * batida (não volta atrás em recomputação/backfill, F7).
 */
export function evaluateMeta(
  meta: Meta,
  medicoes: readonly MedicaoDia[],
  hoje: string,
  atingidaEmAnterior: string | null = null,
): MetaStatus {
  const consecutivos = meta.consecutivos ?? 1;

  if (atingidaEmAnterior !== null) {
    return {
      meta_id: meta.id,
      estado: "atingida",
      progresso: 1,
      streak_atual: consecutivos,
      streak_necessario: consecutivos,
      dias_indeterminados: 0,
      atingida_em: atingidaEmAnterior,
    };
  }

  const valoresPrincipais = medicoes.map((m) => m.resultado.valor);
  const { streak, diasIndeterminados, failEncountered } = evaluateSeries(valoresPrincipais, meta, consecutivos);
  const estado = resolveEstado(streak, consecutivos, failEncountered, diasIndeterminados, meta.prazo, hoje);

  const status: MetaStatus = {
    meta_id: meta.id,
    estado,
    progresso: consecutivos > 0 ? streak / consecutivos : 0,
    streak_atual: streak,
    streak_necessario: consecutivos,
    dias_indeterminados: diasIndeterminados,
  };
  if (estado === "atingida") {
    const ultimaMedida = [...medicoes].reverse().find((m) => m.resultado.valor !== null);
    status.atingida_em = ultimaMedida?.chave ?? hoje;
  }

  const temFaixa = medicoes.some((m) => isFaixa(m.resultado.qualidade));
  if (temFaixa) {
    const valoresSuperior = medicoes.map((m) =>
      isFaixa(m.resultado.qualidade) && m.resultado.limites ? m.resultado.limites.max : m.resultado.valor,
    );
    const sup = evaluateSeries(valoresSuperior, meta, consecutivos);
    status.status_no_limite_superior = resolveEstado(
      sup.streak,
      consecutivos,
      sup.failEncountered,
      sup.diasIndeterminados,
      meta.prazo,
      hoje,
    );
    const ultimaFaixa = [...medicoes].reverse().find((m) => isFaixa(m.resultado.qualidade) && m.resultado.limites);
    if (ultimaFaixa?.resultado.limites) {
      status.faixa = ultimaFaixa.resultado.limites;
    }
  }

  return status;
}

function isFaixa(q: Qualidade): boolean {
  return q === "faixa";
}
