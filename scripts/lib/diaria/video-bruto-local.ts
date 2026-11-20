/**
 * video-bruto-local.ts (#13740) — o bruto está inteiro e local antes de ler?
 *
 * Na 261119 um dos 7 brutos (9,57 GB) existia em `I:` só como item ainda não
 * baixado pelo Drive for desktop, e outro ainda estava sendo copiado para a
 * pasta da edição. Qualquer leitura disparava o download pela nuvem (rede
 * lenta) e o `transcribe`/`inventory` penduravam sem dizer nada. Antes de ler
 * cada bruto, `transcribe`, `inventory` e `check-video-env --montagem`
 * conferem duas coisas, sem ler o conteúdo:
 *
 * - no Windows, os atributos do arquivo: OFFLINE, RECALL_ON_OPEN ou
 *   RECALL_ON_DATA_ACCESS ligados = o conteúdo está só na nuvem (placeholder);
 * - o tamanho estável entre duas leituras do metadado: mudou = ainda copiando
 *   ou sincronizando. Tamanho 0 também para (placeholder vazio, cópia que nem
 *   começou).
 *
 * Qualquer um desses para o comando com a mensagem nomeando cada arquivo, em
 * vez de pendurar. Atributo ilegível (PowerShell ausente, erro) não bloqueia:
 * só o tamanho é conferido, e a mensagem diz que o atributo não foi lido.
 *
 * Funções puras com IO injetável (testadas); o default usa `statSync`, uma
 * espera síncrona e, só no Windows, uma única chamada ao PowerShell para todos
 * os arquivos.
 */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename } from "node:path";

/** FILE_ATTRIBUTE_OFFLINE: os dados não estão disponíveis na hora. */
export const WIN_ATTR_OFFLINE = 0x1000;
/** FILE_ATTRIBUTE_RECALL_ON_OPEN: abrir o arquivo dispara o download. */
export const WIN_ATTR_RECALL_ON_OPEN = 0x40000;
/** FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: ler o conteúdo dispara o download (placeholder do Cloud Files). */
export const WIN_ATTR_RECALL_ON_DATA_ACCESS = 0x400000;
const CLOUD_ONLY_MASK = WIN_ATTR_OFFLINE | WIN_ATTR_RECALL_ON_OPEN | WIN_ATTR_RECALL_ON_DATA_ACCESS;

/** Espera entre as duas leituras do tamanho (o arquivo sendo copiado cresce bem mais que isso nesse tempo). */
export const BRUTO_SIZE_SETTLE_MS = 1500;

/** O atributo diz que o conteúdo está só na nuvem? */
export function cloudOnlyAttributes(attrs: number): boolean {
  return Number.isSafeInteger(attrs) && attrs >= 0 && (attrs & CLOUD_ONLY_MASK) !== 0;
}

export interface BrutoLocalDeps {
  /** Tamanho em bytes pelo metadado (nunca lê o conteúdo). */
  size(path: string): number;
  /** Espera síncrona (os comandos que chamam são síncronos). */
  sleep(ms: number): void;
  /** Atributos do Windows por caminho, ou null se não deu para ler (fora do Windows: não chamado). */
  windowsAttributes?(paths: readonly string[]): Map<string, number> | null;
  platform: NodeJS.Platform;
}

export interface BrutoLocalProblem {
  path: string;
  reason: "nuvem" | "crescendo" | "vazio" | "ilegivel";
  detail: string;
}

export interface BrutoLocalCheck {
  problems: BrutoLocalProblem[];
  /** Windows sem o atributo lido: só o tamanho foi conferido. */
  attributesUnread: boolean;
}

const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;

