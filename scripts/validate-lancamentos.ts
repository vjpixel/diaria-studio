/**
 * validate-lancamentos.ts (#160, #876)
 *
 * Garante que a seção LANÇAMENTOS de um `02-reviewed.md` só contém
 * URLs de domínio oficial (whitelist em `categorize.ts`). Cobertura
 * de imprensa, blogs pessoais, agregadores e análise de terceiros vão
 * pra NOTÍCIAS — não pra LANÇAMENTOS, mesmo quando o tema é o
 * lançamento.
 *
 * Modo MD (#160, #902):
 *   npx tsx scripts/validate-lancamentos.ts <md-path>
 *   npx tsx scripts/validate-lancamentos.ts --in <md-path>
 *
 *   Output JSON: { lancamento_count, invalid_urls[], status }
 *
 * Modo approved-json (#876, usado em §2a do orchestrator-stage-2):
 *   npx tsx scripts/validate-lancamentos.ts \
 *     --approved <01-approved.json> \
 *     [--write-removed <_internal/02-lancamentos-removed.json>]
 *
 *   Valida cada URL em `approved.lancamento[]`. Quando `--write-removed`
 *   é passado, grava o resumo `{ removed[], original_count, final_count }`
 *   no path indicado para que `sync-intro-count.ts` ajuste menções
 *   narrativas a "X lançamentos" no intro pós-Clarice.
 *
 * Exit codes:
 *   0  Todas as URLs em LANÇAMENTOS são oficiais (ou seção vazia)
 *   1  Pelo menos 1 URL não-oficial em LANÇAMENTOS
 *   2  Erro de leitura/uso
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isOfficialLancamentoUrl } from "./categorize.ts";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";

export interface ValidationResult {
  lancamento_count: number;
  invalid_urls: Array<{ url: string; line: number }>;
  /** #1799: itens que não são software/hardware (governança/política/análise). */
  non_product: Array<{ url: string; line: number }>;
  status: "ok" | "error";
}

// #1799: casa os 3 formatos de header: `LANÇAMENTOS` solo (Stage 2 antigo),
// `## Lançamentos` (Stage 1 categorized), e `**🚀 LANÇAMENTOS**` (Stage 2
// reviewed.md — antes não casava, então o validador era no-op ali).
const SECTION_LANCAMENTOS_RE =
  /^(?:\*\*)?\s*(?:##\s+)?(?:🚀\s*)?lan[çc]amentos\s*(?:\*\*)?\s*$/im;
const SECTION_BREAK_RE = /^---\s*$/m;
const URL_RE = /https?:\/\/\S+/g;

/**
 * #1799: LANÇAMENTOS só lista software/hardware (modelo, app, API, ferramenta,
 * chip, dispositivo). Documento de governança/política/manifesto/essay/relatório
 * de segurança NÃO é lançamento de produto. Sinais (no slug ou título): termos
 * de governança/política. Slug é mais confiável que o título (que pode estar
 * traduzido). Caso 260604: openai.com/index/public-policy-agenda.
 */
// Só termos de ALTA precisão de governança — `framework`/`agenda`/`blueprint`/
// `guidelines` foram removidos (review #1817): são comuns em produto real
// (LangGraph framework, app de agenda, ...). Single-words porque o slug é
// normalizado (`[-_/]→ espaço`): "public-policy-agenda" → "public policy
// agenda" casa via `policy`. O título (testado as-is) casa via `política`.
const NON_PRODUCT_RE =
  /\b(policy|policies|governance|manifesto|principles|white\s?paper|commitment|charter|testimony|pol[íi]tica|governan[çc]a|diretrizes)\b/i;

/**
 * #1852: defesa-em-profundidade pra LANÇAMENTOS que escaparam o categorize via
 * `type_hint=lancamento` (agent vence as heurísticas). Sinais no SLUG de que a
 * URL é pesquisa/case-study, não a página oficial do produto:
 *   - conferência/pesquisa (cvpr/neurips/.../arxiv/preprint)
 *   - case study / customer story
 * Match SÓ no slug (não no título): o título de um lançamento real pode citar
 * "research" sem que a URL seja um paper. Warn-only no gate, não bloqueia.
 *
 * `cli`/`sdk` ficaram de FORA (review #1875): um CLI/SDK É software/produto, e
 * flagá-los com a mensagem "não software/hardware" seria errado + ruidoso (todo
 * lançamento de CLI/SDK cairia). O caso HF CLI já é tratado no categorize
 * (`isFirstPartyToolingBlog`, host-scoped a huggingface.co/blog/).
 */
const NON_PRODUCT_SLUG_RE =
  /\b(cvpr|neurips|iclr|icml|iccv|eccv|aaai|emnlp|naacl|siggraph|arxiv|preprint|case stud(y|ies)|customer stor(y|ies))\b/i;

export function isNonProductLancamento(url: string, title?: string): boolean {
  let slug = "";
  try {
    slug = decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, " ");
  } catch {
    slug = url;
  }
  return (
    NON_PRODUCT_RE.test(slug) ||
    NON_PRODUCT_SLUG_RE.test(slug) ||
    (!!title && NON_PRODUCT_RE.test(title))
  );
}

