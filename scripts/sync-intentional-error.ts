#!/usr/bin/env npx tsx
/**
 * sync-intentional-error.ts (#754; #3222 — checkIntentionalError agora lê
 * `_internal/intentional-error.json` em vez de frontmatter YAML de
 * `02-reviewed.md`, transparente pra este script)
 *
 * Lê `intentional_error` da edição (via `checkIntentionalError`, que lê
 * `_internal/intentional-error.json` — nunca sincroniza com o Drive, #959)
 * e sincroniza com `data/intentional-errors.jsonl` (idempotente — só
 * adiciona se a edição ainda não tem entry com source="frontmatter_02_reviewed",
 * nome de source preservado por compat histórico).
 *
 * Roda em sequência depois do lint `intentional-error-flagged` no
 * publish-newsletter (Stage 4 passo 0). Garante que `lint-test-email`
 * (Stage 4 review-test-email) reconhece o erro intencional declarado.
 *
 * **#3210:** também chamado programaticamente por `close-poll.ts`
 * (`runSyncIntentionalError`, exportada abaixo) — `close-poll.ts` roda tanto
 * no fluxo automático (Stage 4 pré-render) quanto no fluxo manual
 * (`prep-manual-publish.ts` → paste no Beehiiv → `close-poll.ts`), então
 * wireing o sync ali fecha o gap onde a publicação manual nunca chamava
 * este script — `data/intentional-errors.jsonl` ficava sem entry, e
 * §0-replies (Stage 0) não conseguia creditar acerto de leitor.
 *
 * Uso:
 *   npx tsx scripts/sync-intentional-error.ts \
 *     --md data/editions/{AAMMDD}/02-reviewed.md \
 *     --edition {AAMMDD} \
 *     --jsonl data/intentional-errors.jsonl
 *
 * Exit codes:
 *   0 = sync ok (added: bool no stdout)
 *   1 = frontmatter ausente ou incompleto (não deveria acontecer pós-lint)
 *   2 = erro de uso
 */

import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkIntentionalError } from "./lint-newsletter-md.ts";
import {
  loadIntentionalErrors,
  syncFrontmatterToEntries,
  type IntentionalError,
} from "./lib/intentional-errors.ts";
// #1860: fallback de prosa quando o frontmatter falta.
import { extractIntentionalErrorFromMd } from "./render-erro-intencional.ts";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts"; // #2834

export interface Flags {
  md: string;
  edition: string;
  jsonl: string;
}

function parseArgs(argv: string[]): Flags | null {
  const { values } = parseCliArgs(argv);
  if (!values.md || !values.edition || !values.jsonl) {
    return null;
  }
  return { md: values.md, edition: values.edition, jsonl: values.jsonl };
}

function appendJsonl(path: string, entry: IntentionalError): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  if (!existsSync(path)) {
    // Atomic create
    const tmp = path + ".tmp";
    writeFileSync(tmp, line, "utf8");
    renameSync(tmp, path);
  } else {
    appendFileSync(path, line, "utf8");
  }
}

/**
 * #1589: re-escreve o JSONL inteiro a partir do array `entries`. Usado quando
 * uma entry pre-existente foi atualizada (não dá pra fazer in-place edit num
 * append-only JSONL — precisa re-escrever).
 */
