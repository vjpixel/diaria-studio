/**
 * add-lancamentos-allowlist-entry.ts (#12442)
 *
 * Acrescenta 1 entrada a `seed/lancamentos-tool-allowlist.txt` (#1968) SEM
 * tocar o checkout compartilhado: a linha é gravada num worktree temporário
 * criado de `origin/master`, commitada numa branch dedicada
 * (`allowlist/{edição}-{slug}`) e levada ao master por PR — mesmo desenho do
 * `publish-edition-site-page.ts` com a página da edição (#8636/#11673).
 *
 * Por que (#12442): o Stage 2 mandava editar o arquivo direto no checkout
 * compartilhado. Ninguém commitava a edição; ela ficava modificada até o
 * `sync-code` da edição seguinte, que, se um merge também tocasse o arquivo,
 * a empurrava para o stash (stash `dc3664a9`, 30/10, #11673). A allowlist é
 * config versionada decidida no gate, então precisa chegar ao master.
 *
 * A edição corrente não espera o merge: com `--edition-dir`, a entrada também
 * vai para `{edição}/_internal/lancamentos-tool-allowlist-pending.txt` (dentro
 * de `data/`, fora do git), que `loadToolAllowlist(root, editionDir)` soma à
 * lista do seed. Re-rodar o `validate-lancamentos.ts` da edição já vê o
 * override.
 *
 * Uso:
 *   npx tsx scripts/add-lancamentos-allowlist-entry.ts --entry <url|padrão> \
 *     [--edition-dir data/editions/AAMMDD] [--edition AAMMDD] [--reason "texto"] [--dry-run]
 *
 * `--entry` aceita URL completa (o esquema `https://` e o `www.` saem) ou
 * padrão de caminho (`exemplo.com/blog/`, #11554).
 *
 * Saída: JSON no stdout com `outcome` = `pr_created` | `pr_reused` |
 * `already_in_master` | `dry_run`.
 * Exit: 0 sucesso; 1 falha de git/gh (a entrada pendente da edição, se pedida,
 * já foi gravada — a edição segue, o PR fica por fazer); 2 uso inválido.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { PENDING_ALLOWLIST_REL } from "./validate-lancamentos.ts";

export const ALLOWLIST_REL = "seed/lancamentos-tool-allowlist.txt";

export type GitRunner = (args: string[], cwd: string) => string;
export type GhRunner = (args: string[], cwd: string) => string;

export const defaultGitRunner: GitRunner = (args, cwd) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
export const defaultGhRunner: GhRunner = (args, cwd) =>
  execFileSync("gh", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");

/**
 * Normaliza a entrada para o formato do arquivo (substring de URL sem esquema).
 * Lança em entrada que o `loadToolAllowlist` leria diferente do pretendido:
 * vazia, com espaço, com `#` (vira comentário) ou sem domínio.
 */
export function normalizeAllowlistEntry(raw: string): string {
  let e = (raw ?? "").trim();
  e = e.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  e = e.replace(/^www\./i, "");
  if (!e) throw new Error("entrada vazia");
  if (/\s/.test(e)) throw new Error(`entrada com espaço: "${raw}"`);
  if (e.includes("#")) throw new Error(`entrada com '#' (o arquivo lê '#' como comentário): "${raw}"`);
  const host = e.split("/")[0];
  if (!host.includes(".")) throw new Error(`entrada sem domínio: "${raw}"`);
  return e;
}

/** Linhas efetivas (sem comentário/branco), no mesmo critério do `loadToolAllowlist`. */
export function allowlistEntries(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter((l) => l.length > 0);
}

/** Acrescenta `entry` ao fim do conteúdo; idempotente (`added: false` se já existe). */
export function appendAllowlistEntry(content: string, entry: string): { content: string; added: boolean } {
  if (allowlistEntries(content).includes(entry)) return { content, added: false };
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const base = content.length === 0 || content.endsWith("\n") ? content : content + eol;
  return { content: `${base}${entry}${eol}`, added: true };
}

