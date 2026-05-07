/**
 * render-categorized-md.ts
 *
 * Renderiza `01-categorized.md` de forma determinística a partir do
 * `01-categorized.json` produzido pelo scorer + research-reviewer.
 *
 * Layout:
 *   ## Destaques          — candidatos do scorer (editor mantém 3, remove o resto)
 *   ## Lançamentos        — bucket lancamento
 *   ## Pesquisas          — bucket pesquisa
 *   ## Notícias           — bucket noticias
 *   ## Aprenda hoje       — bucket tutorial (#59)
 *
 * O editor escolhe destaques movendo linhas para/de a seção Destaques.
 * A ordem física dentro de Destaques define D1/D2/D3 (de cima para baixo).
 *
 * Uso:
 *   npx tsx scripts/render-categorized-md.ts \
 *     --in  data/editions/260421/01-categorized.json \
 *     --out data/editions/260421/01-categorized.md \
 *     --edition 260421 \
 *     [--source-health data/source-health.json]
 *
 * Se `--source-health` for passado, inclui a seção "Saúde das fontes" no
 * rodapé; caso contrário, omite a seção.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { parseSections, mergeWithNewJson } from "./apply-gate-edits.ts";
import { computeTotalConsidered as computeTotalConsideredLib } from "./lib/categorized-stats.ts";
import { countEditorSubmissions, formatCoverageLine, resolveEditorEmail } from "./lib/inbox-stats.ts";
import { readEiaAnswer } from "./lib/eia-answer.ts";

// #658 review: paths consistentes contra ROOT (não cwd) — caller invocando
// de outro diretório não quebra resolução de inbox.md / platform.config.json.
const ROOT = resolve(import.meta.dirname, "..");

// #650 Tier C: Article unificado em scripts/lib/types/article.ts.
// render-categorized-md.ts usa o tipo canônico — antes tinha shape duplicado
// que divergia em pequenos detalhes (rank, score, highlight, launch_candidate).
import type { Article } from "./lib/types/article.ts";

interface Highlight {
  /** URL flat (formato legado pré-#229). */
  url?: string;
  /** Article com URL nested (formato spec-compliant pós-#229). */
  article?: { url?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface CategorizedJson {
  highlights?: Highlight[];
  runners_up?: unknown[];
  lancamento: Article[];
  pesquisa: Article[];
  noticias: Article[];
  tutorial?: Article[];
  video?: Article[];
  /** Número total de artigos considerados antes da filtragem do scorer.
   * Injetado pelo orchestrator a partir de `_internal/tmp-categorized.json`
   * ou auto-descoberto pelo render script se ausente (#477). */
  total_considered?: number;
}

interface SourceHealth {
  sources: Record<
    string,
    {
      recent_outcomes?: Array<{ outcome: string; timestamp: string }>;
      last_outcome?: string;
      last_reason?: string;
    }
  >;
}

// ---------- CLI parsing --------------------------------------------------

function parseArgs(): {
  in: string;
  out: string;
  edition: string;
  sourceHealth?: string;
  inboxMd?: string;
} {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = args[i + 1];
      if (val == null || val.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = val;
        i++;
      }
    }
  }
  if (!flags.in || !flags.out || !flags.edition) {
    console.error(
      "Uso: render-categorized-md.ts --in <json> --out <md> --edition <YYMMDD> [--source-health <json>] [--inbox-md <path>]"
    );
    process.exit(1);
  }
  return {
    in: flags.in,
    out: flags.out,
    edition: flags.edition,
    sourceHealth: flags["source-health"],
    inboxMd: flags["inbox-md"],
  };
}

// ---------- Rendering helpers -------------------------------------------

/** Normaliza para YYYY-MM-DD aceitando `date` ou `published_at`. */
export function getDate(a: Article): string {
  const raw = a.date || a.published_at;
  if (!raw) return "????-??-??";
  // Se já vier ISO completo, cortar no T. Senão retornar como está.
  return raw.slice(0, 10);
}

/**
 * Detecta se o TEMA do artigo é sobre o Brasil (não apenas a fonte).
 * Heurística: título ou resumo menciona Brasil/brasileiro(a), entidades
 * brasileiras conhecidas (FGV, ANPD, CVM, Petrobras, Itaú, Anatel, BNDES,
 * USP, Unicamp, Fiesp, etc.), ou cidades/estados brasileiros de destaque.
 *
 * Conteúdo publicado em `.com.br` traduzindo notícia global NÃO recebe a
 * tag — o critério é editorial (o artigo é sobre o Brasil), não o domínio.
 */
