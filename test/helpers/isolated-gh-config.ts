/**
 * Config do gh isolado pros testes que rodam os hooks de merge (#10689).
 *
 * Desde o #10689 o detector de merge lê os aliases do `config.yml` do gh da
 * máquina (`GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `%AppData%\GitHub CLI`,
 * `~/.config/gh`). Um hook rodado pelo teste com o ambiente herdado leria o
 * config REAL de quem roda a suíte — um alias pessoal (`m: pr merge`) mudaria
 * o veredito. `GH_CONFIG_DIR` apontando pra um diretório VAZIO (sem
 * `config.yml` → ENOENT → nenhum alias) torna o resultado independente da
 * máquina.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Diretório vazio, criado uma vez por processo de teste e apagado no fim. */
export const ISOLATED_GH_CONFIG_DIR = mkdtempSync(join(tmpdir(), "gh-config-vazio-"));
process.on("exit", () => {
  try {
    rmSync(ISOLATED_GH_CONFIG_DIR, { recursive: true, force: true });
  } catch {
    // diretório temporário: o SO limpa depois
  }
});

/** `env` (default: `process.env`) com `GH_CONFIG_DIR` apontando pro diretório vazio. */
export function withIsolatedGhConfig(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, GH_CONFIG_DIR: ISOLATED_GH_CONFIG_DIR };
}
