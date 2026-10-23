/**
 * scripts/lib/teste-2608-emenda.ts (#8238 — resíduo da Emenda 17/09, #8249)
 *
 * Seção "Apuração do teste 2608 (Emenda 17/09)" do `cac-report.ts --fonte
 * store`. O funil principal do relatório mostra os números ACUMULADOS por
 * canal (sem recorte de coorte); a Emenda decide o resultado com uma régua
 * própria, e é ela que este módulo implementa — tudo puro, sem I/O:
 *
 * - **Coorte:** cadastros do braço (mesmas chaves de `CHANNEL_KEY_SPECS`, via
 *   `subscribersForChannel`, já sem contas internas/teste) com `created`
 *   dentro das FASES de veiculação: `[d0 00h00 BRT, início da pausa do braço)`
 *   e `[fim da pausa, fim_janela 23h59 BRT]`. As fases saem do `run-state.json`
 *   (`revisao.pausa`, com `inicio_por_braco` quando houver) — nada fixo em
 *   código.
 * - **Métrica que decide:** custo por `leitor-v1` (`isLeitorV1` canônico, sem
 *   definição paralela), por braço e por fase.
 * - **Braço sem sinal:** menos de {@link EMENDA_MIN_LEITORES} leitores no total
 *   da coorte → sai "sem sinal", sem custo e sem posição.
 * - **Comparação:** entre os braços com sinal, razão observada (mais caro ÷
 *   mais barato) contra a razão mínima detectável de
 *   `poisson-detectable-ratio.ts` (`n` = leitores do braço com menos leitores,
 *   alpha 0,05, poder 0,8). "Sai o braço X" só quando a razão observada passa
 *   da detectável **e** X é o mais caro em TODAS as fases; fora disso, "sem
 *   diferença detectável".
 * - **Guard de pré-execução (item 5 da Emenda):** fração dos ativos da coorte
 *   com >=20 recebidas. Abaixo de {@link EMENDA_MIN_FRAC_20_RECEBIDAS} o
 *   relatório diz isso em vez de afirmar veredito.
 *
 * ## Gasto por fase
 *
 * `spend.csv` é MENSAL — não existe gasto diário local para dividir o total
 * entre pré-pausa e pós-retomada. Premissa declarada: o gasto total do braço é
 * a soma das linhas de `spend.csv` cujo mês cai dentro de `[d0, fim_janela]`
 * (linha de mês fora da janela — ex.: Meta 2026-10 — fica de fora e é listada);
 * o gasto POR FASE só entra quando o editor fornece `--gasto-fases <json>`
 * (`{ "<braço>": { "<id da fase>": BRL } }`). Sem ele, o custo por fase sai
 * "indisponível" e o veredito "sai X" não é emitido (a condição "mais caro nas
 * duas fases" fica inverificável) — nunca é inventado por rateio de dias.
 *
 * ## Fora deste módulo (escopo remanescente do #8238)
 *
 * K10 (clique em >=1 das 10 primeiras recebidas) e o corte determinístico por
 * `event.ts` exigem ler eventos por assinante na ordem de entrega — o store
 * entrega aqui só os agregados (`total_received`/`total_unique_clicked`).
 */

import { isLeitorV1 } from "./leitor.ts";
import { minDetectableRatio } from "./poisson-detectable-ratio.ts";
import { normalizePauseIntervals, type AdsTestPauseField } from "./ads-test-pause-window.ts";
import { subscribersForChannel } from "./cac.ts";
import type { BeehiivBackupSubscriber } from "./beehiiv-backup-snapshots.ts";
import type { SpendRow } from "./aquisicao-spend.ts";

