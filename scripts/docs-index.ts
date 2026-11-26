#!/usr/bin/env tsx
/**
 * docs-index.ts (#14061)
 *
 * Gera `docs/README.md`: as convenções de `docs/` (texto fixo, abaixo) e o
 * índice de TODO arquivo de `docs/`, com título e primeira linha de cada doc
 * `.md`. Substitui a tabela manual, que cobria 43 de ~170 arquivos e listava
 * docs defasados sem ninguém notar.
 *
 * Mesmo padrão de `scripts/list-invariants.ts` → `docs/editorial-invariants.md`:
 * o arquivo é derivado, e o `--check` falha quando o commitado divergiu do que
 * o gerador produz (doc novo, renomeado ou apagado sem regenerar o índice).
 * O `--check` roda em `.github/workflows/pr-checks.yml`, que vale para TODO PR:
 * o `ci.yml` ignora PR só de docs (`paths-ignore: docs/**`), justamente o PR
 * que cria doc novo.
 *
 * A lista vem de `git ls-files` (só arquivo rastreado), com fallback para o
 * disco apenas quando o git não responde.
 *
 * Uso:
 *   npx tsx scripts/docs-index.ts            # imprime no stdout
 *   npx tsx scripts/docs-index.ts --write    # grava docs/README.md
 *   npx tsx scripts/docs-index.ts --check    # exit 1 se docs/README.md divergiu
 *   (--docs-dir DIR troca a pasta, para teste)
 *
 * Exit codes: 0 ok · 1 --check divergiu · 2 erro.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DOCS_DIR = join(ROOT, "docs");

/** Arquivo gerado (relativo a `docs/`); fica fora do próprio índice. */
export const INDEX_FILE = "README.md";

/** Pastas de `docs/` que não entram no índice, com o motivo impresso no README. */
export const EXCLUDED_DIRS: Record<string, string> = {
  "audience-history":
    "snapshots datados do perfil de audiência, gerados por `/diaria-atualiza-audiencia`; não são docs de referência",
};

/**
 * Docs regravados por script (relativos a `docs/`) → script que os gera. No
 * índice entram só pelo título: a 1ª linha deles traz data/hora da geração,
 * e repeti-la aqui faria o `--check` reprovar todo PR depois de cada regen
 * (o `bug-heatmap.md` é regravado toda sexta por um PR de bot, #1014).
 * Doc gerado novo entra nesta lista; o teste reprova resumo com timestamp.
 */
export const TITLE_ONLY_DOCS: Record<string, string> = {
  "apex-cutover-status-5125.md": "scripts/apex-cutover-verify-5125.ts",
  "bug-heatmap.md": "scripts/bug-heatmap.ts (weekly-bug-heatmap.yml)",
  "corpus-index-status-5125.md": "scripts/corpus-index-coverage-report.ts",
  "editorial-invariants.md": "scripts/list-invariants.ts",
};

const SUMMARY_MAX = 160;

export interface DocEntry {
  /** Caminho relativo a `docs/`, com `/`. */
  path: string;
  title: string | null;
  summary: string | null;
}

/** Tira marcação inline que atrapalha a leitura numa célula de tabela. */
function cleanInline(s: string): string {
  return s
    .replace(/<!--.*?-->/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.—-]+$/, "")}…`;
}

function escapeCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** Linha que não serve de resumo: estrutura, metadado de issue ou separador. */
function isSkippableLine(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^(-{3,}|={3,}|\*{3,}|_{3,})$/.test(t)) return true;
  if (t.startsWith("```") || t.startsWith("~~~")) return true;
  if (t.startsWith("|")) return true;
  if (/^<!--.*-->$/.test(t)) return true;
  if (/^>?\s*\**(issues?|relacionad[oa]s? a)\**\s*:/i.test(t)) return true;
  return false;
}

/**
 * Título e primeira linha de um doc markdown. Aceita front matter YAML
 * (`name:`/`title:` e `description:`), título ATX (`# X`) e setext (`X\n===`).
 * Sem título, devolve `title: null` e o índice mostra só o nome do arquivo.
 */
