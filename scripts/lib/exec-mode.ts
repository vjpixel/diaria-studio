/**
 * exec-mode.ts (#2643)
 *
 * Detecta o modo de execução da sessão: `'local'` (máquina do editor, com
 * todos os recursos locais disponíveis) ou `'cloud'` (container efêmero, clone
 * fresco sem junction `data/` nem ComfyUI nem credenciais locais).
 *
 * Sinal canônico: presença + resolução do junction `data/` como diretório
 * acessível. A junction aponta para
 * `~/OneDrive/Documentos/diaria-studio-data` e só existe localmente — num
 * clone fresco de cloud o path `data/` simplesmente não existe.
 *
 * Por que este sinal?
 * - É o pré-requisito explícito de TODA skill (`data/` é criado 1x por máquina
 *   antes de qualquer skill rodar — CLAUDE.md § Setup).
 * - É binário e determinístico: `statSync('data').isDirectory()` retorna true
 *   (local) ou lança (cloud). Não depende de env vars de runtime, que variam
 *   por provider e são mutable.
 * - Já é o bloqueio real: issues com label `local` tipicamente precisam de
 *   `data/`, ComfyUI, ou credenciais que também dependem de `data/`.
 *
 * O helper é testável com fs mockado (ver `test/exec-mode.test.ts`) —
 * injeta-se a função stat pelas params opcionais.
 *
 * Uso em runtime (skills/orchestrator):
 *   ```ts
 *   import { detectExecMode } from '../scripts/lib/exec-mode.ts';
 *   const mode = detectExecMode();
 *   // 'local' | 'cloud'
 *   ```
 *
 * Uso como CLI (para shell scripts / Fase 0 das skills):
 *   ```bash
 *   npx tsx scripts/lib/exec-mode.ts
 *   # → imprime "local" ou "cloud" em stdout (exit 0 sempre)
 *   ```
 *
 * @see .claude/skills/diaria-overnight/SKILL.md § Fase 0 passo 4
 * @see .claude/skills/diaria-develop/SKILL.md § Fase 0
 * @see CLAUDE.md § Label `local` — critério e comportamento das skills
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ExecMode = "local" | "cloud";

/**
 * Opções de injeção para tornar a função testável sem depender do fs real.
 * Em runtime, omitir — usa `statSync` de `node:fs` e o cwd real.
 */
export interface ExecModeOptions {
  /** Substituto de `fs.statSync` para testes (mock). */
  statFn?: (path: string) => { isDirectory(): boolean };
  /** Diretório raiz do projeto (default: cwd). */
  projectRoot?: string;
}

/**
 * Detecta se a sessão é local (editor na máquina) ou cloud (container efêmero).
 *
 * Retorna `'local'` se o junction `data/` existe e resolve como diretório;
 * retorna `'cloud'` caso contrário (path inexistente, ENOENT, ou não-diretório).
 */
export function detectExecMode(opts: ExecModeOptions = {}): ExecMode {
  const { statFn = statSync, projectRoot = process.cwd() } = opts;
  const dataPath = join(projectRoot, "data");
  try {
    return statFn(dataPath).isDirectory() ? "local" : "cloud";
  } catch {
    // ENOENT (clone fresco), EACCES, junction quebrada → cloud
    return "cloud";
  }
}

// CLI guard: só executa como main module, importável sem efeito colateral.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(detectExecMode());
}