/** Mínimo de `leitor-v1` no total da coorte para o braço ter "sinal" (Emenda 17/09). */
export const EMENDA_MIN_LEITORES = 3;
/** Nível e poder do teste de razão de Poisson (Emenda 17/09). */
export const EMENDA_ALPHA = 0.05;
export const EMENDA_POWER = 0.8;
/** Piso da fração de ATIVOS da coorte com >=20 recebidas abaixo do qual o
 *  veredito não é afirmado (guard de pré-execução, item 5 da Emenda). A Emenda
 *  aceita ~0,3% de subcontagem para a coorte de 25–27/09; metade dos ativos
 *  sem 20 recebidas na data de apuração é defeito de dado, não comportamento. */
export const EMENDA_MIN_FRAC_20_RECEBIDAS = 0.5;
const LEITOR_MIN_RECEIVED = 20;
/** Teto da busca da razão detectável — com n=3 a razão é ~5; acima de 50 o
 *  braço de referência praticamente não tem leitor e a comparação não diz nada. */
const MAX_DETECTABLE_RATIO = 50;

/** Uma fase de veiculação do braço: `[inicioMs, fimExclusivoMs)`. */
export interface EmendaPhaseWindow {
  /** Id ASCII estável (chave de `--gasto-fases`): `pre-pausa`, `pos-retomada`,
   *  `janela` (sem pausa) ou `fase-N` (2+ pausas). */
  id: string;
  label: string;
  inicioMs: number;
  fimExclusivoMs: number;
}

/** Subconjunto do `run-state.json` que este módulo lê. `inicio_por_braco` não
 *  está tipado em `AdsTestPauseInterval` (vem do JSON editado à mão em 17/09). */
export interface EmendaRunStateInput {
  d0: string;
  fim_janela: string;
  bracos: readonly string[];
  revisao?: { pausa?: AdsTestPauseField } | null;
}

function brtDayStartMs(date: string): number {
  const ms = Date.parse(`${date}T00:00:00-03:00`);
  if (Number.isNaN(ms)) throw new Error(`teste-2608-emenda: data inválida "${date}"`);
  return ms;
}

function parseIso(iso: string, campo: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`teste-2608-emenda: timestamp inválido em ${campo}: "${iso}"`);
  return ms;
}

/**
 * Fases de veiculação do braço a partir do `run-state`. Sem pausa → 1 fase
 * (`janela`). 1 pausa → `pre-pausa` + `pos-retomada` (o início da pausa usa
 * `inicio_por_braco[braco]` quando existir — Microsoft pausou 13 min depois).
 * Pausa ainda aberta (`fim` nulo) encerra a última fase no início dela. @pure
 */
export function resolveEmendaPhaseWindows(runState: EmendaRunStateInput, braco: string): EmendaPhaseWindow[] {
  const inicio = brtDayStartMs(runState.d0);
  const fimExclusivo = brtDayStartMs(runState.fim_janela) + 86_400_000;
  const pausas = normalizePauseIntervals(runState.revisao?.pausa ?? null)
    .map((p, i) => {
      const porBraco = (p as { inicio_por_braco?: Record<string, string> }).inicio_por_braco?.[braco];
      const ini = parseIso(porBraco ?? p.inicio, `revisao.pausa[${i}].inicio`);
      const fim = p.fim != null ? parseIso(p.fim, `revisao.pausa[${i}].fim`) : null;
      if (fim != null && fim < ini) throw new Error(`teste-2608-emenda: revisao.pausa[${i}] com fim antes do início`);
      return { ini, fim };
    })
    .sort((a, b) => a.ini - b.ini);

  const segmentos: Array<{ inicioMs: number; fimExclusivoMs: number }> = [];
  let cursor: number | null = inicio;
  for (const p of pausas) {
    if (cursor == null) break;
    if (p.ini > cursor) segmentos.push({ inicioMs: cursor, fimExclusivoMs: Math.min(p.ini, fimExclusivo) });
    cursor = p.fim == null ? null : Math.max(cursor, p.fim);
  }
  if (cursor != null && cursor < fimExclusivo) segmentos.push({ inicioMs: cursor, fimExclusivoMs: fimExclusivo });
  const validos = segmentos.filter((s) => s.fimExclusivoMs > s.inicioMs);

  if (pausas.length === 0) return validos.map((s) => ({ ...s, id: "janela", label: "janela inteira" }));
  if (pausas.length === 1 && validos.length === 2) {
    return [
      { ...validos[0], id: "pre-pausa", label: "pré-pausa" },
      { ...validos[1], id: "pos-retomada", label: "pós-retomada" },
    ];
  }
  return validos.map((s, i) => ({ ...s, id: `fase-${i + 1}`, label: `fase ${i + 1}` }));
}

