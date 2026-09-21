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
 *
 * **Também exige `ppid === 1`** (achado do fleet review da PR #8692,
 * type-design-analyzer): `PPID=1` é o próprio sinal definidor de órfão
 * descrito acima ("reparentado pro init") — sem essa checagem, um processo
 * `--test-isolation=process` genuinamente VIVO, ainda filho de um `node
 * --test` normal, cujo cmdline por acaso referencia um path
 * MOMENTANEAMENTE ausente (race entre rename/recriação de worktree, ou o
 * próprio `removeWorktreeSafe` no meio de uma checagem concorrente) seria
 * morto por engano via SIGKILL. `existsFn` sozinho nunca é suficiente pra
 * confirmar órfandade — só a combinação com `ppid === 1` é.
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
 * `scripts/lib/list-processes.ts` pra isso) e devolve os que batem TODOS os
 * 3 sinais do vazamento: `looksLikeIsolatedTestProcess`, `ppid === 1`
 * (reparentado pro init — o sinal definidor de órfão, ver docstring de
 * `looksLikeIsolatedTestProcess` acima) e pelo menos um path token ausente
 * do disco. `existsFn` é injetável só pra teste determinístico — default é
 * o `fs.existsSync` real.
 */
export function findOrphanedTestProcesses(
  processes: readonly ProcessInfo[],
  existsFn: (path: string) => boolean = existsSync,
): OrphanedTestProcess[] {
  const found: OrphanedTestProcess[] = [];
  for (const proc of processes) {
    if (proc.ppid !== 1) continue;
    if (!looksLikeIsolatedTestProcess(proc.cmd)) continue;
    const missingPath = extractPathTokens(proc.cmd).find((token) => !existsFn(token));
    if (missingPath !== undefined) {
      found.push({ pid: proc.pid, cmd: proc.cmd, missingPath });
    }
  }
  return found;
}

/**
 * Reverificação de identidade IMEDIATAMENTE antes de matar um PID (#8661,
 * achado do fleet review da PR #8692, silent-failure-hunter — CRÍTICO):
 * entre o snapshot que produziu `orphan` (via `listAllProcesses()`) e o
 * momento do `kill`, o processo original pode ter morrido e o SO reciclado
 * o PID pra um processo novo, completamente não-relacionado.
 * `process.kill(pid, "SIGKILL")` nesse cenário mata o processo ERRADO —
 * com sucesso, sem exceção, sem qualquer sinal de que algo deu errado.
 *
 * `current` deve vir de uma releitura FRESCA do PID feita agora (ver
 * `readProcessNow` em `scripts/lib/list-processes.ts`), nunca do snapshot
 * antigo. `false` (nunca mata) quando: o PID já não existe mais
 * (`current === null` — o processo morreu sozinho, nada a matar), o
 * processo atual não é mais `ppid === 1` + `--test-isolation=process`
 * (deixou de bater o padrão — pode ter sido reparentado de volta, ou o PID
 * foi reciclado), ou o cmdline atual não referencia mais o mesmo
 * `expectedMissingPath` que motivou a detecção (evidência mais forte de
 * reuso de PID: um processo genuinamente órfão do MESMO worktree removido
 * continua citando o mesmo path).
 */
export function stillMatchesOrphanSignature(
  current: ProcessInfo | null,
  expectedMissingPath: string,
): boolean {
  if (current === null) return false;
  if (current.ppid !== 1) return false;
  if (!looksLikeIsolatedTestProcess(current.cmd)) return false;
  return current.cmd.includes(expectedMissingPath);
}
