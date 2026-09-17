/**
 * blind-label-sample.ts (#5995)
 *
 * Gabarito LIMPO por rotulagem às cegas. O `01-approved.json` que a #5995 usa
 * como referência é SILÊNCIO, não escolha: dos ~3.5k pares, só 87 são movimento
 * deliberado do editor; o resto é o bucket do categorizador passando pelo gate
 * sem ser contestado — concordância genuína e item que passou batido são
 * indistinguíveis ali.
 *
 * Consequência prática (medida em 17/09): o guard anti-regressão da issue não
 * consegue APROVAR correção em território de silêncio — uma regra que conserta
 * um item que o editor nunca olhou aparece como regressão, porque a referência
 * é a omissão. Sem gabarito limpo, nem o 91,4% de acerto atual nem o alvo
 * `71 → ≤35` do item 5 são interpretáveis.
 *
 * Este script sorteia itens do SILÊNCIO (categorizado == aprovado, ou seja,
 * nunca tocados), esconde o palpite do categorizador, e registra o rótulo que
 * o editor dá do zero.
 *
 * Amostragem determinística (hash do URL, sem RNG) — a mesma chamada devolve
 * sempre a mesma amostra, e re-rodar `--generate` não embaralha o que já foi
 * rotulado.
 *
 * Uso:
 *   npx tsx scripts/experiments/blind-label-sample.ts --generate 60
 *   npx tsx scripts/experiments/blind-label-sample.ts --next 4
 *   npx tsx scripts/experiments/blind-label-sample.ts --record <url> <bucket>
 *   npx tsx scripts/experiments/blind-label-sample.ts --report
 *
 * Estado em `data/bucket-blind-labels.json` (gitignored junto com data/).
 */

import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { categorizeWithRule, categoryToBucket, type Bucket } from "./lib/launch-heuristics.ts";

const ROOT = resolve(import.meta.dirname, "..");
const STATE = join(ROOT, "data", "bucket-blind-labels.json");
const BUCKETS: readonly Bucket[] = ["lancamento", "radar", "use_melhor"];

interface Sampled {
  url: string;
  title: string;
  source: string;
  summary: string;
  edition: string;
  /** Palpite do categorizador — NUNCA mostrado ao editor antes do rótulo. */
  hidden_guess: Bucket;
  hidden_rule: string;
  /** Bucket que saiu na edição (== hidden_guess, por construção: é silêncio). */
  hidden_shipped: Bucket;
  label?: Bucket | "nao_pertence";
  labeled_at?: string;
}

interface State { generated_at: string; items: Sampled[] }

function editionDirs(): string[] {
  const root = join(ROOT, "data", "editions");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith("replay-")) continue;
    if (/^\d{6}$/.test(e.name)) out.push(join(root, e.name));
    else if (/^\d{4}$/.test(e.name)) {
      for (const s of readdirSync(join(root, e.name), { withFileTypes: true }))
        if (s.isDirectory() && /^\d{6}$/.test(s.name)) out.push(join(root, e.name, s.name));
    }
  }
  return out.sort();
}

/** Itens do SILÊNCIO: presentes no categorizado E no aprovado, no MESMO bucket. */
function collectUntouched(): Sampled[] {
  const out: Sampled[] = [];
  for (const dir of editionDirs()) {
    const pa = join(dir, "_internal", "01-approved.json");
    const pc = join(dir, "_internal", "01-categorized.json");
    if (!existsSync(pa) || !existsSync(pc)) continue;
    let A: any, C: any;
    try { A = JSON.parse(readFileSync(pa, "utf8")); C = JSON.parse(readFileSync(pc, "utf8")); } catch { continue; }
    const catOf = (url: string): Bucket | null => {
      for (const b of BUCKETS) for (const a of (C[b] ?? [])) if (a.url === url) return b;
      return null;
    };
    for (const b of BUCKETS) for (const a of (A[b] ?? [])) {
      if (!a?.url || !a?.title) continue;
      if (catOf(a.url) !== b) continue; // moveu → é decisão, não silêncio
      const r = categorizeWithRule(a);
      out.push({
        url: a.url, title: a.title,
        source: String(a.source ?? ""), summary: String(a.summary ?? "").slice(0, 300),
        edition: dir.split(/[\\/]/).pop()!,
        hidden_guess: categoryToBucket(r.category), hidden_rule: r.rule, hidden_shipped: b,
      });
    }
  }
  return out;
}

/** Ordem determinística por hash do URL — estável entre rodadas. */
export function stableRank(url: string): number {
  return parseInt(createHash("sha256").update(url).digest("hex").slice(0, 8), 16);
}

function load(): State | null {
  if (!existsSync(STATE)) return null;
  return JSON.parse(readFileSync(STATE, "utf8"));
}
function save(s: State) { writeFileSync(STATE, JSON.stringify(s, null, 2)); }