function rewriteJsonl(path: string, entries: IntentionalError[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  const tmp = path + ".tmp";
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

/**
 * (#3210) Núcleo do sync, extraído de `main()` pra ser chamável
 * programaticamente (`close-poll.ts`) além do uso via CLI. Nunca lança —
 * qualquer exceção inesperada (ex: I/O) é capturada e vira exit code 1 com
 * a mensagem em stderr, igual ao contrato de erro já estabelecido pelos
 * demais branches. Callers programáticos (ex: `close-poll.ts`) tratam
 * qualquer exit != 0 como fail-soft (warning, não bloqueia).
 */
export function runSyncIntentionalError(flags: Flags): number {
  try {
    return runSyncIntentionalErrorInner(flags);
  } catch (e) {
    process.stderr.write(
      `[sync-intentional-error] erro inesperado pra edição ${flags.edition}: ${(e as Error).message}\n`,
    );
    return 1;
  }
}

function runSyncIntentionalErrorInner(flags: Flags): number {
  const mdPath = resolve(process.cwd(), flags.md);
  const jsonlPath = resolve(process.cwd(), flags.jsonl);

  // (#3210) Guard: mdPath pode já ter sido arquivado/limpo quando este script
  // é chamado por `close-poll.ts` bem depois da publicação (ou nunca existiu
  // pra essa edição). `checkIntentionalError` já retorna `ok:false` nesse
  // caso, mas o branch de fallback de prosa abaixo faz `readFileSync(mdPath)`
  // incondicionalmente — sem este guard, mdPath ausente lançaria ENOENT não
  // capturado (agora capturado por `runSyncIntentionalError`, mas evitar é
  // melhor que depender só do catch).
  if (!existsSync(mdPath)) {
    process.stderr.write(
      `[sync-intentional-error] ${mdPath} não existe — nada pra sincronizar pra edição ${flags.edition} (provável edição arquivada/limpa pós-publicação, #3210).\n`,
    );
    return 1;
  }

  const lintResult = checkIntentionalError(mdPath);

  // #2016: escalar `intentional_error: none` — editor declarou explicitamente
  // que esta edição não tem erro intencional. Gravamos entry com no_error=true
  // pra manter o registro da decisão (list-month-errors mostra "sem erro").
  if (lintResult.ok && lintResult.no_error) {
    const existing = loadIntentionalErrors(jsonlPath);
    // Guard de idempotência tightened (#2037 fix 1): só é no-op se já existe
    // entry com no_error=true. Entry pré-existente sem no_error (ex: sentinela
    // 4-campos da era pré-#2016) é sobrescrita, não bloqueada.
    if (existing.some((e) => e.edition === flags.edition && e.no_error === true)) {
      process.stderr.write(
        `[sync-intentional-error] edição ${flags.edition} já tem entry no_error=true — no-op\n`,
      );
      process.stdout.write(
        JSON.stringify({ added: false, updated: false, edition: flags.edition, no_error: true }, null, 2) + "\n",
      );
      return 0;
    }
    const entry: IntentionalError = {
      edition: flags.edition,
      error_type: "none",
      is_feature: false,
      no_error: true,
      source: "frontmatter_02_reviewed",
      detected_by: "sync-intentional-error.ts none scalar (#2016)",
      resolution: "no_error_declared",
    };
    const idx = existing.findIndex((e) => e.edition === flags.edition);
    if (idx !== -1) {
      // Sobrescrever entry pré-existente (ex: sentinela 4-campos)
      existing[idx] = entry;
      rewriteJsonl(jsonlPath, existing);
      process.stderr.write(
        `[sync-intentional-error] #2016/#2037: edição ${flags.edition} — entry pré-existente sobrescrita com no_error=true\n`,
      );
      process.stdout.write(
        JSON.stringify({ added: false, updated: true, edition: flags.edition, no_error: true }, null, 2) + "\n",
      );
    } else {
      appendJsonl(jsonlPath, entry);
      process.stderr.write(
        `[sync-intentional-error] #2016: edição ${flags.edition} declarada sem erro intencional (intentional_error: none)\n`,
      );
      process.stdout.write(
        JSON.stringify({ added: true, updated: false, edition: flags.edition, no_error: true }, null, 2) + "\n",
      );
    }
    return 0;
  }

  if (!lintResult.ok || !lintResult.parsed) {
    // #1860: frontmatter ausente/incompleto (publicação manual, ou erro
    // declarado só na prosa "Nessa edição, …"). Em vez de falhar — o que
    // deixa um buraco no JSONL e faz o reveal da próxima edição pular a
    // edição certa (#1854) — extrair da prosa e gravar com source="prose_block".
    const md = readFileSync(mdPath, "utf8");
    const prose = extractIntentionalErrorFromMd(md);
    if (prose) {
      const existing = loadIntentionalErrors(jsonlPath);
      if (existing.some((e) => e.edition === flags.edition)) {
        process.stderr.write(
          `[sync-intentional-error] edição ${flags.edition} já tem entry — no-op (fallback prosa)\n`,
        );
        process.stdout.write(
          JSON.stringify({ added: false, updated: false, edition: flags.edition, source: "prose_block" }, null, 2) + "\n",
        );
        return 0;
      }
      const entry: IntentionalError = {
        edition: flags.edition,
        error_type: "editor_declared",
        is_feature: true,
        detail: prose.detail ?? prose.narrative,
        // #1860: preserva a narrativa pra composeRevealText aplicar a correção
        // do #1443 ("o correto é Y") no reveal seguinte, em vez do detail cru.
        narrative: prose.narrative,
        ...(prose.correct_value ? { correct_value: prose.correct_value } : {}),
        // (#2419) Propaga campo `reveal` quando disponível no MD
        ...(prose.reveal ? { reveal: prose.reveal } : {}),
        source: "prose_block",
        detected_by: "sync-intentional-error.ts fallback de prosa (#1860)",
        resolution: "published_intentionally",
      };
      appendJsonl(jsonlPath, entry);
      process.stderr.write(
        `[sync-intentional-error] #1860: _internal/intentional-error.json ausente/incompleto — entry extraída da PROSA "Nessa edição, …" pra ${flags.edition}. ` +
          `Grave o record em _internal/intentional-error.json (#3222) pra silenciar este fallback.\n`,
      );
      process.stdout.write(
        JSON.stringify({ added: true, updated: false, edition: flags.edition, source: "prose_block" }, null, 2) + "\n",
      );
      return 0;
    }
    process.stderr.write(
      `_internal/intentional-error.json ausente/incompleto E sem prosa "Nessa edição, …" em ${flags.md}: ${lintResult.label}\n`,
    );
    return 1;
  }

  const existing = loadIntentionalErrors(jsonlPath);
  const { added, updated, entries } = syncFrontmatterToEntries(
    lintResult.parsed,
    flags.edition,
    existing,
  );

  if (added) {
    const newEntry = entries[entries.length - 1];
    appendJsonl(jsonlPath, newEntry);
    process.stderr.write(
      `[sync-intentional-error] entry adicionada pra edição ${flags.edition} (category: ${newEntry.error_type})\n`,
    );
  } else if (updated) {
    // #1589: entry pre-existente divergiu do frontmatter — re-escreve o JSONL
    // inteiro com a versão atualizada. MD é fonte autoritativa.
    rewriteJsonl(jsonlPath, entries);
    process.stderr.write(
      `[sync-intentional-error] entry atualizada pra edição ${flags.edition} (frontmatter divergia do JSONL)\n`,
    );
  } else {
    process.stderr.write(
      `[sync-intentional-error] edição ${flags.edition} já tem entry de frontmatter (bate) — no-op\n`,
    );
  }

  process.stdout.write(
    JSON.stringify({ added, updated, edition: flags.edition }, null, 2) + "\n",
  );
  return 0;
}

function main(): number {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  if (!flags) {
    process.stderr.write(
      "Uso: sync-intentional-error.ts --md <reviewed.md> --edition <AAMMDD> --jsonl <jsonl-path>\n",
    );
    return 2;
  }
  return runSyncIntentionalError(flags);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  process.exit(main());
}