export interface EmendaPhaseStats {
  id: string;
  label: string;
  inicioMs: number;
  fimExclusivoMs: number;
  cadastros: number;
  ativos: number;
  leitores: number;
  ativosCom20Recebidas: number;
  /** `null` = gasto por fase não fornecido (`--gasto-fases`). */
  gastoBrl: number | null;
  /** `null` sem gasto da fase ou sem leitor na fase. */
  custoPorLeitor: number | null;
  custoPorCadastro: number | null;
}

/** Um assinante da coorte, para o extrato reproduzível (`apuracao-{corte}-coorte.jsonl`). */
export interface EmendaCohortMember {
  braco: string;
  fase: string;
  email: string;
  created: number;
  status: string;
  total_received: number;
  total_unique_clicked: number;
  leitor_v1: boolean;
}

export interface EmendaArmResult {
  braco: string;
  fases: EmendaPhaseStats[];
  cadastros: number;
  ativos: number;
  leitores: number;
  ativosCom20Recebidas: number;
  /** Soma das linhas de `spend.csv` do braço com mês dentro da janela. `null` sem linha. */
  gastoTotalBrl: number | null;
  /** Meses de `spend.csv` do braço que ficaram FORA da janela (listados, nunca somados em silêncio). */
  mesesForaDaJanela: string[];
  semSinal: boolean;
  custoPorLeitor: number | null;
  custoPorCadastro: number | null;
  membros: EmendaCohortMember[];
}

/** `--gasto-fases`: `{ braço: { idDaFase: BRL } }`. */
export type EmendaGastoPorFase = Record<string, Record<string, number>>;

