#!/usr/bin/env npx tsx
/**
 * collect-annual.ts (#7569) — Etapa 1a da `/diaria-anual`.
 *
 * Monta o insumo da retrospectiva anual: resolve a janela, varre as edições
 * DIÁRIAS publicadas nela e extrai os destaques de cada uma, agrupados por
 * mês.
 *
 * ## Fonte: sempre as diárias (decisão do editor, 07/09/2026)
 *
 * Os digests mensais **não** entram — nem como fonte, nem como contexto. A
 * janela da 1ª rodada (ago/2025–ago/2026) tem digest mensal em só 5 dos 13
 * meses; usar o mensal onde ele existe daria uma entrada desigual ao
 * analista (meses já espremidos em 3 temas competindo com meses crus). Um
 * caminho só, granularidade igual.
 *
 * ## Precedência de leitura, por edição
 *
 *   1. `data/editions/{AAMMDD}/02-reviewed.md` — o markdown final que o
 *      pipeline publicou. Fonte canônica quando existe (mesma precedência do
 *      `collect-monthly.ts`, #2791).
 *   2. `content.free.web` do cache de edições (`edition-cache-reader.ts`,
 *      Beehiiv + Kit) convertido pra pseudo-markdown por
 *      `convertBeehiivHtmlToMarkdown`.
 *
 * Na prática a 1ª rodada usa (2) pra tudo antes de abril/2026 — `data/editions/`
 * local só tem edição a partir daí, e as de 2025 só existem no cache Beehiiv.
 *
 * ## A armadilha das edições importadas
 *
 * As primeiras edições (a partir de 27/08/2025) foram importadas em bloco
 * pra Beehiiv em 04/09/2025 e carregam a data da IMPORTAÇÃO em
 * `publish_date`. Datar por ele joga agosto/2025 inteiro dentro de setembro
 * e faz o projeto parecer ter começado em 03/09. Este script data por
 * `editorialDate()` (`displayed_date ?? publish_date`) — nunca mexer nisso
 * sem ler `UnifiedCachedPost.displayed_date`.
 *
 * Uso:
 *   npx tsx scripts/collect-annual.ts --tipo aniversario --desde 2508 --ate 2608
 *   npx tsx scripts/collect-annual.ts --tipo janeiro
 *   npx tsx scripts/collect-annual.ts --tipo aniversario --top-k 12
 *   npx tsx scripts/collect-annual.ts --tipo aniversario --allow-empty-month
 *
 * Output (stdout): JSON com o resumo por mês. Os arquivos vão pra
 * `data/annual/{AAAA}-{tipo}/_internal/`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { loadUnifiedEditionCache, type UnifiedCachedPost } from "./lib/shared/edition-cache-reader.ts";
import { convertBeehiivHtmlToMarkdown } from "./lib/shared/edition-html-convert.ts";
import { parseLegacyEditionHtml } from "./lib/shared/legacy-edition-parse.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import {
  resolveAnnualWindow,
  type AnnualWindow,
} from "./lib/anual/annual-window.ts";
import { annualSlugFor, annualPaths } from "./lib/anual/annual-paths.ts";
import { annualCounts, type AnnualCounts } from "./lib/anual/annual-counts.ts";
import {
  groupPostsByMonth,
  postEdition,
  editionMonth,
  topKPerMonth,
  dedupDestaquesByUrl,
  unscoredCount,
  type AnnualDestaque,
  type AnnualMonthReport,
  type AnnualMonthSource,
} from "./lib/anual/annual-collect.ts";
// Parsers de destaque: importados do script da mensal de propósito. Eles não
// têm nada de mensal (leem o pseudo-markdown de UMA edição diária), mas vivem
// lá desde #2791 e movê-los pra `lib/shared/` mexeria em `collect-monthly.ts`
// — que esta unidade se comprometeu a não tocar (#7569, "a anual é aditiva").
// A fronteira de `test/lib-boundary.test.ts` cobre `scripts/lib/**`, não
// script→script, então isto é legal; duplicar o parser (e deixar os dois
// divergirem no 1º ajuste de formato) seria pior.
import { parsePost, parseLocalEdition, detectBrazil } from "./collect-monthly.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TOP_K = 10;

export interface CollectAnnualResult {
  slug: string;
  window: { tipo: string; desde: string; ate: string; months: number; label: string };
  editions_found: number;
  destaques_found: number;
  months: AnnualMonthReport[];
  /**
   * Publicações do período, para o bloco de aniversário — **escopadas à
   * janela**, não contagem cumulativa de diretório (ver `annual-counts.ts`).
   * Sai daqui, e não de um `readdirSync` na skill, justamente porque é aqui
   * que a janela existe.
   */
  counts: AnnualCounts;
  warnings: string[];
}

