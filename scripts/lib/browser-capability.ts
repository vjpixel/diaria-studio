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
 * Sinal, por plataforma (a checagem de `DISPLAY`/`WAYLAND_DISPLAY` é um
 * conceito X11/Wayland — **só faz sentido em Linux**; aplicá-la também no
 * Windows daria falso-negativo permanente em `neo`, a MÁQUINA que #5209
 * designa pra rodar `/diaria-apoios-sync` — Windows não usa essas env vars
 * pra sinalizar sessão gráfica, então checá-las lá sempre resultaria em
 * `'unavailable'` mesmo com o editor logado numa sessão desktop normal):
 *   - **Linux**: `DISPLAY` OU `WAYLAND_DISPLAY` não-vazio (há display gráfico
 *     pra anexar) E pelo menos um binário conhecido
 *     (`google-chrome`/`chromium`/`chromium-browser`) presente no PATH.
 *   - **Windows/macOS**: a checagem de display não se aplica (sessão
 *     interativa = GUI presente, por convenção da plataforma) — só o binário
 *     importa. No Windows, `chrome.exe`/`msedge.exe` tipicamente NÃO estão no
 *     PATH (instalador não adiciona por padrão), então além do PATH também
 *     sondamos os diretórios de instalação usuais
 *     (`%ProgramFiles%`/`%ProgramFiles(x86)%`/`%LOCALAPPDATA%`).
 * Checagem de binário é puramente por filesystem (varre diretórios) — nunca
 * executa o binário (rodar `google-chrome`/`chrome.exe` sem argumentos abre a
 * GUI: efeito colateral inaceitável só pra sondar disponibilidade).
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
import { win32 as pathWin32, posix as pathPosix } from "node:path";
import { isMainModule } from "./cli-args.ts";

/**
 * Escolhe o módulo de path (`win32` ou `posix`) pela plataforma INJETADA
 * (parâmetro `platform`), nunca pela plataforma real do processo — os
 * imports estáticos de `node:path` (`join`/`delimiter` "nus") resolvem pro
 * SO real do processo Node em execução, o que quebraria os testes deste
 * módulo: eles rodam num único processo (tipicamente Linux, `predator`) mas
 * precisam simular paths estilo Windows (`C:\...`, `;` como delimiter de
 * PATH) ao injetar `platform: "win32"`.
 */
function pathModuleFor(platform: NodeJS.Platform): typeof pathWin32 {
  return platform === "win32" ? pathWin32 : pathPosix;
}

export type BrowserCapability = "available" | "unavailable" | "unknown";

/** Binários de navegador conhecidos no PATH, checados nesta ordem — por
 * plataforma (nomes/extensões diferem). */
const BROWSER_BINARIES_BY_PLATFORM: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  linux: ["google-chrome", "chromium", "chromium-browser"],
  darwin: ["google-chrome", "chromium"],
  win32: ["chrome.exe", "msedge.exe"],
};

/** Fallback, se `process.platform` não bater com nenhuma chave conhecida
 * acima (plataforma não mapeada) — tenta os nomes POSIX genéricos. */
const DEFAULT_BROWSER_BINARIES = ["google-chrome", "chromium", "chromium-browser"] as const;

/**
 * Diretórios de instalação usuais do Chrome/Edge no Windows, fora do PATH
 * (o instalador não adiciona `chrome.exe` ao PATH por padrão — checar só o
 * PATH sub-detecta Chrome em quase toda instalação real). Cada entrada é
 * `[env var, subpath relativo]`; resolvida só se a env var existir.
 */
const WINDOWS_INSTALL_DIR_CANDIDATES: ReadonlyArray<{ envVar: string; subpath: string[] }> = [
  { envVar: "ProgramFiles", subpath: ["Google", "Chrome", "Application", "chrome.exe"] },
  { envVar: "ProgramFiles(x86)", subpath: ["Google", "Chrome", "Application", "chrome.exe"] },
  { envVar: "LOCALAPPDATA", subpath: ["Google", "Chrome", "Application", "chrome.exe"] },
  { envVar: "ProgramFiles(x86)", subpath: ["Microsoft", "Edge", "Application", "msedge.exe"] },
];

