/**
 * memory-sync-guard.ts (#7759 item 2, resíduo do #7689/#7533)
 *
 * Lógica PURA por trás do hook `SessionStart` que detecta uma máquina cujo
 * diretório de memória (`~/.claude/projects/{slug}/memory/`) ficou FORA do
 * mecanismo de sync (#7533: repo git próprio, `_index.json` como manifesto
 * de curadoria) sem que ninguém note — o desvio manual (editar `MEMORY.md`
 * direto) *parece* funcionar até a primeira regeneração apagar a edição.
 *
 * ## Por que isto é um `SessionStart` vendorado no `diaria-studio`, e não
 * um item no alarme de drift existente
 *
 * A issue oferecia dois caminhos. Um alarme de drift roda como scheduled
 * task — e, por "tasks só no servidor" (decisão já tomada pro projeto:
 * máquinas locais não rodam mais tasks agendadas, só o `300`/servidor
 * roda), um alarme desse tipo só executa NO `300`. O `300` é, por
 * definição, uma máquina que já está conectada — ele não pode observar o
 * estado local do ZenBook/Neo enquanto essas máquinas estiverem
 * desconectadas, que é exatamente o caso de uso que a issue quer cobrir. Um
 * hook vendorado no `diaria-studio`, por outro lado, é distribuído a cada
 * máquina via `git pull` NORMAL do próprio repo de trabalho — chega e roda
 * em qualquer lugar que já usa o projeto, independente do estado da conexão
 * de memória nela. É a MESMA inversão de dependência que o #6310 já usou
 * pro problema irmão (`session-start-claude-config-sync.mjs`,
 * `docs/claude-config-sync.md` §"Auto-arme via `diaria-studio`") — mesmo
 * mecanismo, aplicado a um alvo diferente (memória, não `claude-config`).
 *
 * Este módulo é a decisão pura (dado o estado observado do disco, qual dos
 * 3 status vale?); o hook (`.claude/hooks/session-start-memory-sync-guard.mjs`)
 * DUPLICA esta lógica em JS puro (mesmo padrão dos hooks irmãos: um import
 * estático de `.ts` quebraria o hook inteiro, em silêncio, num Node sem
 * type-stripping nativo) e é responsável por nunca bloquear/atrasar a
 * sessão nem escrever nada em disco — só avisar.
 *
 * ## Contrato de tri-estado (regra inegociável da issue)
 *
 *   - `"ok"` — o diretório existe, é legível, e tem TANTO `.git` QUANTO
 *     `_index.json`: mecanismo completo.
 *   - `"not-connected"` — o diretório existe e é legível, mas falta `.git`
 *     e/ou `_index.json`: máquina real, usando memória, fora do mecanismo —
 *     é o sinal que a issue quer capturar.
 *   - `"cannot-verify"` — o diretório está ausente (sessão cloud/CI/worktree
 *     efêmero, onde não há `~/.claude/projects/{slug}/memory/` local de
 *     verdade) ou ilegível (erro de permissão/IO). Nunca vira `"ok"` nem
 *     `"not-connected"` por definição — não há como afirmar nenhum dos dois
 *     sem conseguir ler o diretório.
 *
 * `"cannot-verify"` é, de longe, o caso mais comum na frota (toda sessão
 * cloud, todo worktree de subagente, todo CI) — por isso o HOOK (não este
 * módulo) escolhe ficar em silêncio nesse status: um aviso que dispara em
 * toda sessão onde o diretório simplesmente não existe por design deixaria
 * de ser lido (mesmo raciocínio da issue sobre ruído). A distinção
 * "cannot-verify ≠ ok" continua sendo respeitada — é um valor de retorno
 * verdadeiro, testável, nunca maquiado como sucesso — só a decisão de
 * SURGIR como aviso visível é que é exclusiva do `"not-connected"`.
 */

import { existsSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeProjectsDir, encodeProjectDirName } from "./session-transcript.ts";

export type MemorySyncGuardStatus = "ok" | "not-connected" | "cannot-verify";

/** Estado observado do diretório de memória em si (antes de olhar dentro dele). */
export type MemoryDirState = "missing" | "unreadable" | "present";

export interface MemorySyncGuardInput {
  dirState: MemoryDirState;
  /** Só relevante quando `dirState === "present"`. */
  hasGitDir: boolean;
  /** Só relevante quando `dirState === "present"`. */
  hasIndexJson: boolean;
}

export interface MemorySyncGuardResult {
  status: MemorySyncGuardStatus;
  reason: string;
  /** Peças faltando do mecanismo — só populado quando `status === "not-connected"`. */
  missing: Array<".git" | "_index.json">;
}

/**
 * Decisão pura, sem IO. Primeira regra que casa vence — mas as 3 regras são
 * mutuamente exclusivas por construção (dirState é uma union fechada), não
 * há ambiguidade de ordem.
 */
