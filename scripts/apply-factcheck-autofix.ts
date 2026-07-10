/**
 * apply-factcheck-autofix.ts (#2598, estendido a social em #3224)
 *
 * Pré-aplica correções determinísticas de claims DIVERGENT do fact-checker em
 * `02-reviewed.md` (newsletter) E `03-social.md` (social) ANTES de montar o
 * gate do Stage 4.
 *
 * Regras de aplicação:
 *   1. Só claims com `verdict === "DIVERGENT"` E `suggested_fix` presente.
 *   2. Nunca auto-corrigir claims do tipo `superlative` (são de ineditismo/tom,
 *      não divergências factuais determísticas).
 *   3. NOT_FOUND_IN_SOURCE nunca recebe suggested_fix → não é processado.
 *   4. Pular claim cujo `destaque` bate com o destaque do `intentional_error`
 *      declarado em `_internal/intentional-error.json` (não tocar erro intencional).
 *   5. Substituição é SCOPED ao bloco do destaque correto — evita clobberar
 *      o intentional_error de outro destaque com mesmo texto (#2617). Em
 *      `03-social.md`, o "bloco do destaque" são os headers `## dN` — pode
 *      haver até 2 (um em `# LinkedIn`, outro em `# Facebook`) e a correção
 *      é aplicada em AMBOS quando o texto aparece nos dois (#3224).
 *   6. `entry.sources` decide ONDE aplicar: `["newsletter"]` → só newsletter,
 *      `["social"]` → só social, `["newsletter","social"]` → em ambos (cada
 *      um só se o texto de fato aparecer lá — sucesso parcial é permitido e
 *      registrado em `files_modified`). Antes do #3224, claims social-only
 *      eram sempre skipped para preservar o sentinel do humanizador; agora
 *      o sentinel é regravado com bypass explícito (`check-humanizer-social.ts`
 *      `writeSentinel`, mecanismo já validado pelo #2529) logo após a escrita
 *      em `03-social.md`, evitando reinventar a trava.
 *
 * Output:
 *   `_internal/fact-check-autofix.json` — log de cada correção aplicada/pulada.
 *   Campo `social_modified: true` sinaliza pro orchestrator que precisa
 *   re-renderizar e republicar o preview social (#3224, análogo ao re-render
 *   obrigatório da newsletter quando `summary.applied > 0`).
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
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { writeSentinel } from "./check-humanizer-social.ts";

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
  /** (#3224) true quando ao menos 1 correção foi escrita em `03-social.md`
   * nesta execução (sempre `false` em `--dry-run`, já que nada é escrito em
   * disco). Sinaliza pro orchestrator que precisa re-renderizar/republicar o
   * preview social (§4c.6b) — análogo ao re-render obrigatório da newsletter
   * quando `summary.applied > 0`. */
  social_modified: boolean;
  /** (#3224) Razão de bypass usada ao regravar `.humanizer-social-done.json`
   * via `check-humanizer-social.ts`'s `writeSentinel` — presente apenas quando
   * `social_modified === true`. */
  social_sentinel_bypass_reason?: string;
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
 * (#3224) Encontra TODOS os ranges (start, end) dos blocos `## dN` em
 * `03-social.md` para o `destaque` dado. Pode haver até 2 — um sob `# LinkedIn`,
 * outro sob `# Facebook` (`merge-social-md.ts` concatena os dois canais no
 * mesmo arquivo) — daí retornar um array em vez de um único range como
 * `findDestaqueBodyRange` (newsletter tem só 1 ocorrência de cada DESTAQUE N).
 *
 * Delimitação: QUALQUER header de 1 ou 2 hashes (`# LinkedIn`, `# Facebook`,
 * `## d1`, `## d2`, `## d3`, `## post_pixel`) fecha o bloco aberto. Headers de
 * 3 hashes (`### comment_diaria`, `### comment_pixel`) ficam DENTRO do bloco —
 * não fecham (mesmo padrão de `parseSocialByDestaque` em lint-social-numbers.ts).
 * Retorna `[]` se o destaque não aparece no arquivo.
 */
export function findSocialDestaqueRanges(
  content: string,
  destaque: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const lines = content.split("\n");
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1; // +1 pelo "\n" removido no split
  }

  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^#{1,2}\s+\S/.test(line)) continue; // não é boundary (1-2 hashes; "###..." não casa)

    // Qualquer header-boundary fecha o bloco aberto (se houver)
    if (openIdx !== -1) {
      ranges[openIdx].end = lineOffsets[i];
      openIdx = -1;
    }

    const dHeader = line.match(/^##\s+d(\d)\b/i);
    if (dHeader && parseInt(dHeader[1], 10) === destaque) {
      ranges.push({ start: lineOffsets[i], end: content.length });
      openIdx = ranges.length - 1;
    }
  }
  return ranges;
}

/**
 * (#3224) Aplica substituição de `oldText` → `newText` em TODOS os ranges
 * `## dN` do destaque em `03-social.md` (até 2: LinkedIn + Facebook) — no
 * máximo 1 substituição por range (primeira ocorrência), mesma semântica
 * conservadora de `applyTextSubstitution`. Compensa o offset dos ranges
 * seguintes à medida que o conteúdo muda (delta de comprimento oldText→newText),
 * já que os ranges são calculados uma vez sobre o conteúdo original.
 */