/** Confere cada caminho (puro com `deps`): atributo de nuvem, tamanho zero, tamanho mudando. */
export function checkBrutosLocal(paths: readonly string[], deps: BrutoLocalDeps, opts: { settleMs?: number } = {}): BrutoLocalCheck {
  const unique = [...new Set(paths)];
  const problems: BrutoLocalProblem[] = [];
  if (!unique.length) return { problems, attributesUnread: false };
  let attributesUnread = false;
  const flagged = new Set<string>();
  if (deps.platform === "win32") {
    const attrs = deps.windowsAttributes?.(unique) ?? null;
    if (!attrs) attributesUnread = true;
    else {
      for (const p of unique) {
        const a = attrs.get(p);
        if (a !== undefined && cloudOnlyAttributes(a)) {
          problems.push({ path: p, reason: "nuvem", detail: `só na nuvem (atributo 0x${a.toString(16)}: o Drive for desktop ainda não baixou o conteúdo)` });
          flagged.add(p);
        }
      }
    }
  }
  const first = new Map<string, number>();
  for (const p of unique) {
    if (flagged.has(p)) continue;
    try {
      first.set(p, deps.size(p));
    } catch (e) {
      problems.push({ path: p, reason: "ilegivel", detail: `metadado ilegível (${(e as Error).message})` });
      flagged.add(p);
    }
  }
  if (first.size) deps.sleep(opts.settleMs ?? BRUTO_SIZE_SETTLE_MS);
  for (const [p, a] of first) {
    let b: number;
    try {
      b = deps.size(p);
    } catch (e) {
      problems.push({ path: p, reason: "ilegivel", detail: `metadado ilegível (${(e as Error).message})` });
      continue;
    }
    if (a !== b) problems.push({ path: p, reason: "crescendo", detail: `tamanho mudando (${gb(a)} → ${gb(b)} em ${((opts.settleMs ?? BRUTO_SIZE_SETTLE_MS) / 1000).toFixed(1)} s): ainda copiando ou sincronizando` });
    else if (b === 0) problems.push({ path: p, reason: "vazio", detail: "0 bytes: cópia que não começou ou item ainda não baixado" });
  }
  // A ordem de entrada, para a mensagem bater com a lista do comando.
  problems.sort((x, y) => unique.indexOf(x.path) - unique.indexOf(y.path));
  return { problems, attributesUnread };
}

/** Bruto que não está inteiro e local: o comando para em vez de pendurar na leitura (#13740). */
export class BrutoNotLocalError extends Error {
  constructor(message: string, readonly problems: readonly BrutoLocalProblem[]) {
    super(message);
    this.name = "BrutoNotLocalError";
  }
}

/** A mensagem de parada, um arquivo por linha, com a correção. */
export function brutoNotLocalMessage(what: string, check: BrutoLocalCheck): string {
  const lines = check.problems.map((p) => `  - ${basename(p.path)}: ${p.detail} (${p.path})`);
  return [
    `${what}: ${check.problems.length === 1 ? "1 bruto não está inteiro e local" : `${check.problems.length} brutos não estão inteiros e locais`}; ler agora dispararia o download pela nuvem e pendura (#13740):`,
    ...lines,
    "Espere a cópia ou o Drive for desktop terminar (no Drive for desktop: botão direito > Disponibilizar off-line), ou copie o arquivo para uma raiz local (--drive-root) e rode de novo.",
    ...(check.attributesUnread ? ["(atributo de nuvem do Windows não lido: só o tamanho foi conferido)"] : []),
  ].join("\n");
}

/** Para com `BrutoNotLocalError` se algum caminho não está inteiro e local. */
export function assertBrutosLocal(what: string, paths: readonly string[], deps: BrutoLocalDeps = defaultBrutoLocalDeps(), opts: { settleMs?: number } = {}): BrutoLocalCheck {
  const check = checkBrutosLocal(paths, deps, opts);
  if (check.problems.length) throw new BrutoNotLocalError(brutoNotLocalMessage(what, check), check.problems);
  return check;
}

/** Espera síncrona sem ocupar a CPU. */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Atributos de vários arquivos numa chamada ao PowerShell (os caminhos vão em
 * JSON por variável de ambiente, nunca interpolados no comando). Linha por
 * arquivo, `-1` para o que não deu para ler. Falha do PowerShell = null.
 */
export function readWindowsAttributes(paths: readonly string[], run: typeof spawnSync = spawnSync): Map<string, number> | null {
  if (!paths.length) return new Map();
  const script = "$ErrorActionPreference='Stop'; $p = $env:DIARIA_BRUTO_PATHS | ConvertFrom-Json; foreach ($x in @($p)) { try { [int64][System.IO.File]::GetAttributes($x) } catch { -1 } }";
  const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, DIARIA_BRUTO_PATHS: JSON.stringify(paths) },
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  const values = String(r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  if (values.length !== paths.length) return null;
  const out = new Map<string, number>();
  paths.forEach((p, i) => {
    const n = Number(values[i]);
    if (Number.isSafeInteger(n) && n >= 0) out.set(p, n);
  });
  return out;
}

export function defaultBrutoLocalDeps(): BrutoLocalDeps {
  return {
    size: (p) => statSync(p).size,
    sleep: sleepSync,
    windowsAttributes: (paths) => readWindowsAttributes(paths),
    platform: process.platform,
  };
}