export function evaluateMemorySyncGuard(input: MemorySyncGuardInput): MemorySyncGuardResult {
  if (input.dirState === "missing") {
    return { status: "cannot-verify", reason: "memory-dir-ausente", missing: [] };
  }
  if (input.dirState === "unreadable") {
    return { status: "cannot-verify", reason: "memory-dir-ilegivel", missing: [] };
  }

  const missing: Array<".git" | "_index.json"> = [];
  if (!input.hasGitDir) missing.push(".git");
  if (!input.hasIndexJson) missing.push("_index.json");

  if (missing.length === 0) {
    return { status: "ok", reason: "mecanismo-completo", missing: [] };
  }
  return { status: "not-connected", reason: `faltando: ${missing.join(", ")}`, missing };
}

/**
 * Path do diretório de memória pra um cwd — mesma convenção já testada em
 * `scripts/lib/session-transcript.ts` (`resolveTranscriptsDir`): o harness
 * grava transcript E memória sob `~/.claude/projects/{encodeProjectDirName(cwd)}/`.
 * Deliberadamente usa `cwd` (segue worktree), não `CLAUDE_PROJECT_DIR`
 * (fixo na raiz do projeto original) — é a mesma escolha já feita pro
 * transcript, pelo mesmo motivo: o diretório de memória que existe de
 * verdade no disco é o que corresponde ao cwd real da sessão, não a uma
 * identidade "lógica" de projeto. Consequência aceita: uma sessão rodando
 * de dentro de um worktree de subagente naturalmente cai em
 * `dirState: "missing"` -> `"cannot-verify"` (o worktree não tem
 * `memory/` próprio) — comportamento correto, não um bug deste guard.
 */
export function resolveMemoryDir(cwd: string = process.cwd(), homeDir: string = homedir()): string {
  return join(claudeProjectsDir(homeDir), encodeProjectDirName(cwd), "memory");
}

export interface MemorySyncGuardStatFns {
  /** Injetável pra teste — precisa lançar `{code:"ENOENT"}` pra ausência e
   * qualquer outro código (`"EACCES"`, etc) pra erro de leitura, mesmo
   * contrato de `fs.statSync`. */
  stat: (path: string) => Stats;
  exists: (path: string) => boolean;
}

const REAL_STAT_FNS: MemorySyncGuardStatFns = { stat: statSync, exists: existsSync };

/** Probe do estado do diretório em si — distingue ausente de ilegível via
 * código de erro (nunca via `existsSync`, que o Node faz engolir toda
 * exceção e devolver só `false`, apagando a distinção que este guard
 * precisa preservar). */
export function probeMemoryDirState(memoryDir: string, fns: MemorySyncGuardStatFns = REAL_STAT_FNS): MemoryDirState {
  let stats: Stats;
  try {
    stats = fns.stat(memoryDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" ? "missing" : "unreadable";
  }
  if (!stats.isDirectory()) return "missing"; // arquivo solto no lugar do diretório: trata como ausente
  return "present";
}

/**
 * Ponta de IO real: probe do diretório + (se presente) checagem de
 * `.git`/`_index.json`. `fns` é injetável pra teste determinístico de
 * TODOS os 4 cenários da regra de regressão da issue sem depender de
 * `chmod`/estado real de permissão do SO (frágil em sandbox rodando como
 * root, onde `chmod 000` não necessariamente nega leitura).
 */
export function checkMemorySyncGuardOnDisk(
  memoryDir: string,
  fns: MemorySyncGuardStatFns = REAL_STAT_FNS,
): MemorySyncGuardResult {
  const dirState = probeMemoryDirState(memoryDir, fns);
  if (dirState !== "present") {
    return evaluateMemorySyncGuard({ dirState, hasGitDir: false, hasIndexJson: false });
  }
  const hasGitDir = fns.exists(join(memoryDir, ".git"));
  const hasIndexJson = fns.exists(join(memoryDir, "_index.json"));
  return evaluateMemorySyncGuard({ dirState, hasGitDir, hasIndexJson });
}

/**
 * Mensagem de aviso (PT-BR, pronta pra virar `additionalContext` do hook)
 * — só chamada pelo hook quando `status === "not-connected"` (ver
 * docstring do módulo: `"cannot-verify"` fica silencioso de propósito, é o
 * caso comum/esperado em sessão cloud/CI/worktree). `null` pra qualquer
 * outro status — deixa explícito que o caller não deveria surgir aviso
 * fora do caso `"not-connected"`.
 */
export function buildMemorySyncGuardWarning(result: MemorySyncGuardResult, memoryDir: string): string | null {
  if (result.status !== "not-connected") return null;
  return (
    `Memória local (${memoryDir}) está fora do mecanismo de sync (#7533/#7759): ` +
    `faltando ${result.missing.join(" e ")}. Editar MEMORY.md à mão aqui parece funcionar, ` +
    `mas some na próxima regeneração e nenhuma outra máquina enxerga o que for escrito. ` +
    `Setup de 1x nesta máquina: docs/claude-config-sync.md §"Política de \`memory/\`" ` +
    `(bloco "nas demais máquinas").`
  );
}
