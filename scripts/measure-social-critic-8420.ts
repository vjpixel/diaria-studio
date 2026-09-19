/**
 * measure-social-critic-8420.ts — medição 7b do epic #8412 (issue #8420)
 *
 * Mede se o Jev (1 `noul` por padrão da skill `humanizador`) bateria ou
 * superaria o `social-critic` (Sonnet, holístico) na detecção de tiques de
 * texto gerado por IA em parágrafos de `03-social.md`.
 *
 * Redução assumida (documentada, permitida pela issue #8420 — "pode ser um
 * subconjunto representativo se 27 perguntas por parágrafo for caro
 * demais"): em vez das ~27 categorias do catálogo (`~/.claude/skills/
 * humanizador/SKILL.md`, fora deste repo — pessoal, obrigatória por
 * `docs/setup.md`), esta medição cobre 8 padrões representativos, um por
 * família do catálogo: inflação de importância, abertura cenográfica,
 * fechamento genérico, metáfora de jornada, gerúndio em cascata, negação
 * paralela/antítese, regra de três, travessão excessivo.
 *
 * Não há shadow-mode histórico do `social-critic` no corpus
 * (`social_critic_pass.enabled` é `false` por padrão e nenhuma edição do
 * corpus gravou `_internal/social-critic.json`) — não existe um "palpite do
 * mecanismo atual" já registrado em disco pra comparar, ao contrário das
 * medições 1/4/título-picker. O gabarito aqui é rótulo cego feito por quem
 * roda a medição (ver #8420, "rotulados por você às cegas"), gravado em
 * `labels.json` ANTES de consultar o Jev.
 *
 * Estado em `data/jev-eval/social-critic-8420/`:
 *   - `sample.json` — pool amostrado (--generate) — parágrafos de `## d1`/
 *     `## d2`/`## d3`/`## post_pixel` da seção `# Social` de `03-social.md`
 *     (nunca `# Curto`, que não é escopo do `social-critic`)
 *   - `labels.json` — `{ patterns: string[], positives: { [idx]: string[] } }`
 *     — rótulo cego, preenchido manualmente ANTES de --eval
 *   - `eval-rows.json` — output de --eval, 1 linha por (parágrafo, padrão)
 *
 * Uso:
 *   npx tsx scripts/measure-social-critic-8420.ts --generate [--n 50]
 *   # preencher labels.json manualmente, às cegas (sem ver a saída do Jev)
 *   npx tsx scripts/measure-social-critic-8420.ts --eval
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getIntArg, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { askJevBatch, type JevNoulAnswer } from "./lib/jev.ts";

const ROOT = resolve(import.meta.dirname, "..");
const FEATURE_DIR = join(ROOT, "data", "jev-eval", "social-critic-8420");
const SAMPLE_PATH = join(FEATURE_DIR, "sample.json");
const LABELS_PATH = join(FEATURE_DIR, "labels.json");
const ROWS_PATH = join(FEATURE_DIR, "eval-rows.json");

export const PATTERNS = [
  "inflacao_importancia",
  "abertura_cenografica",
  "fechamento_generico",
  "metafora_jornada",
  "gerundio_cascata",
  "negacao_paralela",
  "regra_de_tres",
  "travessao_excessivo",
] as const;

export const PATTERN_INSTRUCTIONS: Record<string, string> = {
  inflacao_importancia:
    "Este trecho de texto em português usa vocabulário de inflação de importância — palavras como 'marco', 'divisor de águas', " +
    "'momento crucial', 'ponto de inflexão', 'papel fundamental/central/essencial', 'representa um passo importante', " +
    "'transformador', 'revolucionário', 'histórico' — para fazer um fato arbitrário soar mais significativo do que é.",
  abertura_cenografica:
    "Este trecho abre descrevendo um 'cenário' genérico antes de entrar no fato concreto — frases como 'No mundo atual', " +
    "'Na era digital', 'Em um cenário cada vez mais', 'Vivemos em tempos de', 'Nos dias de hoje', antes do fato real.",
  fechamento_generico:
    "Este trecho fecha com uma frase que só reembala o que já foi dito sem acrescentar nada novo — 'Em suma', 'Em conclusão', " +
    "'Por fim', 'Diante do exposto', 'Vale a pena refletir', 'Fica claro que', 'o futuro é promissor'.",
  metafora_jornada:
    "Este trecho usa metáforas de jornada/exploração para soar inspirador — 'desbravar', 'mergulhar fundo', 'navegar pela', " +
    "'embarcar nesta jornada', 'nossa jornada', 'universo da inovação'.",
  gerundio_cascata:
    "Este trecho encadeia várias orações em gerúndio em sequência para dar falsa profundidade — ex: '...garantindo X, " +
    "proporcionando Y, possibilitando Z, refletindo W'. Só conta se houver DUAS OU MAIS orações em gerúndio encadeadas — " +
    "um único gerúndio isolado não conta.",
  negacao_paralela:
    "Este trecho usa uma construção de negação paralela ou antítese fácil — 'não apenas X, mas também Y', 'não só X como " +
    "também Y', 'não se trata apenas de... mas de...', ou uma antítese do tipo 'é no X que se ganha Y' / 'não X, Y'.",
  regra_de_tres:
    "Este trecho força uma lista de exatamente três itens (substantivos, adjetivos ou orações) lado a lado para parecer " +
    "abrangente ou impactante — ex: 'inovação, eficiência e excelência', ou três orações/verbos em sequência com o mesmo " +
    "propósito retórico.",
  travessao_excessivo:
    "Este trecho usa travessão (—) de forma viciosa — no lugar de dois-pontos antes de definição, em par envolvendo aposto " +
    "curto que caberia em vírgulas, como remate enfático no fim da frase, ou mais de um travessão no mesmo parágrafo. " +
    "NÃO conta: travessão em diálogo, ou um único travessão usado como pausa leve isolada.",
};

function stableRank(id: string): number {
  return parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16);
}

interface Para { id: string; edition: string; section: string; text: string }

/**
 * Extrai os parágrafos elegíveis (`## d1`/`## d2`/`## d3`/`## post_pixel` da
 * seção `# Social`, nunca `# Curto` — fora do escopo do `social-critic`) de
 * UM `03-social.md`. Pura — sem I/O — pra ser testável sem fixture em disco.
 */