export function extractDocSummary(content: string): { title: string | null; summary: string | null } {
  let lines = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  let title: string | null = null;
  let summary: string | null = null;

  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = l.match(/^(name|title|description):\s*(.+)$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (m[1] === "description") summary ??= v;
        else title ??= v;
      }
      lines = lines.slice(end + 1);
    }
  }

  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "") continue;
    const atx = t.match(/^#\s+(.+?)\s*#*$/);
    if (atx) {
      title = cleanInline(atx[1]);
      bodyStart = i + 1;
    } else if (/^=+$/.test(lines[i + 1]?.trim() ?? "")) {
      title = cleanInline(t);
      bodyStart = i + 2;
    }
    break;
  }

  if (summary === null) {
    // 1º parágrafo de texto: docs quebram linha em ~80 colunas, então a
    // "primeira linha" é o parágrafo inteiro até a linha em branco (senão o
    // resumo sai cortado no meio da frase e com `**` desbalanceado).
    const body = lines.slice(bodyStart);
    let inFence = false;
    const para: string[] = [];
    for (const raw of body) {
      const t = raw.trim();
      if (t.startsWith("```") || t.startsWith("~~~")) {
        if (para.length) break;
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (para.length) {
        if (t === "" || /^>\s*$/.test(t) || isSkippableLine(t) || /^[-*+]\s+/.test(t)) break;
        para.push(t.replace(/^>\s*/, ""));
        continue;
      }
      if (isSkippableLine(t)) continue;
      const first = t.replace(/^>\s*/, "").replace(/^[-*+]\s+/, "");
      if (cleanInline(first)) para.push(first);
    }
    if (para.length) summary = cleanInline(para.join(" "));
  }

  return {
    title: title ? cleanInline(title) : null,
    summary: summary ? truncate(cleanInline(summary), SUMMARY_MAX) : null,
  };
}

/** Fallback sem git: varre o disco com as mesmas exclusões de `isIndexed`. */
function walk(dir: string, rel: string, out: string[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (!rel && ent.name in EXCLUDED_DIRS) continue;
      walk(join(dir, ent.name), relPath, out);
    } else if (ent.isFile()) {
      if (!rel && ent.name === INDEX_FILE) continue;
      out.push(relPath);
    }
  }
}

/** Ordem por código de caractere, igual em toda plataforma (sem locale). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Mesmo filtro do `walk`, aplicado à lista do git. */
function isIndexed(relPath: string): boolean {
  if (relPath === INDEX_FILE) return false;
  const top = relPath.split("/")[0];
  return !(relPath.includes("/") && top in EXCLUDED_DIRS);
}

/**
 * Arquivos rastreados de `docs/` (relativos a ele), via `git ls-files`, ou
 * `null` quando o git não responde (fora de repo, git ausente). Arquivo não
 * rastreado no checkout local não entra: senão o `--write` local o listaria e
 * o `--check` do CI (clone limpo) reprovaria o PR.
 */
