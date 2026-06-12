#!/usr/bin/env node
/**
 * clarice-build-edition-sends.ts (#2605-06 / Plano de Envio Edição Maio)
 *
 * Monta os 21 envios diários da Edição Maio (ciclo 2605-06) a partir do plano
 * aprovado (Plano de Envio v3). Substitui o modelo W1–W5 do clarice-build-waves
 * para ESTE ciclo: rampa diária morno->frio + validação de dia-da-semana em blocos.
 *
 * Modelo (ver doc "Plano de Envio — Edição Maio (ciclo 2605-06)"):
 *   - 3 semanas (blocos), 7 envios/semana (1 por dia da semana), 21 no total.
 *   - Volume cresce monotonicamente (warm-up). Total = 40.000 (teto Brevo Standard).
 *   - Pool morno->frio: S1 = T1-abriu + T1-não-abriu + maio + topo-recência T2;
 *     S2 = resto T2 + topo T3; S3 = resto T3 + topo T4.
 *   - DENTRO de cada semana, todo dia recebe a MESMA composição estratificada
 *     (fatia representativa de cada tier, espalhada pela recência) -> mantém o
 *     teste de dia-da-semana limpo (cada dia = mesma mistura; o bloco/semana
 *     absorve a diferença morno->frio entre semanas).
 *   - Assunto ÚNICO (sem A/B/C). Sort: T1 por abriu/não-abriu (arquivos prontos);
 *     demais por recência (ordem das linhas dos arquivos verificados).
 *
 * Por que não precisa de Brevo aqui: só o T1 já foi enviado (Edição Abril), então
 * só o T1 pode ter unsub/blacklist — e isso já está resolvido nos arquivos
 * w1/w2 (build-waves suprimiu). T2/maio/T3/T4 nunca foram importados -> sem
 * blacklist possível. Logo, recombinação pura de arquivos, sem fetch externo.
 *
 * Uso:
 *   npx tsx scripts/clarice-build-edition-sends.ts --cycle 2605-06 [--weeks 1,2,3] [--dry-run]
 *   (T3/T4 verificados precisam existir p/ as semanas 2-3; rode o MV antes.)
 *
 * Inputs (em data/clarice-subscribers/{ciclo}/):
 *   waves/w1-brevo-export-t1-openers.csv       T1 abriu     (email,NOME,...)
 *   waves/w2-brevo-export-t1-non-openers.csv   T1 não-abriu
 *   mv-export-maio-verified.csv                maio verificado
 *   mv-export-t02-ex-assinantes-verified.csv   T2 verificado (recência DESC)
 *   mv-export-t03-leads-2026-jan-abr-verified.csv  T3 verificado (após MV)
 *   mv-export-t04-leads-2025H2-verified.csv        T4 verificado (após MV)
 *
 * Outputs (em data/clarice-subscribers/{ciclo}/sends/):
 *   d01-10jun.csv … d21-30jun.csv   (colunas: email,NOME,TIER)
 *   sends-summary.json
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { clariceCycleDir, clariceWavesDir, ensureDir, requireCycleArg } from "./lib/clarice-paths.ts";

loadProjectEnv();

type Row = Record<string, string>;

// ---------------------------------------------------------------------------
// Plano: 21 envios (data, dia, semana, volume). Volumes batem os totais por
// semana (S1=5.600, S2=13.300, S3=21.100; total 40.000). Editar AQUI muda o plano.
// ---------------------------------------------------------------------------

export interface SendDef {
  n: number;          // 1..21
  date: string;       // "10jun"
  day: string;        // "qua"
  week: 1 | 2 | 3;
  volume: number;
  /** Data de envio agendada: 06:00 BRT = 09:00 UTC em ISO 8601 Z. (#2125)
   *  Fonte canônica das datas do ciclo — scheduledAtFor deriva daqui. */
  scheduledAt: string;
}