/**
 * Tier 1: sinais de alta confiança — 1 match já dispara.
 * Inclui a palavra "Brasil" em si, governo/reguladores, estatais, cidades,
 * universidades públicas, indicadores, e entidades que contêm "brasil" no nome.
 */
export const BR_TIER1_RE =
  /\b(bras(il|ileir[ao]s?|ilienses?)|braz(il|ilians?)|fgv(\s+ibre)?|anpd|cvm|petrobras|bndes|anatel|banco central do brasil|bcb|santander brasil|latam\s+brasil|mec brasil|usp|unicamp|fiesp|ibge|ipea|s[ãa]o paulo|rio de janeiro|bras[íi]lia|inovabra|tribunal (superior|de justi[çc]a)|stf|congresso nacional)\b/i;

/**
 * Tier 2: empresas BR privadas — risco de falso positivo em cobertura
 * internacional. Só dispara com 2+ matches no mesmo artigo, OU com 1 match
 * combinado com algum sinal tier 1.
 *
 * Evitamos nomes curtos/ambíguos (Vale, Stone, WEG, JBS) por risco de
 * falso positivo com palavras comuns ou siglas não-BR.
 */
export const BR_TIER2_RE =
  /\b(ita[úu]|bradesco|nubank|ifood|mercado\s+livre|magalu|magazine\s+luiza|pagseguro|picpay|xp\s+inc|btg\s+pactual|banco\s+inter|c6\s+bank|embraer|gerdau|ambev|braskem|suzano|natura\s*&\s*co|localiza|vtex|totvs|movile|creditas|hotmart)\b/gi;

/**
 * Remove sufixos de atribuição de fonte do título antes de testar BR tier.
 * Ex: "Spotify e IA — BBC News Brasil" → "Spotify e IA" (#319).
 * Padrões: "— Fonte", "- Fonte", "| Fonte", "\ Fonte", ": Fonte".
 */
function stripSourceAttribution(title: string): string {
  return title
    .replace(/\s*[—\-|\\:]\s*[A-Z][^—\-|\\:\n]*$/, "")
    .trim();
}

export function isBrazilianTheme(article: { title?: string; summary?: string }): boolean {
  // Testar título sem o sufixo de fonte para evitar falso positivo de
  // "... — BBC News Brasil" ou "... | InfoMoney" (#319).
  const cleanTitle = stripSourceAttribution(article.title ?? "");
  const hay = `${cleanTitle}\n${article.summary ?? ""}`;
  if (BR_TIER1_RE.test(hay)) return true;
  // Tier 2: exige 2+ matches distintos pra reduzir falso positivo.
  // Reset lastIndex porque regex global mantém estado entre chamadas.
  BR_TIER2_RE.lastIndex = 0;
  const matches = hay.match(BR_TIER2_RE);
  return matches !== null && matches.length >= 2;
}

/**
 * Monta linha: `{N}. [score] Título ⭐|✨ 🇧🇷 [inbox] (descoberta) ⚠️ — https://url — YYYY-MM-DD`
 * Usa lista numerada pra facilitar referência no gate humano (#322).
 */
export function renderLine(
  article: Article,
  isHighlight?: boolean,
  isRunnerUp?: boolean,
  lineNumber?: number,
): string {
  const scoreStr =
    typeof article.score === "number" ? `[${article.score}]` : "[--]";
  const title = article.title?.trim() || "(sem título)";
  const url = article.url;
  const date = getDate(article);

  const markers: string[] = [];
  if (isHighlight) markers.push("⭐");
  else if (isRunnerUp) markers.push("✨");
  if (
    isBrazilianTheme({
      title: article.title,
      summary: typeof article.summary === "string" ? article.summary : undefined,
    })
  )
    markers.push("🇧🇷");
  if (article.editor_submitted) markers.push("[inbox]");
  if (article.discovered_source) markers.push("(descoberta)");
  if (article.date_unverified) markers.push("⚠️");
  if (article.new_in_pool) markers.push("🆕");
  // #778: marker visual quando verify-accessibility falhou pra URL editor_submitted.
  // Editor mandou o link de propósito — mostramos no gate com o motivo do bloqueio
  // em vez de dropar silenciosamente. Só aplica a editor_submitted; outros artigos
  // com verdict != accessible são removidos antes (per orchestrator spec 1i).
  if (article.editor_submitted && article.verify_verdict && article.verify_verdict !== "accessible") {
    const verdictMarkers: Record<string, string> = {
      paywall: "🔒",
      anti_bot: "🚫",
      blocked: "❌",
      error: "⏱️",
      uncertain: "❓",
      video: "📺",
      aggregator: "🔁",
    };
    const icon = verdictMarkers[article.verify_verdict] ?? "⚠️";
    const note = article.verify_note ? `: ${article.verify_note}` : "";
    markers.push(`${icon} (não checado: ${article.verify_verdict}${note})`);
  }
  // #658 review A: condição independe do flag — quando carry-over de inbox preserva
  // flag editor_submitted (boost +8 do categorizer), o marker ainda precisa aparecer.
  if (typeof article.carry_over_from === "string") {
    markers.push(`[carry-over de ${article.carry_over_from}]`);
  }
  if (article.launch_candidate && article.suggested_primary_domain) {
    // #487 — pista pra editor: provavelmente é lançamento, fonte oficial em outro domínio
    markers.push(`🚀→${article.suggested_primary_domain}`);
  }

  const markerStr = markers.length > 0 ? " " + markers.join(" ") : "";
  const prefix = lineNumber != null ? `${lineNumber}.` : "-";
  return `${prefix} ${scoreStr} ${title}${markerStr} — ${url} — ${date}`;
}