export function gitTrackedDocs(docsDir: string): string[] | null {
  const r = spawnSync("git", ["ls-files", "-z", "--", "."], { cwd: docsDir, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return r.stdout
    .split("\0")
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/"))
    .filter((p) => existsSync(join(docsDir, p)));
}

/**
 * `source: "git"` (padrão) lê `git ls-files` e cai no disco só se o git falhar;
 * `source: "fs"` força o disco (usado nos testes com pasta temporária).
 */
export function collectDocs(docsDir: string, opts: { source?: "git" | "fs" } = {}): DocEntry[] {
  let files: string[] = [];
  const tracked = opts.source === "fs" ? null : gitTrackedDocs(docsDir);
  if (tracked) files = tracked.filter(isIndexed);
  else walk(docsDir, "", files);
  files.sort(byCodePoint);
  return files.map((path) => {
    if (!path.endsWith(".md")) return { path, title: null, summary: null };
    const { title, summary } = extractDocSummary(readFileSync(join(docsDir, path), "utf8"));
    return { path, title, summary: path in TITLE_ONLY_DOCS ? null : summary };
  });
}

const HEADER = `# Índice — docs/

<!-- Gerado por \`npx tsx scripts/docs-index.ts --write\` (#14061). Não editar à mão: o check \`docs-index --check\` do pr-checks.yml reprova o PR em que este arquivo diverge de docs/. Para mudar o texto fixo, editar HEADER em scripts/docs-index.ts. -->

\`context/\` é o que entra no prompt das sessões (curado, ver \`CLAUDE.md\`); \`docs/\` é documentação de apoio, lida sob demanda: setup de máquina ou integração, runbooks, registros de decisão, análises e o arquivo histórico.

## Convenções

- **Índice gerado.** A lista abaixo sai do próprio \`docs/\`: título (1º cabeçalho) e primeira linha de texto de cada doc. Doc novo, renomeado ou apagado exige rodar \`npx tsx scripts/docs-index.ts --write\` e commitar o \`docs/README.md\` junto. Resumo ruim se corrige na primeira linha do doc, não aqui.
- **Status no topo.** Doc superado ou parcialmente defasado abre com uma linha \`Status:\` (ou um aviso em citação) dizendo o que vale hoje; é essa linha que aparece no índice.
- **\`archive/\` e \`agents-archive/\`**: spikes, análises encerradas e specs de agentes substituídos. Ficam pelo racional histórico e não descrevem o código atual.
- **Docs auto-gerados** (\`editorial-invariants.md\`, \`bug-heatmap.md\`, os \`*-status-*.md\`) dizem no topo qual script os gera; não editar à mão. No índice aparecem só pelo título (\`TITLE_ONLY_DOCS\` em \`scripts/docs-index.ts\`), porque a 1ª linha deles muda a cada geração.
- **Arquivos que não são markdown** (JSON de medição, propostas de import) entram no índice só pelo nome.
`;

export function renderDocsIndex(entries: DocEntry[]): string {
  const lines: string[] = [HEADER.trimEnd()];
  const excluded = Object.entries(EXCLUDED_DIRS)
    .map(([d, why]) => `\`docs/${d}/\` (${why})`)
    .join("; ");
  lines.push(`- **Fora do índice:** ${excluded}.`, "");

  const groups = new Map<string, DocEntry[]>();
  for (const e of entries) {
    const slash = e.path.lastIndexOf("/");
    const dir = slash < 0 ? "" : e.path.slice(0, slash);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(e);
  }
  const dirs = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : byCodePoint(a, b)));

  lines.push(`## Índice (${entries.length} arquivos)`, "");
  for (const dir of dirs) {
    const group = groups.get(dir)!;
    lines.push(`### \`docs/${dir ? `${dir}/` : ""}\` (${group.length})`, "");
    lines.push("| Doc | Título | Primeira linha |", "|---|---|---|");
    for (const e of group) {
      const link = `[\`${e.path}\`](./${e.path})`;
      lines.push(`| ${link} | ${escapeCell(e.title ?? "")} | ${escapeCell(e.summary ?? "")} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function generateDocsIndex(
  docsDir: string = DEFAULT_DOCS_DIR,
  opts: { source?: "git" | "fs" } = {},
): string {
  return renderDocsIndex(collectDocs(docsDir, opts));
}

/** `true` quando o conteúdo commitado bate com o gerado (ignora CRLF do checkout). */
export function indexMatches(existing: string, generated: string): boolean {
  return existing.replace(/\r\n?/g, "\n") === generated;
}

function main(): number {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const docsDir = values["docs-dir"] ? resolve(values["docs-dir"]) : DEFAULT_DOCS_DIR;
  const indexPath = join(docsDir, INDEX_FILE);
  const md = generateDocsIndex(docsDir);

  if (flags.has("check")) {
    const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
    if (!indexMatches(existing, md)) {
      console.error(
        `[docs-index] ${indexPath} divergiu: conteúdo de docs/ mudou (título/1ª linha, doc novo, renomeado ou apagado); ` +
          "rodar `npx tsx scripts/docs-index.ts --write` e commitar docs/README.md.",
      );
      return 1;
    }
    console.log(`[docs-index] ${indexPath} bate com docs/ — ok.`);
    return 0;
  }
  if (flags.has("write")) {
    writeFileSync(indexPath, md, "utf8");
    console.log(`[docs-index] gravado em ${indexPath}`);
    return 0;
  }
  process.stdout.write(md);
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error("[docs-index] erro:", e);
    process.exitCode = 2;
  }
}