export const SENDS: SendDef[] = [
  { n: 1,  date: "10jun", day: "qua", week: 1, volume:  350, scheduledAt: "2026-06-10T09:00:00.000Z" },
  { n: 2,  date: "11jun", day: "qui", week: 1, volume:  550, scheduledAt: "2026-06-11T09:00:00.000Z" },
  { n: 3,  date: "12jun", day: "sex", week: 1, volume:  700, scheduledAt: "2026-06-12T09:00:00.000Z" },
  { n: 4,  date: "13jun", day: "sab", week: 1, volume:  850, scheduledAt: "2026-06-13T09:00:00.000Z" },
  { n: 5,  date: "14jun", day: "dom", week: 1, volume:  950, scheduledAt: "2026-06-14T09:00:00.000Z" },
  { n: 6,  date: "15jun", day: "seg", week: 1, volume: 1050, scheduledAt: "2026-06-15T09:00:00.000Z" },
  { n: 7,  date: "16jun", day: "ter", week: 1, volume: 1150, scheduledAt: "2026-06-16T09:00:00.000Z" },
  { n: 8,  date: "17jun", day: "qua", week: 2, volume: 1450, scheduledAt: "2026-06-17T09:00:00.000Z" },
  { n: 9,  date: "18jun", day: "qui", week: 2, volume: 1650, scheduledAt: "2026-06-18T09:00:00.000Z" },
  { n: 10, date: "19jun", day: "sex", week: 2, volume: 1800, scheduledAt: "2026-06-19T09:00:00.000Z" },
  { n: 11, date: "20jun", day: "sab", week: 2, volume: 1900, scheduledAt: "2026-06-20T09:00:00.000Z" },
  { n: 12, date: "21jun", day: "dom", week: 2, volume: 2000, scheduledAt: "2026-06-21T09:00:00.000Z" },
  { n: 13, date: "22jun", day: "seg", week: 2, volume: 2100, scheduledAt: "2026-06-22T09:00:00.000Z" },
  { n: 14, date: "23jun", day: "ter", week: 2, volume: 2400, scheduledAt: "2026-06-23T09:00:00.000Z" },
  { n: 15, date: "24jun", day: "qua", week: 3, volume: 2600, scheduledAt: "2026-06-24T09:00:00.000Z" },
  { n: 16, date: "25jun", day: "qui", week: 3, volume: 2800, scheduledAt: "2026-06-25T09:00:00.000Z" },
  { n: 17, date: "26jun", day: "sex", week: 3, volume: 2950, scheduledAt: "2026-06-26T09:00:00.000Z" },
  { n: 18, date: "27jun", day: "sab", week: 3, volume: 3050, scheduledAt: "2026-06-27T09:00:00.000Z" },
  { n: 19, date: "28jun", day: "dom", week: 3, volume: 3150, scheduledAt: "2026-06-28T09:00:00.000Z" },
  { n: 20, date: "29jun", day: "seg", week: 3, volume: 3250, scheduledAt: "2026-06-29T09:00:00.000Z" },
  { n: 21, date: "30jun", day: "ter", week: 3, volume: 3300, scheduledAt: "2026-06-30T09:00:00.000Z" },
];

export const TIERS = ["T1-abriu", "T1-nao-abriu", "maio", "T2", "T3", "T4"] as const;
export type Tier = (typeof TIERS)[number];

// ---------------------------------------------------------------------------
// Pure: apportionment por maior-resto (ints somando `total`, proporcionais a fracs)
// ---------------------------------------------------------------------------

export function apportion(total: number, fracs: number[]): number[] {
  if (total <= 0) return fracs.map(() => 0);
  const raw = fracs.map((f) => f * total);
  const out = raw.map(Math.floor);
  let rem = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ frac: r - Math.floor(r), i }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < rem; k++) out[order[k % order.length].i]++;
  return out;
}

// ---------------------------------------------------------------------------
// Pure: estratificação determinística de `rows` (em ordem de recência) em K
// baldes de capacidades `caps` (sum(caps) === rows.length), espalhando cada
// balde uniformemente pela faixa de recência (streaming largest-remainder /
// Bresenham). Garante que cada dia carregue toda a faixa, não um bloco contíguo.
// ---------------------------------------------------------------------------

