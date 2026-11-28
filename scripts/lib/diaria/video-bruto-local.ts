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
 * - a leitura cronometrada (investigação no Neo em 27/11/2026): o Drive for
 *   desktop monta um volume virtual próprio e deixa todo arquivo com atributo
 *   `0x80` (Normal), baixado ou não, então o atributo acima não pega o bruto
 *   que está só na nuvem. Por isso cada bruto é lido num processo à parte,
 *   com prazo curto (`BRUTO_READ_TIMEOUT_MS`): estourou = o conteúdo ainda vem
 *   da nuvem.
 * - a vazão dessa leitura (#14405): o Drive for desktop pode servir leitura
 *   por trecho sob demanda (como na reprodução de vídeo), e 2 MB chegam em
 *   menos de 1 s numa rede de 50 Mbit/s, então o prazo sozinho só pega rede
 *   muito lenta. A sonda lê `BRUTO_READ_PROBE_CHUNKS` trechos espalhados pelo
 *   arquivo inteiro (o meio fura o cache de início/fim que o player costuma
 *   pedir) e mede a vazão: abaixo de `BRUTO_READ_MIN_BYTES_PER_SEC`, piso
 *   folgado para qualquer disco local, o bruto conta como servido da nuvem.
 *   Os brutos são lidos um por vez, cada um com o próprio prazo, para a vazão
 *   de um não cair por disputa de disco com os outros. Piso não medido no Neo
 *   (premissa da #14405): `DIARIA_BRUTO_MIN_MB_POR_S` troca o piso, e `0`
 *   desliga a checagem de vazão.
 *
 * Qualquer um desses para o comando com a mensagem nomeando cada arquivo, em
 * vez de pendurar. Atributo ilegível (PowerShell ausente, erro) não bloqueia:
 * só o tamanho é conferido, e a mensagem diz que o atributo não foi lido. A
 * sonda de leitura que falha por si (o node filho não sobe) também não
 * bloqueia, e a mensagem diz isso.
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

/** Prazo da leitura cronometrada de cada bruto (32 MB de disco local levam menos de 1 s). */
export const BRUTO_READ_TIMEOUT_MS = 15_000;
/** Tamanho de cada trecho que a sonda lê. */
export const BRUTO_READ_PROBE_BYTES = 4 * 1024 * 1024;
/** Quantos trechos, do início ao fim do arquivo em passos iguais (32 MB no total). */
export const BRUTO_READ_PROBE_CHUNKS = 8;
/**
 * Piso de vazão da sonda: 20 MiB/s (~170 Mbit/s). Disco local, SSD ou HD, lê
 * trechos de 4 MB bem acima disso; o Drive servindo da nuvem numa rede
 * doméstica fica abaixo (50 Mbit/s ≈ 6 MB/s).
 */
export const BRUTO_READ_MIN_BYTES_PER_SEC = 20 * 1024 * 1024;
/** Abaixo disso lido no total (arquivo pequeno), a vazão não é julgada: só o prazo vale. */
export const BRUTO_READ_MIN_RATE_BYTES = 16 * 1024 * 1024;
/** Variável que troca o piso de vazão, em MB/s (`0` desliga a checagem de vazão). */
export const BRUTO_MIN_RATE_ENV = "DIARIA_BRUTO_MIN_MB_POR_S";

/** Resultado da leitura cronometrada de um bruto: leu, leu abaixo do piso de vazão, estourou o prazo ou deu erro. */
export type TimedReadOutcome = "ok" | "devagar" | "timeout" | "erro";

/** Piso de vazão em bytes/s a partir do ambiente (valor inválido = o default). */
export function minReadBytesPerSec(env: Record<string, string | undefined> = process.env): number {
  const raw = env[BRUTO_MIN_RATE_ENV]?.trim();
  if (!raw) return BRUTO_READ_MIN_BYTES_PER_SEC;
  const mb = Number(raw.replace(",", "."));
  return Number.isFinite(mb) && mb >= 0 ? Math.round(mb * 1024 * 1024) : BRUTO_READ_MIN_BYTES_PER_SEC;
}

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
  /**
   * Leitura cronometrada do início e do fim de cada caminho, ou null se a
   * própria sonda falhou. Ausente = leitura não conferida.
   */
  timedRead?(paths: readonly string[], timeoutMs: number): Map<string, TimedReadOutcome> | null;
  platform: NodeJS.Platform;
}

export interface BrutoLocalProblem {
  path: string;
  reason: "nuvem" | "crescendo" | "vazio" | "ilegivel" | "lento";
  detail: string;
}

export interface BrutoLocalCheck {
  problems: BrutoLocalProblem[];
  /** Windows sem o atributo lido: só o tamanho foi conferido. */
  attributesUnread: boolean;
  /** A sonda de leitura cronometrada falhou por si: o conteúdo não foi conferido. */
  readUnchecked?: boolean;
}

const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;

/** Confere cada caminho (puro com `deps`): atributo de nuvem, tamanho zero, tamanho mudando. */
export function checkBrutosLocal(paths: readonly string[], deps: BrutoLocalDeps, opts: { settleMs?: number; readTimeoutMs?: number } = {}): BrutoLocalCheck {
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
    else continue;
    flagged.add(p);
  }
  // O que passou no metadado é lido de verdade, com prazo, num processo à parte.
  let readUnchecked = false;
  const toRead = unique.filter((p) => !flagged.has(p));
  if (deps.timedRead && toRead.length) {
    const timeoutMs = opts.readTimeoutMs ?? BRUTO_READ_TIMEOUT_MS;
    const outcomes = deps.timedRead(toRead, timeoutMs);
    if (!outcomes) readUnchecked = true;
    else {
      for (const p of toRead) {
        const o = outcomes.get(p);
        if (o === "timeout") problems.push({ path: p, reason: "lento", detail: `ler ${BRUTO_READ_PROBE_CHUNKS} trechos do início ao fim não terminou em ${Math.round(timeoutMs / 1000)} s: o Drive for desktop ainda está baixando o arquivo da nuvem` });
        else if (o === "devagar") problems.push({ path: p, reason: "lento", detail: `a leitura de ${BRUTO_READ_PROBE_CHUNKS} trechos espalhados pelo arquivo ficou abaixo do piso de vazão de um disco local: o Drive for desktop está servindo o arquivo da nuvem sob demanda (piso em ${BRUTO_MIN_RATE_ENV}, 0 desliga)` });
        else if (o === "erro") problems.push({ path: p, reason: "ilegivel", detail: "a leitura do conteúdo falhou (arquivo travado ou ainda sincronizando)" });
        else if (o === undefined) readUnchecked = true;
      }
    }
  }
  // A ordem de entrada, para a mensagem bater com a lista do comando.
  problems.sort((x, y) => unique.indexOf(x.path) - unique.indexOf(y.path));
  return readUnchecked ? { problems, attributesUnread, readUnchecked } : { problems, attributesUnread };
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
    ...(check.readUnchecked ? ["(a leitura cronometrada não rodou: o conteúdo não foi conferido)"] : []),
  ].join("\n");
}

