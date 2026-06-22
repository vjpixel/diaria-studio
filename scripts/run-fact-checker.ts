/**
 * run-fact-checker.ts (#2455)
 *
 * Script de orquestração do fact-checker no Stage 4.
 * Lê `_internal/01-approved.json`, `02-reviewed.md` e `03-social.md`,
 * invoca o subagente `fact-checker`, e grava `_internal/fact-check.json`.
 *
 * Também expõe helpers puros (parseClaimsFromText, formatGateSummary) que
 * são testáveis unitariamente sem dependências externas.
 *
 * Uso:
 *   npx tsx scripts/run-fact-checker.ts --edition-dir data/editions/AAMMDD/
 *
 * Output: data/editions/AAMMDD/_internal/fact-check.json
 *   + stdout: seção formatada para o gate do Stage 4
 *
 * Exit codes:
 *   0 — sucesso (mesmo se houver findings — não bloqueia)
 *   1 — erro de args ou arquivo não encontrado
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types — exportados para teste
// ---------------------------------------------------------------------------

export type ClaimType = "price" | "date" | "duration" | "number" | "superlative";
export type Verdict =
  | "SUSTAINED"
  | "DIVERGENT"
  | "NOT_FOUND_IN_SOURCE"
  | "SOURCE_UNREACHABLE"
  | "INFERRED";

export interface FactClaim {
  destaque: number;
  claim_type: ClaimType;
  text: string;
  context: string;
  sources: Array<"newsletter" | "social">;
  verdict: Verdict;
  source_url?: string;
  source_text?: string;
  note?: string;
}

export interface FactCheckSummary {
  total: number;
  sustained: number;
  divergent: number;
  not_found_in_source: number;
  source_unreachable: number;
  inferred: number;
  /** divergent + not_found superlatives + superlatives not sustained */
  attention_items: number;
}

export interface FactCheckResult {
  edition: string;
  checked_at: string;
  claims: FactClaim[];
  summary: FactCheckSummary;
}

// ---------------------------------------------------------------------------
// Pure helpers — exportados para teste
// ---------------------------------------------------------------------------

/**
 * Extrai claims factuais verificáveis de um texto.
 * Estratégia heurística leve (complementa o LLM fact-checker):
 *  - Detecta padrões de preço/cifra (R$, US$, €, $) com valor
 *  - Detecta padrões de ineditismo ("primeira vez", "inédito", "pioneiro",
 *    "primeiro [a/do/no]")
 *  - Retorna array de { text, claim_type, context }
 *
 * Esta extração é conservadora: melhor falso-negativo (não extrair um claim
 * real) do que falso-positivo (extrair spam). O LLM no subagente faz a
 * varredura semântica completa; esta função serve para testes unitários e
 * como pré-filtro.
 */
export interface ExtractedClaim {
  text: string;
  claim_type: ClaimType;
  /** Linha ou frase onde o claim aparece */
  context: string;
}

// Regex para preços com valor numérico
const PRICE_RE = /(?:R\$|US\$|\$|€|USD|BRL|EUR)\s*\d[\d.,]*/g;

// Regex para ineditismo/superlativos.
// Estratégia: capturar a palavra-âncora mais uma janela de contexto à frente
// (até 4 palavras) para cobrir variações como "primeira a lançar",
// "primeiro do Brasil", "inédito no mercado", etc.
// Alternativas ordenadas da mais específica para a mais geral.
const SUPERLATIVE_RE =
  /\b(?:primeira\s+vez|inédito[as]?|pionei(?:ro|ra)s?|(?:primeira|primeiro)\s+(?:a\s+\w+|do\s+\w+|no\s+\w+|na\s+\w+|de\s+\w+|entre\s+\w+)|primeira|primeiro)\b/gi;

/**
 * Extrai padrões de preço de um texto.
 * Retorna cada match com contexto (frase/linha em torno do match).
 */
export function extractPriceClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PRICE_RE)) {
    const raw = m[0].trim();
    if (seen.has(raw)) continue;
    seen.add(raw);
    // Contexto: substring de ±80 chars ao redor do match
    const start = Math.max(0, m.index! - 80);
    const end = Math.min(text.length, m.index! + raw.length + 80);
    const context = text.slice(start, end).replace(/\n+/g, " ").trim();
    claims.push({ text: raw, claim_type: "price", context });
  }
  return claims;
}

/**
 * Extrai padrões de ineditismo/superlativo de um texto.
 */
