#!/usr/bin/env node
/**
 * clarice-build-waves-store.ts — builder de waves STORE-DRIVEN (#2656 cutover).
 *
 * Sucessor do antigo clarice-build-waves.ts (cohort T1/T2 + fetch ao vivo do
 * Brevo — removido em #2844/260702, cutover concluído): monta as waves a
 * partir do store único (#2647), segmentando a BASE INTEIRA
 * por comportamento, decisão editorial registrada:
 *   - corte por send_eligible (supressão já consolidada no store)
 *   - re-envio ordenado por priority_points (histórico de abertura — o preditor
 *     real, validado nos achados T1)
 *   - 1º envio ordenado por tier (T01 ativo → leads)
 * Fila de envio (priorityQueue): engajado → 1º envio → re-envio decaído.
 *
 * Pega o TOPO da fila até `--budget` (orçamento do ciclo — o lever de expansão
 * de alcance) e fatia em waves de `--wave-size`. Escreve wN-store.csv (email,NOME)
 * + waves-manifest.json (consumido pelo clarice-import-waves).
 *
 * SEGURANÇA: só ESCREVE CSVs locais — não envia nada. O envio segue gated pelo
 * import-waves (dry-run default) + schedule (manual). `--dry-run` aqui só imprime
 * o plano sem escrever.
 *
 * Uso:
 *   npx tsx scripts/clarice-build-waves-store.ts --cycle 2605-06 --budget 8000 [--wave-size 2000] [--dry-run] [--cohort junho]
 *   --budget N   OBRIGATÓRIO (>0) — contatos a enviar neste ciclo (lever de alcance).
 *   --cohort X   OPCIONAL (#2817) — restringe a segmentação a uma safra mensal
 *                (rótulo pt-BR, ex: "junho", ou forma canônica "YYYY-MM", ex:
 *                "2026-06" — ver `resolveCohortArg`). Sem a flag, roda sobre a
 *                base inteira (comportamento pré-#2817, sem mudança).
 */

import { writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import {
  segmentFromStore,
  priorityQueue,
  sliceIntoWaves,
  resolveCohortArg,
  type StoreRow,
} from "./lib/clarice-segment.ts";
import { clariceWavesDir, ensureDir, requireCycleArg } from "./lib/clarice-paths.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { injectSeed, CLARICE_SEED_EMAIL, CLARICE_SEED_NOME } from "./lib/clarice-seed.ts";

interface BuilderRow extends StoreRow {
  name: string | null;
}

export interface WaveManifestEntry {
  key: string;
  file: string;
  desc: string;
  count: number;
}

const pad = (t: number): string => `T${String(t).padStart(2, "0")}`;

/** Rótulo curto da wave (vira nome da lista no import). Puro — testável. */
export function describeWave(w: StoreRow[]): string {
  if (w.length === 0) return "vazia";
  const isRe = (r: StoreRow): boolean => (r.sends_count ?? 0) > 0;
  const engaged = w.filter((r) => isRe(r) && (r.priority_points ?? 0) > 0).length;
  const decayed = w.filter((r) => isRe(r) && (r.priority_points ?? 0) <= 0).length;
  const first = w.length - engaged - decayed;
  if (first === w.length) {
    const tiers = w.map((r) => r.tier).filter((t): t is number => t != null);
    if (tiers.length === 0) return "1º envio";
    const lo = Math.min(...tiers);
    const hi = Math.max(...tiers);
    return lo === hi ? `1º envio (${pad(lo)})` : `1º envio (${pad(lo)}–${pad(hi)})`;
  }
  if (engaged === w.length) return "re-envio (engajado)";
  if (decayed === w.length) return "re-envio (decaído)";
  if (first === 0) return "re-envio (engajado+decaído)";
  return "misto (re-envio + 1º)";
}

/** 1º nome p/ personalização. Tira vírgula/espaço (ex: "Azevedo, Ana" → "Azevedo"). */
function firstName(name: string | null): string {
  return (name ?? "").trim().split(/[\s,]+/)[0] || "";
}

/** Monta o manifest + os CSVs (puro: retorna os artefatos, não escreve). */
export function buildWaveArtifacts(
  rows: BuilderRow[],
  budget: number,
  waveSize: number,
): { manifest: WaveManifestEntry[]; csvByFile: Record<string, string>; seg: ReturnType<typeof segmentFromStore> } {
  const nameByEmail = new Map(rows.map((r) => [r.email, firstName(r.name)]));
  const seg = segmentFromStore(rows);
  const queue = priorityQueue(seg);
  const selected = budget > 0 ? queue.slice(0, budget) : queue;
  const waves = sliceIntoWaves(selected, waveSize);

  const manifest: WaveManifestEntry[] = [];
  const csvByFile: Record<string, string> = {};
  for (let i = 0; i < waves.length; i++) {
    const file = `w${i + 1}-store.csv`;
    const w = waves[i];
    // #2683: injeta seed address em toda wave. Dedup: se o editor for assinante
    // elegível (send_eligible=1), já estará em w → apenas marca IS_SEED sem duplicar.
    // Se send_eligible=0 (ou não é assinante), injeta ao fim. IS_SEED="true" marca
    // a row pra exclusão de analytics (open-rate, CTR, priority_points).
    const baseRows = w.map((r) => ({ email: r.email, NOME: nameByEmail.get(r.email) ?? "" }));
    const withSeed = injectSeed(baseRows, "email", { NOME: CLARICE_SEED_NOME });
    // fields explícito: não depende da ordem de chaves do 1º objeto (só o seed
    // tem IS_SEED; sem fields, Papa omitiria a coluna). Reais saem com IS_SEED
    // vazio, o seed com "true".
    csvByFile[file] = Papa.unparse({ fields: ["email", "NOME", "IS_SEED"], data: withSeed });
    // count = rows de assinantes reais (pré-seed). O CSV tem +1 row extra (seed).
    // clarice-import-waves usa countRows(raw) do CSV real — esta contagem é
    // informacional (para o summary de planejamento).
    manifest.push({ key: `W${i + 1}`, file, desc: describeWave(w), count: w.length });
  }
  return { manifest, csvByFile, seg };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const cycle = requireCycleArg(argv);
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  // --budget é OBRIGATÓRIO (sem default mágico): controla quantos contatos
  // recebem email no ciclo — lever de blast-radius, mesmo princípio do --cycle
  // explícito. Sem isso, `--budget 0` cairia num default silencioso (0 é falsy).
  const budgetArg = getArg(argv, "budget");
  const budget = Number(budgetArg);
  if (!budgetArg || !Number.isFinite(budget) || budget <= 0) {
    console.error(
      "❌ --budget N (>0) é obrigatório — quantos contatos enviar neste ciclo " +
        "(lever de alcance). Ex: --budget 8000.",
    );
    process.exit(1);
  }
  const waveSize = Number(getArg(argv, "wave-size")) || 2000;
  const dryRun = hasFlag(argv, "dry-run");

  // #2817: --cohort restringe a segmentação a uma safra mensal específica.
  // Resolvido ANTES do SELECT (falha cedo se o rótulo/forma não for reconhecido
  // — ver resolveCohortArg) e aplicado como WHERE, não como filtro pós-carga:
  // mudança mínima, `segmentFromStore`/`priorityQueue` continuam intocados.
  const cohortArg = getArg(argv, "cohort");
  const cohort = cohortArg ? resolveCohortArg(cohortArg) : null;

  const db = openClariceDb(dbPath);
  const rows = db
    .prepare(
      `SELECT email, name, tier, cohort, priority_points, send_eligible, ineligible_reason, sends_count
         FROM clarice_users${cohort ? " WHERE cohort = ?" : ""}`,
    )
    .all(...(cohort ? [cohort] : [])) as unknown as BuilderRow[];
  db.close();

  if (cohort) {
    console.error(`🎯 filtro --cohort aplicado: cohort='${cohort}' (${rows.length} linha(s) no universo)`);
  }

  if (rows.length === 0) {
    console.error(
      cohort
        ? `❌ 0 contatos com cohort='${cohort}' — verifique se o store já foi rebuildado após o import da safra.`
        : "❌ store vazio — rode clarice-build-db.ts + clarice-sync-brevo.ts antes.",
    );
    process.exit(1);
  }

  const { manifest, csvByFile, seg } = buildWaveArtifacts(rows, budget, waveSize);
  const selectedTotal = manifest.reduce((s, m) => s + m.count, 0);

  // Guard: 0 waves = nenhum elegível selecionado (bug de send_eligible / store).
  // NÃO escrever um manifest vazio em silêncio — o import mandaria nada/lista vazia.
  if (manifest.length === 0) {
    console.error(
      `❌ 0 waves (nenhum contato elegível) — verifique send_eligible no store. ` +
        `eligible_total=${seg.reSend.length + seg.firstSend.length}. Nada escrito.`,
    );
    process.exit(1);
  }

  const summary = {
    cycle,
    source: "store-driven (#2656)",
    budget,
    wave_size: waveSize,
    // #2817: auditoria — undefined vira ausente no JSON (não escreve `null` ruidoso).
    cohort: cohort ?? undefined,
    // Contagens de assinantes reais (pré-seed). O seed (IS_SEED=true) é injetado
    // em cada wave CSV como +1 row extra de monitoramento (#2683).
    seed_email: CLARICE_SEED_EMAIL,
    eligible_total: seg.reSend.length + seg.firstSend.length,
    re_send: seg.reSend.length,
    first_send: seg.firstSend.length,
    excluded: seg.excluded.length,
    selected: selectedTotal,
    waves: manifest,
  };

  if (!dryRun) {
    const wavesDir = clariceWavesDir(cycle);
    ensureDir(wavesDir);
    // Limpa wN-store.csv stale de um run ANTERIOR (ex: budget maior gerou mais
    // waves) que não estão neste manifest — senão o editor vê CSVs órfãos no dir.
    const keep = new Set(Object.keys(csvByFile));
    for (const f of readdirSync(wavesDir)) {
      if (/^w\d+-store\.csv$/.test(f) && !keep.has(f)) {
        unlinkSync(resolve(wavesDir, f));
        console.error(`🧹 removido wave stale: ${f}`);
      }
    }
    for (const [file, csv] of Object.entries(csvByFile)) {
      writeFileSync(resolve(wavesDir, file), csv, "utf8");
    }
    writeFileSync(resolve(wavesDir, "waves-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    writeFileSync(resolve(wavesDir, "waves-summary.json"), JSON.stringify(summary, null, 2), "utf8");
    console.error(`✅ ${manifest.length} waves (${selectedTotal} contatos) em ${wavesDir}`);
  } else {
    console.error(`ℹ️  dry-run — nada escrito. ${manifest.length} waves, ${selectedTotal} contatos.`);
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
