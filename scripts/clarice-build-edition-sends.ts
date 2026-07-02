#!/usr/bin/env node
/**
 * clarice-build-edition-sends.ts (#2775 — cutover store-driven da rampa diária)
 *
 * Monta os envios diários de um ciclo de rampa (warm-up morno->frio) a partir
 * do STORE único (#2647, `clarice-segment.ts`) + de um plano de envio EXTERNO
 * (`{ciclo}/send-plan.json` — datas/volumes/blocos, editável pelo operador).
 *
 * Substitui o modelo legado (`SENDS` hardcoded do ciclo 2605-06 + 6 CSVs de
 * tier nomeados à mão) por:
 *   1. `loadStoreRows(db)` → `segmentFromStore` → `priorityQueue` (fila única
 *      ordenada: re-envio engajado → 1º envio por tier → re-envio decaído).
 *   2. `loadSendPlan(cycleDir)` — plano de blocos/dias/volumes do ciclo.
 *   3. Fatia a fila CONSECUTIVAMENTE por bloco (rampa: bloco 1 = topo/mais
 *      quente da fila, blocos seguintes drenam trechos progressivamente mais
 *      frios) — usando o plano INTEIRO como cursor, mesmo quando só um
 *      subconjunto de blocos é escrito nesta invocação (`--blocks`), pra evitar
 *      duplo-envio entre blocos processados em invocações separadas.
 *   4. DENTRO de cada bloco, estratifica (`stratify`, streaming largest-
 *      remainder) as linhas entre os dias do bloco, proporcional ao volume de
 *      cada dia — mesma composição em todo dia do bloco, neutralizando o teste
 *      de dia-da-semana (a diferença morno->frio fica só entre blocos).
 *
 * Shape de output preservado (blast radius mínimo nos consumidores
 * downstream): `d{NN}-{date}.csv` (email,NOME,TIER,IS_SEED) + `sends-summary.json`
 * (agora com `block` no lugar de `week`, e `date`/`scheduledAt`/`volume` por
 * dia — ver `scripts/lib/send-plan.ts`).
 *
 * Uso:
 *   npx tsx scripts/clarice-build-edition-sends.ts --cycle 2605-06 [--blocks 1,2,3] [--dry-run] [--db path] [--cohort junho]
 *   (Requer {ciclo}/send-plan.json — ver scripts/send-plan.example.json.)
 *   --cohort X   OPCIONAL (#2817) — restringe a fila de prioridade a uma safra
 *                mensal antes de segmentar (mesmo `resolveCohortArg` do
 *                clarice-build-waves-store.ts). Sem a flag, roda sobre a base
 *                inteira (comportamento pré-#2817, sem mudança).
 *
 * Inputs:
 *   data/clarice-subscribers/clarice-users.db      store único (#2647)
 *   data/clarice-subscribers/{ciclo}/send-plan.json  plano de envio (blocos/dias/volumes)
 *
 * Outputs (em data/clarice-subscribers/{ciclo}/sends/):
 *   d01-10jun.csv … dNN-*.csv   (colunas: email,NOME,TIER,IS_SEED)
 *   sends-summary.json
 */

import { readdirSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { clariceCycleDir, ensureDir, requireCycleArg } from "./lib/clarice-paths.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { segmentFromStore, priorityQueue, resolveCohortArg, type StoreRow } from "./lib/clarice-segment.ts";
import { loadSendPlan, allBlocks, planByBlock, parseBlocksArg, type SendPlanEntry, type SendsSummaryEntry } from "./lib/send-plan.ts";
import { getArg, hasFlag } from "./lib/cli-args.ts";
import { CLARICE_SEED_EMAIL } from "./lib/clarice-seed.ts";

loadProjectEnv();

type Row = Record<string, string>;

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
// Pure: estratificação determinística de `rows` (em ordem de prioridade) em K
// baldes de capacidades `caps` (sum(caps) === rows.length), espalhando cada
// balde uniformemente pela faixa (streaming largest-remainder / Bresenham).
// Garante que cada dia carregue toda a faixa do bloco, não um trecho contíguo.
// ---------------------------------------------------------------------------

export function stratify<T>(rows: T[], caps: number[]): T[][] {
  const k = caps.length;
  const out: T[][] = caps.map(() => []);
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
// StoreRow -> CSV row
// ---------------------------------------------------------------------------

const pad = (t: number): string => `T${String(t).padStart(2, "0")}`;

/**
 * Normaliza uma `StoreRow` pro output: email + NOME + TIER + IS_SEED.
 *
 * TIER deriva do tier numérico do store (`T01`..`T10`; vazio se nulo — leads
 * sem proveniência Stripe). Análogo ao `pad()` de `clarice-build-waves-store.ts`
 * (#2656) — mesma convenção de rótulo entre os dois builders store-driven.
 *
 * IS_SEED: marca `true` se a row for o endereço de monitoramento do editor
 * (`CLARICE_SEED_EMAIL`) e ele aparecer NATURALMENTE na fila (é assinante
 * elegível de verdade) — não força injeção de uma row extra por dia (isso
 * multiplicaria o seed por N dias; ver decisão documentada no PR #2775).
 */
export function outRow(r: StoreRow, name: string): Row {
  const isSeed = r.email.trim().toLowerCase() === CLARICE_SEED_EMAIL.toLowerCase();
  return {
    email: r.email,
    NOME: name,
    TIER: r.tier != null ? pad(r.tier) : "",
    IS_SEED: isSeed ? "true" : "",
  };
}

// ---------------------------------------------------------------------------
// Montagem por bloco (pura sobre a fila + o plano)
// ---------------------------------------------------------------------------

export interface BuiltDay {
  n: number;
  date: string;
  day: string;
  block: number;
  scheduledAt: string;
  volume: number;
  rows: Row[];
}

/**
 * Fatia `queue` (já ordenada por prioridade) consecutivamente por bloco
 * (rampa) e estratifica dentro de cada bloco pelos dias do plano.
 *
 * `queue` deve conter PELO MENOS a soma de volumes do plano inteiro — cada
 * bloco consome o próximo trecho da fila em ordem, então blocos requisitados
 * fora de ordem ainda avançam o cursor corretamente (mesma fila, mesmo
 * offset acumulado) desde que `plan` seja o plano COMPLETO do ciclo.
 *
 * @param nameByEmail primeiro nome por email (personalização; "" se ausente)
 */
export function buildSends(
  queue: StoreRow[],
  plan: SendPlanEntry[],
  nameByEmail: Map<string, string>,
): BuiltDay[] {
  const blocks = planByBlock(plan);
  const totalNeeded = blocks.reduce((a, b) => a + b.total, 0);
  if (queue.length < totalNeeded) {
    throw new Error(
      `fila de prioridade insuficiente: plano precisa de ${totalNeeded} contatos elegíveis, fila tem ${queue.length}.`,
    );
  }

  const out: BuiltDay[] = [];
  let offset = 0;
  for (const bp of blocks) {
    const blockSlice = queue.slice(offset, offset + bp.total);
    offset += bp.total;

    const dayVols = bp.sends.map((s) => s.volume);
    const fracs = dayVols.map((v) => v / bp.total);
    const caps = apportion(bp.total, fracs);
    const perDay = stratify<StoreRow>(blockSlice, caps);

    bp.sends.forEach((s, di) => {
      const rows = perDay[di].map((r) => outRow(r, nameByEmail.get(r.email) ?? ""));
      out.push({ n: s.n, date: s.date, day: s.day, block: s.block, scheduledAt: s.scheduledAt, volume: s.volume, rows });
    });
  }
  return out;
}

/** 1º nome p/ personalização (ex: "Azevedo, Ana" → "Azevedo"). */
function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/[\s,]+/)[0] || "";
}

/**
 * Merge cirúrgico (#495) entre a recomputação FRESCA (`freshSends`, sempre
 * cobre o plano inteiro) e o `sends-summary.json` pré-existente: dias cujo
 * bloco está FORA de `blocksInScope` nesta invocação preservam a entrada já
 * gravada anteriormente (com `listId` injetado por `clarice-import-sends`, se
 * houver) — não sobrescrevem com números frescos de um CSV que não foi
 * re-escrito agora.
 *
 * Sem isso, uma invocação parcial (ex: `--blocks 2,3` rodada depois de o
 * store ter mudado) reescreveria a entrada do bloco-célula com uma composição
 * que não bate mais com o CSV real já importado/agendado (drift silencioso).
 *
 * Pura + exportada pra testabilidade (#633, #2775).
 */
