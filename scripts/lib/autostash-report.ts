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

/**
 * #9887: lê só as DATAS de criação dos autostashes do módulo (1 spawn, sem
 * `git stash show` por entrada) — insumo de `assessAutostashPileup`. Mais novo
 * primeiro. `null` = `git stash list` falhou (indeterminado, nunca "vazio").
 */
export function listAutostashDates(spawn: Spawn): string[] | null {
  const res = spawn("git", ["stash", "list", "--format=%cI|%gs"]);
  if (res.status !== 0) return null;
  const out: string[] = [];
  for (const line of res.stdout.split("\n")) {
    const [date, ...subject] = line.split("|");
    if (!date || !subject.join("|").includes(GIT_SYNC_STASH_MESSAGE)) continue;
    out.push(date.trim());
  }
  return out;
}

/**
 * #9887: dias sem autostash novo a partir dos quais o pileup é tratado como
 * RESÍDUO HISTÓRICO. 2, não 1: a edição roda ~1×/dia por máquina, então
 * "nenhum novo em 2 dias" já cobre ao menos 1 sync inteiro sem empilhar.
 */
export const AUTOSTASH_PILEUP_IDLE_DAYS = 2;

/**
 * #9887: o pileup está CRESCENDO ou é resíduo parado? Motivação: a mesma
 * pilha de 15 autostashes de uma máquina virou issue duas vezes (#9690 em
 * 261006, #9887 em 261008) pedindo "investigar por que ainda são criados",
 * quando a contagem não tinha crescido — o alarme não distinguia pilha
 * crescendo (bug ativo) de sobra anterior aos fixes #8991/#9107 (limpeza
 * manual pendente).
 * - `active`: esta rodada criou/preservou um autostash, ou o mais recente tem
 *   menos de `idleDays` dias — o sync ainda está empilhando (investigar causa).
 * - `historical`: nenhum novo há `idleDays`+ dias e esta rodada não criou
 *   nenhum — o que falta é limpeza MANUAL, não código.
 * - `unknown`: datas indisponíveis/ilegíveis — nunca vira `historical`.
 */
export type AutostashPileupKind = "active" | "historical" | "unknown";

export interface AutostashPileupAssessment {
  kind: AutostashPileupKind;
  newest_at: string | null;
  oldest_at: string | null;
  idle_days: number | null;
}

export function assessAutostashPileup(
  dates: string[] | null,
  opts: { now: Date; createdThisRun: boolean; idleDays?: number },
): AutostashPileupAssessment {
  const idleThreshold = opts.idleDays ?? AUTOSTASH_PILEUP_IDLE_DAYS;
  const times = (dates ?? []).map((d) => ({ d, t: Date.parse(d) }));
  const valid = times.filter((x) => Number.isFinite(x.t));
  // Qualquer data ilegível (ou nenhuma) → não afirma "histórico" sem prova.
  if (valid.length === 0 || valid.length !== times.length) {
    return { kind: opts.createdThisRun ? "active" : "unknown", newest_at: null, oldest_at: null, idle_days: null };
  }
  valid.sort((a, b) => b.t - a.t);
  const newest = valid[0];
  const oldest = valid[valid.length - 1];
  const idleDays = Math.max(0, Math.floor((opts.now.getTime() - newest.t) / 86_400_000));
  const kind: AutostashPileupKind = opts.createdThisRun || idleDays < idleThreshold ? "active" : "historical";
  return { kind, newest_at: newest.d, oldest_at: oldest.d, idle_days: idleDays };
}

/** #9887: banner de pileup do `sync-code.ts`, com o veredito ativo/histórico. */
export function formatAutostashPileupBanner(count: number, threshold: number, a: AutostashPileupAssessment): string {
  const head =
    `\n📚 PILEUP DE AUTOSTASH — ${count} stashes de sync-code.ts acumulados em 'git stash list' ` +
    `(limiar de alarme: ${threshold}+; incidente que motivou o alarme, #8719, mediu 6).\n`;
  const span = a.newest_at
    ? `   Mais recente: ${a.newest_at} (${a.idle_days} dia(s) atrás); mais antigo: ${a.oldest_at}.\n`
    : "";
  const review =
    `   Revise CADA um antes de descartar (pode haver trabalho legítimo ali): npx tsx scripts/list-autostashes.ts\n` +
    `   Descarte é sempre manual (#8719 — nada é dropado automaticamente): git stash drop <sha>\n\n`;
  if (a.kind === "historical") {
    return (
      head +
      span +
      `   RESÍDUO HISTÓRICO (#9887): nenhum autostash novo há ${a.idle_days} dia(s) e esta rodada não criou\n` +
      `   nenhum — o sync NÃO está mais empilhando; a contagem só não baixa porque a limpeza é manual.\n` +
      `   Não é bug ativo de código: não abra issue nova por este alarme enquanto ele seguir histórico.\n` +
      review
    );
  }
  if (a.kind === "active") {
    return (
      head +
      span +
      `   PILEUP ATIVO (#9887): esta rodada criou/preservou um autostash, ou há um com menos de\n` +
      `   ${AUTOSTASH_PILEUP_IDLE_DAYS} dia(s) — o sync ainda está empilhando. Veja 'ff_refusal' no JSON acima (#9690)\n` +
      `   para saber qual arquivo faz o ff-only recusar, e trate a causa.\n` +
      review
    );
  }
  return (
    head +
    `   Não foi possível ler as datas dos autostashes — não dá pra dizer se o pileup ainda cresce (#9887).\n` +
    review
  );
}