export function extractSocialParagraphs(md: string, edition: string): Para[] {
  const pool: Para[] = [];

  const socialStart = md.indexOf("# Social");
  if (socialStart === -1) return pool;
  const curtoStart = md.indexOf("\n# Curto");
  const socialBlock = curtoStart === -1 ? md.slice(socialStart) : md.slice(socialStart, curtoStart);

  const sectionRe = /^##\s+(d1|d2|d3|post_pixel)\s*$/gm;
  const matches = [...socialBlock.matchAll(sectionRe)];
  for (let i = 0; i < matches.length; i++) {
    const section = matches[i][1];
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : socialBlock.length;
    const body = socialBlock.slice(start, end);
    const paragraphs = body.split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
    paragraphs.forEach((text, idx) => {
      if (/^(#\w+\s*)+$/.test(text)) return; // pure hashtag line
      if (text.includes("{") || text.includes("}")) return; // unresolved template placeholder
      if (text.length < 120) return; // too short to carry a pattern meaningfully
      if (/^É IA\?/.test(text)) return; // poll boilerplate
      if (/CC BY-SA|Wikimedia|wikidata\.org/.test(text)) return; // photo credit captions, not editorial prose
      pool.push({ id: `${edition}:${section}:${idx}`, edition, section, text });
    });
  }
  return pool;
}

function collectPool(): { pool: Para[]; editionsWithSocial: number } {
  const editionsRoot = join(ROOT, "data", "editions");
  const dirs = enumerateEditionDirs(editionsRoot);
  const pool: Para[] = [];

  for (const [edition, dir] of dirs) {
    const p = join(dir, "03-social.md");
    if (!existsSync(p)) continue;
    let md: string;
    try { md = readFileSync(p, "utf8"); } catch { continue; }
    pool.push(...extractSocialParagraphs(md, edition));
  }
  return { pool, editionsWithSocial: new Set(pool.map((p) => p.edition)).size };
}

function cmdGenerate(n: number) {
  const { pool, editionsWithSocial } = collectPool();
  console.log(`pool total: ${pool.length} parágrafos, ${editionsWithSocial} edições com 03-social.md legível`);
  pool.sort((a, b) => stableRank(a.id) - stableRank(b.id));
  const sample = pool.slice(0, n);
  writeFileSync(SAMPLE_PATH, JSON.stringify(sample, null, 2));
  console.log(`amostra: ${sample.length} — wrote ${SAMPLE_PATH}`);
  console.log(`\nPróximo passo: rotular ÀS CEGAS em ${LABELS_PATH} (formato:`);
  console.log(`  { "patterns": [...${PATTERNS.length} padrões...], "positives": { "<idx>": ["<padrão>", ...] } }`);
  console.log(`) — sem consultar o Jev antes — depois rodar --eval.`);
}

async function cmdEval() {
  if (!existsSync(SAMPLE_PATH)) { console.error(`rode --generate primeiro (${SAMPLE_PATH} ausente)`); process.exit(2); }
  if (!existsSync(LABELS_PATH)) { console.error(`${LABELS_PATH} ausente — rotule às cegas antes de --eval`); process.exit(2); }

  loadProjectEnv(ROOT);
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) { console.error("TYPESAFE_API_KEY ausente"); process.exit(2); }

  const sample: Para[] = JSON.parse(readFileSync(SAMPLE_PATH, "utf8"));
  const labelData = JSON.parse(readFileSync(LABELS_PATH, "utf8")) as { patterns: string[]; positives: Record<string, string[]> };
  const patterns = labelData.patterns;
  const positives = labelData.positives;

  const cacheDir = join(FEATURE_DIR, "cache");
  const items = sample.map((item, idx) => ({
    id: String(idx),
    state: { text: item.text },
    questions: patterns.map((p) => ({ id: p, type: "noul" as const, instructions: PATTERN_INSTRUCTIONS[p] })),
    cacheKey: `social-critic-8420:${item.id}`,
  }));

  const { results, errors } = await askJevBatch(items, { apiKey, cacheDir });
  if (errors.size > 0) {
    console.error(`${errors.size} falha(s) de transporte:`);
    for (const [id, e] of errors) console.error(`  ${id}: ${e instanceof Error ? e.message : e}`);
  }
  const byId = new Map(results.map((r) => [r.id, r.answers]));

  interface Row {
    idx: number; id: string; pattern: string; label: boolean;
    jevProb: number | null; jevConfidence: number | null; jevGuess: boolean | null;
  }

  const rows: Row[] = [];
  for (let idx = 0; idx < sample.length; idx++) {
    const answers = byId.get(String(idx)) ?? [];
    const answersByPattern = new Map(answers.map((a) => [a.id, a as JevNoulAnswer]));
    const truePatterns = new Set(positives[String(idx)] ?? []);
    for (const p of patterns) {
      const ans = answersByPattern.get(p);
      rows.push({
        idx, id: sample[idx].id, pattern: p, label: truePatterns.has(p),
        jevProb: ans?.probability ?? null, jevConfidence: ans?.confidence ?? null,
        jevGuess: ans ? ans.probability >= 0.5 : null,
      });
    }
  }

  writeFileSync(ROWS_PATH, JSON.stringify(rows, null, 2));

  const withJev = rows.filter((r) => r.jevGuess !== null);
  const positiveLabels = rows.filter((r) => r.label).length;
  const jevTP = withJev.filter((r) => r.label && r.jevGuess).length;
  const jevFP = withJev.filter((r) => !r.label && r.jevGuess).length;
  const jevFN = withJev.filter((r) => r.label && !r.jevGuess).length;
  const jevTN = withJev.filter((r) => !r.label && !r.jevGuess).length;
  const jevCorrect = jevTP + jevTN;

  console.log(`\n=== social-critic (#8420) — n_paragrafos=${sample.length}, n_perguntas=${withJev.length}, positivos_reais=${positiveLabels} ===`);
  console.log(`Jev acerto geral (todas as (parágrafo,padrão)): ${jevCorrect}/${withJev.length} (${((jevCorrect / withJev.length) * 100).toFixed(1)}%)`);
  console.log(`  TP=${jevTP} FP=${jevFP} FN=${jevFN} TN=${jevTN}`);
  console.log(`  precisão=${jevTP + jevFP > 0 ? ((jevTP / (jevTP + jevFP)) * 100).toFixed(1) + "%" : "n/a (0 positivos previstos)"}`);
  console.log(`  recall=${positiveLabels > 0 ? ((jevTP / positiveLabels) * 100).toFixed(1) + "%" : "n/a"}`);
  console.log(`  falso-positivo rate=${jevFP + jevTN > 0 ? ((jevFP / (jevFP + jevTN)) * 100).toFixed(2) + "%" : "n/a"} (${jevFP}/${jevFP + jevTN})`);

  console.log(`\nPor padrão:`);
  for (const p of patterns) {
    const pr = rows.filter((r) => r.pattern === p && r.jevGuess !== null);
    const pos = pr.filter((r) => r.label).length;
    const tp = pr.filter((r) => r.label && r.jevGuess).length;
    const fp = pr.filter((r) => !r.label && r.jevGuess).length;
    console.log(`  ${p.padEnd(22)} positivos_reais=${pos} Jev_TP=${tp} Jev_FP=${fp} (n=${pr.length})`);
  }

  console.log(`\nCurva confiança x acerto (Jev, todas as (parágrafo,padrão)):`);
  for (let i = 0; i < 5; i++) {
    const lo = i * 0.2, hi = i === 4 ? 1.0001 : (i + 1) * 0.2;
    const inb = withJev.filter((r) => r.jevConfidence !== null && r.jevConfidence >= lo && r.jevConfidence < hi);
    const correct = inb.filter((r) => r.jevGuess === r.label).length;
    console.log(`  [${lo.toFixed(1)},${hi === 1.0001 ? "1.0" : hi.toFixed(1)}) n=${inb.length} acerto=${inb.length ? ((correct / inb.length) * 100).toFixed(1) + "%" : "—"}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--generate")) {
    cmdGenerate(getIntArg(argv, "n", { min: 1 }) ?? 50);
  } else if (argv.includes("--eval")) {
    await cmdEval();
  } else {
    console.error("uso: npx tsx scripts/measure-social-critic-8420.ts --generate [--n 50] | --eval");
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