/**
 * Quota por bucket: PROPORCIONAL ao corpus (estimativa global sem viés), com
 * piso de `MIN_PER_BUCKET` pra que bucket raro ainda renda precisão própria,
 * e teto no que existe (nunca pede mais itens do que o bucket tem).
 */
export const MIN_PER_BUCKET = 8;

export function bucketQuota(bucketSize: number, poolSize: number, target: number): number {
  if (bucketSize <= 0 || poolSize <= 0) return 0;
  const proportional = Math.round((bucketSize / poolSize) * target);
  return Math.min(Math.max(MIN_PER_BUCKET, proportional), bucketSize);
}

function generate(n: number) {
  const pool = collectUntouched();
  // Estratificado PROPORCIONAL ao corpus (estimativa de acerto global sem viés),
  // com piso de 8 por bucket pra ter precisão por bucket também.
  const byBucket = new Map<Bucket, Sampled[]>();
  for (const b of BUCKETS) byBucket.set(b, pool.filter((p) => p.hidden_shipped === b).sort((x, y) => stableRank(x.url) - stableRank(y.url)));
  const picked: Sampled[] = [];
  for (const b of BUCKETS) {
    const arr = byBucket.get(b)!;
    picked.push(...arr.slice(0, bucketQuota(arr.length, pool.length, n)));
  }
  const prev = load();
  if (prev) { // preserva rótulos já dados
    const done = new Map(prev.items.filter((i) => i.label).map((i) => [i.url, i]));
    for (const p of picked) { const d = done.get(p.url); if (d) { p.label = d.label; p.labeled_at = d.labeled_at; } }
  }
  save({ generated_at: new Date().toISOString(), items: picked });
  console.log(`pool de silêncio: ${pool.length} itens`);
  console.log(`amostra: ${picked.length}`);
  for (const b of BUCKETS) console.log(`  ${b.padEnd(11)} ${picked.filter((p) => p.hidden_shipped === b).length}`);
  console.log(`\nestado → ${STATE}`);
}

function next(k: number) {
  const s = load(); if (!s) { console.error("rode --generate primeiro"); process.exit(2); }
  const todo = s.items.filter((i) => !i.label).slice(0, k);
  // Saída SEM o palpite — é isso que garante a cegueira.
  console.log(JSON.stringify(todo.map((i) => ({ url: i.url, title: i.title, source: i.source, summary: i.summary, edition: i.edition })), null, 2));
  console.error(`\n${s.items.filter((i) => i.label).length}/${s.items.length} rotulados`);
}

function record(url: string, label: string) {
  const s = load(); if (!s) { console.error("rode --generate primeiro"); process.exit(2); }
  const it = s.items.find((i) => i.url === url);
  if (!it) { console.error(`url não está na amostra: ${url}`); process.exit(2); }
  if (!([...BUCKETS, "nao_pertence"] as string[]).includes(label)) { console.error(`bucket inválido: ${label}`); process.exit(2); }
  it.label = label as Sampled["label"]; it.labeled_at = new Date().toISOString();
  save(s);
  console.log(`ok ${label} ← ${it.title.slice(0, 60)}`);
}

function report() {
  const s = load(); if (!s) { console.error("rode --generate primeiro"); process.exit(2); }
  const done = s.items.filter((i) => i.label && i.label !== "nao_pertence");
  if (!done.length) { console.log("nenhum rótulo ainda"); return; }
  const agree = done.filter((i) => i.hidden_guess === i.label).length;
  console.log(`GABARITO LIMPO (n=${done.length} de ${s.items.length})`);
  console.log(`  categorizador acerta: ${agree}/${done.length} (${(agree / done.length * 100).toFixed(1)}%)`);
  console.log(`  [referência suja — acordo com o silêncio: 100% por construção]`);
  console.log(`\n  discordâncias (categorizador → editor):`);
  const dir = new Map<string, number>();
  for (const i of done) if (i.hidden_guess !== i.label) dir.set(`${i.hidden_guess} → ${i.label}`, (dir.get(`${i.hidden_guess} → ${i.label}`) ?? 0) + 1);
  for (const [k, v] of [...dir].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${v}`);
  for (const i of done) if (i.hidden_guess !== i.label) console.log(`    · ${i.hidden_guess} → ${i.label} [${i.hidden_rule}] ${i.title.slice(0, 62)}`);
}

const a = process.argv.slice(2);
const gi = a.indexOf("--generate"), ni = a.indexOf("--next"), ri = a.indexOf("--record");
if (gi >= 0) generate(Number(a[gi + 1] ?? 60));
else if (ni >= 0) next(Number(a[ni + 1] ?? 4));
else if (ri >= 0) record(a[ri + 1], a[ri + 2]);
else if (a.includes("--report")) report();
else console.error("uso: --generate N | --next K | --record <url> <bucket> | --report");