export function stratify(rows: Row[], caps: number[]): Row[][] {
  const k = caps.length;
  const out: Row[][] = caps.map(() => []);
  const N = rows.length;
  if (N === 0) return out;
  const credit = new Array<number>(k).fill(0);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < k; i++) credit[i] += caps[i] / N;
    let best = -1;
    let bc = -Infinity;
    for (let i = 0; i < k; i++) {
      if (out[i].length < caps[i] && credit[i] > bc) {
        bc = credit[i];
        best = i;
      }
    }
    out[best].push(rows[j]);
    credit[best] -= 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function readCsv(path: string): Row[] {
  const parsed = Papa.parse<Row>(readFileSync(path, "utf-8"), {
    header: true,
    skipEmptyLines: true,
  });
  return parsed.data;
}

function emailKeyOf(row: Row | undefined): string {
  if (!row) return "email";
  const k = Object.keys(row).find((f) => /e-?mail/i.test(f.trim()));
  if (!k) throw new Error(`CSV sem coluna de email: colunas=${Object.keys(row ?? {}).join(",")}`);
  return k;
}

/** Normaliza uma linha pro output: email + NOME + TIER (descarta MV_*, OPEN_PROBABILITY). */
function outRow(r: Row, emailKey: string, tier: Tier): Row {
  return { email: (r[emailKey] ?? "").trim(), NOME: r["NOME"] ?? r["nome"] ?? "", TIER: tier };
}

// ---------------------------------------------------------------------------
// Montagem dos pools por semana (data-driven a partir dos tamanhos reais)
// ---------------------------------------------------------------------------

interface TierRows {
  tier: Tier;
  rows: Row[];
  emailKey: string;
}

/** Quanto cada tier contribui por semana, derivado dos totais de volume + tamanhos reais. */
export interface WeekPlan {
  week: 1 | 2 | 3;
  total: number;
  segments: { tier: Tier; count: number }[];
}

/**
 * Deriva, dos tamanhos reais dos tiers, quantas linhas cada tier dá a cada semana.
 * Regras (morno->frio, recência drena entre semanas):
 *   S1 = T1-abriu(all) + T1-não-abriu(all) + maio(all) + topo-T2 (fill até 5.600)
 *   S2 = resto T2 + topo T3 (fill até 13.300)
 *   S3 = resto T3 + topo T4 (fill até 21.100)
 */
export function planWeeks(sizes: Record<Tier, number>, weeks: number[] = [1, 2, 3]): WeekPlan[] {
  const wk = (w: 1 | 2 | 3): number =>
    SENDS.filter((s) => s.week === w).reduce((a, s) => a + s.volume, 0);
  const [S1, S2, S3] = [wk(1), wk(2), wk(3)];

  // Aritmética sequencial pura (independe de quais arquivos foram carregados).
  const t2InS1 = S1 - (sizes["T1-abriu"] + sizes["T1-nao-abriu"] + sizes["maio"]);
  const t2InS2 = sizes["T2"] - t2InS1;
  const t3InS2 = S2 - t2InS2;
  const t3InS3 = sizes["T3"] - t3InS2;
  const t4InS3 = S3 - t3InS3;

  const all: WeekPlan[] = [
    {
      week: 1,
      total: S1,
      segments: [
        { tier: "T1-abriu", count: sizes["T1-abriu"] },
        { tier: "T1-nao-abriu", count: sizes["T1-nao-abriu"] },
        { tier: "maio", count: sizes["maio"] },
        { tier: "T2", count: t2InS1 },
      ],
    },
    { week: 2, total: S2, segments: [{ tier: "T2", count: t2InS2 }, { tier: "T3", count: t3InS2 }] },
    { week: 3, total: S3, segments: [{ tier: "T3", count: t3InS3 }, { tier: "T4", count: t4InS3 }] },
  ];

  // Valida só as semanas pedidas (permite testar S1 antes do MV de T3/T4).
  if (weeks.includes(1)) {
    if (t2InS1 < 0) throw new Error(`Pool quente (T1+maio) já passa de ${S1} na S1 (${-t2InS1} a mais)`);
    if (t2InS1 > sizes["T2"]) throw new Error(`T2 insuficiente p/ S1: precisa ${t2InS1}, tem ${sizes["T2"]}`);
  }
  if (weeks.includes(2)) {
    if (t2InS2 < 0) throw new Error(`T2 insuficiente: apenas ${sizes["T2"]} disponíveis, mas S1 consome ${t2InS1} (${-t2InS2} a menos p/ S2)`);
    if (t3InS2 < 0) throw new Error(`T2 restante (${t2InS2}) já passa de ${S2} na S2`);
    if (t3InS2 > sizes["T3"]) throw new Error(`T3 insuficiente p/ S2: precisa ${t3InS2}, tem ${sizes["T3"]}`);
  }
  if (weeks.includes(3)) {
    if (t4InS3 < 0) throw new Error(`T3 restante (${t3InS3}) já passa de ${S3} na S3`);
    if (t4InS3 > sizes["T4"]) throw new Error(`T4 insuficiente p/ S3: precisa ${t4InS3}, tem ${sizes["T4"]}`);
  }

  return all.filter((p) => weeks.includes(p.week));
}