/**
 * Extrai todas as URLs da seção LANÇAMENTOS do MD. Retorna array
 * de { url, line } onde line é 1-indexed.
 */
export function extractLancamentoUrls(
  text: string,
): Array<{ url: string; line: number }> {
  const lines = text.split("\n");
  let inSection = false;
  const out: Array<{ url: string; line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SECTION_LANCAMENTOS_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && SECTION_BREAK_RE.test(line)) {
      // --- termina a seção
      inSection = false;
      continue;
    }
    if (inSection) {
      // Outro header de seção (ex: PESQUISAS, ## Pesquisas) também encerra.
      // #587: aceita formato Stage 1 (`## Header`) além de Stage 2 (`HEADER` solo).
      const trimmed = line.trim();
      const isPlainCaps = /^[A-ZÇÃÕÁÉÍÓÚÊÔ ]+$/.test(trimmed) && trimmed.length > 5;
      const isMdHeader = /^##\s+\S/.test(trimmed);
      // #1799: header bold do reviewed.md (ex `**📡 RADAR**`) também encerra —
      // senão a seção bold de LANÇAMENTOS vazaria pros próximos blocos. Exige:
      // (a) bold sem url/link (não confundir com item `**[Título](url)**`), e
      // (b) conteúdo UPPERCASE — section headers são caixa-alta (`RADAR`,
      // `USE MELHOR`), itens não (`**Produto v2**` tem minúscula → não encerra,
      // não trunca a seção). Review #1817.
      const boldInner = trimmed.replace(/^\*\*|\*\*$/g, "").trim();
      const isBoldHeader =
        /^\*\*[^*]+\*\*$/.test(trimmed) &&
        !/https?:\/\//.test(trimmed) &&
        !trimmed.includes("[") &&
        /\p{L}/u.test(boldInner) &&
        !/[a-zà-ÿ]/.test(boldInner);
      if (isPlainCaps || isMdHeader || isBoldHeader) {
        inSection = false;
        continue;
      }
      const matches = line.matchAll(URL_RE);
      for (const m of matches) {
        // Trim trailing punctuation that often follows URLs in markdown
        const url = m[0].replace(/[).,;]+$/, "");
        out.push({ url, line: i + 1 });
      }
    }
  }

  return out;
}

export function validateLancamentos(text: string): ValidationResult {
  const urls = extractLancamentoUrls(text);
  // Markdown links [url](url) duplicate the URL — dedup by url string.
  const seen = new Set<string>();
  const unique = urls.filter((u) => {
    if (seen.has(u.url)) return false;
    seen.add(u.url);
    return true;
  });

  const invalid = unique.filter((u) => !isOfficialLancamentoUrl(u.url));
  // #1799: itens de governança/política/análise — warn (não muda o status, que
  // segue regido pela regra de domínio oficial #160).
  const non_product = unique.filter((u) => isNonProductLancamento(u.url));
  return {
    lancamento_count: unique.length,
    invalid_urls: invalid,
    non_product,
    status: invalid.length === 0 ? "ok" : "error",
  };
}

// ---------------------------------------------------------------------------
// Modo approved-json (#876) — valida `lancamento[]` no 01-approved.json
// e devolve a lista de URLs removidas para que `sync-intro-count.ts` ajuste
// menções narrativas a "X lançamentos" no intro.
// ---------------------------------------------------------------------------

export interface LancamentoRemoved {
  url: string;
  title?: string;
  reason: string;
}

export interface LancamentosRemovedSummary {
  removed: LancamentoRemoved[];
  /** #1799: itens que parecem governança/política/análise (warn, não removidos
   * automaticamente — decisão editorial no gate). */
  flagged_non_product: Array<{ url: string; title?: string }>;
  original_count: number;
  final_count: number;
}

