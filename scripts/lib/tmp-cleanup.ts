/**
 * scripts/lib/tmp-cleanup.ts (#8828)
 *
 * Lógica PURA (sem I/O) da limpeza periódica de `/tmp` no servidor `300` —
 * o `/tmp` (tmpfs de 15 GB) estourou a cota (EDQUOT) em 25/09/2026,
 * derrubando TODO comando Bash de TODA sessão de Claude Code na máquina (o
 * harness grava saída de shell em `/tmp/claude-{uid}/...`). Depois da
 * limpeza manual, `/tmp/claude-1000` sozinho media só ~24 MB — o grosso do
 * consumo real vem de fora do escopo deste helper (cache SSR do
 * wrangler/esbuild, clones de isolamento de worktree do próprio harness,
 * caches de sistema como `gh-cli-cache`/`node-compile-cache`/`tsx-1000`) e
 * fica fora de alcance de um script deste repo — ver docstring de
 * `scripts/cleanup-tmp-300.ts` pro diagnóstico completo. Este módulo cobre
 * só o que É deste projeto: os diretórios de sessão do Claude Code
 * (`/tmp/claude-{uid}/<projeto>/<sessionId>/`) e os arquivos `.output` de
 * tarefas em background dentro deles.
 *
 * Mesmo molde do resto do repo: decisão PURA aqui, testável sem tocar
 * disco; I/O (readdir/stat/rm real, consulta ao `session-registry.ts`) fica
 * em `scripts/cleanup-tmp-300.ts`.
 *
 * ─── Guards invariáveis ─────────────────────────────────────────────────────
 *
 * 1. **Nunca apagar diretório de sessão ATIVA** — `activeSessionIds` (lido
 *    de `listActiveSessions()`/`session-registry.ts` pelo caller) é
 *    checado ANTES de qualquer critério de idade. Um diretório cujo
 *    `sessionId` aparece no registro nunca entra em `sessionDirsToRemove`,
 *    mesmo que pareça velho (heartbeat pode não tocar o diretório em
 *    `/tmp`, então "velho" e "morto" não são a mesma coisa).
 * 2. **Guard de idade explícito** — nada é removido com menos de
 *    `SESSION_DIR_MIN_AGE_MS` (2 dias, decisão conservadora: uma sessão
 *    pausada por horas ainda deve sobreviver a uma execução diária do
 *    cleanup) ou `OUTPUT_FILE_MIN_AGE_MS` (1 dia, `.output` files).
 */

/** 2 dias — nunca remover diretório de sessão mais novo que isso, mesmo que
 *  a sessão não conste como ativa no registro (proteção contra corrida
 *  entre o fim de uma sessão e a próxima execução do cleanup). */
export const SESSION_DIR_MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** 1 dia — arquivo `.output` de task em background só é candidato depois
 *  desta idade, independente do tamanho. */
export const OUTPUT_FILE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** ~50 MB — abaixo disso um `.output` não é candidato, mesmo velho (não é
 *  o que estoura a cota; a poda mais agressiva é a do diretório de sessão
 *  inteiro quando ele envelhecer). */
export const OUTPUT_FILE_MIN_SIZE_BYTES = 50 * 1024 * 1024;

export interface SessionDirCandidate {
  /** `sessionId` extraído do nome do diretório — comparado 1:1 contra
   *  `listActiveSessions()`/`session-registry.ts` pelo caller. */
  sessionId: string;
  /** Caminho absoluto do diretório de sessão. */
  path: string;
  /** `mtimeMs` mais recente encontrado dentro do diretório (o caller decide
   *  como computar — recursivo é mais preciso, mas custa mais I/O). */
  mtimeMs: number;
}

export interface OutputFileCandidate {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface TmpCleanupPlan {
  sessionDirsToRemove: SessionDirCandidate[];
  sessionDirsSkippedActive: SessionDirCandidate[];
  sessionDirsSkippedYoung: SessionDirCandidate[];
  outputFilesToRemove: OutputFileCandidate[];
  outputFilesSkipped: OutputFileCandidate[];
}

/**
 * Pura — decide o que remover. `now`/os candidatos vêm do caller (I/O real:
 * `readdirSync`/`statSync` em `scripts/cleanup-tmp-300.ts`); `activeSessionIds`
 * vem de `listActiveSessions(repoRoot).map(s => s.sessionId)` — MAS este
 * helper não é exclusivo de sessões coordenadoras: qualquer sessão viva
 * (inclusive `interactive`, listada por `listActiveSessions` desde o #6168)
 * deve entrar no set pra nunca ser podada em voo.
 */
export function planTmpCleanup(
  sessionDirs: readonly SessionDirCandidate[],
  outputFiles: readonly OutputFileCandidate[],
  activeSessionIds: ReadonlySet<string>,
  now: number = Date.now(),
): TmpCleanupPlan {
  const sessionDirsToRemove: SessionDirCandidate[] = [];
  const sessionDirsSkippedActive: SessionDirCandidate[] = [];
  const sessionDirsSkippedYoung: SessionDirCandidate[] = [];

  for (const dir of sessionDirs) {
    if (activeSessionIds.has(dir.sessionId)) {
      sessionDirsSkippedActive.push(dir);
      continue;
    }
    const ageMs = now - dir.mtimeMs;
    if (!(ageMs >= SESSION_DIR_MIN_AGE_MS)) {
      sessionDirsSkippedYoung.push(dir);
      continue;
    }
    sessionDirsToRemove.push(dir);
  }

  const outputFilesToRemove: OutputFileCandidate[] = [];
  const outputFilesSkipped: OutputFileCandidate[] = [];
  for (const file of outputFiles) {
    const ageMs = now - file.mtimeMs;
    const bigEnough = file.sizeBytes >= OUTPUT_FILE_MIN_SIZE_BYTES;
    const oldEnough = ageMs >= OUTPUT_FILE_MIN_AGE_MS;
    if (bigEnough && oldEnough) {
      outputFilesToRemove.push(file);
    } else {
      outputFilesSkipped.push(file);
    }
  }

  return { sessionDirsToRemove, sessionDirsSkippedActive, sessionDirsSkippedYoung, outputFilesToRemove, outputFilesSkipped };
}

/** Soma bytes liberados por um plano — só `.output` files têm tamanho
 *  conhecido sem stat recursivo; diretórios de sessão não entram na soma
 *  (o caller pode reportar contagem de diretórios separadamente). */
export function planFreedOutputBytes(plan: TmpCleanupPlan): number {
  return plan.outputFilesToRemove.reduce((sum, f) => sum + f.sizeBytes, 0);
}
