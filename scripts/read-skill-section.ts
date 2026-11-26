#!/usr/bin/env npx tsx
/**
 * read-skill-section.ts (#14119) — imprime só a(s) seção(ões) de um SKILL.md
 * marcada(s) por âncora `<!-- anchor: nome -->` (convenção em
 * `scripts/lib/skill-section.ts`).
 *
 * Por que existe: `/diaria-pacote-semanal` manda seguir passos de
 * `/diaria-retro-semanal`, `/diaria-linkedin-semanal` e `/diaria-stack`; ler o
 * SKILL.md inteiro de cada uma punha até ~134 KB a mais no contexto. Com este
 * CLI a sessão lê só o passo citado.
 *
 * Uso:
 *   npx tsx scripts/read-skill-section.ts --skill diaria-linkedin-semanal --section passo-8a,passo-8b,passo-8c
 *   npx tsx scripts/read-skill-section.ts --skill diaria-stack --list
 *
 * `--section` aceita vários nomes separados por vírgula, impressos na ordem
 * pedida. `--list` imprime as âncoras do arquivo (nome e título).
 *
 * Exit: 0 = seção impressa; 1 = âncora inexistente, duplicada ou mal posta
 * (nada é impresso no stdout — nunca sai vazio em silêncio); 2 = uso inválido
 * ou skill inexistente.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { extractAnchoredSection, listAnchors, SkillSectionError } from "./lib/skill-section.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function skillPath(skill: string, root = REPO_ROOT): string {
  return join(root, ".claude", "skills", skill, "SKILL.md");
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(argv: string[], root = REPO_ROOT): RunResult {
  const { values, flags } = parseArgs(argv);
  const skill = values.skill ?? "";
  const usage = "uso: read-skill-section.ts --skill NOME (--section a[,b] | --list)";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skill)) {
    return { code: 2, stdout: "", stderr: `--skill inválido ou ausente. ${usage}\n` };
  }
  const path = skillPath(skill, root);
  if (!existsSync(path)) {
    return { code: 2, stdout: "", stderr: `skill não encontrada: ${path}\n` };
  }
  const md = readFileSync(path, "utf8");
  try {
    if (flags.has("list")) {
      const out = listAnchors(md).map((a) => `${a.name}\t${a.heading}`).join("\n");
      return { code: 0, stdout: out ? out + "\n" : "", stderr: out ? "" : `nenhuma âncora em ${path}\n` };
    }
    const names = (values.section ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) {
      return { code: 2, stdout: "", stderr: `--section ausente. ${usage}\n` };
    }
    const parts = names.map((n) => extractAnchoredSection(md, n));
    return { code: 0, stdout: parts.join("\n"), stderr: "" };
  } catch (e) {
    if (e instanceof SkillSectionError) {
      return { code: 1, stdout: "", stderr: `[read-skill-section] ${skill}: ${e.message}\n` };
    }
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}