/**
 * Renderiza a seção Destaques a partir de `01-approved.json` (#585).
 *
 * Quando o editor aprova o gate, `apply-gate-edits.ts` extrai os destaques
 * selecionados pra `_internal/01-approved.json`. Re-renders subsequentes do
 * MD devem ler esse arquivo em vez de emitir o placeholder
 * "_(mova 3 artigos para cá)_" — que apagava a curadoria do editor toda vez
 * que o renderer rodava após apply-gate-edits.
 *
 * Retorna null se approved.json não existe ou está vazio (caller usa fallback).
 */
export function renderDestaquesFromApproved(
  approvedPath: string,
  highlightUrls: Set<string>,
  runnerUpUrls: Set<string>,
): string | null {
  if (!existsSync(approvedPath)) return null;
  let approved: { highlights?: Array<{ url?: string; article?: Article }> };
  try {
    approved = JSON.parse(readFileSync(approvedPath, "utf8"));
  } catch {
    return null;
  }
  const highlights = approved.highlights ?? [];
  if (highlights.length === 0) return null;

  // Reutiliza renderLine — extrai article ou usa flat shape compatível.
  const lines = highlights.map((h, idx) => {
    const art: Article = (h.article ?? (h as unknown as Article)) as Article;
    if (!art.url && h.url) art.url = h.url;
    return renderLine(art, highlightUrls.has(art.url), runnerUpUrls.has(art.url), idx + 1);
  });

  return `## Destaques\n\n${lines.join("\n")}\n`;
}

/**
 * Coleta URLs dos candidatos a destaque. Suporta dois formatos no top-level
 * `highlights[]` (#229):
 *   - `{ url, ... }` (flat, formato pré-#229)
 *   - `{ article: { url, ... }, ... }` (nested, spec-compliant pós-#229)
 * Mais o formato legado de `highlight: true` inline em cada artigo do bucket.
 */
export function buildHighlightUrls(data: CategorizedJson): Set<string> {
  const urls = new Set<string>();

  // Formato top-level highlights[] — aceita URL flat OU nested em article.
  for (const h of data.highlights ?? []) {
    const url = h.url ?? h.article?.url;
    if (url) urls.add(url);
  }

  // Formato legado: inline em cada artigo
  for (const bucket of [data.lancamento, data.pesquisa, data.noticias, data.tutorial, data.video]) {
    for (const a of bucket ?? []) {
      if (a.highlight) urls.add(a.url);
    }
  }

  return urls;
}

/**
 * Coleta URLs dos runners_up — candidatos com score alto que não entraram
 * no top do scorer. Renderizados com ✨ pra o editor ver o universo completo
 * de recomendações, não só o slice principal (ver #104).
 */
export function buildRunnerUpUrls(data: CategorizedJson): Set<string> {
  const urls = new Set<string>();
  for (const r of data.runners_up ?? []) {
    if (!r || typeof r !== "object") continue;
    // Aceita URL flat OU nested em article (mesmo pattern do #229).
    const obj = r as { url?: unknown; article?: { url?: unknown } };
    const flat = obj.url;
    const nested = obj.article?.url;
    if (typeof flat === "string") urls.add(flat);
    else if (typeof nested === "string") urls.add(nested);
  }
  return urls;
}

