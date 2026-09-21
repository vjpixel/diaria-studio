/**
 * scripts/lib/orphaned-test-process-sweep.ts (#8661)
 *
 * Lógica pura (item 1 pendente do #7753, "rede de segurança: varrer
 * processos órfãos cujo cmdline aponte pro worktree corrente e matá-los"):
 * dado um snapshot de processos vivos, encontra os netos do runner nativo
 * (`node --test-isolation=process`, o default do `node:test`, 1 processo
 * por arquivo de teste) cujo cmdline referencia um path que **não existe
 * mais no disco** — sinal de que o worktree onde o processo nasceu já foi
 * removido (`git worktree remove --force`) enquanto ele ainda rodava.
 *
 * Mecanismo (ver issue #8661 pro cmdline real capturado ao vivo): o pai
 * (`node --test ...`) morre — timeout, OOM killer, `git worktree remove`
 * apagando o worktree por baixo dele — e o neto, sem `detached`/kill de
 * process group alcançando ele, é reparentado pro `init` (`PPID=1`) e roda
 * pra sempre, vazando RSS. O cmdline do neto sempre inclui pelo menos um
 * path absoluto que morava dentro do worktree (o loader `--import`/
 * `--require` do `tsx`, ou o próprio arquivo de teste com path absoluto) —
 * quando o worktree some, esse path some junto (worktree tem seu próprio
 * `node_modules/` via `npm ci`, nunca compartilhado — ver
 * `context/overnight-dispatch-rules.md` item 3), então checar `existsSync`
 * nesses tokens é suficiente pra confirmar a órfandade sem precisar
 * localizar o worktree por nome.
 *
 * Nunca casa processo que não seja `--test-isolation=process` — não é
 * varredura genérica de "processo com path inexistente na cmdline", é
 * restrita ao padrão exato deste vazamento (evita falso positivo em
 * qualquer outro processo node de vida longa da máquina).
 */
import { existsSync } from "node:fs";
import type { ProcessInfo } from "./list-processes.ts";

const ABSOLUTE_PATH_RE = /^(\/|[A-Za-z]:[\\/])/;

/**
 * Extrai todo path absoluto — POSIX (`/...`) ou Windows (`C:\...`/`C:/...`)
 * — presente na cmdline, tanto como token isolado (`--import /a/b.mjs`)
 * quanto embutido num argumento `--flag=/a/b.mjs` (a parte depois do 1º
 * `=` é checada isoladamente). Puro: `cmd.split` sobre whitespace, sem
 * qualquer I/O.
 */
export function extractPathTokens(cmd: string): string[] {
  const tokens: string[] = [];
  for (const tok of cmd.split(/\s+/)) {
    if (tok.length === 0) continue;
    if (ABSOLUTE_PATH_RE.test(tok)) {
      tokens.push(tok);
      continue;
    }
    const eqIdx = tok.indexOf("=");
    if (eqIdx === -1) continue;
    const afterEq = tok.slice(eqIdx + 1);
    if (ABSOLUTE_PATH_RE.test(afterEq)) tokens.push(afterEq);
  }
  return tokens;
}

/**
 * `true` só para o padrão exato do vazamento (#7753/#8661): processo
 * `node:test` rodando com `--test-isolation=process` — o default do
 * runner, que cria 1 processo neto por arquivo de teste. Essa flag por si
 * só já é um identificador único do runner nativo (nenhum outro comando do
 * repo/ecossistema a usa) — sem ela, um processo qualquer com um path
 * velho na cmdline (ex: um script comum apontando pra um arquivo temporário
 * já apagado) seria matado por engano.
 */
export function looksLikeIsolatedTestProcess(cmd: string): boolean {
  return cmd.includes("--test-isolation=process");
}

export interface OrphanedTestProcess {
  pid: number;
  cmd: string;
  /** O 1º path token da cmdline que não existe mais no disco — evidência da órfandade. */
  missingPath: string;
}

/**
 * Varre `processes` (snapshot já coletado — nunca chama `ps` aqui, ver
 * `scripts/lib/list-processes.ts` pra isso) e devolve os que batem o
 * padrão `looksLikeIsolatedTestProcess` E têm pelo menos um path token
 * ausente do disco. `existsFn` é injetável só pra teste determinístico —
 * default é o `fs.existsSync` real.
 */
export function findOrphanedTestProcesses(
  processes: readonly ProcessInfo[],
  existsFn: (path: string) => boolean = existsSync,
): OrphanedTestProcess[] {
  const found: OrphanedTestProcess[] = [];
  for (const proc of processes) {
    if (!looksLikeIsolatedTestProcess(proc.cmd)) continue;
    const missingPath = extractPathTokens(proc.cmd).find((token) => !existsFn(token));
    if (missingPath !== undefined) {
      found.push({ pid: proc.pid, cmd: proc.cmd, missingPath });
    }
  }
  return found;
}