interface ApprovedShape {
  lancamento?: Array<{ url?: string; title?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

/**
 * Valida o array `lancamento[]` do 01-approved.json. URLs não-oficiais
 * vão para `removed` com a razão `non_official_domain`. URLs vazias são
 * ignoradas (não contam como original nem como removido).
 */
export function validateLancamentosFromApproved(
  approved: ApprovedShape,
): LancamentosRemovedSummary {
  const list = Array.isArray(approved.lancamento) ? approved.lancamento : [];
  const removed: LancamentoRemoved[] = [];
  const flagged_non_product: Array<{ url: string; title?: string }> = [];
  let kept = 0;

  for (const item of list) {
    const url = typeof item.url === "string" ? item.url : "";
    if (!url) continue;
    const title = typeof item.title === "string" ? item.title : undefined;
    if (isOfficialLancamentoUrl(url)) {
      kept++;
    } else {
      removed.push({ url, title, reason: "non_official_domain" });
    }
    // #1799: classificação produto-vs-governança é independente do domínio —
    // openai.com/index/public-policy-agenda é oficial mas NÃO é produto.
    if (isNonProductLancamento(url, title)) {
      flagged_non_product.push({ url, title });
    }
  }

  const original_count = kept + removed.length;
  return { removed, flagged_non_product, original_count, final_count: kept };
}

function mainApproved(args: Record<string, string>, ROOT: string): void {
  const approvedPath = resolve(ROOT, args.approved);
  if (!existsSync(approvedPath)) {
    console.error(`Arquivo não existe: ${approvedPath}`);
    process.exit(2);
  }
  let approved: ApprovedShape;
  try {
    approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedShape;
  } catch (err) {
    console.error(`Falha ao parsear ${approvedPath}: ${(err as Error).message}`);
    process.exit(2);
  }
  const summary = validateLancamentosFromApproved(approved);
  console.log(JSON.stringify(summary, null, 2));

  if (args["write-removed"]) {
    const outPath = resolve(ROOT, args["write-removed"]);
    writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  }

  // #1799: warn de não-produto (governança/política) — surfaça no gate, não
  // bloqueia (decisão editorial; pode ser oficial mas não-produto).
  if (summary.flagged_non_product.length > 0) {
    console.error(
      `\n⚠️ ${summary.flagged_non_product.length} item(ns) de LANÇAMENTOS parece(m) governança/política/pesquisa/case-study, não página oficial de produto (#1799/#1852):`,
    );
    for (const f of summary.flagged_non_product) {
      const titleHint = f.title ? ` ("${f.title.slice(0, 60)}")` : "";
      console.error(`  ${f.url}${titleHint}`);
    }
    console.error(
      "Revise no gate: LANÇAMENTOS só lista produto (modelo/app/API/ferramenta/chip/dispositivo).",
    );
  }

  if (summary.removed.length > 0) {
    console.error(
      `\n⚠️ ${summary.removed.length} de ${summary.original_count} lançamento(s) removido(s) (URL não-oficial):`,
    );
    for (const r of summary.removed) {
      const titleHint = r.title ? ` ("${r.title.slice(0, 60)}")` : "";
      console.error(`  ${r.url}${titleHint}`);
    }
    process.exit(1);
  }
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // #926: usar parser compartilhado. Adiciona suporte a --md/--in (#902) sem
  // quebrar compatibilidade com posicional `<md-path>`.
  const { values: flagArgs, positional } = parseCliArgs(process.argv.slice(2));

  // Modo approved-json (#876)
  if (flagArgs.approved) {
    mainApproved(flagArgs, ROOT);
    return;
  }

  // #902: aceita --md ou --in como alias para o posicional. Posicional ainda
  // funciona para retrocompatibilidade.
  const arg = flagArgs["md"] ?? flagArgs["in"] ?? positional[0];
  if (!arg) {
    console.error(
      "Uso: validate-lancamentos.ts <md-path>\n" +
        "  ou: validate-lancamentos.ts --md <md-path>\n" +
        "  ou: validate-lancamentos.ts --in <md-path>\n" +
        "  ou: validate-lancamentos.ts --approved <01-approved.json> [--write-removed <path>]",
    );
    process.exit(2);
  }
  const path = resolve(ROOT, arg);
  if (!existsSync(path)) {
    console.error(`Arquivo não existe: ${path}`);
    process.exit(2);
  }
  const text = readFileSync(path, "utf8");
  const result = validateLancamentos(text);
  console.log(JSON.stringify(result, null, 2));
  // #1799: warn de não-produto (governança/política) — não muda o status.
  if (result.non_product.length > 0) {
    console.error(
      `\n⚠️ ${result.non_product.length} item(ns) de LANÇAMENTOS parece(m) governança/política/pesquisa/case-study, não página oficial de produto (#1799/#1852):`,
    );
    for (const u of result.non_product) {
      console.error(`  linha ${u.line}: ${u.url}`);
    }
  }
  if (result.status === "error") {
    console.error(
      `\n❌ ${result.invalid_urls.length} URL(s) em LANÇAMENTOS não bate(m) com whitelist oficial:`,
    );
    for (const u of result.invalid_urls) {
      console.error(`  linha ${u.line}: ${u.url}`);
    }
    console.error(
      "\nReclassifique como NOTÍCIAS ou substitua por link de domínio oficial. Veja editorial-rules.md → 'Lançamentos só com link oficial'.",
    );
    process.exit(1);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