/**
 * Computa quantas linhas de cada tier foram consumidas pelas `skippedWeeks`
 * usando APENAS aritmética pura — SEM os throws de validação do `planWeeks`.
 *
 * Destinado ao cálculo de cursor de tier em `main()`: ao calcular quais linhas
 * das semanas PULADAS (skippedWeeks) já foram consumidas, `planWeeks` valida os
 * tamanhos dos tiers — o que lança quando T3 < t3InS2 mesmo que a semana pedida
 * seja legítima. `advanceCursors` computa o mesmo `consumed` sem essas validações.
 *
 * **Escopo:** corrige APENAS o cursor das semanas puladas (skippedWeeks).
 * A chamada `planWeeks(sizes, weeks)` para as semanas PEDIDAS em `main()` ainda
 * valida os tamanhos — se os pools das semanas pedidas forem insuficientes,
 * `planWeeks` ainda lança normalmente. O operador deve garantir pools adequados
 * para as semanas efetivamente enviadas; `advanceCursors` só elimina o throw
 * espúrio do cursor de semanas puladas.
 *
 * #2048 item 4b — extraído para eliminar throw de validação no cursor de skippedWeeks.
 */
export function advanceCursors(
  sizes: Record<Tier, number>,
  skippedWeeks: number[],
): Record<Tier, number> {
  const consumed: Record<Tier, number> = {
    "T1-abriu": 0,
    "T1-nao-abriu": 0,
    maio: 0,
    T2: 0,
    T3: 0,
    T4: 0,
  };

  if (skippedWeeks.length === 0) return consumed;

  const wk = (w: 1 | 2 | 3): number =>
    SENDS.filter((s) => s.week === w).reduce((a, s) => a + s.volume, 0);
  const [S1, S2, S3] = [wk(1), wk(2), wk(3)];

  const t2InS1 = S1 - (sizes["T1-abriu"] + sizes["T1-nao-abriu"] + sizes["maio"]);
  const t2InS2 = sizes["T2"] - t2InS1;
  const t3InS2 = S2 - t2InS2;
  const t3InS3 = sizes["T3"] - t3InS2;
  const t4InS3 = S3 - t3InS3;

  if (skippedWeeks.includes(1)) {
    consumed["T1-abriu"] += sizes["T1-abriu"];
    consumed["T1-nao-abriu"] += sizes["T1-nao-abriu"];
    consumed["maio"] += sizes["maio"];
    consumed["T2"] += t2InS1;
  }
  if (skippedWeeks.includes(2)) {
    consumed["T2"] += t2InS2;
    consumed["T3"] += t3InS2;
  }
  if (skippedWeeks.includes(3)) {
    consumed["T3"] += t3InS3;
    consumed["T4"] += t4InS3;
  }

  return consumed;
}

