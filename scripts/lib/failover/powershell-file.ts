/**
 * scripts/lib/failover/powershell-file.ts (#12993)
 *
 * Roda um script PowerShell gravado num `.ps1` temporário, com `-File`.
 *
 * Por que não `-Command -` lendo o script do stdin: o Windows PowerShell 5.1
 * descarta em silêncio tudo a partir do primeiro bloco multi-linha
 * (`if (...) {` numa linha, `}` em outra) e sai com status 0. Reprodução:
 *
 *   printf 'if ($true) {\n Write-Output "inside"\n}\nWrite-Output "after"\n' \
 *     | powershell.exe -NoProfile -NonInteractive -Command -
 *
 * não imprime nada e devolve 0. No 1º ensaio do failover (15/11/2026, Neo) o
 * `--arm` disse "armado: 15 tarefas", gravou o lease do Neo e registrou ZERO
 * `Diaria-Failover-*`: o script de remoção que abre o de registro tem um
 * `if ($still.Count -gt 0) {` multi-linha, e tudo depois dele sumiu.
 *
 * O `.ps1` vai com BOM UTF-8: sem BOM o PowerShell 5.1 lê o arquivo como ANSI
 * (página de código do sistema) e corrompe os acentos dos textos do script.
 * A 1ª linha troca a saída do console para UTF-8: sem ela o stdout/stderr sai
 * na página OEM e o `AVISO #12993` chegava ao editor com "execu��o".
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Prefixo que faz o stdout/stderr do script sair em UTF-8 (lido com `encoding: "utf8"`). */
export const UTF8_OUTPUT_LINE = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false";

/** Conteúdo do `.ps1`: BOM UTF-8 + saída em UTF-8 + o script, tudo em UTF-8. */
export function encodePs1(script: string): Buffer {
  return Buffer.concat([UTF8_BOM, Buffer.from(`${UTF8_OUTPUT_LINE}\n${script}`, "utf8")]);
}

/** Argumentos do `powershell.exe` para rodar o arquivo (nunca `-Command -`). */
export function powershellFileArgs(scriptPath: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
}

export type PsResult = { ok: boolean; stdout: string; stderr: string };

type SpawnResult = { status: number | null; stdout?: string | null; stderr?: string | null; error?: Error };

/** Efeitos colaterais injetáveis (teste em Linux sem PowerShell). */
export interface PowerShellFileDeps {
  spawn: (cmd: string, args: string[], opts: { encoding: "utf8"; timeout: number; windowsHide: boolean }) => SpawnResult;
  makeTempDir: () => string;
  writeFile: (path: string, data: Buffer) => void;
  removeDir: (path: string) => void;
}

const defaultDeps: PowerShellFileDeps = {
  spawn: (cmd, args, opts) => spawnSync(cmd, args, opts),
  makeTempDir: () => mkdtempSync(join(tmpdir(), "diaria-ps-")),
  writeFile: (path, data) => writeFileSync(path, data),
  removeDir: (path) => rmSync(path, { recursive: true, force: true }),
};

/**
 * Grava `script` num `.ps1` temporário e roda com `powershell.exe -File`.
 * O diretório temporário é apagado no `finally`, inclusive quando o spawn
 * lança. Falha de escrita do arquivo vira `ok: false` (nunca lança).
 */
export function runPowerShellFile(script: string, timeoutMs: number, deps: Partial<PowerShellFileDeps> = {}): PsResult {
  const d: PowerShellFileDeps = { ...defaultDeps, ...deps };
  let dir: string | null = null;
  try {
    dir = d.makeTempDir();
    const path = join(dir, "script.ps1");
    d.writeFile(path, encodePs1(script));
    const r = d.spawn("powershell.exe", powershellFileArgs(path), { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    if (r.error) return { ok: false, stdout: r.stdout ?? "", stderr: r.error.message };
    return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (e) {
    return { ok: false, stdout: "", stderr: `script PowerShell não rodou: ${(e as Error).message}` };
  } finally {
    if (dir) {
      try {
        d.removeDir(dir);
      } catch {
        // Sobra de arquivo temporário não muda o resultado do script.
      }
    }
  }
}
