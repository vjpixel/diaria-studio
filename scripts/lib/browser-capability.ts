/**
 * browser-capability.ts (#5208)
 *
 * Detecta se HÁ um navegador utilizável (Claude in Chrome / automação via
 * browser) nesta máquina. Eixo SEPARADO de `exec-mode.ts::detectExecMode` —
 * não confundir os dois:
 *
 *   - `ExecMode` (`exec-mode.ts`) responde "tenho os recursos locais (junction
 *     `data/`, credenciais, ComfyUI)?" — sinal correto pro que mede,
 *     **inalterado por este módulo**.
 *   - `BrowserCapability` (aqui) responde uma pergunta DIFERENTE: "existe
 *     display gráfico + binário de navegador nesta máquina, pra automação
 *     tipo Claude in Chrome funcionar?" — derivado do ambiente
 *     (`DISPLAY`/`WAYLAND_DISPLAY`) + presença de binário no PATH, nunca de
 *     `data/`.
 *
 * A confusão dos dois eixos é a causa raiz do #5208: `predator` (servidor
 * onde roda `/diaria-overnight`) resolve `local` no eixo do filesystem
 * (junction `data/` presente) mas é **headless** no eixo do navegador — sem
 * `DISPLAY`/`WAYLAND_DISPLAY`, sem `google-chrome`/`chromium` instalado.
 * `detectExecMode() === 'local'` nunca deveria ter sido lido como "logo,
 * Claude in Chrome funciona aqui" — os dois sinais respondem perguntas
 * diferentes e precisam ser checados separadamente (ver #5209, que consome
 * este helper no preflight de `/diaria-apoios-sync`).
 *
 * Sinal: `DISPLAY` OU `WAYLAND_DISPLAY` não-vazio (há display gráfico pra
 * anexar) E pelo menos um binário de browser conhecido
 * (`google-chrome`/`chromium`/`chromium-browser`) presente no PATH.
 * Checagem de PATH é puramente por filesystem (varre os diretórios do PATH
 * procurando o arquivo) — nunca executa o binário (rodar `google-chrome` sem
 * argumentos abre a GUI: efeito colateral inaceitável só pra sondar
 * disponibilidade).
 *
 * Fail-soft total (padrão dos demais helpers CLI do repo, ex: `exec-mode.ts`,
 * `studio-chat-enabled.ts`): nunca lança, sempre retorna um dos 3 estados.
 * `'unknown'` é o resultado de qualquer falha inesperada na própria sondagem
 * (nunca confundir com `'unavailable'`, que é uma resposta determinística —
 * ver #4800 pro mesmo princípio aplicado a `TaskSchedulerKind`).
 *
 * Uso em runtime (skills/scripts):
 *   ```ts
 *   import { detectBrowserCapability } from '../scripts/lib/browser-capability.ts';
 *   const capability = detectBrowserCapability();
 *   // 'available' | 'unavailable' | 'unknown'
 *   ```
 *
 * Uso como CLI (Passo 0 de skills que dependem de Claude in Chrome):
 *   ```bash
 *   npx tsx scripts/lib/browser-capability.ts
 *   # → imprime "available" | "unavailable" | "unknown" em stdout (exit 0 sempre)
 *   ```
 *
 * @see scripts/lib/exec-mode.ts (eixo irmão — recursos locais / ExecMode)
 * @see .claude/skills/diaria-apoios-sync/SKILL.md § Passo 0 (#5209, 1º consumidor)
 */

import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { isMainModule } from "./cli-args.ts";

export type BrowserCapability = "available" | "unavailable" | "unknown";

/** Binários de navegador conhecidos, checados nesta ordem no PATH. */
const BROWSER_BINARIES = ["google-chrome", "chromium", "chromium-browser"] as const;

/** Opções de injeção para tornar `detectBrowserCapability` testável sem
 * depender do ambiente real nem do filesystem real. Em runtime, omitir. */
export interface BrowserCapabilityOptions {
  /** Substituto de `process.env` para testes (mock). */
  env?: NodeJS.ProcessEnv;
  /** Substituto de `fs.existsSync` para testes (mock). */
  existsFn?: (path: string) => boolean;
}

/**
 * Varre os diretórios do PATH procurando `name` como arquivo — nunca executa
 * o binário (só confirma presença no filesystem). Puramente síncrono e sem
 * efeito colateral.
 */
function binaryExistsOnPath(
  name: string,
  pathEnv: string,
  existsFn: (path: string) => boolean,
): boolean {
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  return dirs.some((dir) => existsFn(join(dir, name)));
}

/**
 * Detecta se há navegador utilizável (display gráfico + binário instalado)
 * nesta máquina.
 *
 * - `DISPLAY`/`WAYLAND_DISPLAY` ambos ausentes/vazios → `'unavailable'`
 *   (sessão headless — nenhum binário instalado teria onde renderizar).
 * - Display presente mas nenhum dos binários conhecidos está no PATH →
 *   `'unavailable'`.
 * - Display presente E algum binário encontrado → `'available'`.
 * - Qualquer exceção inesperada durante a sondagem (env/fs indisponíveis de
 *   forma anômala) → `'unknown'`, nunca lançada pro caller.
 */
export function detectBrowserCapability(opts: BrowserCapabilityOptions = {}): BrowserCapability {
  try {
    const { env = process.env, existsFn = existsSync } = opts;
    const hasDisplay = Boolean(env.DISPLAY?.trim()) || Boolean(env.WAYLAND_DISPLAY?.trim());
    if (!hasDisplay) return "unavailable";

    const pathEnv = env.PATH ?? "";
    const hasBrowserBinary = BROWSER_BINARIES.some((bin) =>
      binaryExistsOnPath(bin, pathEnv, existsFn),
    );
    return hasBrowserBinary ? "available" : "unavailable";
  } catch {
    return "unknown";
  }
}

// CLI guard: só executa como main module, importável sem efeito colateral.
if (isMainModule(import.meta.url)) {
  console.log(detectBrowserCapability());
}