function monthsInWindow(d0: string, fimJanela: string): Set<string> {
  const out = new Set<string>();
  let [y, m] = d0.slice(0, 7).split("-").map(Number);
  const [yEnd, mEnd] = fimJanela.slice(0, 7).split("-").map(Number);
  while (y < yEnd || (y === yEnd && m <= mEnd)) {
    out.add(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function div(gasto: number | null, n: number): number | null {
  return gasto != null && n > 0 ? gasto / n : null;
}

/** Calcula coorte, leitores e custo de UM braço. `subs` = coorte inteira do
 *  store já sem internos/teste (o filtro por canal acontece aqui). @pure */
export function computeEmendaArm(
  subs: readonly BeehiivBackupSubscriber[],
  spendRows: readonly SpendRow[],
  runState: EmendaRunStateInput,
  braco: string,
  gastoPorFase: EmendaGastoPorFase | null = null,
): EmendaArmResult {
  const janelaMeses = monthsInWindow(runState.d0, runState.fim_janela);
  const linhas = spendRows.filter((r) => r.canal === braco);
  const dentro = linhas.filter((r) => janelaMeses.has(r.mes));
  const gastoTotalBrl = dentro.length > 0 ? dentro.reduce((a, r) => a + r.valor, 0) : null;
  const mesesForaDaJanela = [...new Set(linhas.filter((r) => !janelaMeses.has(r.mes)).map((r) => r.mes))].sort();

  const windows = resolveEmendaPhaseWindows(runState, braco);
  const doCanal = subscribersForChannel([...subs], braco);
  const membros: EmendaCohortMember[] = [];
  const fases: EmendaPhaseStats[] = windows.map((w) => {
    const coorte = doCanal.filter((s) => {
      const ms = (s.created ?? 0) * 1000;
      return ms >= w.inicioMs && ms < w.fimExclusivoMs;
    });
    let ativos = 0;
    let leitores = 0;
    let com20 = 0;
    for (const s of coorte) {
      const received = s.stats?.total_received ?? 0;
      const clicked = s.stats?.total_unique_clicked ?? 0;
      const leitor = isLeitorV1({ status: s.status, totalReceived: received, totalUniqueClicked: clicked });
      if (s.status === "active") {
        ativos += 1;
        if (received >= LEITOR_MIN_RECEIVED) com20 += 1;
      }
      if (leitor) leitores += 1;
      membros.push({
        braco,
        fase: w.id,
        email: s.email,
        created: s.created ?? 0,
        status: s.status,
        total_received: received,
        total_unique_clicked: clicked,
        leitor_v1: leitor,
      });
    }
    const gastoFase = gastoPorFase?.[braco]?.[w.id];
    const gastoBrl = typeof gastoFase === "number" && Number.isFinite(gastoFase) ? gastoFase : null;
    return {
      id: w.id,
      label: w.label,
      inicioMs: w.inicioMs,
      fimExclusivoMs: w.fimExclusivoMs,
      cadastros: coorte.length,
      ativos,
      leitores,
      ativosCom20Recebidas: com20,
      gastoBrl,
      custoPorLeitor: div(gastoBrl, leitores),
      custoPorCadastro: div(gastoBrl, coorte.length),
    };
  });

  const sum = (k: "cadastros" | "ativos" | "leitores" | "ativosCom20Recebidas") => fases.reduce((a, f) => a + f[k], 0);
  const leitores = sum("leitores");
  const cadastros = sum("cadastros");
  const semSinal = leitores < EMENDA_MIN_LEITORES;
  return {
    braco,
    fases,
    cadastros,
    ativos: sum("ativos"),
    leitores,
    ativosCom20Recebidas: sum("ativosCom20Recebidas"),
    gastoTotalBrl,
    mesesForaDaJanela,
    semSinal,
    custoPorLeitor: semSinal ? null : div(gastoTotalBrl, leitores),
    custoPorCadastro: div(gastoTotalBrl, cadastros),
    membros,
  };
}

export type EmendaVerdictKind = "sai" | "sem-diferenca" | "indisponivel";

export interface EmendaVerdict {
  kind: EmendaVerdictKind;
  /** Frase final do relatório. */
  texto: string;
  comSinal: string[];
  semSinal: string[];
  maisCaro: string | null;
  maisBarato: string | null;
  razaoObservada: number | null;
  /** `null` quando não calculável (menos de 2 braços com sinal) ou acima do teto. */
  razaoDetectavel: number | null;
  nReferencia: number | null;
  /** Fração dos ativos da coorte (3 braços) com >=20 recebidas. */
  fracCom20Recebidas: number | null;
}

/** Veredito da Emenda 17/09 — ver docstring do módulo. @pure */
export function evaluateEmendaVerdict(
  arms: readonly EmendaArmResult[],
  opts: { alpha?: number; power?: number; minFrac20?: number } = {},
): EmendaVerdict {
  const alpha = opts.alpha ?? EMENDA_ALPHA;
  const power = opts.power ?? EMENDA_POWER;
  const minFrac20 = opts.minFrac20 ?? EMENDA_MIN_FRAC_20_RECEBIDAS;
  const ativos = arms.reduce((a, s) => a + s.ativos, 0);
  const com20 = arms.reduce((a, s) => a + s.ativosCom20Recebidas, 0);
  const fracCom20Recebidas = ativos > 0 ? com20 / ativos : null;

  const comSinalArms = arms.filter((a) => !a.semSinal && a.custoPorLeitor != null);
  const base: EmendaVerdict = {
    kind: "indisponivel",
    texto: "",
    comSinal: comSinalArms.map((a) => a.braco),
    semSinal: arms.filter((a) => a.semSinal).map((a) => a.braco),
    maisCaro: null,
    maisBarato: null,
    razaoObservada: null,
    razaoDetectavel: null,
    nReferencia: null,
    fracCom20Recebidas,
  };

  if (fracCom20Recebidas == null || fracCom20Recebidas < minFrac20) {
    const pct = fracCom20Recebidas == null ? "n/a" : `${(fracCom20Recebidas * 100).toFixed(1)}%`;
    return {
      ...base,
      texto:
        `Veredito NÃO afirmado: só ${pct} dos ativos da coorte têm >=${LEITOR_MIN_RECEIVED} recebidas ` +
        `(piso ${(minFrac20 * 100).toFixed(0)}%) — leitor-v1 ainda não é mensurável na coorte (guard de pré-execução, Emenda item 5).`,
    };
  }
  if (comSinalArms.length < 2) {
    return { ...base, texto: `Sem comparação: menos de 2 braços com sinal (>=${EMENDA_MIN_LEITORES} leitor-v1).` };
  }

  const ordenados = [...comSinalArms].sort((a, b) => (b.custoPorLeitor as number) - (a.custoPorLeitor as number));
  const maisCaro = ordenados[0];
  const maisBarato = ordenados[ordenados.length - 1];
  const razaoObservada = (maisCaro.custoPorLeitor as number) / (maisBarato.custoPorLeitor as number);
  const nReferencia = Math.min(...comSinalArms.map((a) => a.leitores));
  let razaoDetectavel: number | null;
  try {
    razaoDetectavel = minDetectableRatio(nReferencia, alpha, power, { maxRatio: MAX_DETECTABLE_RATIO });
  } catch {
    razaoDetectavel = null;
  }
  const filled = { ...base, maisCaro: maisCaro.braco, maisBarato: maisBarato.braco, razaoObservada, razaoDetectavel, nReferencia };
  const fmtR = (r: number) => r.toFixed(2);

  if (razaoDetectavel == null || razaoObservada <= razaoDetectavel) {
    return {
      ...filled,
      kind: "sem-diferenca",
      texto:
        `Sem diferença detectável: razão observada ${fmtR(razaoObservada)} (${maisCaro.braco} ÷ ${maisBarato.braco}) ` +
        (razaoDetectavel == null
          ? `e razão mínima detectável acima de ${MAX_DETECTABLE_RATIO} com n=${nReferencia}.`
          : `<= razão mínima detectável ${fmtR(razaoDetectavel)} (n=${nReferencia}, alpha ${alpha}, poder ${power}).`),
    };
  }

  // Razão passa da detectável — falta "X é o mais caro em TODAS as fases".
  const faseIds = maisCaro.fases.map((f) => f.id);
  const custoFase = (arm: EmendaArmResult, id: string): number | null | "sem-leitor" => {
    const f = arm.fases.find((x) => x.id === id);
    if (!f || f.gastoBrl == null) return null;
    if (f.leitores === 0) return f.gastoBrl > 0 ? "sem-leitor" : null;
    return f.gastoBrl / f.leitores;
  };
  const faltaGasto = faseIds.some((id) => comSinalArms.some((a) => custoFase(a, id) == null));
  if (faltaGasto) {
    return {
      ...filled,
      kind: "indisponivel",
      texto:
        `Razão observada ${fmtR(razaoObservada)} > detectável ${fmtR(razaoDetectavel)}, mas o gasto por fase não foi fornecido ` +
        `(--gasto-fases) — a condição "${maisCaro.braco} é o mais caro nas duas fases" não é verificável, então nenhum braço sai.`,
    };
  }
  const rank = (c: number | "sem-leitor" | null) => (c === "sem-leitor" ? Number.POSITIVE_INFINITY : (c as number));
  const caroEmTodas = faseIds.every((id) =>
    comSinalArms.every((a) => a.braco === maisCaro.braco || rank(custoFase(maisCaro, id)) > rank(custoFase(a, id))),
  );
  if (!caroEmTodas) {
    return {
      ...filled,
      kind: "sem-diferenca",
      texto:
        `Sem diferença detectável: razão ${fmtR(razaoObservada)} > ${fmtR(razaoDetectavel)} no total, ` +
        `mas ${maisCaro.braco} não é o mais caro em todas as fases.`,
    };
  }
  return {
    ...filled,
    kind: "sai",
    texto:
      `Sai o braço ${maisCaro.braco}: razão observada ${fmtR(razaoObservada)} > detectável ${fmtR(razaoDetectavel)} ` +
      `(n=${nReferencia}) e mais caro em todas as fases.`,
  };
}

export interface EmendaSection {
  runStatePath: string;
  corte: string;
  arms: EmendaArmResult[];
  verdict: EmendaVerdict;
  gastoPorFaseFornecido: boolean;
}

/** Monta a seção inteira (todos os braços + veredito). @pure */
export function computeEmendaSection(
  subs: readonly BeehiivBackupSubscriber[],
  spendRows: readonly SpendRow[],
  runState: EmendaRunStateInput,
  meta: { runStatePath: string; corte: string },
  gastoPorFase: EmendaGastoPorFase | null = null,
): EmendaSection {
  if (gastoPorFase) validateEmendaGastoPorFaseKeys(gastoPorFase, runState);
  const arms =runState.bracos.map((b) => computeEmendaArm(subs, spendRows, runState, b, gastoPorFase));
  return { ...meta, arms, verdict: evaluateEmendaVerdict(arms), gastoPorFaseFornecido: gastoPorFase != null };
}

function fmtBrl(n: number | null): string {
  return n == null ? "—" : `R$ ${n.toFixed(2).replace(".", ",")}`;
}

function fmtBrt(ms: number): string {
  const d = new Date(ms - 3 * 3_600_000);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} BRT`;
}

function fmtPct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

/** Markdown da seção (anexado ao relatório congelado). @pure */
export function formatEmendaSectionMarkdown(s: EmendaSection): string[] {
  const out: string[] = [];
  out.push("## Apuração do teste 2608 (Emenda 17/09, #8249)");
  out.push("");
  out.push(
    `Coorte: cadastros no store unificado (sem contas internas/teste) com UTM do braço e cadastro dentro das fases de veiculação do \`${s.runStatePath}\`. ` +
      `Rótulo/corte: ${s.corte} (o store é mutável — o extrato da coorte gravado junto com o relatório é o que torna a leitura reproduzível).`,
  );
  out.push(
    `Métrica que decide: custo por leitor-v1. Braço com menos de ${EMENDA_MIN_LEITORES} leitores sai "sem sinal". ` +
      `Gasto total = linhas de spend.csv com mês dentro da janela; gasto por fase ${s.gastoPorFaseFornecido ? "fornecido via --gasto-fases" : "NÃO fornecido (--gasto-fases) — custo por fase indisponível"}.`,
  );
  out.push("");
  out.push("| Braço | Fase | Período [início, fim) | Cadastros | Ativos | Leitores | >=20 recebidas | Gasto | Custo/leitor | Custo/cadastro |");
  out.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const a of s.arms) {
    for (const f of a.fases) {
      out.push(
        `| ${a.braco} | ${f.label} | ${fmtBrt(f.inicioMs)} → ${fmtBrt(f.fimExclusivoMs)} | ${f.cadastros} | ${f.ativos} | ${f.leitores} | ` +
          `${fmtPct(f.ativosCom20Recebidas, f.ativos)} | ${fmtBrl(f.gastoBrl)} | ${fmtBrl(f.custoPorLeitor)} | ${fmtBrl(f.custoPorCadastro)} |`,
      );
    }
    out.push(
      `| **${a.braco}** | total | — | ${a.cadastros} | ${a.ativos} | ${a.leitores} | ${fmtPct(a.ativosCom20Recebidas, a.ativos)} | ` +
        `${fmtBrl(a.gastoTotalBrl)} | ${a.semSinal ? "sem sinal" : fmtBrl(a.custoPorLeitor)} | ${fmtBrl(a.custoPorCadastro)} |`,
    );
  }
  out.push("");
  for (const a of s.arms) {
    if (a.mesesForaDaJanela.length > 0) {
      out.push(`- ${a.braco}: gasto de ${a.mesesForaDaJanela.join(", ")} em spend.csv fica FORA da janela e não entra no total acima.`);
    }
    if (a.gastoTotalBrl == null) out.push(`- ${a.braco}: nenhuma linha de gasto dentro da janela em spend.csv.`);
  }
  const v = s.verdict;
  out.push(
    `- Fração dos ativos da coorte com >=${LEITOR_MIN_RECEIVED} recebidas: ` +
      `${v.fracCom20Recebidas == null ? "n/a" : `${(v.fracCom20Recebidas * 100).toFixed(1)}%`} (piso ${(EMENDA_MIN_FRAC_20_RECEBIDAS * 100).toFixed(0)}%).`,
  );
  if (v.razaoObservada != null) {
    out.push(
      `- Razão observada (mais caro ÷ mais barato, braços com sinal): ${v.razaoObservada.toFixed(2)}; ` +
        `razão mínima detectável: ${v.razaoDetectavel == null ? `> ${MAX_DETECTABLE_RATIO}` : v.razaoDetectavel.toFixed(2)} ` +
        `(n=${v.nReferencia}, alpha ${EMENDA_ALPHA}, poder ${EMENDA_POWER}).`,
    );
  }
  out.push("");
  out.push(`**Veredito:** ${v.texto}`);
  out.push("");
  out.push("Não calculado nesta seção (escopo remanescente do #8238): custo por K10 e corte determinístico por timestamp de evento.");
  return out;
}