export function applySocialTextSubstitution(
  content: string,
  destaque: number,
  oldText: string,
  newText: string,
): { changed: boolean; content: string; modifiedRanges: number } {
  const ranges = findSocialDestaqueRanges(content, destaque);
  let current = content;
  let delta = 0;
  let modifiedRanges = 0;
  for (const range of ranges) {
    const adjusted = { start: range.start + delta, end: range.end + delta };
    const result = applyTextSubstitution(current, oldText, newText, adjusted);
    if (result.changed) {
      current = result.content;
      delta += newText.length - oldText.length;
      modifiedRanges++;
    }
  }
  return { changed: modifiedRanges > 0, content: current, modifiedRanges };
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
  const socialPath = join(editionDir, "03-social.md");
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
  const socialExists = existsSync(socialPath);
  let social = socialExists ? readFileSync(socialPath, "utf8") : "";

  // Extrair destaque do erro intencional (#3222: _internal/intentional-error.json)
  const intentionalErrorRecord = loadIntentionalErrorJson(intentionalErrorJsonPath(editionDir));
  const intentionalDestaque = extractIntentionalErrorDestaque(intentionalErrorRecord);

  // Planejar autofixes
  const entries = planAutofixes(factCheck.claims, intentionalDestaque);

  // Aplicar substituições — newsletter SCOPED ao bloco DESTAQUE N (#2617);
  // social SCOPED aos blocos ## dN (#3224, pode tocar LinkedIn + Facebook).
  let newsletterModified = false;
  let socialModified = false;

  for (const entry of entries) {
    if (entry.status !== "applied") continue;
    if (!entry.suggested_fix) continue; // guard (planAutofixes garante, mas TS)

    // Guard: sources pode ser undefined se o fact-checker omitir o campo (#2628 gap 2).
    const sources = entry.sources ?? [];
    const hasNewsletter = sources.includes("newsletter");
    const hasSocial = sources.includes("social");
    const filesModified: string[] = [];
    const failureNotes: string[] = [];

    if (hasNewsletter) {
      const scope = findDestaqueBodyRange(newsletter, entry.destaque);
      if (!scope) {
        console.warn(`[apply-factcheck-autofix] WARN: bloco DESTAQUE ${entry.destaque} não encontrado em 02-reviewed.md — pulando claim "${entry.text}"`);
        failureNotes.push(`Bloco DESTAQUE ${entry.destaque} não encontrado no corpo de 02-reviewed.md.`);
      } else {
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
          filesModified.push("newsletter");
          if (!isDryRun) newsletterModified = true;
        } else {
          failureNotes.push(`Texto "${entry.text}" não encontrado no bloco DESTAQUE ${entry.destaque} de 02-reviewed.md.`);
        }
      }
    }

    // (#3224) social: aplica em TODOS os blocos ## dN (LinkedIn + Facebook) —
    // reusa o mecanismo de bypass do sentinel do humanizador já validado pelo
    // #2529, em vez do skip incondicional de antes.
    if (hasSocial) {
      if (!socialExists) {
        failureNotes.push("03-social.md ausente — correção social pulada.");
      } else {
        const { changed, content: newContent } = applySocialTextSubstitution(
          social,
          entry.destaque,
          entry.text,
          entry.suggested_fix,
        );
        if (changed) {
          social = newContent;
          filesModified.push("social");
          if (!isDryRun) socialModified = true;
        } else {
          failureNotes.push(`Texto "${entry.text}" não encontrado nos blocos ## d${entry.destaque} de 03-social.md.`);
        }
      }
    }

    if (filesModified.length > 0) {
      entry.status = "applied";
      entry.files_modified = filesModified;
      // Sucesso parcial (ex: corrigiu newsletter mas não achou em social) —
      // registrar o motivo pra transparência no gate, sem virar skip.
      if (failureNotes.length > 0) entry.note = failureNotes.join(" ");
    } else {
      entry.status = "skipped_text_not_found";
      entry.note = failureNotes.join(" ") || "Texto não encontrado em nenhum arquivo aplicável.";
    }
  }

  // Gravar arquivos modificados + regravar sentinel do humanizador social (não dry-run)
  let socialSentinelBypassReason: string | undefined;
  if (!isDryRun) {
    if (newsletterModified) {
      writeFileSync(newsletterPath, newsletter, "utf8");
    }
    if (socialModified) {
      writeFileSync(socialPath, social, "utf8");
      // (#3224) Regrava o sentinel com bypass explícito — reusa o mecanismo já
      // validado em produção pelo #2529 (`check-humanizer-social.ts`'s
      // `writeSentinel`) em vez de inventar um novo, evitando falso-alarme de
      // "social editado sem re-humanizar" no próximo `--check`.
      const appliedSocialEntries = entries.filter(
        (e) => e.status === "applied" && (e.files_modified ?? []).includes("social"),
      );
      const destaquesTouched = [...new Set(appliedSocialEntries.map((e) => `D${e.destaque}`))].sort();
      socialSentinelBypassReason =
        `factcheck-autofix: ${appliedSocialEntries.length} correção(ões) DIVERGENT aplicada(s) em 03-social.md (${destaquesTouched.join(", ")})`;
      try {
        writeSentinel(editionDir, socialSentinelBypassReason);
      } catch (e) {
        console.warn(`[apply-factcheck-autofix] WARN: falha ao regravar sentinel do humanizador social — ${(e as Error).message}`);
      }
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
    social_modified: socialModified,
    ...(socialSentinelBypassReason ? { social_sentinel_bypass_reason: socialSentinelBypassReason } : {}),
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

  if (result.social_modified) {
    console.log(
      `[apply-factcheck-autofix] 03-social.md corrigido — sentinel do humanizador regravado com bypass (#3224). ` +
      `Re-renderizar e republicar o preview social antes do gate (§4c.6b).`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[apply-factcheck-autofix] ERRO:", e);
    process.exit(1);
  });
}
