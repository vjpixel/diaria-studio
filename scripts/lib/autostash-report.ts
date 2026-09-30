/**
 * autostash-report.ts (#8991)
 *
 * Listagem READ-ONLY dos autostashes de `git-sync.ts` (`GIT_SYNC_STASH_MESSAGE`)
 * acumulados em `git stash list`, com data, sha e arquivos tocados por cada um —
 * o insumo para o editor revisar CADA stash antes de descartar (o banner de
 * pileup do `sync-code.ts` pede exatamente isso). Nunca dropa nada: descartar
 * é sempre decisão humana (a pilha de stash é compartilhada entre worktrees).
 */
import type { SpawnResult } from "./spawn-types.ts";
import { GIT_SYNC_STASH_MESSAGE } from "./git-sync.ts";

export type Spawn = (cmd: string, args: string[]) => SpawnResult;

export interface AutostashEntry {
  ref: string;
  sha: string;
  date: string;
  /**
   * Arquivos tocados pelo stash. `null` = indeterminado: `git stash show`
   * falhou (#9154) — nunca confundir com "0 arquivos".
   */
  files: string[] | null;
  /** Motivo (stderr do `git stash show`) quando `files === null`. */
  filesError?: string;
}

/**
 * `git stash list` falhou (#9154): a listagem é DESCONHECIDA, não vazia.
 * Lançar em vez de devolver `[]` evita o relatório "Nenhum autostash" falso
 * que levaria o editor a concluir que não há nada a revisar antes de descartar.
 */
export class AutostashListError extends Error {
  constructor(status: number | null, stderr: string) {
    super(`git stash list falhou (status ${status}): ${stderr.trim() || "(sem stderr)"}`);
    this.name = "AutostashListError";
  }
}

/**
 * Lista os autostashes do módulo (mais novo primeiro, ordem de `git stash list`).
 * Lança `AutostashListError` se `git stash list` falhar (#9154).
 */
export function listAutostashes(spawn: Spawn): AutostashEntry[] {
  const res = spawn("git", ["stash", "list", "--format=%gd|%H|%ci|%gs"]);
  if (res.status !== 0) throw new AutostashListError(res.status, res.stderr ?? "");
  const out: AutostashEntry[] = [];
  for (const line of res.stdout.split("\n")) {
    const [ref, sha, date, ...subject] = line.split("|");
    if (!ref || !sha || !subject.join("|").includes(GIT_SYNC_STASH_MESSAGE)) continue;
    const show = spawn("git", ["stash", "show", "--include-untracked", "--name-only", sha]);
    if (show.status === 0) {
      out.push({ ref, sha, date, files: show.stdout.split("\n").map((f) => f.trim()).filter(Boolean) });
    } else {
      out.push({ ref, sha, date, files: null, filesError: (show.stderr ?? "").trim() || `status ${show.status}` });
    }
  }
  return out;
}

export function formatAutostashReport(entries: AutostashEntry[]): string {
  if (entries.length === 0) return "Nenhum autostash de sync-code acumulado.\n";
  const lines = [`${entries.length} autostash(es) de sync-code (somente leitura; nada foi descartado):`, ""];
  for (const e of entries) {
    if (e.files === null) {
      lines.push(`${e.ref}  ${e.sha.slice(0, 10)}  ${e.date}  (arquivos INDETERMINADOS — git stash show falhou: ${e.filesError})`);
      continue;
    }
    lines.push(`${e.ref}  ${e.sha.slice(0, 10)}  ${e.date}  (${e.files.length} arquivo(s))`);
    for (const f of e.files.slice(0, 10)) lines.push(`    ${f}`);
    if (e.files.length > 10) lines.push(`    ... +${e.files.length - 10}`);
  }
  lines.push("", "Revise cada um (git stash show -p <ref>) e descarte à mão só o que for resíduo: git stash drop <ref>");
  return lines.join("\n") + "\n";
}
