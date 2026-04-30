/**
 * Coleta os ~90 destaques de todas as edições publicadas em um mês.
 *
 * Entrada: arquivos `.txt` em `data/monthly/{YYMM}/raw-posts/`, gerados pelo
 * agent `collect-monthly-runner` que busca via Beehiiv MCP. Cada arquivo
 * contém o markdown bruto de uma edição publicada (formato `get_post_content`):
 * seções separadas por linhas de traços (`-` repetidos), com `##### CATEGORIA`
 * + `# [Título](url)` por destaque.
 *
 * Output: `data/monthly/{YYMM}/raw-destaques.json` com todos os destaques do
 * mês + metadata estruturada pro `analyst-monthly` agrupar por tema.
 *
 * Brasil detection: `category === "BRASIL"` é sinal forte (decisão editorial
 * do scorer diário). Reforçado por host (`.br` + lista BR_HOSTS) e palavras-
 * chave no título/body com word boundary (evita false-positives de tokens
 * curtos como `stf`, `cade` casando dentro de palavras maiores).
 *
 * Uso:
 *   npx tsx scripts/collect-monthly.ts <YYMM>
 *
 * Ex: `npx tsx scripts/collect-monthly.ts 2604` para abril 2026.
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MONTHLY_DIR = resolve(ROOT, "data/monthly");

interface MonthlyDestaque {
  edition: string;          // AAMMDD (extraída do nome do arquivo)
  beehiiv_post_id: string;  // prefixo do ID do post no Beehiiv
  position: 1 | 2 | 3;      // ordem na edição original
  category: string;         // ex: "BRASIL", "GEOPOLÍTICA", "INSTABILIDADE"
  title: string;
  url: string;
  body: string;             // corpo do destaque (excluindo "View image:" / "Caption:")
  why: string;              // texto após "Por que isso importa:"
  is_brazil: boolean;
  brazil_signals: string[]; // motivos da flag (category, host, keyword)
}

interface MonthlyOutput {
  yymm: string;
  generated_at: string;
  editions_count: number;
  destaques_count: number;
  destaques: MonthlyDestaque[];
  warnings: string[];
}

// ── Brasil detection ────────────────────────────────────────────────

const BR_HOSTS = [
  "g1.globo.com",
  "globo.com",
  "uol.com.br",
  "folha.uol.com.br",
  "folha.com.br",
  "estadao.com.br",
  "valor.globo.com",
  "valoreconomico.com.br",
  "cnnbrasil.com.br",
  "correio24horas.com.br",
  "nexojornal.com.br",
  "veja.abril.com.br",
  "exame.com",
  "infomoney.com.br",
  "tecnoblog.net",
  "olhardigital.com.br",
  "akitaonrails.com",
];

// Keywords em ASCII — `stripAccents` no haystack normaliza `Itaú`/`Brasília`/etc.
// pra `Itau`/`Brasilia`, evitando precisar duplicar entradas com/sem acento.
const BR_KEYWORDS = [
  "brasil",
  "brasileiro",
  "brasileira",
  "lula",
  "anpd",
  "lgpd",
  "anatel",
  "abdi",
  "tse",
  "stf",
  "cade",
  "itau",
  "bradesco",
  "petrobras",
  "embraer",
  "nubank",
  "stone",
  "magazine luiza",
  "brasilia",
];

// Combining marks regex (U+0300..U+036F) construído via codePoint pra evitar
// que chars não-imprimíveis sumam em copy/paste, encoding switch, etc.
const COMBINING_MARKS_RE = new RegExp(
  `[${String.fromCodePoint(0x0300)}-${String.fromCodePoint(0x036f)}]`,
  "gu",
);

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(COMBINING_MARKS_RE, "");
}

export function detectBrazil(args: {
  category: string;
  url: string;
  title: string;
  body: string;
}): { is_brazil: boolean; signals: string[] } {
  const signals: string[] = [];

  // Sinal forte: categoria BRASIL é decisão editorial do scorer diário.
  if (stripAccents(args.category).trim().toUpperCase() === "BRASIL") {
    signals.push("category:BRASIL");
  }

  // Host (.br + lista curada)
  try {
    const host = new URL(args.url).hostname.replace(/^www\./, "");
    if (host.endsWith(".br")) signals.push(`host:${host}`);
    else if (BR_HOSTS.includes(host)) signals.push(`host:${host}`);
  } catch {
    // ignore malformed URL
  }

  // Keywords com word boundary + accent-strip (evita "lulav", "cadeira", "stfu"
  // casando, e cobre `Itaú`/`Brasília` via NFD-strip sem duplicar entradas).
  const haystack = stripAccents(`${args.title} ${args.body}`).toLowerCase();
  for (const kw of BR_KEYWORDS) {
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "u");
    if (re.test(haystack)) {
      signals.push(`kw:${kw}`);
      break; // um match já basta pra flagar
    }
  }

  return { is_brazil: signals.length > 0, signals };
}

// ── Raw post discovery ─────────────────────────────────────────────

interface RawPostFile {
  path: string;
  filename: string;
  beehiiv_post_id: string;
  edition: string; // AAMMDD
}

function listRawPosts(yymm: string): RawPostFile[] {
  const dir = join(MONTHLY_DIR, yymm, "raw-posts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^post_[a-f0-9]+_\d{6}\.txt$/i.test(name))
    .map((name) => {
      const m = name.match(/^post_([a-f0-9]+)_(\d{6})\.txt$/i);
      // m can't be null here because we filtered above, but TS doesn't know it.
      const [, id, ed] = m as RegExpMatchArray;
      return {
        path: join(dir, name),
        filename: name,
        beehiiv_post_id: id,
        edition: ed,
      };
    })
    .sort((a, b) => a.edition.localeCompare(b.edition));
}

// ── Parser ─────────────────────────────────────────────────────────

export function splitSections(raw: string): string[] {
  // Separadores são linhas com 10+ traços (cobrem `----------` e `--------------------`).
  return raw.split(/\r?\n-{10,}\r?\n/);
}

export function parsePost(file: RawPostFile, raw: string, warnings: string[]): MonthlyDestaque[] {
  const sections = splitSections(raw);
  const destaques: MonthlyDestaque[] = [];
  let totalMatched = 0;

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Estrutura de destaque = h5/h6 categoria (`##### {CAT}` ou `###### {CAT}`) + h1 com link
    // (`# [Título](url)`). Sections de lista (LANÇAMENTOS/PESQUISAS/OUTRAS NOTÍCIAS) usam
    // `**[...](url)**`, não h1 — caem fora naturalmente. É AI?/Sorteio/Encerrar idem.
    // Regex aceita 5 ou 6 hashes porque o formato Beehiiv usa `######` (h6) nas categorias reais
    // mas `#####` (h5) em "Por que isso importa:" — edições mais antigas usam apenas bold.
    const catMatch = trimmed.match(/^#{5,6} (.+?)\s*$/m);
    if (!catMatch) continue;
    // Limpar bold/italic do nome da categoria (ex: `**SEGURANÇA**` → `SEGURANÇA`)
    const category = catMatch[1].replace(/\*+/g, "").trim();

    const h1Match = trimmed.match(/^# \[(.+?)\]\((https?:\/\/[^\s)]+)\)\s*$/m);
    if (!h1Match) continue;
    const [h1Line, title, url] = h1Match;

    totalMatched++;

    // Capamos em 3, mas continuamos contando pra warning de "edição com 4+".
    if (destaques.length >= 3) continue;

    // Body = depois do h1, antes de "Por que isso importa:" (variantes h0/h3 + bold).
    const afterH1 = trimmed.substring(trimmed.indexOf(h1Line) + h1Line.length);
    const whyDelim = afterH1.match(/^#{0,3}\s*\*?\*?Por que isso importa:?\*?\*?\s*$/im);
    let bodyRaw: string;
    let whyRaw: string;
    if (whyDelim) {
      const idx = afterH1.indexOf(whyDelim[0]);
      bodyRaw = afterH1.substring(0, idx);
      whyRaw = afterH1.substring(idx + whyDelim[0].length);
    } else {
      bodyRaw = afterH1;
      whyRaw = "";
    }

    // Limpar `View image:` e `Caption:` que vêm antes do corpo.
    const body = bodyRaw
      .split(/\r?\n/)
      .filter((line) => !/^View image:/i.test(line.trim()))
      .filter((line) => !/^Caption:/i.test(line.trim()))
      .join("\n")
      .trim();
    const why = whyRaw.trim();

    const brazil = detectBrazil({ category, url, title, body });

    destaques.push({
      edition: file.edition,
      beehiiv_post_id: file.beehiiv_post_id,
      position: (destaques.length + 1) as 1 | 2 | 3,
      category,
      title,
      url,
      body,
      why,
      is_brazil: brazil.is_brazil,
      brazil_signals: brazil.signals,
    });
  }

  if (destaques.length === 0) {
    warnings.push(`${file.edition}: nenhum destaque parseado — verificar formato do post`);
  } else if (totalMatched > 3) {
    warnings.push(
      `${file.edition}: ${totalMatched} sections matched destaque pattern (esperado 3) — usando os 3 primeiros`,
    );
  } else if (destaques.length < 3) {
    warnings.push(`${file.edition}: parseou ${destaques.length} destaques (esperado 3)`);
  }

  return destaques;
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  const yymm = process.argv[2];
  if (!yymm) {
    console.error("Usage: npx tsx scripts/collect-monthly.ts <YYMM>");
    console.error("  Ex: npx tsx scripts/collect-monthly.ts 2604");
    process.exit(2);
  }
  if (!/^\d{4}$/.test(yymm)) {
    console.error(`YYMM inválido: ${yymm}. Formato esperado: YYMM (ex: 2604).`);
    process.exit(2);
  }

  const files = listRawPosts(yymm);
  if (files.length === 0) {
    console.error(
      `Nenhum raw-post encontrado em data/monthly/${yymm}/raw-posts/. ` +
        `Rode o agent collect-monthly-runner antes do script (ver SKILL.md Stage 1a).`,
    );
    process.exit(1);
  }

  const allDestaques: MonthlyDestaque[] = [];
  const warnings: string[] = [];

  for (const f of files) {
    const text = readFileSync(f.path, "utf8");
    const dest = parsePost(f, text, warnings);
    allDestaques.push(...dest);
  }

  const output: MonthlyOutput = {
    yymm,
    generated_at: new Date().toISOString(),
    editions_count: files.length,
    destaques_count: allDestaques.length,
    destaques: allDestaques,
    warnings,
  };

  const outDir = join(MONTHLY_DIR, yymm);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "raw-destaques.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");

  const brCount = allDestaques.filter((d) => d.is_brazil).length;
  console.log(
    `OK: ${allDestaques.length} destaques de ${files.length} edições (${brCount} marcados Brasil) → ${outPath}`,
  );
  if (warnings.length > 0) {
    console.log(`Warnings: ${warnings.length}`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