export function mergeSummaryAcrossBlocks(
  freshSends: SendsSummaryEntry[],
  prevSends: SendsSummaryEntry[] | undefined,
  blocksInScope: number[],
): SendsSummaryEntry[] {
  const prevByN = new Map((prevSends ?? []).map((s) => [s.n, s]));
  return freshSends.map((s) => (blocksInScope.includes(s.block) ? s : prevByN.get(s.n) ?? s));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = requireCycleArg(argv);
  const dryRun = hasFlag(argv, "dry-run");
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;

  const cycleDir = clariceCycleDir(cycle);
  const plan = loadSendPlan(cycleDir);
  const validBlocks = allBlocks(plan);
  const blocks = parseBlocksArg(argv, validBlocks);

  // #2817: --cohort restringe a fila de prioridade a uma safra mensal, aplicado
  // como WHERE no carregamento — a segmentação/estratificação downstream
  // (segmentFromStore/priorityQueue/buildSends) fica intocada.
  const cohortArg = getArg(argv, "cohort");
  const cohort = cohortArg ? resolveCohortArg(cohortArg) : null;

  const db = openClariceDb(dbPath);
  let storeRows: (StoreRow & { name?: string | null })[];
  try {
    storeRows = db
      .prepare(
        `SELECT email, name, tier, priority_points, send_eligible, ineligible_reason, sends_count
           FROM clarice_users${cohort ? " WHERE cohort = ?" : ""}`,
      )
      .all(...(cohort ? [cohort] : [])) as unknown as (StoreRow & { name?: string | null })[];
  } finally {
    db.close();
  }

  if (cohort) {
    console.error(`🎯 filtro --cohort aplicado: cohort='${cohort}' (${storeRows.length} linha(s) no universo)`);
  }

  if (storeRows.length === 0) {
    throw new Error(
      cohort
        ? `0 contatos com cohort='${cohort}' — verifique se o store já foi rebuildado após o import da safra.`
        : "store vazio — rode clarice-build-db.ts + clarice-sync-brevo.ts antes.",
    );
  }

  const nameByEmail = new Map(storeRows.map((r) => [r.email, firstName(r.name)]));
  const seg = segmentFromStore(storeRows);
  const queue = priorityQueue(seg);

  console.error(
    `Fila de prioridade: ${queue.length} elegíveis (re-envio=${seg.reSend.length} 1º-envio=${seg.firstSend.length} excluídos=${seg.excluded.length})`,
  );

  const built = buildSends(queue, plan, nameByEmail);

  const sendsDir = ensureDir(resolve(cycleDir, "sends"));
  const summary: { cycle: string; total: number; sends: SendsSummaryEntry[] } = {
    cycle,
    total: 0,
    sends: [],
  };

  for (const day of built) {
    const file = `d${String(day.n).padStart(2, "0")}-${day.date}.csv`;
    const comp: Record<string, number> = {};
    for (const r of day.rows) comp[r.TIER || "(sem tier)"] = (comp[r.TIER || "(sem tier)"] ?? 0) + 1;

    const entry: SendsSummaryEntry = {
      n: day.n,
      date: day.date,
      day: day.day,
      block: day.block,
      volume: day.volume,
      scheduledAt: day.scheduledAt,
      file,
      planned: day.volume,
      actual: day.rows.length,
      comp,
    };
    summary.sends.push(entry);
    summary.total += day.rows.length;

    console.error(
      `  ${file}  dia=${day.day} bloco=${day.block} plan=${day.volume} real=${day.rows.length}  ${JSON.stringify(comp)}${
        blocks.includes(day.block) ? "" : "  (fora de --blocks — não escrito)"
      }`,
    );

    if (!dryRun && blocks.includes(day.block)) {
      writeFileAtomic(
        resolve(sendsDir, file),
        Papa.unparse({ fields: ["email", "NOME", "TIER", "IS_SEED"], data: day.rows }),
      );
    }
  }

  if (!dryRun) {
    // Limpa CSVs de dias stale (ex: plano encolheu) que não constam mais do plano atual.
    const keep = new Set(built.filter((d) => blocks.includes(d.block)).map((d) => `d${String(d.n).padStart(2, "0")}-${d.date}.csv`));
    for (const f of readdirSync(sendsDir)) {
      if (/^d\d{2}-.*\.csv$/.test(f) && !keep.has(f)) {
        // Só remove arquivos de dias DENTRO dos blocos pedidos nesta invocação —
        // não mexe em CSVs de blocos que não fazem parte de `--blocks` (podem
        // ter sido escritos por uma invocação anterior e ainda ser válidos).
        const match = f.match(/^d(\d{2})-/);
        const n = match ? Number(match[1]) : null;
        const dayPlan = n != null ? built.find((d) => d.n === n) : undefined;
        if (dayPlan && blocks.includes(dayPlan.block)) {
          unlinkSync(resolve(sendsDir, f));
          console.error(`🧹 removido stale: ${f}`);
        }
      }
    }

    // Merge cirúrgico (#495) com sends-summary.json pré-existente — ver
    // mergeSummaryAcrossBlocks. Blocos fora de `--blocks` preservam a entrada já
    // gravada (com `listId`, se já importado); só os blocos pedidos são frescos.
    const summaryPath = resolve(sendsDir, "sends-summary.json");
    let finalSends = summary.sends;
    if (existsSync(summaryPath)) {
      try {
        const prev: { sends?: SendsSummaryEntry[] } = JSON.parse(readFileSync(summaryPath, "utf8"));
        finalSends = mergeSummaryAcrossBlocks(summary.sends, prev.sends, blocks);
      } catch (e) {
        console.error(`⚠️  sends-summary.json existente corrompido (JSON inválido) — sobrescrevendo do zero: ${String(e)}`);
      }
    }
    const finalTotal = finalSends.reduce((a, s) => a + s.actual, 0);
    writeFileAtomic(summaryPath, JSON.stringify({ cycle, total: finalTotal, sends: finalSends }, null, 2));
  }
  console.error(`\nTotal (plano inteiro): ${summary.total}`);
  console.error(dryRun ? "(dry-run: nada escrito)" : `Escrito em ${sendsDir} (blocos: ${blocks.join(",")})`);
}

// CLI guard (#tests importam helpers sem disparar main)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("clarice-build-edition-sends.ts")) {
  main().catch((e) => {
    console.error(String(e?.stack || e));
    process.exit(1);
  });
}