/** Extrai os destaques de UMA edição, com a precedência documentada acima. */
export function destaquesForPost(
  post: UnifiedCachedPost,
  edition: string,
  localEditionDirs: Map<string, string>,
  warnings: string[],
): { destaques: AnnualDestaque[]; source: AnnualMonthSource } {
  const month = editionMonth(edition);
  const toAnnual = (list: ReturnType<typeof parseLocalEdition>): AnnualDestaque[] =>
    list.map((d) => ({
      edition,
      month,
      position: d.position,
      category: d.category,
      title: d.title,
      url: d.url,
      body: d.body,
      why: d.why,
      is_brazil: d.is_brazil,
    }));

  // (1) markdown final publicado, quando a máquina tem a edição em disco.
  const localDir = localEditionDirs.get(edition);
  if (localDir) {
    const reviewed = join(localDir, "02-reviewed.md");
    if (existsSync(reviewed)) {
      const parsed = parseLocalEdition(edition, readFileSync(reviewed, "utf8"));
      if (parsed.length > 0) return { destaques: toAnnual(parsed), source: "edicoes-locais" };
      warnings.push(`${edition}: 02-reviewed.md presente mas sem destaque parseável — caindo pro cache`);
    }
  }

  // (2) HTML do cache. Dois formatos convivem na janela de 12-13 meses: o
  // layout ATUAL (título como link markdown, `##### CATEGORIA`) e o ANTIGO
  // (título em texto puro, URL no `[Aprofunde]` do fim) — a transição foi
  // gradual, ~fev–abr/2026, sem um dia de corte. Por isso a escolha é por
  // RENDIMENTO, não por data: o parser atual roda primeiro e, quando entrega
  // os 3 destaques esperados, fecha o caso; qualquer resultado abaixo disso
  // faz o legado rodar também, e fica quem extraiu mais. Um corte por data
  // seria uma linha inventada, e erraria nas edições de transição.
  const html = post.content?.free?.web ?? post.content?.free?.email;
  if (!html) {
    warnings.push(`${edition}: sem conteúdo no cache (content.free ausente) — edição ignorada`);
    return { destaques: [], source: "vazio" };
  }

  const quiet: string[] = []; // warnings do parser perdedor não interessam
  const converted = convertBeehiivHtmlToMarkdown(html, edition);
  const modern = parsePost(
    { path: `<cache:${edition}>`, filename: `${edition}.html`, beehiiv_post_id: post.slug ?? edition, edition },
    converted.markdown,
    quiet,
  );

  if (modern.length >= 3) return { destaques: toAnnual(modern), source: "cache-html" };

  const legacy = parseLegacyEditionHtml(html, edition);
  if (legacy.destaques.length > modern.length) {
    const asAnnual: AnnualDestaque[] = legacy.destaques.map((d) => {
      const brazil = detectBrazil({ category: d.category, url: d.url, title: d.title, body: d.body });
      return {
        edition,
        month,
        position: d.position,
        category: d.category,
        title: d.title,
        url: d.url,
        body: d.body,
        why: d.why,
        is_brazil: brazil.is_brazil,
      };
    });
    return { destaques: asAnnual, source: "cache-html-legado" };
  }

  if (modern.length === 0) {
    warnings.push(`${edition}: nenhum destaque extraído — nem no formato atual nem no antigo`);
  } else {
    warnings.push(`${edition}: só ${modern.length} destaque(s) extraído(s) (esperado 3)`);
  }
  return { destaques: toAnnual(modern), source: "cache-html" };
}

/**
 * Fonte predominante de um mês — o que o relatório do gate mostra. Moda
 * simples, com desempate por ordem de preferência (a fonte mais confiável
 * primeiro), pra o rótulo não oscilar entre execuções num mês empatado.
 */
