/**
 * Texto de uma skill para os testes de documentação (#14040).
 *
 * Desde o #14040 as skills de vídeo (`diaria-video-montagem`, `diaria-publica`,
 * `diaria-video-roteiro`) guardam os casos raros em `reference/*.md`, na pasta
 * da skill, lidos sob demanda pelo gatilho citado no SKILL.md. A regra que um
 * teste confere pode estar em qualquer um dos arquivos: este helper devolve o
 * SKILL.md seguido de cada `reference/*.md` em ordem alfabética, cada um
 * precedido de uma linha `<!-- arquivo: reference/{nome} -->`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** Os `reference/*.md` da skill, em ordem alfabética (vazio se a pasta não existe). */
export function skillReferenceFiles(skill: string, root = ROOT): string[] {
  const dir = join(root, ".claude", "skills", skill, "reference");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Todos os arquivos de prompt das skills sob `skillsDir` (default
 * `.claude/skills`): o `SKILL.md` de cada pasta e os `reference/*.md` dela,
 * nessa ordem. É a lista que os guards de prosa das skills varrem (#14040):
 * regra movida para `reference/` continua coberta.
 */
export function skillPromptFiles(skillsDir = join(ROOT, ".claude", "skills")): string[] {
  const files: string[] = [];
  if (!existsSync(skillsDir)) return files;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    if (existsSync(skillPath)) files.push(skillPath);
    const refDir = join(skillsDir, entry.name, "reference");
    if (existsSync(refDir)) {
      for (const f of readdirSync(refDir).filter((n) => n.endsWith(".md")).sort()) files.push(join(refDir, f));
    }
  }
  return files;
}

/** SKILL.md + `reference/*.md` da skill, concatenados. */
export function readSkillWithReferences(skill: string, root = ROOT): string {
  const skillPath = join(root, ".claude", "skills", skill, "SKILL.md");
  const parts = [readFileSync(skillPath, "utf8")];
  for (const f of skillReferenceFiles(skill, root)) {
    parts.push(`<!-- arquivo: reference/${basename(f)} -->\n${readFileSync(f, "utf8")}`);
  }
  return parts.join("\n\n");
}
