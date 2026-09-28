/**
 * test/cli-args-dash-prefix-guard.test.ts (#8932)
 *
 * Guard estrutural (mesmo molde de `test/getarg-numeric-guard-4573.test.ts`)
 * contra o padrão que causou o bug achado ao vivo em 28/09/2026 rodando o
 * regen semanal de hubs (#8906): `scripts/lib/cli-args.ts` (`parseArgs`)
 * guarda flags/values SEM o prefixo `--` (`values["session-id"]`,
 * `flags.add("dry-run")`) — chamar `hasFlag(argv, "--dry-run")` ou
 * `getArg(argv, "--session-id")` com o prefixo incluído na chave faz a
 * flag ser SEMPRE ignorada (`hasFlag` sempre `false`, `getArg` sempre `""`).
 *
 * `scripts/hubs-weekly-regen.ts` chamava as duas assim — `--dry-run` nunca
 * ativava o caminho de dry-run (rodava o caminho REAL) e `--session-id`
 * nunca era lido (o script só não chegou a escrever nada porque abortava
 * cedo com `session-id-ausente`, mascarando o 1º bug). Mesmo padrão achado
 * em `scripts/check-kv-image-binding.ts` e `scripts/task-registry-prose-drift-check.ts`
 * via `grep -rnE '(hasFlag|getArg|getIntArg|getStringArg)\([a-zA-Z_.]+, *"--' scripts/`.
 *
 * Este guard varre `scripts/**\/*.ts` atrás de `hasFlag(`/`getArg(`/
 * `getIntArg(`/`getStringArg(` chamados com uma chave literal começando com
 * `--` — nenhuma dessas 4 funções aceita esse prefixo (todas indexam
 * `parseArgs(...).flags`/`.values` por chave SEM `--`, conferido na fonte),
 * então o padrão é sempre um bug, nunca um caso legítimo — sem allowlist.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = join(ROOT, "scripts");

function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

/** Substitui comentário de bloco por espaços, preservando quebras de linha (mesmo padrão do #4573). */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block
      .split("\n")
      .map((line) => " ".repeat(line.length))
      .join("\n"),
  );
}

const DASH_PREFIX_RE = /\b(?:hasFlag|getArg|getIntArg|getStringArg)\(\s*[a-zA-Z_][a-zA-Z0-9_.]*\s*,\s*"--/g;

export interface DashPrefixMatch {
  /** Path relativo ao root do repo, POSIX. */
  file: string;
  line: number;
}

export function findDashPrefixUsages(dir: string): DashPrefixMatch[] {
  const found: DashPrefixMatch[] = [];
  for (const file of tsFilesUnder(dir)) {
    const rawSrc = readFileSync(file, "utf8");
    const src = stripBlockComments(rawSrc);
    const lines = src.split("\n");
    const relFile = file.slice(ROOT.length + 1).split("\\").join("/");
    lines.forEach((lineText, idx) => {
      DASH_PREFIX_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DASH_PREFIX_RE.exec(lineText))) {
        const commentIdx = lineText.indexOf("//");
        if (commentIdx !== -1 && commentIdx < m.index) continue;
        found.push({ file: relFile, line: idx + 1 });
      }
    });
  }
  return found;
}

/** Aplica o mesmo scanner de `findDashPrefixUsages` sobre uma fixture em memória, sem tocar disco. */
function scanFixture(fixture: string, relFile: string): DashPrefixMatch[] {
  const src = stripBlockComments(fixture);
  const lines = src.split("\n");
  const matches: DashPrefixMatch[] = [];
  lines.forEach((lineText, idx) => {
    DASH_PREFIX_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DASH_PREFIX_RE.exec(lineText))) {
      const commentIdx = lineText.indexOf("//");
      if (commentIdx !== -1 && commentIdx < m.index) continue;
      matches.push({ file: relFile, line: idx + 1 });
    }
  });
  return matches;
}

describe("guard estrutural: hasFlag/getArg/getIntArg/getStringArg chamados com chave prefixada por -- (#8932)", () => {
  it("scripts/ não tem nenhuma ocorrência do padrão (parseArgs guarda chave SEM --, sempre um bug)", () => {
    const found = findDashPrefixUsages(SCRIPTS_DIR);
    assert.deepEqual(
      found,
      [],
      `hasFlag/getArg/getIntArg/getStringArg chamados com "--" na chave — parseArgs em ` +
        `scripts/lib/cli-args.ts guarda flags/values SEM o prefixo "--", então a flag é ` +
        `SEMPRE ignorada. Remova o "--" da chave:\n  ${found.map((m) => `${m.file}:${m.line}`).join("\n  ")}`,
    );
  });

  it("mutação: reproduz o padrão exato achado em hubs-weekly-regen.ts antes do fix (fixture sintética)", () => {
    const fixture = [
      "export async function main(): Promise<void> {",
      "  const argv = process.argv.slice(2);",
      '  const dryRun = hasFlag(argv, "--dry-run");',
      '  const sessionId = getArg(argv, "--session-id") || undefined;',
      "}",
    ].join("\n");
    const found = scanFixture(fixture, "fixture/hubs-weekly-regen-before-fix.ts");
    assert.ok(
      found.some((m) => m.line === 3) && found.some((m) => m.line === 4),
      `esperava flagar as linhas 3 e 4 — achou: ${JSON.stringify(found)}`,
    );
  });

  it("sanity: chave sem -- (o padrão correto) não é reportada", () => {
    const fixture = [
      "export async function main(): Promise<void> {",
      "  const argv = process.argv.slice(2);",
      '  const dryRun = hasFlag(argv, "dry-run");',
      '  const sessionId = getArg(argv, "session-id") || undefined;',
      "}",
    ].join("\n");
    const matches = scanFixture(fixture, "fixture/hubs-weekly-regen-after-fix.ts");
    assert.deepEqual(matches, [], "chave sem -- não deveria ser reportada");
  });

  it("sanity: comentário de linha citando o padrão em prosa não conta", () => {
    const fixture = [
      "export function main(): void {",
      '  // antes: hasFlag(argv, "--dry-run") era o bug',
      "}",
    ].join("\n");
    const matches = scanFixture(fixture, "fixture/comment.ts");
    assert.deepEqual(matches, [], "comentário histórico não deveria contar");
  });
});