/** Opções de injeção para tornar `detectBrowserCapability` testável sem
 * depender do ambiente real nem do filesystem real. Em runtime, omitir. */
export interface BrowserCapabilityOptions {
  /** Substituto de `process.env` para testes (mock). */
  env?: NodeJS.ProcessEnv;
  /** Substituto de `fs.existsSync` para testes (mock). */
  existsFn?: (path: string) => boolean;
  /** Substituto de `process.platform` para testes (mock). */
  platform?: NodeJS.Platform;
}

/**
 * Varre os diretórios do PATH procurando `name` como arquivo — nunca executa
 * o binário (só confirma presença no filesystem). Puramente síncrono e sem
 * efeito colateral. `platform` decide o separador de PATH (`;` no Windows,
 * `:` em POSIX) e o join de path, independente do SO real do processo.
 */
function binaryExistsOnPath(
  name: string,
  pathEnv: string,
  existsFn: (path: string) => boolean,
  platform: NodeJS.Platform,
): boolean {
  const pathMod = pathModuleFor(platform);
  const dirs = pathEnv.split(pathMod.delimiter).filter(Boolean);
  return dirs.some((dir) => existsFn(pathMod.join(dir, name)));
}

/** No Windows, além do PATH, sonda os diretórios de instalação usuais
 * (Chrome/Edge raramente entram no PATH). Só chamada quando `platform ===
 * 'win32'` — sempre usa o join estilo Windows. */
function binaryExistsInWindowsInstallDirs(
  env: NodeJS.ProcessEnv,
  existsFn: (path: string) => boolean,
): boolean {
  return WINDOWS_INSTALL_DIR_CANDIDATES.some(({ envVar, subpath }) => {
    const base = env[envVar];
    return Boolean(base) && existsFn(pathWin32.join(base as string, ...subpath));
  });
}

/**
 * Detecta se há navegador utilizável (sessão gráfica + binário instalado)
 * nesta máquina.
 *
 * - **Linux**: `DISPLAY`/`WAYLAND_DISPLAY` ambos ausentes/vazios →
 *   `'unavailable'` (sessão headless — é o caso motivador, `predator`, #5208).
 *   Display presente mas nenhum binário conhecido no PATH → `'unavailable'`.
 *   Display presente E binário encontrado → `'available'`.
 * - **Windows/macOS**: a checagem de display é ignorada (não é um conceito
 *   dessas plataformas — sessão interativa já implica GUI); só o binário
 *   decide. No Windows, PATH + diretórios de instalação usuais são
 *   sondados juntos.
 * - Qualquer exceção inesperada durante a sondagem (env/fs indisponíveis de
 *   forma anômala) → `'unknown'`, nunca lançada pro caller.
 */
export function detectBrowserCapability(opts: BrowserCapabilityOptions = {}): BrowserCapability {
  try {
    const { env = process.env, existsFn = existsSync, platform = process.platform } = opts;

    if (platform === "linux") {
      const hasDisplay = Boolean(env.DISPLAY?.trim()) || Boolean(env.WAYLAND_DISPLAY?.trim());
      if (!hasDisplay) return "unavailable";
    }
    // Windows/macOS/outras plataformas: display não é um sinal aplicável,
    // segue direto pra checagem de binário.

    const binaries = BROWSER_BINARIES_BY_PLATFORM[platform] ?? DEFAULT_BROWSER_BINARIES;
    const pathEnv = env.PATH ?? "";
    const hasBrowserBinary = binaries.some((bin) =>
      binaryExistsOnPath(bin, pathEnv, existsFn, platform),
    );
    if (hasBrowserBinary) return "available";

    if (platform === "win32" && binaryExistsInWindowsInstallDirs(env, existsFn)) {
      return "available";
    }

    return "unavailable";
  } catch {
    return "unknown";
  }
}

// CLI guard: só executa como main module, importável sem efeito colateral.
if (isMainModule(import.meta.url)) {
  console.log(detectBrowserCapability());
}
