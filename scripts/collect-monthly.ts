/**
 * Coleta os ~90 destaques de todas as edições publicadas em um mês.
 *
 * Entrada: arquivos `.txt` em `data/monthly/{ciclo}/raw-posts/`, gerados pelo
 * script `fetch-monthly-posts.ts` (ou via MCP Beehiiv). Cada arquivo
 * contém o markdown bruto de uma edição publicada (formato `get_post_content`):
 * seções separadas por linhas de traços (`-` repetidos), com `##### CATEGORIA`
 * + `# [Título](url)` por destaque.
 *
 * Output: `data/monthly/{ciclo}/_internal/raw-destaques.json` com todos os
 * destaques do mês + metadata estruturada pro `analyst-monthly` agrupar por tema.
 *
 * Brasil detection: `category === "BRASIL"` é sinal forte (decisão editorial
 * do scorer diário). Reforçado por host (`.br` + lista BR_HOSTS) e palavras-
 * chave no título/body com word boundary (evita false-positives de tokens
 * curtos como `stf`, `cade` casando dentro de palavras maiores).
 *
 * Uso (#1962 — novo):
 *   npx tsx scripts/collect-monthly.ts --cycle 2605-06
 *
 * Compat (legado — ainda aceito com aviso):
 *   npx tsx scripts/collect-monthly.ts 2604
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MONTHLY_BASE,
  monthlyDir as resolveMonthlyDir,
  cycleToYymm,
  parseMonthlyCycleArg,
} from "./lib/mensal/monthly-paths.ts";
import { parseEdition, normalizeHeader } from "./monthly-click-sections.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts"; // #2463/#3025: layout flat+nested

// Alias para compat com usos internos (path join na MONTHLY_BASE).
const MONTHLY_DIR = MONTHLY_BASE;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface MonthlyDestaque {
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

/**
 * Lista os raw-posts de um diretório mensal.
 * @param dirOrCycle path absoluto do diretório, ou identificador (ciclo/yymm)
 */
function listRawPosts(dirOrCycle: string): RawPostFile[] {
  // Se for um path absoluto (começa com drive letter ou /), usar direto.
  // Caso contrário, resolver via monthlyDir (aceita ciclo ou yymm).
  const dir = join(
    dirOrCycle.match(/^([a-zA-Z]:\\|\/|\\\\)/) ? dirOrCycle : resolveMonthlyDir(dirOrCycle),
    "raw-posts",
  );
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

// ── Modo local (#2791) ───────────────────────────────────────────────
//
// Fonte canônica: quando `data/editions/{AAMMDD}/02-reviewed.md` existe (o
// markdown final publicado, sempre disponível numa máquina local que rodou
// a edição), lê DIRETO dele em vez de depender do raw-post baixado do
// Beehiiv. Institucionaliza o workaround manual do ciclo 2606-07 (converter
// 02-reviewed.md pro formato raw-post antes de rodar este script).

/**
 * Separador usado no MARKDOWN FINAL publicado (`02-reviewed.md`): HR padrão
 * de 3 traços. Distinto do separador do raw-post do Beehiiv (10+ traços —
 * ver `splitSections` acima); um threshold único de 3 mudaria o
 * comportamento hoje testado de `splitSections` ("ignora linhas com menos
 * de 10 traços"), por isso este é um splitter dedicado.
 */
export function splitLocalSections(md: string): string[] {
  return md.split(/\r?\n-{3,}\r?\n/);
}

const LOCAL_DESTAQUE_HEADER_RE = /^\*\*DESTAQUE\s+(\d+)\s*\|\s*(.+?)\*\*\s*$/m;
const WHY_DELIM_RE = /^\*?\*?Por que isso importa:?\*?\*?\s*$/im;
const TITLE_LINK_LINE_RE = /^.*\[.+?\]\(https?:\/\/[^\s)]+\).*$/m;

/**
 * Parseia os destaques de um `02-reviewed.md` (markdown final publicado —
 * modo LOCAL, #2791). Reaproveita `parseEdition` (o parser DE VERDADE já
 * usado por `monthly-click-sections.ts` pra ler esse mesmo arquivo) pra
 * extrair título/url do destaque de forma robusta — cobre os formatos
 * antigo/novo de link e filtra links não-editoriais via `isEditorial`.
 * `parseEdition` não devolve corpo/why completos (só um resumo de 1
 * linha), então esses dois campos — e a categoria — são extraídos aqui, do
 * texto bruto do mesmo bloco (não duplica a lógica de `parseEdition`,
 * complementa o que ele não cobre).
 */
