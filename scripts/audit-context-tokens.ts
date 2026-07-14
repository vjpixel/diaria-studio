/**
 * audit-context-tokens.ts (#3438)
 *
 * Audita `context/` (todo arquivo ali entra no prompt cache — CLAUDE.md
 * §"Otimização de tokens") para:
 *   1. Tamanho por arquivo (bytes + estimativa de tokens).
 *   2. Invalidadores de cache silenciosos (timestamps/UUIDs/conteúdo que
 *      muda a cada render embutido no meio do arquivo, fora de um cabeçalho
 *      estático de metadata).
 *
 * Estimativa de tokens é heurística (chars/4) — não usa `messages.count_tokens`
 * porque este script roda sem acesso à API Anthropic (nem sempre há
 * ANTHROPIC_API_KEY no ambiente local). Trate como aproximação; pra número
 * exato, rode `ant messages count-tokens --message "@<arquivo>"` por arquivo
 * (skill claude-api § token-counting).
 *
 * Uso:
 *   npx tsx scripts/audit-context-tokens.ts [--dir context] [--out <path>]
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface FileAudit {
  path: string; // relative to repo root
  bytes: number;
  estimatedTokens: number;
  invalidators: string[]; // descriptions of matches, empty if clean
}

/**
 * Padrões que indicariam conteúdo volátil embutido fora de um cabeçalho
 * estático de metadata (ex: `**updated_at:** 2026-06-18` no topo de um
 * arquivo gerado é esperado e não é um invalidador — só regenera quando o
 * arquivo é regenerado, não a cada chamada de agente). Padrões abaixo
 * miram o que mudaria a CADA render/chamada se estivesse presente.
 */
const INVALIDATOR_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "new Date() / Date.now() literal em prosa", re: /\bnew Date\(\)|\bDate\.now\(\)/ },
  { label: "UUID literal", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { label: "timestamp ISO 8601 completo (fora de exemplo de código)", re: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/ },
];

/** Chars/4 é a heurística mais simples; runs perto de português com acentos
 * UTF-8 e blocos de código tendem a ficar um pouco abaixo do custo real —
 * trate como piso, não teto. */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

export function findInvalidators(content: string): string[] {
  const found: string[] = [];
  for (const { label, re } of INVALIDATOR_PATTERNS) {
    if (re.test(content)) found.push(label);
  }
  return found;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

export function auditDir(dir: string): FileAudit[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  walk(dir, files);
  return files
    .map((f) => {
      const content = readFileSync(f, "utf8");
      return {
        path: relative(ROOT, f).split("\\").join("/"),
        bytes: Buffer.byteLength(content, "utf8"),
        estimatedTokens: estimateTokens(content),
        invalidators: findInvalidators(content),
      };
    })
    .sort((a, b) => b.bytes - a.bytes);
}

export function formatReport(files: FileAudit[]): string {
  const totalBytes = files.reduce((a, f) => a + f.bytes, 0);
  const totalTokens = files.reduce((a, f) => a + f.estimatedTokens, 0);
  const flagged = files.filter((f) => f.invalidators.length > 0);

  const lines: string[] = [
    "# Context Token Audit",
    "",
    `Total: ${files.length} arquivos, ${totalBytes} bytes, ~${totalTokens} tokens (estimativa chars/4).`,
    "",
    "| Arquivo | Bytes | ~Tokens | Invalidadores |",
    "|---|---:|---:|---|",
  ];
  for (const f of files) {
    lines.push(
      `| ${f.path} | ${f.bytes} | ${f.estimatedTokens} | ${f.invalidators.length ? f.invalidators.join("; ") : "-"} |`,
    );
  }
  lines.push("");
  lines.push(
    flagged.length === 0
      ? "Nenhum invalidador de cache detectado nos padrões verificados."
      : `${flagged.length} arquivo(s) com possível invalidador — revisar manualmente (pode ser exemplo estático em prosa/código, não necessariamente um invalidador real).`,
  );
  return lines.join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(ROOT, (args.dir as string) ?? "context");
  const files = auditDir(dir);
  const report = formatReport(files);

  if (args.out) {
    const outPath = resolve(ROOT, args.out as string);
    writeFileSync(outPath, report, "utf8");
    console.log(`✓ report gravado em ${outPath}`);
  } else {
    process.stdout.write(report + "\n");
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
