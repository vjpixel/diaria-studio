/**
 * resolve-edition-dir-arg.ts (#9427)
 *
 * Resolve o argumento `--edition-dir` (ou posicional `<edition-dir>`) dos
 * publishers do Stage 5 de forma independente do cwd do processo e robusta
 * à conversão de path do Git Bash (MSYS) no Windows.
 *
 * Incidente que motivou (edição 261002): publishers despachados em subshells
 * background `( ... ) &` saíram com "03-social.md não encontrado" e o
 * `brevo-diaria-stage5-dispatch.ts` com `C:\Program Files\Git\02-reviewed.md
 * not found` — o argumento chegou ao Node como o diretório de instalação do
 * Git, assinatura clássica do MSYS convertendo um path POSIX-absoluto (ex.:
 * `/` vindo de `$VAR/` com `$VAR` vazio no subshell, ou `/data/editions/...`)
 * para `C:/Program Files/Git/...`. O brevo-dispatch ainda resolvia contra
 * `process.cwd()` em vez da raiz do repo.
 *
 * Regras:
 *  1. Vazio/só espaços → erro (nunca resolve para a raiz do repo em silêncio).
 *  2. Path que cai dentro do diretório de instalação do Git for Windows
 *     (`.../Program Files/Git/...` ou `.../Git/usr/...`) → erro explícito
 *     com dica sobre a conversão MSYS — resolver isso em silêncio publicaria
 *     contra o diretório errado.
 *  3. No win32, path estilo MSYS `/c/Users/...` → `C:/Users/...`.
 *  4. Relativo → `path.resolve(root, raw)` (raiz do repo, nunca o cwd).
 */

import { win32, posix } from "node:path";

export class EditionDirArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditionDirArgError";
  }
}

export interface ResolveEditionDirArgOptions {
  /** Raiz do repo — base para paths relativos. */
  root: string;
  /** Injetável para teste; default `process.platform`. */
  platform?: NodeJS.Platform;
}

/** Assinatura de um path POSIX-absoluto convertido pelo MSYS para a instalação do Git. */
const MSYS_GIT_INSTALL_RE = /(^|[\\/])Program Files( \(x86\))?[\\/]Git([\\/]|$)/i;

/** `/c/Users/x` → `C:/Users/x` (forma MSYS/Cygwin de drive). */
const MSYS_DRIVE_RE = /^\/([a-zA-Z])(\/|$)/;

export function resolveEditionDirArg(raw: string | undefined | null, opts: ResolveEditionDirArgOptions): string {
  const platform = opts.platform ?? process.platform;
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    throw new EditionDirArgError(
      "--edition-dir vazio — passe o diretório da edição (ex.: data/editions/2610/261002/). " +
        "Se veio de uma variável de shell, ela pode estar vazia no subshell.",
    );
  }

  if (MSYS_GIT_INSTALL_RE.test(trimmed)) {
    throw new EditionDirArgError(
      `--edition-dir "${trimmed}" aponta para a instalação do Git — sinal de conversão de path do ` +
        "Git Bash (MSYS) sobre um argumento POSIX-absoluto (ex.: '/' de uma variável vazia, ou " +
        "'/data/editions/...'). Passe o path relativo à raiz do repo (data/editions/AAMM/AAMMDD/) " +
        "ou absoluto Windows (C:/...), ou exporte MSYS_NO_PATHCONV=1.",
    );
  }

  let normalized = trimmed;
  if (platform === "win32") {
    const m = MSYS_DRIVE_RE.exec(normalized);
    if (m) normalized = `${m[1].toUpperCase()}:/${normalized.slice(m[0].length)}`;
  }

  // path.win32/posix explícito para o teste poder emular a outra plataforma;
  // em produção `platform === process.platform`, idêntico ao `path` default.
  const p = platform === "win32" ? win32 : posix;
  return p.isAbsolute(normalized) ? p.resolve(normalized) : p.resolve(opts.root, normalized);
}

/**
 * Variante de CLI: imprime o erro em stderr e encerra com `exitCode`
 * (default 2 = uso) em vez de lançar.
 */
export function resolveEditionDirArgOrExit(
  raw: string | undefined | null,
  opts: ResolveEditionDirArgOptions & { exitCode?: number },
): string {
  try {
    return resolveEditionDirArg(raw, opts);
  } catch (e) {
    if (e instanceof EditionDirArgError) {
      process.stderr.write(`ERRO: ${e.message}\n`);
      process.exit(opts.exitCode ?? 2);
    }
    throw e;
  }
}