export function parseLocalEdition(edition: string, md: string): MonthlyDestaque[] {
  const destaques: MonthlyDestaque[] = [];

  for (const rawSection of splitLocalSections(md)) {
    const trimmed = rawSection.trim();
    if (!trimmed) continue;

    const headerMatch = trimmed.match(LOCAL_DESTAQUE_HEADER_RE);
    if (!headerMatch) continue; // não é um bloco de destaque (ex: intro, sorteio, É IA?)

    const position = parseInt(headerMatch[1], 10);
    if (position !== 1 && position !== 2 && position !== 3) continue;
    const category = normalizeHeader(headerMatch[2]);

    // parseEdition() de verdade, aplicado ao bloco isolado do destaque.
    const link = parseEdition(edition, trimmed).find((it) => it.section === "destaque");
    if (!link) continue;

    const afterHeader = trimmed.slice(trimmed.indexOf(headerMatch[0]) + headerMatch[0].length);
    const titleLineMatch = afterHeader.match(TITLE_LINK_LINE_RE);
    const afterTitle = titleLineMatch
      ? afterHeader.slice(afterHeader.indexOf(titleLineMatch[0]) + titleLineMatch[0].length)
      : afterHeader;

    const whyMatch = afterTitle.match(WHY_DELIM_RE);
    let bodyRaw: string;
    let whyRaw: string;
    if (whyMatch) {
      const idx = afterTitle.indexOf(whyMatch[0]);
      bodyRaw = afterTitle.slice(0, idx);
      whyRaw = afterTitle.slice(idx + whyMatch[0].length);
    } else {
      bodyRaw = afterTitle;
      whyRaw = "";
    }

    const body = bodyRaw
      .split(/\r?\n/)
      .filter((line) => !/^View image:/i.test(line.trim()))
      .filter((line) => !/^Caption:/i.test(line.trim()))
      .join("\n")
      .trim();
    const why = whyRaw.trim();

    const brazil = detectBrazil({ category, url: link.url, title: link.title, body });

    destaques.push({
      edition,
      // Modo local não tem o post_id do Beehiiv à mão (só existe no
      // filename do raw-post baixado via API). O campo não é consumido
      // programaticamente em nenhum lugar downstream (analyst-monthly /
      // writer-monthly só o exibem como referência) — vazio é seguro aqui.
      beehiiv_post_id: "",
      position: position as 1 | 2 | 3,
      category,
      title: link.title,
      url: link.url,
      body,
      why,
      is_brazil: brazil.is_brazil,
      brazil_signals: brazil.signals,
    });
  }

  return destaques;
}

export interface CollectMonthResult {
  destaques: MonthlyDestaque[];
  warnings: string[];
  source_counts: { local: number; raw: number; missing: number };
}

/**
 * Coleta os destaques do mês combinando as duas fontes, com precedência
 * LOCAL > raw-post (por edição — pode ser misto dentro do mesmo mês).
 *
 * @param yymm mês do conteúdo (ex: "2606")
 * @param rawPostsRoot diretório do ciclo mensal que contém `raw-posts/`
 *   (normalmente `resolveMonthlyDir(cycle)`; testável com um dir arbitrário)
 * @param editionsRoot diretório que contém `{AAMMDD}/02-reviewed.md`
 *   (normalmente `data/editions/`; testável com um dir arbitrário)
 */
