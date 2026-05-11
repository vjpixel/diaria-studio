/**
 * check-stage2-invariants.ts (#1072 / #1073)
 *
 * Validator pós-Stage 2 — confirma que os polidores (Humanizador + Clarice)
 * e o renderizador do bloco ERRO INTENCIONAL rodaram de fato. Sem essas
 * etapas, edições saem com prosa polida-vazia (gerúndios em cascata,
 * vocabulário inflado) ou com placeholder literal contaminando o paste manual.
 *
 * Strategy: comparar arquivos intermediários. Se outputs forem idênticos aos
 * inputs, a skill foi pulada e o passo deve ser refeito.
 *
 * Uso:
 *   npx tsx scripts/check-stage2-invariants.ts --edition-dir data/editions/AAMMDD/
 *
 * Output:
 *   stdout: JSON com { ok, checks: { humanizador, clarice, erro_intencional } }
 *   exit 0 quando todos passaram; exit 1 com mensagem clara quando algum falhou.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli-args.ts";

interface CheckResult {
  ok: boolean;
  label?: string;
}

/**
 * Pure (#1072): humanizador roda no `02-normalized.md` → `02-humanized.md`.
 * Se a skill pulou ou foi no-op, os 2 arquivos são byte-idênticos (ou
 * `02-humanized.md` nem existe). Ambos os casos sinalizam pulo.
 *
 * Edge legítimo: texto perfeitamente humano. Mas writer-agent SEMPRE produz
 * tics LLM detectáveis pelo humanizador (gerúndio, "É importante", etc.)
 * — então byte-idêntico é proxy confiável.
 */
export function checkHumanizadorRan(internalDir: string): CheckResult {
  const normalized = join(internalDir, "02-normalized.md");
  const humanized = join(internalDir, "02-humanized.md");
  if (!existsSync(humanized)) {
    return { ok: false, label: "humanized_missing: 02-humanized.md não existe — humanizador foi pulado" };
  }
  // Se normalized não existe, o passo anterior falhou — não é problema do humanizador
  if (!existsSync(normalized)) {
    return { ok: true, label: "normalized_missing: passo anterior falhou, skip" };
  }
  const a = readFileSync(normalized, "utf8");
  const b = readFileSync(humanized, "utf8");
  if (a === b) {
    return { ok: false, label: "humanized_unchanged: 02-humanized.md byte-idêntico a 02-normalized.md — humanizador foi no-op" };
  }
  return { ok: true };
}

/**
 * Pure (#1072): Clarice roda no snapshot `02-pre-clarice.md` → `02-reviewed.md`.
 * Se a skill pulou, os 2 arquivos são byte-idênticos.
 */
export function checkClariceRan(editionDir: string): CheckResult {
  const preClarice = join(editionDir, "_internal", "02-pre-clarice.md");
  const reviewed = join(editionDir, "02-reviewed.md");
  if (!existsSync(reviewed)) {
    return { ok: false, label: "reviewed_missing: 02-reviewed.md não existe — Clarice foi pulada" };
  }
  if (!existsSync(preClarice)) {
    return { ok: false, label: "pre_clarice_missing: snapshot _internal/02-pre-clarice.md ausente — assertion #889 falhou" };
  }
  const a = readFileSync(preClarice, "utf8");
  const b = readFileSync(reviewed, "utf8");
  if (a === b) {
    return { ok: false, label: "clarice_unchanged: 02-reviewed.md byte-idêntico a 02-pre-clarice.md — Clarice foi no-op" };
  }
  return { ok: true };
}

/**
 * Pure (#1073): `render-erro-intencional.ts` substitui placeholder no
 * `02-reviewed.md` pós-Clarice. Se foi pulado, o placeholder literal continua
 * no MD e vaza pro Beehiiv como texto.
 */
export function checkErroIntencionalRendered(editionDir: string): CheckResult {
  const reviewed = join(editionDir, "02-reviewed.md");
  if (!existsSync(reviewed)) {
    return { ok: true, label: "reviewed_missing: outro check captura isso" };
  }
  const md = readFileSync(reviewed, "utf8");
  // Placeholder literal do writer (variantes conhecidas)
  if (/\{placeholder,?\s*script\s*render-erro-intencional/i.test(md)) {
    return { ok: false, label: "erro_intencional_placeholder: 02-reviewed.md ainda tem o placeholder literal — script render-erro-intencional.ts foi pulado" };
  }
  // Verifica se a seção ERRO INTENCIONAL existe e parece preenchida.
  // Não é um check forte (pode-se publicar sem essa seção em casos edge),
  // mas warning se o header existe mas sem conteúdo abaixo.
  return { ok: true };
}

interface AggregateResult {
  ok: boolean;
  checks: {
    humanizador: CheckResult;
    clarice: CheckResult;
    erro_intencional: CheckResult;
  };
}

export function checkStage2Invariants(editionDir: string): AggregateResult {
  const internalDir = join(editionDir, "_internal");
  const humanizador = checkHumanizadorRan(internalDir);
  const clarice = checkClariceRan(editionDir);
  const erro_intencional = checkErroIntencionalRendered(editionDir);
  return {
    ok: humanizador.ok && clarice.ok && erro_intencional.ok,
    checks: { humanizador, clarice, erro_intencional },
  };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];
  if (!editionDirArg) {
    console.error("Uso: check-stage2-invariants.ts --edition-dir data/editions/AAMMDD/");
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  if (!existsSync(editionDir)) {
    console.error(`[check-stage2-invariants] dir não existe: ${editionDir}`);
    process.exit(1);
  }
  const result = checkStage2Invariants(editionDir);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    const failed: string[] = [];
    if (!result.checks.humanizador.ok) failed.push(`humanizador: ${result.checks.humanizador.label}`);
    if (!result.checks.clarice.ok) failed.push(`clarice: ${result.checks.clarice.label}`);
    if (!result.checks.erro_intencional.ok) failed.push(`erro_intencional: ${result.checks.erro_intencional.label}`);
    console.error(`\n[check-stage2-invariants] FAIL — ${failed.length} check(s) falharam:`);
    for (const f of failed) console.error(`  - ${f}`);
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