/** Branch determinística por entrada: re-rodar a mesma entrada reaproveita a PR aberta. */
export function allowlistBranchName(entry: string, edition?: string): string {
  const slug = entry
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const hash = createHash("sha1").update(entry).digest("hex").slice(0, 8);
  const prefix = edition && /^\d{6}$/.test(edition) ? `${edition}-` : "";
  return `allowlist/${prefix}${slug}-${hash}`;
}

export function buildAllowlistPrTitle(entry: string): string {
  return `chore(allowlist): ${entry} na verificação de LANÇAMENTOS (#12442)`;
}

export function buildAllowlistPrBody(entry: string, edition?: string, reason?: string): string {
  return [
    `Acrescenta \`${entry}\` a \`${ALLOWLIST_REL}\` (override da verificação positiva de ferramenta, #1968).`,
    "",
    edition ? `Edição: ${edition}.` : "Edição: não informada.",
    reason ? `Motivo: ${reason}` : "Motivo: ferramenta legítima de slug atípico, decidida no gate do Stage 2.",
    "",
    "Gerado por `scripts/add-lancamentos-allowlist-entry.ts`: a linha foi gravada num worktree de " +
      "`origin/master`, nunca no checkout compartilhado (#12442). A edição corrente já usa a entrada " +
      "pela lista pendente em `_internal/` da edição; este PR leva a linha ao master.",
    "",
    "no-regression-test: só 1 linha de config na allowlist, sem código.",
    "",
    "Refs #1968, #12442",
  ].join("\n");
}

/** Grava a entrada na lista pendente da edição (idempotente). Devolve se acrescentou. */
export function recordPendingAllowlistEntry(editionDir: string, entry: string): boolean {
  const p = resolve(editionDir, ...PENDING_ALLOWLIST_REL);
  const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  const { content, added } = appendAllowlistEntry(cur, entry);
  if (added) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf8");
  }
  return added;
}

export interface AddAllowlistOptions {
  rootDir: string;
  entry: string;
  edition?: string;
  editionDir?: string;
  reason?: string;
  dryRun?: boolean;
}

export interface AddAllowlistDeps {
  git: GitRunner;
  gh: GhRunner;
  /** Diretório (ainda inexistente) onde o worktree temporário será criado. */
  makeWorktreePath: () => string;
  log: (msg: string) => void;
}

export interface AddAllowlistResult {
  entry: string;
  branch: string;
  outcome: "pr_created" | "pr_reused" | "already_in_master" | "dry_run";
  pending_recorded: boolean;
  pr_url?: string;
  pr_number?: number;
  fetch_stale?: boolean;
}

export function parsePrNumber(url: string | undefined): number | undefined {
  const m = url?.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

function findOpenPr(gh: GhRunner, rootDir: string, branch: string): { number: number; url: string } | null {
  const raw = gh(["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"], rootDir);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed[0] as { number: number; url: string };
  } catch {
    /* saída ilegível = sem PR aberta; o create abaixo falha alto se houver */
  }
  return null;
}

/**
 * Fluxo completo. Nunca escreve em `rootDir`: o seed é lido e escrito só no
 * worktree temporário, que sai no `finally`.
 */