export function renderSection(
  title: string,
  articles: Article[],
  highlightUrls: Set<string>,
  runnerUpUrls: Set<string>,
  /** #579: numeração inicial pra seção. Default 1 (compat). Caller passa
   *  cumulative offset pra criar referência única contínua entre seções. */
  startNumber = 1,
): string {
  if (articles.length === 0) {
    return `## ${title}\n\n_(vazio)_\n`;
  }
  // Ordenar por score desc — exceto quando há artigos de merge do editor
  // (new_in_pool presente = merge aconteceu → preservar ordem original).
  // Só preserva ordem quando há artigos do editor (não-novos) misturados com novos.
  // Se todos forem novos, reordenar por score ainda faz sentido.
  const hasMerge = articles.some((a) => "new_in_pool" in a) &&
                   articles.some((a) => !a.new_in_pool);
  const sorted = hasMerge
    ? [...articles]
    : [...articles].sort((a, b) => {
        const sa = typeof a.score === "number" ? a.score : -Infinity;
        const sb = typeof b.score === "number" ? b.score : -Infinity;
        return sb - sa;
      });
  // Numeração contínua entre seções (#579) — startNumber + idx.
  // Editor referencia "linha 7" sem precisar contar offset por seção.
  const lines = sorted.map((a, idx) =>
    renderLine(a, highlightUrls.has(a.url), runnerUpUrls.has(a.url), startNumber + idx),
  );
  return `## ${title}\n\n${lines.join("\n")}\n`;
}