// #2048 item 4c: conjunto de semanas derivado de SENDS em vez de literal [1,2,3].
// NOTA (#2061): ALL_WEEKS captura todas as semanas presentes em SENDS, MAS
// advanceCursors tem blocos hardcoded pra semanas 1/2/3 — se SENDS ganhar uma
// semana 4, ALL_WEEKS a incluirá corretamente, mas advanceCursors precisará de
// um bloco `if (skippedWeeks.includes(4)) { ... }` correspondente (semana 4 em
// skippedWeeks seria ignorada em silêncio sem ele). Estender juntos.
export const ALL_WEEKS: number[] = [...new Set(SENDS.map((s) => s.week))].sort(
  (a, b) => a - b,
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = requireCycleArg(argv);
  const dryRun = argv.includes("--dry-run");
  const weeksIdx = argv.indexOf("--weeks");
  const weeksArg = weeksIdx !== -1 ? argv[weeksIdx + 1] : undefined;
  // --weeks sem valor ou valor inválido (ex: --weeks --dry-run) → erro explícito
  if (argv.includes("--weeks")) {
    if (!weeksArg || weeksArg.startsWith("-")) {
      throw new Error(`--weeks requer um valor (ex: --weeks 1 ou --weeks 2,3). Recebido: ${weeksArg ?? "(nada)"}`);
    }
  }
  // #2048 item 4c: semanas válidas derivadas de SENDS em vez de literal [1,2,3].
  const weeksRaw = weeksArg
    ? weeksArg.split(",").map((x) => Number(x.trim())).filter((x) => ALL_WEEKS.includes(x))
    : [...ALL_WEEKS];
  if (argv.includes("--weeks") && weeksRaw.length === 0) {
    throw new Error(`--weeks "${weeksArg}" não contém semanas válidas (use ${ALL_WEEKS.join(", ")}).`);
  }
  const weeks = weeksRaw;

  const cycleDir = clariceCycleDir(cycle);
  const wavesDir = clariceWavesDir(cycle);
  const src: Record<Tier, string> = {
    "T1-abriu": resolve(wavesDir, "w1-brevo-export-t1-openers.csv"),
    "T1-nao-abriu": resolve(wavesDir, "w2-brevo-export-t1-non-openers.csv"),
    maio: resolve(cycleDir, "mv-export-maio-verified.csv"),
    T2: resolve(cycleDir, "mv-export-t02-ex-assinantes-verified.csv"),
    T3: resolve(cycleDir, "mv-export-t03-leads-2026-jan-abr-verified.csv"),
    T4: resolve(cycleDir, "mv-export-t04-leads-2025H2-verified.csv"),
  };

  // planWeeks precisa do tamanho de TODOS os tiers que afetam o fill das semanas pedidas,
  // incluindo tiers de semanas anteriores (cursor de T2 depende do tamanho consumido pela S1).
  // #2048 item 4a: bloco único — T1+maio+T2 sempre necessários para cálculo de cursores;
  // T3 para semanas 2/3; T4 só para semana 3. Eliminados os dois blocos sobrepostos anteriores.
  const neededTiers = new Set<Tier>();
  (["T1-abriu", "T1-nao-abriu", "maio", "T2"] as Tier[]).forEach((t) => neededTiers.add(t));
  if (weeks.includes(2) || weeks.includes(3)) neededTiers.add("T3");
  if (weeks.includes(3)) neededTiers.add("T4");

  const pool: Partial<Record<Tier, TierRows>> = {};
  const sizes = { "T1-abriu": 0, "T1-nao-abriu": 0, maio: 0, T2: 0, T3: 0, T4: 0 } as Record<Tier, number>;
  // Dedup GLOBAL em ordem de prioridade (TIERS = morno->frio): um contato em
  // mais de um tier (ex: maio ∩ T3 — o cohort maio é aditivo, não disjunto dos
  // tiers) fica só na fatia mais quente. Sem isso, alguém recebe 2 emails.
  const seenGlobal = new Set<string>();
  for (const tier of TIERS) {
    if (!neededTiers.has(tier)) continue;
    if (!existsSync(src[tier])) {
      throw new Error(
        `Arquivo do tier ${tier} não existe: ${src[tier]}\n` +
          (tier === "T3" || tier === "T4"
            ? `Rode o MV antes: npx tsx scripts/verify-emails-mv.ts --cycle ${cycle} --input stripe-export-${tier === "T3" ? "t03-leads-2026-jan-abr" : "t04-leads-2025H2"}.csv`
            : ""),
      );
    }
    const rows = readCsv(src[tier]);
    const ek = emailKeyOf(rows[0]);
    const kept: Row[] = [];
    let dropped = 0;
    for (const r of rows) {
      const e = (r[ek] ?? "").trim().toLowerCase();
      if (!e || seenGlobal.has(e)) {
        dropped++;
        continue;
      }
      seenGlobal.add(e);
      kept.push(r);
    }
    pool[tier] = { tier, rows: kept, emailKey: ek };
    sizes[tier] = kept.length;
    if (dropped) console.error(`  ${tier}: -${dropped} (dup global / email vazio)`);
  }

  console.error("Tamanhos dos tiers:", sizes);
  const plans = planWeeks(sizes, weeks);

  // Para cada semana: para cada tier-segmento, fatia em 7 baldes (1 por dia)
  // proporcionais ao volume do dia; depois combina por dia.
  const sendsDir = ensureDir(resolve(cycleDir, "sends"));
  const summary: any = { cycle, total: 0, perTier: {}, sends: [] };
  for (const t of TIERS) summary.perTier[t] = 0;

  // cursor por tier: quantas linhas já consumidas por semanas ANTERIORES às pedidas.
  // Inicializar a 0 e avançar as semanas não pedidas que precedem as pedidas evita o
  // bug de duplo-envio: --weeks 2 sem esse ajuste começaria o T2 do início, enviando
  // as mesmas linhas que a S1 já recebeu. (#2007 / #2018)
  //
  // #2048 item 4b: usa `advanceCursors` (puro, sem throws de validação) em vez de
  // `planWeeks(sizes, skippedWeeks)`. Isso permite rodar `--weeks 3` após os CSVs de
  // T3 já terem sido aparados pós-S2 (T3=0), sem lançar `T3 insuficiente p/ S2`.
  // #2048 item 4c: `ALL_WEEKS` derivado de `SENDS` em vez do literal [1,2,3].
  const skippedWeeks = ALL_WEEKS.filter((w) => !weeks.includes(w) && w < Math.max(...weeks));
  const consumed = advanceCursors(sizes, skippedWeeks);

  for (const plan of plans) {
    const daySends = SENDS.filter((s) => s.week === plan.week);
    const dayVols = daySends.map((s) => s.volume);
    const fracs = dayVols.map((v) => v / plan.total);
    // dia -> linhas acumuladas
    const dayRows: Row[][] = daySends.map(() => []);

    for (const seg of plan.segments) {
      const tr = pool[seg.tier];
      if (!tr) throw new Error(`pool do tier ${seg.tier} não carregado`);
      // pega o trecho deste tier para esta semana (topo->resto via cursor)
      const start = consumed[seg.tier];
      const slice = tr.rows.slice(start, start + seg.count);
      consumed[seg.tier] = start + seg.count;
      if (slice.length !== seg.count) {
        throw new Error(`tier ${seg.tier}: esperado ${seg.count}, fatiou ${slice.length} (cursor ${start})`);
      }
      // distribui as `seg.count` linhas nos 7 dias, proporcional ao volume
      const caps = apportion(seg.count, fracs);
      const perDay = stratify(slice, caps);
      perDay.forEach((rowsForDay, di) => {
        for (const r of rowsForDay) dayRows[di].push(outRow(r, tr.emailKey, seg.tier));
        summary.perTier[seg.tier] += rowsForDay.length;
      });
    }

    daySends.forEach((s, di) => {
      const rows = dayRows[di];
      const comp: Record<string, number> = {};
      for (const r of rows) comp[r.TIER] = (comp[r.TIER] ?? 0) + 1;
      summary.total += rows.length;
      summary.sends.push({ n: s.n, file: `d${String(s.n).padStart(2, "0")}-${s.date}.csv`, day: s.day, week: s.week, planned: s.volume, actual: rows.length, comp });
      const name = `d${String(s.n).padStart(2, "0")}-${s.date}.csv`;
      if (!dryRun) {
        writeFileAtomic(resolve(sendsDir, name), Papa.unparse({ fields: ["email", "NOME", "TIER"], data: rows }));
      }
      console.error(`  ${name}  dia=${s.day} plan=${s.volume} real=${rows.length}  ${JSON.stringify(comp)}`);
    });
  }

  if (!dryRun) {
    writeFileAtomic(resolve(sendsDir, "sends-summary.json"), JSON.stringify(summary, null, 2));
  }
  console.error(`\nTotal: ${summary.total}  perTier:`, summary.perTier);
  console.error(dryRun ? "(dry-run: nada escrito)" : `Escrito em ${sendsDir}`);
}

// CLI guard (#tests importam helpers sem disparar main)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("clarice-build-edition-sends.ts")) {
  main().catch((e) => {
    console.error(String(e?.stack || e));
    process.exit(1);
  });
}