export function extractSuperlativeClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(SUPERLATIVE_RE)) {
    const raw = m[0].trim().toLowerCase();
    if (seen.has(raw)) continue;
    seen.add(raw);
    const start = Math.max(0, m.index! - 80);
    const end = Math.min(text.length, m.index! + m[0].length + 80);
    const context = text.slice(start, end).replace(/\n+/g, " ").trim();
    claims.push({ text: m[0].trim(), claim_type: "superlative", context });
  }
  return claims;
}

/**
 * Extrai todos os claims detectáveis heuristicamente de um texto.
 * Combina preços + superlativos.
 */
export function parseClaimsFromText(text: string): ExtractedClaim[] {
  return [...extractPriceClaims(text), ...extractSuperlativeClaims(text)];
}

/**
 * Formata a seção de fact-check para o gate do Stage 4.
 * Retorna string multi-linha para exibição no terminal.
 *
 * - Se não há claims de atenção: mostra resumo positivo
 * - Se há DIVERGENT: mostra em destaque com ❌
 * - Se há superlatives não-SUSTAINED: mostra com ⚠️
 * - Se há NOT_FOUND_IN_SOURCE: mostra com ⚠️
 */
export function formatGateSummary(result: FactCheckResult): string {
  const { claims, summary } = result;
  const lines: string[] = [];

  lines.push("━━━ FACT-CHECK (#2455) ━━━━━━━━━━━━━━━━━━");

  if (summary.total === 0) {
    lines.push("  ℹ️  Nenhum claim verificável extraído (newsletter + social).");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    return lines.join("\n");
  }

  lines.push(
    `  Total: ${summary.total} claims | ✅ ${summary.sustained} sustentados | ` +
      `${summary.divergent > 0 ? `❌ ${summary.divergent} divergentes` : `✅ 0 divergentes`} | ` +
      `${summary.not_found_in_source > 0 ? `⚠️  ${summary.not_found_in_source} não encontrados na fonte` : `✅ 0 não encontrados`}`,
  );

  if (summary.attention_items === 0) {
    lines.push("  ✅ Todos os claims verificados sem divergências.");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    return lines.join("\n");
  }

  lines.push("");

  // Divergentes primeiro (mais graves)
  const divergent = claims.filter((c) => c.verdict === "DIVERGENT");
  if (divergent.length > 0) {
    lines.push("  ❌ DIVERGÊNCIAS (verificar antes de publicar):");
    for (const c of divergent) {
      lines.push(`    D${c.destaque} [${c.claim_type}] "${c.text}"`);
      if (c.note) lines.push(`       → ${c.note}`);
      if (c.source_text) lines.push(`       Fonte: "${c.source_text}"`);
    }
    lines.push("");
  }

  // Superlativos sem suporte
  const unsupportedSuperlatives = claims.filter(
    (c) => c.claim_type === "superlative" && c.verdict !== "SUSTAINED",
  );
  if (unsupportedSuperlatives.length > 0) {
    lines.push("  ⚠️  INEDITISMO/SUPERLATIVOS sem confirmação na fonte:");
    for (const c of unsupportedSuperlatives) {
      lines.push(`    D${c.destaque} "${c.text}" [${c.verdict}]`);
      if (c.note) lines.push(`       → ${c.note}`);
    }
    lines.push("");
  }

  // Not found (excluindo superlativos já listados)
  const notFound = claims.filter(
    (c) => c.verdict === "NOT_FOUND_IN_SOURCE" && c.claim_type !== "superlative",
  );
  if (notFound.length > 0) {
    lines.push("  ⚠️  Claims não encontrados na fonte primária:");
    for (const c of notFound) {
      lines.push(`    D${c.destaque} [${c.claim_type}] "${c.text}"`);
      if (c.note) lines.push(`       → ${c.note}`);
    }
    lines.push("");
  }

  lines.push(
    "  Decisão final é do editor. Aprovação no gate confirma revisão dos itens acima.",
  );
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

/**
 * Computa o summary.attention_items a partir de uma lista de claims.
 * Exportado para uso em testes e no script de output.
 */
export function computeAttentionItems(claims: FactClaim[]): number {
  return claims.filter(
    (c) =>
      c.verdict === "DIVERGENT" ||
      (c.claim_type === "superlative" && c.verdict !== "SUSTAINED") ||
      (c.verdict === "NOT_FOUND_IN_SOURCE" && c.claim_type !== "superlative"),
  ).length;
}

/**
 * Valida e normaliza o output do subagente fact-checker.
 * Garante que o JSON tem o schema esperado antes de gravar.
 * Retorna o resultado normalizado ou lança erro se inválido.
 */
export function normalizeFactCheckResult(raw: unknown, edition: string): FactCheckResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("fact-checker output não é um objeto JSON");
  }
  const obj = raw as Record<string, unknown>;

  const claims: FactClaim[] = Array.isArray(obj.claims)
    ? (obj.claims as FactClaim[]).filter(
        (c) => c && typeof c === "object" && c.text && c.verdict && c.destaque,
      )
    : [];

  const summary: FactCheckSummary = {
    total: claims.length,
    sustained: claims.filter((c) => c.verdict === "SUSTAINED").length,
    divergent: claims.filter((c) => c.verdict === "DIVERGENT").length,
    not_found_in_source: claims.filter((c) => c.verdict === "NOT_FOUND_IN_SOURCE").length,
    source_unreachable: claims.filter((c) => c.verdict === "SOURCE_UNREACHABLE").length,
    inferred: claims.filter((c) => c.verdict === "INFERRED").length,
    attention_items: computeAttentionItems(claims),
  };

  return {
    edition,
    checked_at: typeof obj.checked_at === "string" ? obj.checked_at : new Date().toISOString(),
    claims,
    summary,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        out[key] = argv[i + 1];
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function extractEditionId(editionDir: string): string {
  // Extrai AAMMDD do path (ex: data/editions/260622/ → 260622)
  const parts = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "unknown";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args["edition-dir"]) {
    console.error("Uso: run-fact-checker.ts --edition-dir data/editions/AAMMDD/");
    process.exit(1);
  }

  const editionDir = resolve(process.cwd(), args["edition-dir"]);
  const edition = args.edition ?? extractEditionId(editionDir);

  const newsletterPath = join(editionDir, "02-reviewed.md");
  const socialPath = join(editionDir, "03-social.md");
  const approvedPath = join(editionDir, "_internal", "01-approved.json");
  const internalDir = join(editionDir, "_internal");
  const outPath = join(internalDir, "fact-check.json");

  // Verificar pré-condições
  for (const [label, p] of [
    ["02-reviewed.md", newsletterPath],
    ["03-social.md", socialPath],
    ["_internal/01-approved.json", approvedPath],
  ] as const) {
    if (!existsSync(p)) {
      console.error(`[run-fact-checker] ERRO: ${label} não encontrado em ${p}`);
      console.error(
        "  Fact-checker requer Stage 2 completado. Verifique se 02-reviewed.md e 03-social.md existem.",
      );
      process.exit(1);
    }
  }

  mkdirSync(internalDir, { recursive: true });

  // Modo dry-run: só extrai claims heurísticos sem invocar o subagente
  if (args["dry-run"] === "true") {
    const newsletter = readFileSync(newsletterPath, "utf8");
    const social = readFileSync(socialPath, "utf8");
    const allText = `${newsletter}\n${social}`;
    const extracted = parseClaimsFromText(allText);

    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          edition,
          claims_heuristic: extracted,
          note: "Dry-run: só extração heurística. Omite verificação por URL (sem subagente).",
        },
        null,
        2,
      ),
    );
    return;
  }

  // Modo normal: chamar subagente fact-checker via Agent tool
  // Na pipeline real, o orchestrator despacha este script como passo do Stage 4;
  // o próprio orchestrator (top-level) invoca o subagente fact-checker via Agent.
  // Este script: (1) valida pré-condições, (2) grava o out_path passado ao agente,
  // e (3) formata o gate summary. O invoke do agente é responsabilidade do orchestrator.
  //
  // Para teste de integração isolado, o script aceita --input-json com o resultado
  // já computado pelo subagente (útil em CI sem acesso ao Agent tool).

  if (args["input-json"]) {
    // Modo integração: recebe JSON do subagente via arquivo
    const inputPath = resolve(process.cwd(), args["input-json"]);
    if (!existsSync(inputPath)) {
      console.error(`[run-fact-checker] --input-json não encontrado: ${inputPath}`);
      process.exit(1);
    }
    const raw = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
    const result = normalizeFactCheckResult(raw, edition);

    writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
    console.log(formatGateSummary(result));
    return;
  }

  // Modo padrão: imprimir instrução para o orchestrator
  console.log(
    `[run-fact-checker] Pré-condições validadas para edição ${edition}.`,
  );
  console.log(`  Newsletter: ${newsletterPath}`);
  console.log(`  Social:     ${socialPath}`);
  console.log(`  Approved:   ${approvedPath}`);
  console.log(`  Output:     ${outPath}`);
  console.log("");
  console.log(
    "  O orchestrator deve despachar o subagente fact-checker com os parâmetros acima.",
  );
  console.log(
    "  Após o subagente gravar fact-check.json, rodar com --input-json para formatar o gate summary.",
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error("[run-fact-checker] ERRO:", e);
    process.exit(1);
  });
}