/** Para com `BrutoNotLocalError` se algum caminho não está inteiro e local. */
export function assertBrutosLocal(what: string, paths: readonly string[], deps: BrutoLocalDeps = defaultBrutoLocalDeps(), opts: { settleMs?: number; readTimeoutMs?: number } = {}): BrutoLocalCheck {
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

/**
 * Leitor de um bruto, rodado num processo neto (`node -e SCRIPT caminho
 * trecho trechos piso minimo`): lê `trechos` blocos de `trecho` bytes em
 * posições iguais do início ao fim e cronometra só a leitura. Sai 0 ao ler,
 * 3 quando leu ao menos `minimo` bytes abaixo de `piso` bytes/s (`piso` 0 =
 * vazão não julgada), 2 no erro.
 */
export const BRUTO_READER_SCRIPT = [
  "const fs = require('node:fs');",
  "try {",
  "  const p = process.argv[1]; const chunk = Number(process.argv[2]); const chunks = Math.max(1, Number(process.argv[3]));",
  "  const minBps = Number(process.argv[4]); const minBytes = Number(process.argv[5]);",
  "  const fd = fs.openSync(p, 'r'); const size = fs.fstatSync(fd).size; const len = Math.min(chunk, size);",
  "  const buf = Buffer.alloc(Math.max(1, len)); const span = size - len; let read = 0;",
  "  const t0 = process.hrtime.bigint();",
  "  for (let i = 0; i < chunks; i++) {",
  "    const pos = chunks === 1 ? 0 : Math.floor((span * i) / (chunks - 1));",
  "    let off = 0;",
  "    while (off < len) { const n = fs.readSync(fd, buf, off, len - off, pos + off); if (n <= 0) break; off += n; }",
  "    read += off;",
  "    if (span === 0) break;",
  "  }",
  "  const secs = Number(process.hrtime.bigint() - t0) / 1e9;",
  "  fs.closeSync(fd);",
  "  process.exit(minBps > 0 && read >= minBytes && secs > 0 && read / secs < minBps ? 3 : 0);",
  "} catch { process.exit(2); }",
].join("\n");

/**
 * Coordenador da sonda, rodado num processo filho: lê os brutos UM POR VEZ,
 * cada um num neto (destacado e sem pipe, para o filho poder sair com o neto
 * ainda preso na leitura) com o próprio prazo, e imprime `{caminho:
 * "ok"|"devagar"|"timeout"|"erro"}`. Um por vez para a vazão medida de um
 * bruto não cair por disputa de disco com os outros. No prazo estourado,
 * manda kill para o neto sem esperar por ele (um processo preso numa leitura
 * do volume do Drive pode não morrer na hora) e segue para o próximo.
 */
const BRUTO_PROBE_COORDINATOR = [
  "const { spawn } = require('node:child_process');",
  "const paths = JSON.parse(process.env.DIARIA_BRUTO_PATHS);",
  "const reader = JSON.parse(process.env.DIARIA_BRUTO_READER);",
  "const timeoutMs = Number(process.env.DIARIA_BRUTO_TIMEOUT_MS);",
  "const args = JSON.parse(process.env.DIARIA_BRUTO_READER_ARGS);",
  "const out = {}; let i = 0;",
  "const finish = () => process.stdout.write(JSON.stringify(out), () => process.exit(0));",
  "const next = () => {",
  "  if (i >= paths.length) return finish();",
  "  const p = paths[i++]; let timer = null; let settled = false;",
  "  const k = spawn(process.execPath, [...reader, p, ...args], { detached: true, stdio: 'ignore', windowsHide: true });",
  "  k.unref();",
  "  const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); out[p] = v; if (v === 'timeout') { try { k.kill('SIGKILL'); } catch {} } next(); };",
  "  timer = setTimeout(() => done('timeout'), timeoutMs);",
  "  k.on('error', () => done('erro'));",
  "  k.on('exit', (code) => done(code === 0 ? 'ok' : code === 3 ? 'devagar' : 'erro'));",
  "};",
  "next();",
].join("\n");

/**
 * Leitura cronometrada de vários brutos: um processo filho lê um por vez, cada
 * um com prazo de `timeoutMs`, e devolve o resultado sem pendurar este
 * processo. `reader` são os argumentos do `node` do neto antes do caminho
 * (injetável: os testes simulam a leitura lenta). Falha da própria sonda (o
 * filho não sobe, saída ilegível) = null.
 */
export function timedReadBrutos(
  paths: readonly string[],
  timeoutMs: number,
  opts: {
    reader?: readonly string[];
    probeBytes?: number;
    probeChunks?: number;
    minBytesPerSec?: number;
    minRateBytes?: number;
    run?: typeof spawnSync;
  } = {},
): Map<string, TimedReadOutcome> | null {
  if (!paths.length) return new Map();
  const readerArgs = [
    opts.probeBytes ?? BRUTO_READ_PROBE_BYTES,
    opts.probeChunks ?? BRUTO_READ_PROBE_CHUNKS,
    opts.minBytesPerSec ?? BRUTO_READ_MIN_BYTES_PER_SEC,
    opts.minRateBytes ?? BRUTO_READ_MIN_RATE_BYTES,
  ].map(String);
  const r = (opts.run ?? spawnSync)(process.execPath, ["-e", BRUTO_PROBE_COORDINATOR], {
    encoding: "utf8",
    // Um prazo por bruto, mais a margem para o filho subir e imprimir; se nem ele responder, o kill vem do spawnSync.
    timeout: timeoutMs * paths.length + 10_000,
    killSignal: "SIGKILL",
    // Caminhos e leitor vão por variável de ambiente, nunca interpolados no código.
    env: {
      ...process.env,
      DIARIA_BRUTO_PATHS: JSON.stringify(paths),
      DIARIA_BRUTO_READER: JSON.stringify(opts.reader ?? ["-e", BRUTO_READER_SCRIPT]),
      DIARIA_BRUTO_TIMEOUT_MS: String(timeoutMs),
      DIARIA_BRUTO_READER_ARGS: JSON.stringify(readerArgs),
    },
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(r.stdout ?? ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const out = new Map<string, TimedReadOutcome>();
  for (const p of paths) {
    const v = (parsed as Record<string, unknown>)[p];
    if (v === "ok" || v === "devagar" || v === "timeout" || v === "erro") out.set(p, v);
  }
  return out;
}

export function defaultBrutoLocalDeps(): BrutoLocalDeps {
  return {
    size: (p) => statSync(p).size,
    sleep: sleepSync,
    windowsAttributes: (paths) => readWindowsAttributes(paths),
    timedRead: (paths, timeoutMs) => timedReadBrutos(paths, timeoutMs, { minBytesPerSec: minReadBytesPerSec() }),
    platform: process.platform,
  };
}