export function collectMonth(
  yymm: string,
  rawPostsRoot: string,
  editionsRoot: string,
): CollectMonthResult {
  const warnings: string[] = [];
  const rawFiles = listRawPosts(rawPostsRoot);
  const rawByEdition = new Map(rawFiles.map((f) => [f.edition, f]));

  // #2463/#3025: enumera AMBOS os layouts (flat legado + nested novo) — antes
  // um `readdirSync(editionsRoot)` direto perdia edições no layout nested
  // pós-#3023.
  const localEditionRe = new RegExp(`^${yymm}\\d{2}$`);
  const editionDirsByAammdd = enumerateEditionDirs(editionsRoot);
  const localSet = new Set(
    [...editionDirsByAammdd.keys()].filter((n) => localEditionRe.test(n)),
  );

  const allEditions = [...new Set([...localSet, ...rawByEdition.keys()])].sort();

  const allDestaques: MonthlyDestaque[] = [];
  const source_counts = { local: 0, raw: 0, missing: 0 };

  for (const edition of allEditions) {
    const localEditionDir = editionDirsByAammdd.get(edition);
    const localPath = localEditionDir ? join(localEditionDir, "02-reviewed.md") : undefined;
    if (localSet.has(edition) && localPath && existsSync(localPath)) {
      const md = readFileSync(localPath, "utf8");
      const dest = parseLocalEdition(edition, md);
      // Paridade com parsePost (raw-post): avisa tanto no caso 0 quanto no
      // caso parcial (1-2 de 3 esperados) — sem isso, uma edição com só 1-2
      // blocos DESTAQUE N reconhecidos passava batido, sem warning.
      if (dest.length === 0) {
        warnings.push(
          `${edition}: 0 destaques via modo local (02-reviewed.md presente, mas nenhum bloco DESTAQUE N casou) — verificar formato`,
        );
      } else if (dest.length < 3) {
        warnings.push(
          `${edition}: parseou ${dest.length} destaques via modo local (esperado 3)`,
        );
      }
      allDestaques.push(...dest);
      source_counts.local++;
      continue;
    }

    const rawFile = rawByEdition.get(edition);
    if (rawFile) {
      const text = readFileSync(rawFile.path, "utf8");
      allDestaques.push(...parsePost(rawFile, text, warnings)); // parsePost já empurra warning em 0
      source_counts.raw++;
      continue;
    }

    // Diretório da edição existe em `editionsRoot` (ex: pipeline rodou o
    // Stage 1 mas não chegou no Stage 2), porém sem 02-reviewed.md — e sem
    // raw-post correspondente. Nunca falha silenciosa (#2794): warning
    // explícito, contribui 0 destaques, e o script segue normalmente.
    warnings.push(`${edition}: nem 02-reviewed.md local nem raw-post encontrado — 0 destaques`);
    source_counts.missing++;
  }

  return { destaques: allDestaques, warnings, source_counts };
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  // Aceita --cycle 2605-06 (novo) ou argumento posicional 2604 (legado compat).
  const cycle = parseMonthlyCycleArg(process.argv.slice(2));
  if (!cycle) {
    console.error(
      "Usage: npx tsx scripts/collect-monthly.ts --cycle YYMM-MM\n" +
      "  Ex:  npx tsx scripts/collect-monthly.ts --cycle 2605-06\n" +
      "Compat (com aviso): npx tsx scripts/collect-monthly.ts 2604",
    );
    process.exit(2);
  }

  // yymm é o mês do conteúdo (campo legado no output JSON)
  const yymm = cycleToYymm(cycle);
  // #2048 item 2: escrita sempre usa o formato novo — sem fallback legado.
  const editionDir = resolveMonthlyDir(cycle, { allowLegacyFallback: false });
  const editionsRoot = join(ROOT, "data", "editions");

  const result = collectMonth(yymm, editionDir, editionsRoot);
  const editionsProcessed = result.source_counts.local + result.source_counts.raw;
  if (editionsProcessed === 0) {
    console.error(
      `Nenhuma edição encontrada para ${yymm}: nem 02-reviewed.md em ${editionsRoot}/${yymm}XX/ (modo local, #2791), ` +
        `nem raw-post em ${editionDir}/raw-posts/. Rode fetch-monthly-posts.ts antes do script (ver SKILL.md Stage 1a) ` +
        `ou confira se as edições diárias do mês existem localmente.`,
    );
    process.exit(1);
  }

  const { destaques: allDestaques, warnings } = result;

  const output: MonthlyOutput = {
    yymm,
    generated_at: new Date().toISOString(),
    editions_count: editionsProcessed,
    destaques_count: allDestaques.length,
    destaques: allDestaques,
    warnings,
  };

  mkdirSync(editionDir, { recursive: true });
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  const outPath = join(editionDir, "_internal", "raw-destaques.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");

  const brCount = allDestaques.filter((d) => d.is_brazil).length;
  console.log(
    `OK: ${allDestaques.length} destaques de ${editionsProcessed} edições ` +
      `(local: ${result.source_counts.local}, raw: ${result.source_counts.raw}, ` +
      `${brCount} marcados Brasil) → ${outPath}`,
  );
  if (result.source_counts.missing > 0) {
    console.log(`${result.source_counts.missing} edição(ões) sem local nem raw-post (ver warnings).`);
  }
  if (warnings.length > 0) {
    console.log(`Warnings: ${warnings.length}`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
