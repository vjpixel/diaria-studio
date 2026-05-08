/**
 * sync-intro-count.ts (#743, #876)
 *
 * Lê um MD de newsletter, calcula a contagem real de URLs editoriais e,
 * se o número declarado na intro ("Selecionamos os N mais relevantes")
 * divergir da contagem real, corrige cirurgicamente o número.
 *
 * #876 — opcionalmente também ajusta menções narrativas a "X lançamentos"
 * quando `_internal/02-lancamentos-removed.json` existe (escrito por
 * `validate-lancamentos.ts --approved ... --write-removed ...` em §2a do
 * orchestrator-stage-2). Isso evita que a narrativa do intro diga "5
 * lançamentos da semana" quando o cap pré-writer rejeitou 2 por URL não
 * oficial e a edição final só carrega 3.
 *
 * Uso:
 *   npx tsx scripts/sync-intro-count.ts --md <md-path>
 *     [--lancamentos-removed <_internal/02-lancamentos-removed.json>]
 *
 * Exit codes:
 *   0  OK (com ou sem correção)
 *   1  Erro de leitura / parse
 *
 * Output JSON em stdout:
 *   { changed, claimed_before, actual, lancamentos_changed, path }
 *
 * Warn em stderr quando algum número é corrigido.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { lintIntroCount } from "./lint-newsletter-md.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure helpers (#876) — exportadas para testes
// ---------------------------------------------------------------------------

export interface LancamentosRemovedSummary {
  removed: Array<{ url: string; title?: string; reason: string }>;
  original_count: number;
  final_count: number;
}

/**
 * Substitui menções narrativas a "N lançamentos" / "N lançamento" no MD,
 * trocando `original_count` por `final_count`. Cobertura intencionalmente
 * cirúrgica: regex word-boundary numérico + lookahead pra não mexer em
 * ordinais ("1º lançamento") nem em listas markdown ("1. lançamento").
 *
 * Retorna `{ md, changed }`. `changed=true` quando pelo menos uma
 * substituição foi feita.
 */
export function syncLancamentosNarrative(
  md: string,
  summary: LancamentosRemovedSummary,
): { md: string; changed: boolean } {
  if (
    !summary ||
    summary.final_count === summary.original_count ||
    summary.original_count <= 0
  ) {
    return { md, changed: false };
  }

  const original = String(summary.original_count);
  const finalStr = String(summary.final_count);

  // Match `\b(\d+)\s+lançament[oa]s?\b` (case-insensitive, \b funciona com
  // dígitos). Captura `\b\d+` no group 1 para preservar capitalização do
  // resto. Aceita "lançamento", "lançamentos", "lançamenta", "lançamentas"
  // (variação narrativa).
  // Nota: \b após `lançamento[s|...]` falha em final de string puro pq `\b`
  // requer transição word/non-word — para `lançamentos.` ou `lançamentos `
  // funciona; para EOF, o cobrimos via lookahead.
  const re = new RegExp(
    `\\b(${original})(\\s+lan[çc]ament[oa]s?)\\b`,
    "gi",
  );
  let changed = false;
  const newMd = md.replace(re, (_match, _num, tail) => {
    changed = true;
    return `${finalStr}${tail}`;
  });
  return { md: newMd, changed };
}

function loadRemovedSummary(path: string): LancamentosRemovedSummary | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as LancamentosRemovedSummary;
    if (
      typeof parsed.original_count !== "number" ||
      typeof parsed.final_count !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function main(): void {
  const ROOT = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  if (!args.md) {
    console.error(
      "Uso: sync-intro-count.ts --md <md-path> [--lancamentos-removed <path>]",
    );
    process.exit(1);
  }
  const mdPath = resolve(ROOT, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(1);
  }

  let md = readFileSync(mdPath, "utf8");
  let changedAny = false;

  // ---- Passo 1 (#876): ajustar menções narrativas a "X lançamentos" ----
  let lancamentosChanged = false;
  if (args["lancamentos-removed"]) {
    const removedPath = resolve(ROOT, args["lancamentos-removed"]);
    const summary = loadRemovedSummary(removedPath);
    if (summary && summary.original_count !== summary.final_count) {
      const result = syncLancamentosNarrative(md, summary);
      if (result.changed) {
        md = result.md;
        lancamentosChanged = true;
        changedAny = true;
        console.error(
          `warn: sync-intro-count: narrativa do intro mencionava ${summary.original_count} lançamento(s) ` +
            `mas validate-lancamentos manteve apenas ${summary.final_count} — ajustado em ${mdPath}`,
        );
      }
    }
  }

  // ---- Passo 2 (#743): ajustar contagem total na intro ----
  const check = lintIntroCount(md);
  let claimedBefore = check.claimed;
  let countChanged = false;

  if (
    !check.ok &&
    check.claimed !== undefined &&
    check.actual !== undefined
  ) {
    // #973 hard guard: actual === 0 é claramente bug do parser (newsletter
    // sem nenhuma URL editorial nunca acontece em produção). Em vez de
    // sobrescrever a intro com "Selecionamos os 0 mais relevantes",
    // logar erro e pular a sincronização — contagem real fica intacta.
    if (check.actual === 0) {
      console.error(
        `error: sync-intro-count: contagem real retornou 0 — provável bug de parser (formato do template mudou?). ` +
          `Pulando sincronização do total. Verificar template e abrir issue se necessário.`,
      );
    } else {
      const claimedStr = String(check.claimed);
      const actualStr = String(check.actual);
      const patternRe = new RegExp(
        `((?:Selecionamos|Escolhemos|Reunimos|Destacamos|Separamos|Trouxemos)\\s+os?\\s+)${claimedStr}\\b`,
        "i",
      );
      if (patternRe.test(md)) {
        md = md.replace(patternRe, `$1${actualStr}`);
        countChanged = true;
        changedAny = true;
        console.error(
          `warn: sync-intro-count: intro dizia ${check.claimed} mas contagem real é ${check.actual} — corrigido em ${mdPath}`,
        );
      } else {
        // Padrão não encontrado após expansão — avisa mas não bloqueia
        console.error(
          `warn: sync-intro-count: padrão não encontrado — verificar manualmente se a intro tem o número correto.`,
        );
      }
    }
  }

  if (changedAny) {
    writeFileSync(mdPath, md, "utf8");
  }

  console.log(
    JSON.stringify({
      changed: countChanged,
      claimed_before: claimedBefore,
      actual: check.actual,
      lancamentos_changed: lancamentosChanged,
      path: mdPath,
    }),
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