/** Valida o JSON de `--gasto-fases`. Lança com mensagem acionável. @pure */
export function parseEmendaGastoPorFase(raw: unknown): EmendaGastoPorFase {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("--gasto-fases: esperado objeto { braço: { idDaFase: BRL } }");
  }
  const out: EmendaGastoPorFase = {};
  for (const [braco, fases] of Object.entries(raw as Record<string, unknown>)) {
    if (fases == null || typeof fases !== "object" || Array.isArray(fases)) {
      throw new Error(`--gasto-fases: valor de "${braco}" deve ser objeto { idDaFase: BRL }`);
    }
    out[braco] = {};
    for (const [fase, valor] of Object.entries(fases as Record<string, unknown>)) {
      if (typeof valor !== "number" || !Number.isFinite(valor) || valor < 0) {
        throw new Error(`--gasto-fases: "${braco}"."${fase}" deve ser número >= 0`);
      }
      out[braco][fase] = valor;
    }
  }
  return out;
}

/**
 * Confere as chaves de `--gasto-fases` contra o `run-state` (braços e ids de
 * fase de cada braço). Chave digitada errado (`pre_pausa`, braço sem o sufixo)
 * lança nomeando a chave inválida e as válidas — nunca vira `gastoBrl: null`
 * em silêncio, que faria o veredito dizer "gasto por fase não fornecido" a
 * quem acabou de fornecê-lo (#8238, self-review do PR #10956). @pure
 */
export function validateEmendaGastoPorFaseKeys(gastoPorFase: EmendaGastoPorFase, runState: EmendaRunStateInput): void {
  const bracos = runState.bracos;
  for (const [braco, fases] of Object.entries(gastoPorFase)) {
    if (!bracos.includes(braco)) {
      throw new Error(
        `--gasto-fases: braço desconhecido "${braco}". Braços válidos (run-state): ${bracos.map((b) => `"${b}"`).join(", ")}`,
      );
    }
    const validas = resolveEmendaPhaseWindows(runState, braco).map((w) => w.id);
    for (const fase of Object.keys(fases)) {
      if (!validas.includes(fase)) {
        throw new Error(
          `--gasto-fases: fase desconhecida "${fase}" no braço "${braco}". Fases válidas: ${validas.map((f) => `"${f}"`).join(", ")}`,
        );
      }
    }
  }
}
