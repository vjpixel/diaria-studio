/**
 * scripts/lib/diff-touched-lines.ts (#7978, Camada 5 da #7972)
 *
 * Helper PURO (parsing) + 1 função com I/O (`gitDiffTouchedLines`, spawna
 * `git`) — extrai, pra 1 arquivo, o conjunto de números de linha que um
 * diff tocou NO ARQUIVO NOVO (adições + o contexto imediato de remoções
 * puras). Usado por `scripts/check-editorial-signoff.ts` pra decidir se
 * uma mudança em `.claude/agents/scorer.md` cai DENTRO de um bloco
 * `CALIBRATED:*` (`scripts/lib/calibration-file-allowlist.ts`) — mesma
 * separação parser-puro/I-O de `diff-line-stats.ts`, que já resolve o
 * problema irmão (contagem agregada, não posição).
 *
 * Formato lido: `git diff --unified=0` — cada hunk `@@ -a,b +c,d @@` diz
 * "no arquivo novo, a partir da linha c, d linhas mudaram" (d omitido = 1
 * linha). `unified=0` garante que só linhas REALMENTE tocadas aparecem,
 * sem contexto extra que infParia falso-positivo de "toquei uma linha
 * vizinha ao bloco calibrado".
 */
import { spawnSync } from "node:child_process";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Parseia a saída de `git diff --unified=0` pra 1 arquivo, retornando o conjunto de linhas tocadas no arquivo NOVO. Linha de deleção pura (d=0 no hunk) não aparece — não há linha nova correspondente a marcar. */
export function parseTouchedLinesFromUnifiedZeroDiff(diffOutput: string): Set<number> {
  const touched = new Set<number>();
  for (const line of diffOutput.split("\n")) {
    const m = HUNK_HEADER.exec(line);
    if (!m) continue;
    const startLine = Number.parseInt(m[1], 10);
    const count = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1;
    if (count === 0) continue; // deleção pura, sem linha nova a marcar
    for (let i = 0; i < count; i++) touched.add(startLine + i);
  }
  return touched;
}

/** Roda `git diff --unified=0 {baseSha}..{headSha} -- {path}` e retorna as linhas tocadas no arquivo novo. Arquivo deletado no head (`git show` falha) retorna conjunto vazio — o chamador trata "arquivo sumiu" separadamente (ver `newContent === null` em `isCalibrationTouchingFile`). */
export function gitDiffTouchedLines(cwd: string, baseSha: string, headSha: string, path: string): Set<number> {
  const result = spawnSync("git", ["diff", "--unified=0", `${baseSha}..${headSha}`, "--", path], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git diff falhou (exit ${result.status}) pra ${path}: ${result.stderr}`);
  }
  return parseTouchedLinesFromUnifiedZeroDiff(result.stdout);
}

/** Lê o conteúdo de um arquivo em um SHA específico (`git show {sha}:{path}`). `null` se o arquivo não existir nesse SHA (deletado, ou criado só depois) — nunca lança pra esse caso, que é esperado. */
export function gitShowFileAtSha(cwd: string, sha: string, path: string): string | null {
  const result = spawnSync("git", ["show", `${sha}:${path}`], { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout;
}
