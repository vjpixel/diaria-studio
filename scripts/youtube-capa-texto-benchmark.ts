/**
 * scripts/youtube-capa-texto-benchmark.ts (#13253)
 *
 * Benchmark do TEXTO das capas em canais de IA, em cima da coleta do benchmark
 * visual (`scripts/youtube-capa-benchmark.ts`, #13217). Não chama API: lê o
 * arquivo de medição com o texto transcrito de cada capa e imprime as tabelas
 * do `docs/youtube-capa-texto-benchmark.md` (modelo de texto × acima da média,
 * comparação dentro de cada canal, nosso canal).
 *
 * Uso:
 *   # relatório (default: a medição mais recente em docs/measurements/)
 *   npx tsx scripts/youtube-capa-texto-benchmark.ts [--medicao F] [--json]
 *   # conferir se a medição cobre todas as capas de uma coleta
 *   npx tsx scripts/youtube-capa-texto-benchmark.ts --medicao F --benchmark data/youtube-capa-benchmark/{data}/benchmark.json
 *   # esqueleto para uma rodada nova (texto vazio, a preencher lendo thumbs/{id}.jpg)
 *   npx tsx scripts/youtube-capa-texto-benchmark.ts --benchmark B --esqueleto OUT.json
 *
 * Exit: 0 ok; 1 medição inválida ou incompleta frente ao `--benchmark`;
 * 2 uso inválido ou arquivo ausente.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findUnknownFlags, isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import {
  groupStats,
  modeloDivergences,
  proprioSummary,
  renderMarkdown,
  suggestCapaTextoModelo,
  validateMedicao,
  withinChannel,
  type CapaTextoEntry,
  type CapaTextoMedicao,
} from "./lib/diaria/youtube-capa-texto-benchmark.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MEASUREMENTS = join(ROOT, "docs", "measurements");
const PREFIX = "youtube-capa-texto-benchmark-";
const KNOWN_FLAGS = ["medicao", "benchmark", "esqueleto", "json", "help"] as const;

interface BenchVideo { id: string; title: string; views: number; ratio: number }
interface BenchChannel { handle: string; lang: "pt" | "en"; status: string; ranking?: { outliers: BenchVideo[]; typical: BenchVideo[] } }

/** Pure: as capas (acima da média + típicas) de um `benchmark.json`. */
export function benchmarkCapas(bench: { channels?: BenchChannel[] }): Omit<CapaTextoEntry, "texto" | "modelo" | "diz_assunto" | "visual">[] {
  const out: Omit<CapaTextoEntry, "texto" | "modelo" | "diz_assunto" | "visual">[] = [];
  for (const c of bench.channels ?? []) {
    if (c.status !== "ok" || !c.ranking) continue;
    for (const [grupo, list] of [["acima", c.ranking.outliers], ["tipico", c.ranking.typical]] as const) {
      for (const v of list) out.push({ id: v.id, canal: c.handle, lang: c.lang, grupo, ratio: Math.round(v.ratio * 100) / 100, views: v.views, titulo: v.title });
    }
  }
  return out;
}

/** Pure: ids da coleta sem transcrição na medição. */
export function missingFromMedicao(medicao: CapaTextoMedicao, bench: { channels?: BenchChannel[] }): string[] {
  const have = new Set(medicao.capas.map((c) => `${c.canal}:${c.id}`));
  return benchmarkCapas(bench).filter((c) => !have.has(`${c.canal}:${c.id}`)).map((c) => `${c.canal} ${c.id} (${c.grupo})`);
}

function latestMedicao(): string | null {
  if (!existsSync(MEASUREMENTS)) return null;
  const files = readdirSync(MEASUREMENTS).filter((f) => f.startsWith(PREFIX) && f.endsWith(".json")).sort();
  return files.length ? join(MEASUREMENTS, files[files.length - 1]) : null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const unknown = findUnknownFlags(argv, KNOWN_FLAGS);
  const args = parseArgs(argv);
  if (unknown.length || args.flags.has("help")) {
    console.error(unknown.length ? `flag desconhecida: ${unknown.join(", ")}` : "");
    console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    return unknown.length ? 2 : 0;
  }
  const benchPath = args.values["benchmark"];
  if (benchPath && !existsSync(benchPath)) {
    console.error(`--benchmark não encontrado: ${benchPath}`);
    return 2;
  }

  const esqueleto = args.values["esqueleto"];
  if (esqueleto) {
    if (!benchPath) {
      console.error("--esqueleto precisa de --benchmark");
      return 2;
    }
    const bench = readJson(benchPath) as { generated_at?: string; channels?: BenchChannel[] };
    const capas = benchmarkCapas(bench).map((c) => ({ ...c, texto: "", modelo: "sem-texto", diz_assunto: false, visual: "nenhum" }));
    const out = {
      schema_version: 1,
      coleta: (bench.generated_at ?? "").slice(0, 10),
      nota: "Esqueleto: preencher texto, modelo, diz_assunto e visual lendo thumbs/{id}.jpg da coleta. modelo sem-texto só com texto vazio.",
      capas,
    };
    writeFileSync(esqueleto, `${JSON.stringify(out, null, 2)}\n`);
    console.log(JSON.stringify({ path: esqueleto, capas: capas.length }));
    return 0;
  }

  const medPath = args.values["medicao"] ?? latestMedicao();
  if (!medPath || !existsSync(medPath)) {
    console.error(`medição não encontrada: ${medPath ?? `${MEASUREMENTS}/${PREFIX}*.json`}`);
    return 2;
  }
  const raw = readJson(medPath);
  const errs = validateMedicao(raw);
  if (errs.length) {
    console.error(`medição inválida (${medPath}):\n  ${errs.join("\n  ")}`);
    return 1;
  }
  const med = raw as CapaTextoMedicao;
  let status = 0;
  if (benchPath) {
    const missing = missingFromMedicao(med, readJson(benchPath) as { channels?: BenchChannel[] });
    if (missing.length) {
      console.error(`${missing.length} capa(s) da coleta sem transcrição:\n  ${missing.join("\n  ")}`);
      status = 1;
    }
  }
  const div = modeloDivergences(med.capas);
  if (div.length) {
    console.error(`[aviso] ${div.length} capa(s) com modelo diferente da heurística (o gravado vale):`);
    for (const d of div) console.error(`  ${d.id} "${d.texto}": gravado ${d.gravado}, heurística ${d.sugerido}`);
  }
  if (args.flags.has("json")) {
    const up = med.capas.filter((c) => c.grupo === "acima");
    const ty = med.capas.filter((c) => c.grupo === "tipico");
    console.log(JSON.stringify({
      medicao: medPath,
      acima: groupStats(up),
      tipicas: groupStats(ty),
      dentro_do_canal: withinChannel(med.capas, ["diz_assunto", "nomeia", "repete", "complementa", "protagonista", "assunto-literal", "pergunta", "citacao", "enigma", "veredito"]),
      canal_proprio: med.canal_proprio ? proprioSummary(med.canal_proprio) : null,
      sem_heuristica: med.capas.filter((c) => suggestCapaTextoModelo(c.texto) === null).length,
    }, null, 2));
  } else {
    console.log(renderMarkdown(med));
  }
  return status;
}

if (isMainModule(import.meta.url)) void runCli(main);
