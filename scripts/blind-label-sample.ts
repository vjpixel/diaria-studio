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
 * RÓTULO DADO NUNCA SE PERDE (#8206 review, finding 1). O rótulo do editor é
 * caro e insubstituível, e `data/editions/` cresce todo dia — então uma
 * re-geração não pode derrubar trabalho já feito. Duas defesas:
 *
 *   1. `selectByThreshold` inclui incondicionalmente todo URL já rotulado,
 *      mesmo fora do corte de hash.
 *   2. `generate` ABORTA sem gravar se, ainda assim, algum rótulo sumiria.
 *
 * O que NÃO é prometido: estabilidade da amostra NÃO rotulada. O corte é
 * derivado do número de candidatos para render ~`quota`, então item sem
 * rótulo pode entrar/sair entre rodadas. Custa nada — ninguém o olhou ainda.
 *
 * A versão original desta ferramenta usava top-K com quota proporcional ao
 * pool INTEIRO: o crescimento de OUTRO bucket encolhia a quota deste e cortava
 * a cauda do conjunto anterior, rótulos incluídos, em silêncio.
 *
 * Uso:
 *   npx tsx scripts/blind-label-sample.ts --generate 60
 *   npx tsx scripts/blind-label-sample.ts --next 4
 *   npx tsx scripts/blind-label-sample.ts --record <url> <bucket>
 *   npx tsx scripts/blind-label-sample.ts --report
 *
 * Estado em `data/bucket-blind-labels.json` (gitignored junto com data/).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { categorizeWithRule, categoryToBucket, type Bucket } from "./lib/launch-heuristics.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { parseArgs, getIntArg, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(import.meta.dirname, "..");
const STATE = join(ROOT, "data", "bucket-blind-labels.json");

/**
 * Escopo deliberado: os 3 buckets editoriais ambíguos da #5995. `video` fica
 * de fora porque `isVideoUrl` decide por URL (YouTube/Vimeo) antes de qualquer
 * heurística — não é a fricção que esta issue mede, e nenhum item de `video`
 * entra no pool. Por isso `label` NÃO usa `Bucket` (que inclui `video`): o tipo
 * declara exatamente o que `--record` aceita (#8206 review, finding 7).
 */
const BUCKETS = ["lancamento", "radar", "use_melhor"] as const;
type TrackedBucket = (typeof BUCKETS)[number];
type Label = TrackedBucket | "nao_pertence";

const MAX_RANK = 0xffffffff;

export interface Sampled {
  url: string;
  title: string;
  source: string;
  summary: string;
  edition: string;
  /** Palpite do categorizador — NUNCA mostrado ao editor antes do rótulo. */
  hidden_guess: Bucket;
  hidden_rule: string;
  /** Bucket que saiu na edição (== hidden_guess, por construção: é silêncio). */
  hidden_shipped: TrackedBucket;
  label?: Label;
  labeled_at?: string;
}

interface State {
  generated_at: string;
  items: Sampled[];
}

/**
 * `data/` é uma junction do OneDrive criada por máquina (CLAUDE.md §2b) e não
 * existe em clone fresco nem no CI. Sem esta checagem, `generate` varria zero
 * edições, salvava uma amostra vazia e saía com código 0 — "sucesso" que um
 * chamador automatizado não distingue de "não há item sem rótulo"
 * (#8206 review, finding 3).
 */
function requireCorpus(): string {
  const editions = join(ROOT, "data", "editions");
  if (!existsSync(editions)) {
    console.error(
      `data/editions/ ausente em ${ROOT}.\n` +
        `Esta máquina não tem o corpus montado (sessão cloud, clone fresco).\n` +
        `Crie a junction do OneDrive antes de rodar — ver CLAUDE.md passo 2b.`,
    );
    process.exit(2);
  }
  return editions;
}

/** Ordem determinística por hash do URL — estável entre rodadas e máquinas. */
export function stableRank(url: string): number {
  return parseInt(createHash("sha256").update(url).digest("hex").slice(0, 8), 16);
}

/**
 * Corte no espaço de hash que rende ~`target` itens de um bucket com
 * `bucketSize` candidatos. Proporcional ao PRÓPRIO bucket, nunca ao pool —
 * é isso que torna a amostra aditiva sob crescimento do corpus.
 * Piso de `MIN_PER_BUCKET` para que bucket raro ainda renda precisão própria.
 */
export const MIN_PER_BUCKET = 8;

export function bucketQuota(bucketSize: number, poolSize: number, target: number): number {
  if (bucketSize <= 0 || poolSize <= 0 || !Number.isFinite(target) || target <= 0) return 0;
  const proportional = Math.round((bucketSize / poolSize) * target);
  return Math.min(Math.max(MIN_PER_BUCKET, proportional), bucketSize);
}

/**
 * Seleção por limiar: devolve os itens cujo `stableRank` cai abaixo do corte,
 * MAIS todo item já rotulado (que nunca sai da amostra, mesmo fora do corte).
 *
 * Invariante que isto garante e o top-K não garantia: o conjunto devolvido por
 * uma segunda chamada com um pool MAIOR é um superconjunto do trabalho já
 * rotulado na primeira.
 */
export function selectByThreshold(
  candidates: Sampled[],
  quota: number,
  alreadyLabeled: ReadonlySet<string>,
): Sampled[] {
  if (candidates.length === 0) return [];
  const cutoff = quota >= candidates.length
    ? MAX_RANK
    : Math.floor((quota / candidates.length) * MAX_RANK);
  const picked = candidates.filter(
    (c) => stableRank(c.url) <= cutoff || alreadyLabeled.has(c.url),
  );
  return picked.sort((a, b) => stableRank(a.url) - stableRank(b.url));
}

/** Itens do SILÊNCIO: presentes no categorizado E no aprovado, no MESMO bucket. */
function collectUntouched(editionsRoot: string): { pool: Sampled[]; skipped: string[] } {
  const pool: Sampled[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>(); // #8206 review, finding 10: URL duplicada entra 1x
  for (const [edition, dir] of enumerateEditionDirs(editionsRoot)) {
    const pa = join(dir, "_internal", "01-approved.json");
    const pc = join(dir, "_internal", "01-categorized.json");
    if (!existsSync(pa) || !existsSync(pc)) continue;
    let A: Record<string, unknown>;
    let C: Record<string, unknown>;
    try {
      A = JSON.parse(readFileSync(pa, "utf8"));
      C = JSON.parse(readFileSync(pc, "utf8"));
    } catch (e) {
      // #8206 review, finding 9: edição ilegível sai do pool, mas nunca em
      // silêncio — quem lê o --report precisa saber se o corpus veio completo.
      skipped.push(`${edition} (${e instanceof Error ? e.message.slice(0, 60) : "JSON inválido"})`);
      continue;
    }
    const catOf = (url: string): TrackedBucket | null => {
      for (const b of BUCKETS) for (const a of ((C[b] as any[]) ?? [])) if (a?.url === url) return b;
      return null;
    };
    for (const b of BUCKETS) for (const a of ((A[b] as any[]) ?? [])) {
      if (!a?.url || !a?.title) continue;
      if (seen.has(a.url)) continue;
      if (catOf(a.url) !== b) continue; // moveu → é decisão, não silêncio
      seen.add(a.url);
      const r = categorizeWithRule(a);
      pool.push({
        url: a.url,
        title: a.title,
        source: String(a.source ?? ""),
        summary: String(a.summary ?? "").slice(0, 300),
        edition,
        hidden_guess: categoryToBucket(r.category),
        hidden_rule: r.rule,
        hidden_shipped: b,
      });
    }
  }
  return { pool, skipped };
}

function load(): State | null {
  if (!existsSync(STATE)) return null;
  return JSON.parse(readFileSync(STATE, "utf8"));
}

function save(s: State) {
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

function generate(n: number) {
  const editionsRoot = requireCorpus();
  const { pool, skipped } = collectUntouched(editionsRoot);
  const prev = load();
  const priorLabels = new Map<string, Sampled>(
    (prev?.items ?? []).filter((i) => i.label).map((i) => [i.url, i]),
  );
  const labeledUrls = new Set(priorLabels.keys());

  const picked: Sampled[] = [];
  for (const b of BUCKETS) {
    const candidates = pool.filter((p) => p.hidden_shipped === b);
    const quota = bucketQuota(candidates.length, pool.length, n);
    picked.push(...selectByThreshold(candidates, quota, labeledUrls));
  }
  for (const p of picked) {
    const d = priorLabels.get(p.url);
    if (d) {
      p.label = d.label;
      p.labeled_at = d.labeled_at;
    }
  }

  // Guard do invariante aditivo: nenhum rótulo pago pode sumir numa re-geração.
  const keptUrls = new Set(picked.map((p) => p.url));
  const lost = [...labeledUrls].filter((u) => !keptUrls.has(u));
  if (lost.length > 0) {
    console.error(`ABORTADO: ${lost.length} item(ns) já rotulado(s) sairiam da amostra.`);
    for (const u of lost) console.error(`  ${u}`);
    console.error(`Nada foi gravado — o estado anterior segue intacto em ${STATE}.`);
    process.exit(1);
  }

  save({ generated_at: new Date().toISOString(), items: picked });
  console.log(`pool de silêncio: ${pool.length} itens`);
  console.log(`amostra: ${picked.length} (${labeledUrls.size} já rotulados, preservados)`);
  for (const b of BUCKETS) console.log(`  ${b.padEnd(11)} ${picked.filter((p) => p.hidden_shipped === b).length}`);
  if (skipped.length) {
    console.warn(`\n${skipped.length} edição(ões) ilegível(is), fora do pool:`);
    for (const s of skipped) console.warn(`  ${s}`);
  }
  console.log(`\nestado → ${STATE}`);
}

function next(k: number) {
  const s = load();
  if (!s) { console.error("rode --generate primeiro"); process.exit(2); }
  const todo = s.items.filter((i) => !i.label).slice(0, k);
  // Saída SEM o palpite — é isso que garante a cegueira.
  console.log(JSON.stringify(
    todo.map((i) => ({ url: i.url, title: i.title, source: i.source, summary: i.summary, edition: i.edition })),
    null, 2,
  ));
  console.error(`\n${s.items.filter((i) => i.label).length}/${s.items.length} rotulados`);
}

function record(url: string, label: string) {
  const s = load();
  if (!s) { console.error("rode --generate primeiro"); process.exit(2); }
  const it = s.items.find((i) => i.url === url);
  if (!it) { console.error(`url não está na amostra: ${url}`); process.exit(2); }
  if (!([...BUCKETS, "nao_pertence"] as string[]).includes(label)) {
    console.error(`bucket inválido: ${label} (aceitos: ${[...BUCKETS, "nao_pertence"].join(", ")})`);
    process.exit(2);
  }
  it.label = label as Label;
  it.labeled_at = new Date().toISOString();
  save(s);
  console.log(`ok ${label} ← ${it.title.slice(0, 60)}`);
}

function report() {
  const s = load();
  if (!s) { console.error("rode --generate primeiro"); process.exit(2); }
  const done = s.items.filter((i) => i.label && i.label !== "nao_pertence");
  if (!done.length) { console.log("nenhum rótulo ainda"); return; }
  const agree = done.filter((i) => i.hidden_guess === i.label).length;
  console.log(`GABARITO LIMPO (n=${done.length} de ${s.items.length})`);
  console.log(`  categorizador acerta: ${agree}/${done.length} (${(agree / done.length * 100).toFixed(1)}%)`);
  console.log(`  [referência suja — acordo com o silêncio: 100% por construção]`);
  console.log(`\n  discordâncias (categorizador → editor):`);
  const dir = new Map<string, number>();
  for (const i of done) if (i.hidden_guess !== i.label) {
    const k = `${i.hidden_guess} → ${i.label}`;
    dir.set(k, (dir.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...dir].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${v}`);
  for (const i of done) if (i.hidden_guess !== i.label) {
    console.log(`    · ${i.hidden_guess} → ${i.label} [${i.hidden_rule}] ${i.title.slice(0, 62)}`);
  }
}

/**
 * `parseArgs` classifica `--generate 60` como VALUE e `--generate` sozinho como
 * FLAG — então "o comando foi pedido?" é a união dos dois, e só depois
 * `getIntArg` decide o número (lançando em `--generate abc`, em vez de deixar
 * `NaN` virar amostra vazia em silêncio, que era o bug do #8206 finding 4).
 */
function asked(parsed: ReturnType<typeof parseArgs>, key: string): boolean {
  return parsed.flags.has(key) || parsed.values[key] !== undefined;
}

function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (asked(parsed, "generate")) {
    generate(getIntArg(argv, "generate", { min: 1 }) ?? 60);
  } else if (asked(parsed, "next")) {
    next(getIntArg(argv, "next", { min: 1 }) ?? 4);
  } else if (asked(parsed, "record")) {
    const i = argv.indexOf("--record");
    const [url, bucket] = [argv[i + 1], argv[i + 2]];
    if (!url || !bucket) {
      console.error("uso: --record <url> <bucket>");
      process.exit(2);
    }
    record(url, bucket);
  } else if (asked(parsed, "report")) {
    report();
  } else {
    console.error("uso: --generate N | --next K | --record <url> <bucket> | --report");
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    // getIntArg lança com mensagem própria em `--generate abc`/`--generate=""`.
    // Stack trace crua aqui não ajuda ninguém — a mensagem já diz o que fazer.
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