export function dominantSource(sources: readonly AnnualMonthSource[]): AnnualMonthSource {
  const real = sources.filter((s) => s !== "vazio");
  if (real.length === 0) return "vazio";
  const ranked: AnnualMonthSource[] = ["edicoes-locais", "cache-html", "cache-html-legado"];
  let best: AnnualMonthSource = ranked[0];
  let bestCount = -1;
  for (const candidate of ranked) {
    const count = real.filter((s) => s === candidate).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function collectAnnual(opts: {
  window: AnnualWindow;
  posts: readonly UnifiedCachedPost[];
  localEditionDirs: Map<string, string>;
}): { destaques: AnnualDestaque[]; months: AnnualMonthReport[]; warnings: string[] } {
  const warnings: string[] = [];
  const byMonth = groupPostsByMonth(opts.posts, opts.window.months);
  const all: AnnualDestaque[] = [];
  const months: AnnualMonthReport[] = [];

  for (const month of opts.window.months) {
    const posts = byMonth.get(month) ?? [];
    const monthWarnings: string[] = [];
    const sources: AnnualMonthSource[] = [];
    let found = 0;

    for (const post of posts) {
      const edition = postEdition(post);
      if (!edition) continue;
      // Isolamento por edição, mesmo padrão que `loadBeehiivCache` usa por
      // arquivo: uma edição com encoding estranho ou markdown inesperado não
      // pode derrubar a coleta dos outros 12 meses. Perder uma edição é um
      // aviso; perder a janela inteira é recomeçar do zero.
      try {
        const { destaques, source } = destaquesForPost(post, edition, opts.localEditionDirs, monthWarnings);
        sources.push(source);
        found += destaques.length;
        all.push(...destaques);
      } catch (err) {
        monthWarnings.push(`${edition}: falha ao extrair destaques (${(err as Error).message}) — edição pulada`);
        sources.push("vazio");
      }
    }

    if (posts.length === 0) {
      monthWarnings.push(`nenhuma edição publicada encontrada em ${month} — mês entra vazio na retrospectiva`);
    }

    months.push({
      month,
      source: dominantSource(sources),
      editions_found: posts.length,
      destaques_found: found,
      destaques_selected: 0, // preenchido depois do top-K (Etapa 1b)
      warnings: monthWarnings,
    });
    warnings.push(...monthWarnings.map((w) => `${month}: ${w}`));
  }

  return { destaques: all, months, warnings };
}

/**
 * Modo `--select-top-k`: lê o pool já pontuado e grava a seleção que vai pro
 * analista. É um passo SEPARADO da coleta de propósito — entre um e outro
 * roda o `scorer-monthly`, e refazer a coleta só pra aplicar o corte
 * descartaria os scores.
 *
 * O pool (`raw-destaques.json`) nunca é sobrescrito: a seleção vai pra um
 * arquivo próprio. Assim, mudar o K é re-rodar este passo, não a coleta
 * inteira nem o scoring.
 */
export function selectTopK(rootDir: string, slug: string, topK: number): { selected: number; byMonth: Record<string, number> } {
  const paths = annualPaths(slug, resolve(rootDir, "data/annual"));
  if (!existsSync(paths.rawDestaques)) {
    throw new Error(
      `--select-top-k precisa do pool coletado, e ${paths.rawDestaques} não existe. ` +
        `Rode a coleta primeiro (sem --select-top-k).`,
    );
  }
  const pool = JSON.parse(readFileSync(paths.rawDestaques, "utf8")) as {
    window: unknown;
    destaques: AnnualDestaque[];
  };

  const missing = unscoredCount(pool.destaques);
  if (missing > 0) {
    process.stderr.write(
      `[collect-annual] aviso: ${missing} destaque(s) sem score — rode o scorer-monthly antes, ` +
        `senão o corte vira ordem de leitura, não mérito.\n`,
    );
  }

  const deduped = dedupDestaquesByUrl(pool.destaques);
  const selected = topKPerMonth(deduped, topK);
  const byMonth: Record<string, number> = {};
  for (const d of selected) byMonth[d.month] = (byMonth[d.month] ?? 0) + 1;

  writeFileSync(
    paths.selected,
    JSON.stringify(
      {
        slug,
        window: pool.window,
        generated_at: new Date().toISOString(),
        top_k_per_month: topK,
        destaques_count: selected.length,
        destaques: selected,
      },
      null,
      2,
    ),
  );
  return { selected: selected.length, byMonth };
}

export function main(argv: string[] = process.argv.slice(2), rootDir: string = ROOT): CollectAnnualResult {
  const args = parseCliArgs(argv);
  const window = resolveAnnualWindow({
    tipo: args.values.tipo,
    desde: args.values.desde,
    ate: args.values.ate,
  });
  // Precedência: --top-k > platform.config.json → annual.top_k_per_month >
  // constante. O config existe pro editor mexer sem editar código; a
  // constante é só a rede de segurança pra um config incompleto.
  const configTopK = (() => {
    try {
      const cfg = JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8"));
      return typeof cfg.annual?.top_k_per_month === "number" ? cfg.annual.top_k_per_month : undefined;
    } catch (err) {
      // Chave ausente é normal (cai no default). Config ilegível não é — e
      // `platform.config.json` é lido pelo pipeline inteiro, então engolir
      // isso aqui esconde um problema que não é desta unidade.
      process.stderr.write(
        `[collect-annual] aviso: não consegui ler platform.config.json (${(err as Error).message}) — ` +
          `usando top-K default ${DEFAULT_TOP_K}.\n`,
      );
      return undefined;
    }
  })();
  const topK = args.values["top-k"] ? Number(args.values["top-k"]) : (configTopK ?? DEFAULT_TOP_K);
  if (!Number.isInteger(topK) || topK < 1) {
    throw new Error(`--top-k inválido: ${args.values["top-k"]} — precisa ser inteiro >= 1`);
  }

  const allowEmptyMonth = args.flags.has("allow-empty-month");
  const slug = annualSlugFor(window);
  const paths = annualPaths(slug, resolve(rootDir, "data/annual"));
  const log = (msg: string) => process.stderr.write(`[collect-annual] ${msg}\n`);

  // Passo SEPARADO da coleta: aplicar o top-K sobre o pool já pontuado. Entre
  // um e outro roda o `scorer-monthly` — recoletar aqui descartaria os scores.
  if (args.flags.has("select-top-k")) {
    const r = selectTopK(rootDir, slug, topK);
    log(`seleção: ${r.selected} destaques (top-${topK} por mês) → ${paths.selected}`);
    const report = JSON.parse(readFileSync(paths.collectReport, "utf8")) as CollectAnnualResult;
    for (const m of report.months) m.destaques_selected = r.byMonth[m.month] ?? 0;
    writeFileSync(paths.collectReport, JSON.stringify(report, null, 2));
    return report;
  }

  for (const w of window.warnings) log(`aviso: ${w}`);
  log(`janela: ${window.label} (${window.months.length} meses) — tipo ${window.tipo}, dir ${slug}`);

  const posts = loadUnifiedEditionCache();
  const localEditionDirs = enumerateEditionDirs(resolve(rootDir, "data/editions"));
  const { destaques, months, warnings } = collectAnnual({ window, posts, localEditionDirs });

  mkdirSync(paths.internal, { recursive: true });
  writeFileSync(
    paths.rawDestaques,
    JSON.stringify(
      {
        slug,
        window: { tipo: window.tipo, desde: window.desde, ate: window.ate, label: window.label, months: window.months },
        generated_at: new Date().toISOString(),
        top_k_per_month: topK,
        destaques_count: destaques.length,
        destaques,
      },
      null,
      2,
    ),
  );

  const result: CollectAnnualResult = {
    slug,
    window: {
      tipo: window.tipo,
      desde: window.desde,
      ate: window.ate,
      months: window.months.length,
      label: window.label,
    },
    editions_found: months.reduce((n, m) => n + m.editions_found, 0),
    destaques_found: destaques.length,
    months,
    counts: annualCounts({
      monthlyBase: resolve(rootDir, "data/monthly"),
      specialBase: resolve(rootDir, "data/artigo-especial"),
      months: window.months,
      edicoesDiarias: months.reduce((n, m) => n + m.editions_found, 0),
    }),
    warnings: [...window.warnings, ...warnings],
  };
  writeFileSync(paths.collectReport, JSON.stringify(result, null, 2));

  log(`${result.editions_found} edições, ${result.destaques_found} destaques → ${paths.rawDestaques}`);

  // Todo aviso vai pro stderr, não só pro JSON. Um relatório de 13 meses tem
  // dezenas de linhas; contar com "alguém abre e lê o arquivo" é como não
  // avisar (a instrução em prosa da skill não é um gate).
  for (const w of warnings) log(`aviso: ${w}`);

  // Mês vazio é o modo de falha central desta coleta: a retrospectiva sai com
  // um buraco e ninguém percebe, porque o texto continua sendo escrito
  // normalmente sobre os meses que sobraram. Por isso é BARULHENTO e, por
  // padrão, faz o passo falhar — a causa quase sempre é cache faltando ou um
  // formato de edição que nenhum dos parsers reconhece, e as duas têm
  // conserto. `--allow-empty-month` é a válvula para o caso legítimo (janela
  // que atravessa um mês em que a newsletter de fato não publicou).
  const empty = months.filter((m) => m.destaques_found === 0);
  if (empty.length > 0) {
    log(
      `MESES SEM NENHUM DESTAQUE: ${empty.map((m) => m.month).join(", ")} — ` +
        `a retrospectiva sairia com buraco nesse(s) período(s).`,
    );
    if (!allowEmptyMonth) {
      throw new Error(
        `${empty.length} mês(es) sem destaque (${empty.map((m) => m.month).join(", ")}). ` +
          `Confira o cache de edições e os parsers antes de seguir, ou passe --allow-empty-month ` +
          `se a newsletter realmente não publicou nesse período.`,
      );
    }
    log("--allow-empty-month passado — seguindo mesmo assim.");
  }

  return result;
}

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(main(), null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`[collect-annual] ERRO: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