export function addAllowlistEntry(opts: AddAllowlistOptions, deps: AddAllowlistDeps): AddAllowlistResult {
  const entry = normalizeAllowlistEntry(opts.entry);
  const branch = allowlistBranchName(entry, opts.edition);
  if (opts.dryRun) {
    return { entry, branch, outcome: "dry_run", pending_recorded: false };
  }

  // A edição primeiro: se o git/gh falhar abaixo, o override da edição já vale.
  const pending_recorded = opts.editionDir ? recordPendingAllowlistEntry(opts.editionDir, entry) : false;

  let fetch_stale = false;
  try {
    deps.git(["fetch", "origin", "master"], opts.rootDir);
  } catch (e) {
    fetch_stale = true;
    deps.log(`aviso: 'git fetch origin master' falhou (${(e as Error).message}); seguindo com o ref local.`);
  }

  const wt = deps.makeWorktreePath();
  deps.git(["worktree", "add", "--detach", wt, "origin/master"], opts.rootDir);
  try {
    const seedPath = join(wt, ...ALLOWLIST_REL.split("/"));
    const cur = existsSync(seedPath) ? readFileSync(seedPath, "utf8") : "";
    const { content, added } = appendAllowlistEntry(cur, entry);
    if (!added) {
      return { entry, branch, outcome: "already_in_master", pending_recorded, fetch_stale };
    }

    const open = findOpenPr(deps.gh, opts.rootDir, branch);
    if (open) {
      return {
        entry,
        branch,
        outcome: "pr_reused",
        pending_recorded,
        pr_url: open.url,
        pr_number: open.number,
        fetch_stale,
      };
    }

    deps.git(["checkout", "-B", branch], wt);
    writeFileSync(seedPath, content, "utf8");
    deps.git(["add", "--", ALLOWLIST_REL], wt);
    deps.git(
      ["commit", "-m", `chore(allowlist): ${entry} na verificação de LANÇAMENTOS\n\nRefs #1968, #12442`, "--", ALLOWLIST_REL],
      wt,
    );
    // Branch dedicada por entrada: o que houver no remoto com esse nome é de
    // rodada anterior sem PR aberta (a aberta já saiu acima), descartável.
    deps.git(["push", "--force", "-u", "origin", branch], wt);
    const out = deps.gh(
      [
        "pr",
        "create",
        "--base",
        "master",
        "--head",
        branch,
        "--title",
        buildAllowlistPrTitle(entry),
        "--body",
        buildAllowlistPrBody(entry, opts.edition, opts.reason),
      ],
      opts.rootDir,
    );
    const pr_url = out.trim().split(/\s+/).find((t) => /\/pull\/\d+/.test(t));
    return { entry, branch, outcome: "pr_created", pending_recorded, pr_url, pr_number: parsePrNumber(pr_url), fetch_stale };
  } finally {
    try {
      deps.git(["worktree", "remove", "--force", wt], opts.rootDir);
    } catch {
      try {
        rmSync(wt, { recursive: true, force: true });
        deps.git(["worktree", "prune"], opts.rootDir);
      } catch (e) {
        deps.log(`aviso: worktree ${wt} não removido (${(e as Error).message}); remova à mão.`);
      }
    }
  }
}

function editionFromDir(editionDir: string | undefined): string | undefined {
  if (!editionDir) return undefined;
  const b = basename(resolve(editionDir));
  return /^\d{6}$/.test(b) ? b : undefined;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (!values.entry) {
    console.error(
      "Uso: add-lancamentos-allowlist-entry.ts --entry <url|padrão> [--edition-dir <dir>] [--edition AAMMDD] [--reason texto] [--dry-run]",
    );
    process.exit(2);
  }
  const editionDir = values["edition-dir"] ? resolve(ROOT, values["edition-dir"]) : undefined;
  try {
    normalizeAllowlistEntry(values.entry);
  } catch (e) {
    console.error(`Entrada inválida: ${(e as Error).message}`);
    process.exit(2);
  }
  try {
    const result = addAllowlistEntry(
      {
        rootDir: ROOT,
        entry: values.entry,
        edition: values.edition ?? editionFromDir(editionDir),
        editionDir,
        reason: values.reason,
        dryRun: flags.has("dry-run"),
      },
      {
        git: defaultGitRunner,
        gh: defaultGhRunner,
        makeWorktreePath: () => join(tmpdir(), `allowlist-wt-${randomUUID()}`),
        log: (m) => process.stderr.write(`[allowlist] ${m}\n`),
      },
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    const pendingNote = editionDir ? " A entrada pendente da edição foi gravada antes da falha; a edição já usa o override." : "";
    console.error(`[allowlist] falha ao abrir o PR: ${(e as Error).message}.${pendingNote}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
