/**
 * apply-factcheck-autofix.ts (#2598)
 *
 * Pré-aplica correções determinísticas de claims DIVERGENT do fact-checker em
 * `02-reviewed.md` ANTES de montar o gate do Stage 4.
 *
 * Regras de aplicação:
 *   1. Só claims com `verdict === "DIVERGENT"` E `suggested_fix` presente.
 *   2. Nunca auto-corrigir claims do tipo `superlative` (são de ineditismo/tom,
 *      não divergências factuais determísticas).
 *   3. NOT_FOUND_IN_SOURCE nunca recebe suggested_fix → não é processado.
 *   4. Pular claim cujo `destaque` bate com o destaque do `intentional_error`
 *      declarado no frontmatter de `02-reviewed.md` (não tocar erro intencional).
 *   5. Substituição é SCOPED ao bloco do destaque correto — evita clobberar
 *      o intentional_error de outro destaque com mesmo texto (#2617).
 *   6. Apenas `02-reviewed.md` é modificado. `03-social.md` NÃO é tocado —
 *      qualquer edição em social invalida o sentinel do humanizador (#2617).
 *
 * Output:
 *   `_internal/fact-check-autofix.json` — log de cada correção aplicada/pulada.
 *
 * Uso:
 *   npx tsx scripts/apply-factcheck-autofix.ts --edition-dir data/editions/AAMMDD/
 *   npx tsx scripts/apply-factcheck-autofix.ts --edition-dir data/editions/AAMMDD/ --dry-run
 *
 * Exit codes:
 *   0 — sucesso (inclui o caso onde não há nada a corrigir)
 *   1 — erro de args ou arquivo ausente
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { FactClaim, FactCheckResult } from "./run-fact-checker.ts";
import {
  destaqueFromLocation,
  loadIntentionalErrorJson,
  intentionalErrorJsonPath,
  type IntentionalErrorJson,
} from "./lib/intentional-errors.ts";
import { parseArgs } from "./lib/cli-args.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutofixStatus =
  | "applied"       // substituição feita
  | "skipped_intentional_error"  // claim pertence ao destaque do erro intencional
  | "skipped_superlative"        // claim_type superlative — nunca auto-fix
  | "skipped_no_fix"             // sem suggested_fix no claim (ou texto/fix vazio)
  | "skipped_text_not_found";    // texto do claim não encontrado nos arquivos

export interface AutofixEntry {
  destaque: number;
  claim_type: FactClaim["claim_type"];
  text: string;
  suggested_fix: string | undefined;
  sources: Array<"newsletter" | "social">;
  status: AutofixStatus;
  /** Arquivo(s) modificado(s), preenchido quando status="applied" */
  files_modified?: string[];
  note?: string;
}