function renderSourceHealth(path?: string): string {
  if (!path || !existsSync(path)) return "";
  try {
    const health: SourceHealth = JSON.parse(readFileSync(path, "utf8"));
    const warnings: string[] = [];
    const streaks: string[] = [];
    for (const [name, info] of Object.entries(health.sources ?? {})) {
      const last = info.last_outcome;
      const recent = info.recent_outcomes ?? [];
      if (last && last !== "ok") {
        const reason = info.last_reason || last;
        warnings.push(`⚠️ ${name} — ${reason}`);
      }
      // streak 3+ não-ok consecutivos
      const last3 = recent.slice(-3);
      if (
        last3.length === 3 &&
        last3.every((o) => o.outcome && o.outcome !== "ok")
      ) {
        const times = last3.map((o) => o.timestamp).join(", ");
        streaks.push(
          `🔴 ${name} — 3 falhas seguidas: ${times} — considere desativar em seed/sources.csv`
        );
      }
    }
    if (warnings.length === 0 && streaks.length === 0) {
      return `\n---\n\n## Saúde das fontes\n\nTodas as fontes responderam normalmente.\n`;
    }
    const body = [...warnings, ...streaks].join("\n");
    return `\n---\n\n## Saúde das fontes\n\n${body}\n`;
  } catch (e) {
    console.error(
      `render-categorized-md: aviso — não foi possível ler source-health: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return "";
  }
}

/**
 * Auto-discovers `01-verified.json` in the same _internal/ directory as the
 * input JSON and marks articles with `verdict: "uncertain"` as
 * `date_unverified: true`. This is a hardening measure — the research-reviewer
 * normally sets this flag, but if the pipeline is re-run partially the flag
 * can be lost. The render script is the final consumer, so it cross-references
 * the verification source of truth directly.
 */
function mergeVerifiedFlags(inputPath: string, data: CategorizedJson): void {
  const dir = dirname(inputPath);
  const verifiedPath = join(dir, "01-verified.json");
  if (!existsSync(verifiedPath)) return;

  try {
    const verified: Array<{ url?: string; verdict?: string }> = JSON.parse(
      readFileSync(verifiedPath, "utf8")
    );
    const uncertainUrls = new Set(
      verified.filter((v) => v.verdict === "uncertain").map((v) => v.url)
    );
    if (uncertainUrls.size === 0) return;

    for (const bucket of [data.lancamento, data.pesquisa, data.noticias, data.tutorial, data.video]) {
      for (const a of bucket ?? []) {
        if (uncertainUrls.has(a.url)) a.date_unverified = true;
      }
    }
  } catch {
    // Non-fatal — verified.json may be malformed or unreadable
  }
}

/**
 * Reintegra scores do `_internal/tmp-scored.json` nos artigos de cada bucket.
 * O scorer grava scores em `all_scored[]` nesse arquivo; o categorized.json
 * final pode não ter o campo `score` em todos os artigos (ex: re-render após
 * gate edit). Este função garante que o renderizador sempre mostre o score
 * correto ao editor, independente de qual caminho o JSON tomou no pipeline.
 *
 * O arquivo é auto-descoberto: substitui o sufixo `01-categorized.json` (ou
 * `01-approved.json`) por `tmp-scored.json` no mesmo diretório `_internal/`.
 */
function mergeScores(jsonPath: string, data: CategorizedJson): void {
  const scoredPath = jsonPath.replace('01-categorized.json', 'tmp-scored.json')
                             .replace('01-approved.json', 'tmp-scored.json');
  if (!existsSync(scoredPath)) return;
  try {
    const scored: { url: string; score: number }[] = JSON.parse(readFileSync(scoredPath, 'utf8')).all_scored ?? [];
    const scoreMap = new Map(scored.map(s => [s.url, s.score]));
    for (const bucket of [data.lancamento, data.pesquisa, data.noticias, data.tutorial, data.video]) {
      for (const art of (bucket ?? [])) {
        if (art.url && scoreMap.has(art.url)) {
          art.score = scoreMap.get(art.url);
        }
      }
    }
  } catch {
    // Non-fatal — tmp-scored.json may be absent (partial run) or malformed
  }
}

// ---------- Coverage line resolution (#666) ----------------------------

/**
 * Resolve a linha de cobertura da edição a partir das fontes disponíveis,
 * em ordem de prioridade:
 *
 *  1. Se `cliInBasename === "01-approved.json"`, o input já é o approved —
 *     usa `inputCoverage.line` diretamente sem re-ler o disco.
 *  2. Senão, usa `siblingCoverage.line` (pré-carregada pelo caller a partir
 *     do 01-approved.json adjacente ao cli.in).
 *  3. Fallback: chama `fallback()` — computa a partir do inbox.md e do JSON
 *     de categorized (caso pre-gate ou approved sem campo coverage).
 *
 * Retorna a linha sem "\n\n" trailing — caller decide a formatação.
 *
 * **Pura**: não lê o filesystem. Caller carrega os dados e injeta.
 */
export function resolveCoverageLine(opts: {
  cliInBasename: string;
  inputCoverage?: { line?: string };
  siblingCoverage?: { line?: string } | null;
  fallback: () => string;
}): string {
  // Acessa campos lazy (não desestrutura adiantado) pra o teste de "sibling não
  // é consultado quando cliIn é approved.json" ser determinístico.
  if (opts.cliInBasename === "01-approved.json") {
    return opts.inputCoverage?.line ?? opts.fallback();
  }

  if (opts.siblingCoverage?.line) return opts.siblingCoverage.line;
  return opts.fallback();
}

// ---------- Coverage metrics (#477) -------------------------------------

/**
 * Calcula o total de artigos "considerados" antes da filtragem do scorer.
 *
 * Estratégia de auto-descoberta (sem mudar o caller):
 *  1. Se o JSON já tiver `total_considered` (injetado pelo orchestrator), usar diretamente.
 *  2. Tentar ler `_internal/tmp-categorized.json` no mesmo diretório do JSON de input:
 *     esse arquivo tem os artigos pós-dedup e pós-categorize, antes do filtro de score.
 *     É o melhor proxy para "quanto foi analisado".
 *  3. Fallback: retornar `null` (placeholder `???` no MD).
 */
export function computeTotalConsidered(inputPath: string, data: CategorizedJson): number | null {
  // Re-exported wrapper para compat (#592 extraiu lógica pra scripts/lib/categorized-stats.ts).
  return computeTotalConsideredLib(inputPath, data);
}

// ---------- É IA? block -------------------------------------------------

/**
 * Lê o arquivo do É IA? do diretório da edição e monta o bloco para inserção
 * entre as seções do `01-categorized.md`.
 *
 * Suporta o padrão novo (`01-eia.md`, pós-#428) e o legacy (`01-eai.md`).
 *
 * Fix #481: emite APENAS a linha de crédito editável pelo editor, sem
 * frontmatter YAML, sem "É IA?" duplicado e sem paths de imagem. Os paths
 * ficam exclusivamente no `01-eia.md` (informação estruturada para o
 * publisher). O writer lê a linha de crédito desta seção do categorized.md.
 *
 * Se o arquivo existir: retorna o bloco com apenas a linha de crédito.
 * Se não existir (ainda processando em background): retorna placeholder.
 */
export function renderEaiBlock(editionDir: string): string {
  const separator = "---";

  // Suporte a novo padrão (eia, pós-#428) e legacy (eai, pré-#428)
  const eaiMd =
    existsSync(join(editionDir, "01-eia.md")) ? join(editionDir, "01-eia.md") :
    existsSync(join(editionDir, "01-eai.md")) ? join(editionDir, "01-eai.md") :
    null;

  if (eaiMd) {
    const content = readFileSync(eaiMd, "utf8");
    // Extrair apenas a linha de crédito (#481):
    // - Ignorar bloco frontmatter (--- ... ---)
    // - Ignorar linha "É IA?"
    // - Pegar a primeira linha não-vazia restante
    const lines = content.split('\n');
    let inFrontmatter = false;
    let frontmatterDone = false;
    let creditLine = '';
    // Se o arquivo não começa com frontmatter (primeira linha não-vazia não é ---),
    // tratar todo o conteúdo como pós-frontmatter.
    const firstNonEmpty = lines.find((l) => l.trim() !== '');
    if (firstNonEmpty && firstNonEmpty.trim() !== '---') frontmatterDone = true;
    for (const line of lines) {
      if (line.trim() === '---') {
        if (!frontmatterDone) { inFrontmatter = !inFrontmatter; if (!inFrontmatter) frontmatterDone = true; }
        continue;
      }
      if (inFrontmatter) continue;
      if (!frontmatterDone) continue;
      if (line.trim() === 'É IA?' || line.trim() === '') continue;
      creditLine = line.trim();
      break;
    }
    if (!creditLine) return `\n${separator}\n\n## É IA? ⏳ (ainda processando)\n\n${separator}\n`;

    // #584/#927/#939: extrair gabarito via fallback chain (sidecar > meta.json
    // > frontmatter) e mostrar pro editor — apenas em categorized.md /
    // pre-publish, strippado depois pra não estragar o poll Trivia da
    // newsletter. readEiaAnswer já cobre frontmatter como nível 3, então não
    // há fallback adicional necessário (#939: extractEaiAnswer in-memory
    // duplicava trabalho).
    const gabarito = readEiaAnswer(editionDir);
    const gabaritoLine = gabarito ? `\n> Gabarito: **A = ${gabarito.A}**, **B = ${gabarito.B}**\n` : "";

    return `\n${separator}\n\n## É IA?\n\n${creditLine}\n${gabaritoLine}\n${separator}\n`;
  }
  return `\n${separator}\n\n## É IA? ⏳ (ainda processando — será revisado quando disponível)\n\n${separator}\n`;
}

/**
 * Extrai `eia_answer.A` e `eia_answer.B` do frontmatter de `01-eia.md` (#584).
 * Retorna null se ausente ou malformado.
 *
 * **#939**: não é mais usada como fallback em renderEaiBlock — `readEiaAnswer`
 * cobre frontmatter como nível 3. Mantida exportada para tests legados e
 * potential reuso (parser pure-string sem disk read).
 */
export function extractEaiAnswer(eiaMd: string): { A: string; B: string } | null {
  const fmMatch = eiaMd.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const aMatch = fm.match(/^\s*A:\s*(\w+)\s*$/m);
  const bMatch = fm.match(/^\s*B:\s*(\w+)\s*$/m);
  if (!aMatch || !bMatch) return null;
  return { A: aMatch[1], B: bMatch[1] };
}

// ---------- Main ---------------------------------------------------------

function main() {
  const cli = parseArgs();
  const data: CategorizedJson = JSON.parse(readFileSync(cli.in, "utf8"));
  mergeVerifiedFlags(cli.in, data);
  mergeScores(cli.in, data);

  if (!data.lancamento || !data.pesquisa || !data.noticias) {
    console.error(
      `render-categorized-md: input JSON não tem os buckets esperados (lancamento/pesquisa/noticias)`
    );
    process.exit(1);
  }

  const highlightUrls = buildHighlightUrls(data);
  const runnerUpUrls = buildRunnerUpUrls(data);

  // #477, #592: métricas de cobertura — X submissões / Y descobertos / Z selecionados.
  const totalSelected =
    data.lancamento.length + data.pesquisa.length + data.noticias.length +
    (data.tutorial?.length ?? 0) + (data.video?.length ?? 0);
  const totalConsidered = computeTotalConsidered(cli.in, data);

  // #592 / #666: linha de cobertura — resolvida em 3 steps pela função pura
  // resolveCoverageLine. Carregamentos de arquivo acontecem aqui (caller),
  // não dentro da função.
  const cliInBasename = basename(cli.in);
  let siblingCoverage: { line?: string } | null = null;
  if (cliInBasename !== "01-approved.json") {
    const approvedPathForCoverage = resolve(dirname(cli.in), "01-approved.json");
    if (existsSync(approvedPathForCoverage)) {
      try {
        const parsed = JSON.parse(readFileSync(approvedPathForCoverage, "utf8")) as {
          coverage?: { line?: string };
        };
        siblingCoverage = parsed.coverage ?? null;
      } catch (err) {
        // #658 review E: warn antes do fallback — editor percebe arquivo corrompido.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[render-categorized-md] WARN: approved.json existe mas falhou parse (${msg.slice(0, 200)}). Caindo no fallback de inbox.md.`,
        );
      }
    }
  }

  const coverageLine = resolveCoverageLine({
    cliInBasename,
    inputCoverage: (data as unknown as { coverage?: { line?: string } }).coverage,
    siblingCoverage,
    fallback: () => {
      const inboxMdPath = cli.inboxMd ?? resolve(ROOT, "data/inbox.md");
      const platformConfigPath = resolve(ROOT, "platform.config.json");
      const editorEmail = resolveEditorEmail(platformConfigPath);
      const editorSubmissions = countEditorSubmissions(inboxMdPath, editorEmail);
      const diariaDiscovered = totalConsidered !== null
        ? Math.max(0, totalConsidered - editorSubmissions)
        : null;
      return diariaDiscovered !== null
        ? formatCoverageLine({ editorSubmissions, diariaDiscovered, selected: totalSelected })
        : `Para esta edição, eu (o editor) enviei ${editorSubmissions} submissões e a Diar.ia encontrou outros ??? artigos. Selecionamos os ${totalSelected} mais relevantes para as pessoas que assinam a newsletter.`;
    },
  }) + "\n\n";

  const header = `# Diar.ia — Edição ${cli.edition} — Research\n`;
  const instructions =
    `> Candidatos recomendados pelo scorer:\n` +
    `>   - ⭐ — top do scorer (highlights[]).\n` +
    `>   - ✨ — runners-up (próximos da lista, considerar se top não couber).\n` +
    `>   - 🆕 — artigo novo desde a última curadoria (não estava no MD anterior).\n` +
    `> Mova **exatamente 3** linhas para a seção **Destaques** (a ordem define D1, D2, D3).\n` +
    `> Marcador \`⚠️\` indica que a data de publicação não pôde ser verificada automaticamente.\n`;

  // Determinar o diretório da edição a partir do path do arquivo de saída (#371).
  // O É IA? é embutido entre Pesquisas e Notícias para revisão integrada no gate da Etapa 1.
  const editionDir = cli.out ? dirname(resolve(cli.out)) : process.cwd();
  const eaiBlock = renderEaiBlock(editionDir);

  // #585: Quando 01-approved.json existe (gate aprovado), renderiza destaques
  // a partir dele em vez do placeholder. Evita re-renders apagarem a curadoria.
  const approvedPath = resolve(editionDir, "_internal", "01-approved.json");
  const destaquesFromApproved = renderDestaquesFromApproved(approvedPath, highlightUrls, runnerUpUrls);
  const destaquesSection = destaquesFromApproved ?? `## Destaques\n\n_(mova 3 artigos para cá)_\n`;

  // #579: numeração contínua entre seções — editor referencia "linha N" sem
  // precisar contar offset por seção. Calcula offset acumulado conforme renderiza.
  let cumOffset = 1;
  const lancSec = renderSection("Lançamentos", data.lancamento, highlightUrls, runnerUpUrls, cumOffset);
  cumOffset += data.lancamento.length;
  const pesqSec = renderSection("Pesquisas", data.pesquisa, highlightUrls, runnerUpUrls, cumOffset);
  cumOffset += data.pesquisa.length;
  const notSec = renderSection("Notícias", data.noticias, highlightUrls, runnerUpUrls, cumOffset);
  cumOffset += data.noticias.length;
  const tutSec = data.tutorial && data.tutorial.length > 0
    ? renderSection("Aprenda hoje", data.tutorial, highlightUrls, runnerUpUrls, cumOffset)
    : null;
  if (tutSec) cumOffset += data.tutorial!.length;
  const vidSec = data.video && data.video.length > 0
    ? renderSection("Vídeos", data.video, highlightUrls, runnerUpUrls, cumOffset)
    : null;

  const sections = [
    coverageLine + destaquesSection,
    lancSec,
    pesqSec,
    eaiBlock,
    notSec,
    ...(tutSec ? [tutSec] : []),
    ...(vidSec ? [vidSec] : []),
  ].join("\n");

  const footer = renderSourceHealth(cli.sourceHealth);

  // #293: Merge automático da curadoria do editor.
  // Se o MD existente foi modificado pelo editor (detectado por hash fingerprint),
  // mesclamos a curadoria com o novo JSON antes de renderizar — preservando
  // destaques movidos, artigos deletados e reordenações.
  const backupDir = resolve(dirname(cli.out), "_internal");
  const hashFilePath = resolve(backupDir, "01-render-hash.json");
  if (existsSync(cli.out)) {
    const existingMd = readFileSync(cli.out, "utf8");
    const currentHash = createHash("sha256").update(existingMd).digest("hex");
    let savedHash: string | null = null;
    if (existsSync(hashFilePath)) {
      try {
        savedHash = (JSON.parse(readFileSync(hashFilePath, "utf8")) as { md_hash: string }).md_hash;
      } catch { /* hash file corrompido — trata como "editor editou" */ }
    }
    if (savedHash !== null && currentHash !== savedHash) {
      // Editor modificou o MD desde o último render → merge automático
      const { merged, warnings: mergeWarnings } = mergeWithNewJson(
        existingMd,
        data as unknown as Parameters<typeof mergeWithNewJson>[1],
      );
      Object.assign(data, {
        lancamento: merged.lancamento,
        pesquisa: merged.pesquisa,
        noticias: merged.noticias,
        tutorial: merged.tutorial,
        video: merged.video,
      });
      if (mergeWarnings.length > 0) {
        console.error(
          `[render-categorized-md] merge curadoria: ${mergeWarnings.length} warn(s):\n` +
          mergeWarnings.map((w) => `  - ${w}`).join("\n"),
        );
      }
      console.error(
        `[render-categorized-md] curadoria do editor preservada via merge (#293)`,
      );
    }
  }

  // #242: backup defensivo antes de sobrescrever.
  // #288: pruning de backups antigos — manter só os últimos 3 antes de criar novo.
  if (existsSync(cli.out)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = basename(cli.out);
    const backupPath = resolve(backupDir, `${baseName}.bak-${ts}`);
    try {
      mkdirSync(backupDir, { recursive: true });
      // Pruning: listar backups existentes, ordenar por nome (ISO timestamp → ordem cronológica),
      // apagar os mais antigos se tiver mais que 3 (#288).
      const existingBackups = readdirSync(backupDir)
        .filter((f) => f.startsWith(`${baseName}.bak-`))
        .sort(); // ISO timestamp → lexicográfico = cronológico
      const MAX_BACKUPS = 3;
      for (let i = 0; i < existingBackups.length - MAX_BACKUPS; i++) {
        try { unlinkSync(resolve(backupDir, existingBackups[i])); } catch { /* ignore */ }
      }
      copyFileSync(cli.out, backupPath);
    } catch (err) {
      // Backup é defensivo — se falhar, segue (não bloqueia render). Loga
      // pra audit em stderr; o orchestrator pode capturar pra run-log.
      console.error(
        `[render-categorized-md] backup falhou (continuando): ${(err as Error).message}`,
      );
    }
  }

  const md = `${header}${instructions}\n${sections}${footer}`;
  writeFileSync(cli.out, md, "utf8");

  // Salvar hash fingerprint do MD recém-renderizado (#293).
  // Próxima chamada ao renderer usa esse hash para detectar edições do editor.
  try {
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(
      hashFilePath,
      JSON.stringify({
        md_hash: createHash("sha256").update(md).digest("hex"),
        rendered_at: new Date().toISOString(),
      }),
      "utf8",
    );
  } catch { /* hash é opcional — não bloqueia se falhar */ }

  const highlighted = highlightUrls.size;
  const unverified = [
    ...data.lancamento,
    ...data.pesquisa,
    ...data.noticias,
    ...(data.tutorial ?? []),
    ...(data.video ?? []),
  ].filter((a) => a.date_unverified).length;

  process.stdout.write(
    JSON.stringify({
      out: cli.out,
      total_articles: totalSelected,
      total_considered: totalConsidered,
      highlights_rendered: highlighted,
      runners_up_rendered: runnerUpUrls.size,
      date_unverified: unverified,
    }) + "\n"
  );
}

const _isMain =
  process.argv[1] != null &&
  import.meta.url.endsWith(
    process.argv[1].replaceAll("\\", "/").replace(/^.*\//, "")
  );
if (_isMain) main();