export interface AutofixResult {
  edition: string;
  applied_at: string;
  dry_run: boolean;
  intentional_error_destaque: number | string | null;
  entries: AutofixEntry[];
  summary: {
    total_divergent: number;
    applied: number;
    skipped: number;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — exportados para teste
// ---------------------------------------------------------------------------

/**
 * Extrai o destaque do `intentional_error` a partir do record estruturado da
 * edição (#3222: `_internal/intentional-error.json`, antes frontmatter YAML
 * em `02-reviewed.md`). Retorna null se o record estiver ausente, declarar
 * `no_error: true`, ou sem `location`.
 */
export function extractIntentionalErrorDestaque(
  record: IntentionalErrorJson | null | undefined,
): number | string | null {
  if (!record) return null;
  if (record.no_error === true) return null;
  if (!record.location || typeof record.location !== "string") return null;

  const location = record.location.trim();
  if (!location || /^\{PREENCHER/i.test(location)) return null;

  const destaque = destaqueFromLocation(location);
  return destaque !== "" ? destaque : null;
}

/**
 * Determina se um claim deve ser pulado por ser do destaque do erro intencional.
 * Match é feito pela igualdade numérica do destaque (normalizado para número).
 */
export function isIntentionalErrorClaim(
  claim: FactClaim,
  intentionalDestaque: number | string | null,
): boolean {
  if (intentionalDestaque === null) return false;
  const claimStr = String(claim.destaque);
  const intentionalStr = String(intentionalDestaque);
  return claimStr === intentionalStr;
}

/**
 * #2634/#2707/#2715: fronteira canônica de um header "DESTAQUE N" — o número
 * seguido de um separador de header (pipe, dois-pontos, travessão ou hífen,
 * com whitespace opcional antes, ex: "DESTAQUE 1 | MERCADO", "DESTAQUE 2:
 * Título", "DESTAQUE 2 — Título") ou de fim de linha. Sem esse ancoramento,
 * texto de CORPO como "DESTAQUE 2 foi importante porque..." também casa (o
 * "2" é seguido por um espaço, que já satisfazia um `\s` solto) e é confundido
 * com o início/fim de um header real.
 *
 * Compartilhado entre `markerRe` (start-boundary, âncora no `destaque` exato)
 * e `nextMatch` (end-boundary, âncora em qualquer `\d+`) para as duas fronteiras
 * não voltarem a divergir — #2634 corrigiu só o end-boundary; #2707 estendeu o
 * mesmo fix ao start-boundary, que tinha o mesmo bug-class.
 * `\s*(?:[|:—-]|$)` (#2715 item 1) generaliza `\s*(?:\||$)` (#2707 item 2)
 * pra aceitar header não-canônico ("DESTAQUE 2: Título", "DESTAQUE 2 — X") —
 * sem isso, `nextMatch` não encontra o separador esperado, retorna null, e o
 * range do destaque anterior engloba os seguintes até EOF.
 */
function destaqueHeaderPattern(numPattern: string): string {
  return String.raw`DESTAQUE\s+${numPattern}\s*(?:[|:—-]|$)`;
}

/**
 * Encontra o range (start, end) do bloco "DESTAQUE N" no conteúdo, excluindo
 * o frontmatter. Retorna null se o destaque não for encontrado.
 *
 * Resolve o bug de indexOf destaque-blind: substitui apenas dentro do bloco
 * correto, não na primeira ocorrência do documento inteiro (#2617).
 */
export function findDestaqueBodyRange(
  content: string,
  destaque: number,
): { start: number; end: number } | null {
  // Pular frontmatter
  let bodyStart = 0;
  const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (fmMatch) {
    bodyStart = fmMatch[0].length;
  }
  const body = content.slice(bodyStart);

  // Encontrar marcador "DESTAQUE N" no início de linha. `m` (multiline) faz o
  // `$` de destaqueHeaderPattern casar fim-de-LINHA (não só fim-do-documento) —
  // mesma necessidade do end-boundary abaixo.
  const markerRe = new RegExp(`(?:^|\\n)(${destaqueHeaderPattern(String(destaque))})`, "im");
  const markerMatch = markerRe.exec(body);
  if (!markerMatch) return null;

  // start = posição do "DESTAQUE N" no content completo
  const matchOffset = markerMatch.index + (markerMatch[0].startsWith("\n") ? 1 : 0);
  const blockStart = bodyStart + matchOffset;

  // end = início do próximo "DESTAQUE \d" ou fim do arquivo.
  // Usar ^DESTAQUE com flag m (multiline) em vez de \nDESTAQUE — o \n exige linha
  // em branco antes do próximo marcador; sem ela, nextMatch=null e o range de D1 engloba
  // todo o restante incluindo D2 (#2628 gap 1).
  const afterStart = body.slice(matchOffset + markerMatch[1].length);
  const nextMatch = new RegExp(`^${destaqueHeaderPattern("\\d+")}`, "im").exec(afterStart);
  const blockEnd = nextMatch
    ? blockStart + markerMatch[1].length + nextMatch.index
    : content.length;

  return { start: blockStart, end: blockEnd };
}

/**
 * Aplica substituição cirúrgica de `oldText` por `newText` em `content`,
 * LIMITADA ao range [scope.start, scope.end).
 * Retorna { changed: boolean; content: string }.
 *
 * Quando scope é omitido, opera no conteúdo inteiro (comportamento legado —
 * manter para uso em testes unitários de applyTextSubstitution).
 */
export function applyTextSubstitution(
  content: string,
  oldText: string,
  newText: string,
  scope?: { start: number; end: number },
): { changed: boolean; content: string } {
  if (scope) {
    const region = content.slice(scope.start, scope.end);
    const idx = region.indexOf(oldText);
    if (idx === -1) return { changed: false, content };
    const newRegion = region.slice(0, idx) + newText + region.slice(idx + oldText.length);
    return { changed: true, content: content.slice(0, scope.start) + newRegion + content.slice(scope.end) };
  }
  const idx = content.indexOf(oldText);
  if (idx === -1) return { changed: false, content };
  const updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
  return { changed: true, content: updated };
}

/**
 * Processa a lista de claims e determina ação para cada um.
 * Pure: não lê/escreve arquivos — lógica de decisão testável.
 *
 * @param claims - Lista de claims do fact-check.json
 * @param intentionalDestaque - Destaque do erro intencional (null se ausente)
 * @returns Array de AutofixEntry com status e reason para cada claim DIVERGENT
 */
export function planAutofixes(
  claims: FactClaim[],
  intentionalDestaque: number | string | null,
): AutofixEntry[] {
  const divergent = claims.filter((c) => c.verdict === "DIVERGENT");
  return divergent.map((c): AutofixEntry => {
    // Regra 2: superlativos nunca recebem auto-fix (são de tom)
    if (c.claim_type === "superlative") {
      return {
        destaque: c.destaque,
        claim_type: c.claim_type,
        text: c.text,
        suggested_fix: c.suggested_fix,
        sources: c.sources,
        status: "skipped_superlative",
        note: "Superlativos de ineditismo não recebem auto-fix — revisão editorial manual.",
      };
    }

    // Regra 4: pular se o claim pertence ao destaque do erro intencional
    // DEVE vir antes do check de suggested_fix para logar o motivo correto (#2617).
    if (isIntentionalErrorClaim(c, intentionalDestaque)) {
      return {
        destaque: c.destaque,
        claim_type: c.claim_type,
        text: c.text,
        suggested_fix: c.suggested_fix,
        sources: c.sources,
        status: "skipped_intentional_error",
        note: `Claim no D${c.destaque} — mesmo destaque do intentional_error declarado. Não auto-corrigir.`,
      };
    }

    // Regra 3: sem suggested_fix, ou texto/fix vazio/whitespace = não há correção
    const textTrimmed = (c.text ?? "").trim();
    const fixTrimmed = (c.suggested_fix ?? "").trim();
    if (!c.suggested_fix || !textTrimmed || !fixTrimmed) {
      return {
        destaque: c.destaque,
        claim_type: c.claim_type,
        text: c.text,
        suggested_fix: c.suggested_fix,
        sources: c.sources,
        status: "skipped_no_fix",
        note: !textTrimmed
          ? "text vazio — claim ignorado."
          : !fixTrimmed
          ? "suggested_fix vazio ou só whitespace — ignorado para evitar deleção acidental."
          : "Sem suggested_fix — fact-checker não identificou correção determinística.",
      };
    }

    // Candidato para aplicação — status final determinado pelo caller (que tem acesso aos arquivos)
    return {
      destaque: c.destaque,
      claim_type: c.claim_type,
      text: c.text,
      suggested_fix: c.suggested_fix,
      sources: c.sources,
      status: "applied", // provisório; caller corrige para skipped_text_not_found se não encontrar
    };
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function extractEditionId(editionDir: string): string {
  const parts = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "unknown";
}

async function main(): Promise<void> {
  const { values: args, flags } = parseArgs(process.argv.slice(2));
  if (!args["edition-dir"]) {
    console.error("Uso: apply-factcheck-autofix.ts --edition-dir data/editions/AAMMDD/ [--dry-run]");
    process.exit(1);
  }

  const editionDir = resolve(process.cwd(), args["edition-dir"]);
  const edition = args.edition ?? extractEditionId(editionDir);
  const isDryRun = flags.has("dry-run");

  const factCheckPath = join(editionDir, "_internal", "fact-check.json");
  const newsletterPath = join(editionDir, "02-reviewed.md");
  const internalDir = join(editionDir, "_internal");
  const outPath = join(internalDir, "fact-check-autofix.json");

  // Pré-condições
  if (!existsSync(factCheckPath)) {
    console.error(`[apply-factcheck-autofix] ERRO: fact-check.json não encontrado em ${factCheckPath}`);
    console.error("  Rodar o subagente fact-checker antes do apply-factcheck-autofix.");
    process.exit(1);
  }
  if (!existsSync(newsletterPath)) {
    console.error(`[apply-factcheck-autofix] ERRO: 02-reviewed.md não encontrado em ${newsletterPath}`);
    process.exit(1);
  }

  mkdirSync(internalDir, { recursive: true });

  // Ler inputs
  const factCheck = JSON.parse(readFileSync(factCheckPath, "utf8")) as FactCheckResult;
  let newsletter = readFileSync(newsletterPath, "utf8");

  // Extrair destaque do erro intencional (#3222: _internal/intentional-error.json)
  const intentionalErrorRecord = loadIntentionalErrorJson(intentionalErrorJsonPath(editionDir));
  const intentionalDestaque = extractIntentionalErrorDestaque(intentionalErrorRecord);

  // Planejar autofixes
  const entries = planAutofixes(factCheck.claims, intentionalDestaque);

  // Aplicar substituições (scoped ao bloco do destaque correto)
  const filesModifiedSet = new Set<string>();
  for (const entry of entries) {
    if (entry.status !== "applied") continue;
    if (!entry.suggested_fix) continue; // guard (planAutofixes garante, mas TS)

    // Apenas newsletter — social não é tocado (invalidaria o sentinel do humanizador)
    // Claims com sources: ["social"] only são documentados como skipped no log.
    // Guard: sources pode ser undefined se o fact-checker omitir o campo (#2628 gap 2).
    const hasNewsletter = (entry.sources ?? []).includes("newsletter");
    if (!hasNewsletter) {
      entry.status = "skipped_text_not_found";
      entry.note = "Claim apenas em social — auto-fix restrito a 02-reviewed.md para preservar sentinel do humanizador (#2617).";
      continue;
    }

    // Encontrar o bloco do destaque para substituição scoped (#2617)
    const scope = findDestaqueBodyRange(newsletter, entry.destaque);
    if (!scope) {
      console.warn(`[apply-factcheck-autofix] WARN: bloco DESTAQUE ${entry.destaque} não encontrado em 02-reviewed.md — pulando claim "${entry.text}"`);
      entry.status = "skipped_text_not_found";
      entry.note = `Bloco DESTAQUE ${entry.destaque} não encontrado no corpo de 02-reviewed.md.`;
      continue;
    }

    const { changed, content: newContent } = applyTextSubstitution(
      newsletter,
      entry.text,
      entry.suggested_fix,
      scope,
    );

    if (changed) {
      // Atualizar in-memory SEMPRE (inclusive dry-run) para que substituições
      // sequenciais reflitam o estado real do documento (#2617).
      newsletter = newContent;
      entry.files_modified = ["newsletter"];
      if (!isDryRun) {
        filesModifiedSet.add(newsletterPath);
      }
    } else {
      entry.status = "skipped_text_not_found";
      entry.note = `Texto "${entry.text}" não encontrado no bloco DESTAQUE ${entry.destaque} de 02-reviewed.md.`;
    }
  }

  // Gravar arquivos modificados (não dry-run)
  if (!isDryRun) {
    for (const path of filesModifiedSet) {
      if (path === newsletterPath) writeFileSync(path, newsletter, "utf8");
    }
  }

  // Montar resultado
  const applied = entries.filter((e) => e.status === "applied").length;
  const skipped = entries.length - applied;

  const result: AutofixResult = {
    edition,
    applied_at: new Date().toISOString(),
    dry_run: isDryRun,
    intentional_error_destaque: intentionalDestaque,
    entries,
    summary: {
      total_divergent: entries.length,
      applied,
      skipped,
    },
  };

  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");

  // Saída para o orchestrator
  if (applied > 0) {
    console.log(`[apply-factcheck-autofix] ${isDryRun ? "[DRY-RUN] " : ""}${applied} correção(ões) aplicada(s) automaticamente:`);
    for (const e of entries.filter((x) => x.status === "applied")) {
      console.log(`  D${e.destaque} [${e.claim_type}] "${e.text}" → "${e.suggested_fix}" (${(e.files_modified ?? []).join(", ")})`);
    }
  } else {
    console.log(`[apply-factcheck-autofix] Nenhuma correção automática disponível (${skipped} claim(s) pulado(s)).`);
  }

  if (skipped > 0) {
    for (const e of entries.filter((x) => x.status !== "applied")) {
      console.log(`  ⏭  D${e.destaque} [${e.claim_type}] "${e.text}" — ${e.status}${e.note ? ": " + e.note : ""}`);
    }
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error("[apply-factcheck-autofix] ERRO:", e);
    process.exit(1);
  });
}
