/**
 * scripts/lib/systemd-node-binary.ts (#13136)
 *
 * Qual binário `node` vai no `ExecStart=` das units geradas por
 * `scripts/setup-systemd-timers.ts`.
 *
 * Antes do #13136 o gerador assava `process.execPath`: o node do shell que o
 * rodou. Por `ssh` não-interativo o nvm não carrega e o shell acha
 * `/usr/bin/node`, enquanto as units armadas no `300` usam
 * `~/.nvm/versions/node/v24.19.0/bin/node`. Comparar o gerado com o instalado
 * mostrava ~130 units "diferentes" só por isso, e rearmar a partir desse
 * gerado trocaria o node de todas em silêncio (#7842 é a mesma família).
 *
 * Ordem de resolução, a primeira que responder vence:
 *   1. override explícito (`--node-bin` ou `DIARIA_SYSTEMD_NODE_BIN`), só path
 *      absoluto;
 *   2. instalação do nvm (`$NVM_DIR` ou `~/.nvm`) que casa com o `.nvmrc` do
 *      repo, a de versão mais alta;
 *   3. `process.execPath`, só se a versão do processo casa com o `.nvmrc`.
 * Nenhuma das três → erro. Nunca cai em silêncio num node fora do `.nvmrc`.
 * Sem `.nvmrc` legível, o passo 2 não tem critério e o passo 3 aceita o
 * `process.execPath` como antes (comportamento legado, com `source` dizendo).
 *
 * Pura com I/O injetado (`deps`), para testar sem nvm real nem filesystem.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, posix } from "node:path";
// O caminho vai pro `ExecStart=` de uma unit systemd (Linux): sempre POSIX,
// mesmo quando o gerador roda no Windows (#13738 — no Neo o `join` nativo
// montava `\home\u\.nvm\...` e o nvm do `.nvmrc` nunca era achado).
const { join } = posix;

export type SystemdNodeBinarySource = "override" | "nvm" | "process-execpath" | "process-execpath-sem-nvmrc";

export interface SystemdNodeBinary {
  path: string;
  source: SystemdNodeBinarySource;
  /** Conteúdo do `.nvmrc` usado como critério (`null` quando ausente). */
  nvmrc: string | null;
}

export interface ResolveSystemdNodeBinaryDeps {
  /** Override do `--node-bin`. */
  override?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  execPath?: string;
  processVersion?: string;
  /** Conteúdo cru do `.nvmrc` (ou `null` se ausente). */
  readNvmrc?: () => string | null;
  /** Lista os nomes em `<nvmDir>/versions/node/` (vazio se ausente). */
  listNvmVersions?: (dir: string) => string[];
  fileExists?: (path: string) => boolean;
}

export const NODE_BIN_ENV = "DIARIA_SYSTEMD_NODE_BIN";

const DEFAULT_NVMRC_PATH = new URL("../../.nvmrc", import.meta.url);

function defaultReadNvmrc(): string | null {
  try {
    return readFileSync(DEFAULT_NVMRC_PATH, "utf8");
  } catch {
    return null;
  }
}

function defaultListNvmVersions(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Componentes numéricos de `v24.19.0` / `24` / `24.19` — `null` se não for versão. */
export function parseVersionComponents(raw: string): number[] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) return null;
  return [m[1], m[2], m[3]].filter((x): x is string => x !== undefined).map(Number);
}

/**
 * `true` quando `version` casa com a especificação do `.nvmrc` por prefixo de
 * componentes (`24` casa `v24.19.0`; `24.19` casa `v24.19.3`; `v24.19.0` só
 * casa ela mesma). Especificação não numérica (`lts/*`, `node`) não casa nada
 * — o chamador trata como erro, não adivinha.
 */
export function versionMatchesNvmrc(version: string, nvmrc: string): boolean {
  const spec = parseVersionComponents(nvmrc);
  const v = parseVersionComponents(version);
  if (!spec || !v || v.length < spec.length) return false;
  return spec.every((n, i) => v[i] === n);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function resolveSystemdNodeBinary(deps: ResolveSystemdNodeBinaryDeps = {}): SystemdNodeBinary {
  const env = deps.env ?? process.env;
  const fileExists = deps.fileExists ?? existsSync;
  const nvmrcRaw = (deps.readNvmrc ?? defaultReadNvmrc)();
  const nvmrc = nvmrcRaw?.trim() ? nvmrcRaw.trim() : null;

  const override = deps.override ?? (env[NODE_BIN_ENV]?.trim() || undefined);
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new Error(`node do ExecStart precisa ser path absoluto (recebido "${override}") (#13136)`);
    }
    if (!fileExists(override)) {
      throw new Error(`node do ExecStart não existe: "${override}" (#13136)`);
    }
    return { path: override, source: "override", nvmrc };
  }

  const execPath = deps.execPath ?? process.execPath;
  const processVersion = deps.processVersion ?? process.version;

  if (nvmrc === null) {
    return { path: execPath, source: "process-execpath-sem-nvmrc", nvmrc };
  }
  if (!parseVersionComponents(nvmrc)) {
    throw new Error(
      `.nvmrc "${nvmrc}" não é uma versão numérica; passe --node-bin <path absoluto> (#13136)`,
    );
  }

  const nvmDir = env.NVM_DIR?.trim() || join(deps.homeDir ?? homedir(), ".nvm");
  const versionsDir = join(nvmDir, "versions", "node");
  const candidates = (deps.listNvmVersions ?? defaultListNvmVersions)(versionsDir)
    .filter((name) => versionMatchesNvmrc(name, nvmrc))
    .map((name) => ({ name, parts: parseVersionComponents(name)! }))
    .sort((a, b) => compareVersions(b.parts, a.parts));
  for (const c of candidates) {
    const bin = join(versionsDir, c.name, "bin", "node");
    if (fileExists(bin)) return { path: bin, source: "nvm", nvmrc };
  }

  if (versionMatchesNvmrc(processVersion, nvmrc)) {
    return { path: execPath, source: "process-execpath", nvmrc };
  }

  throw new Error(
    `Nenhum node que case com o .nvmrc ("${nvmrc}"): nvm sem a versão em ${versionsDir} e o node ` +
      `deste processo é ${processVersion} (${execPath}). Carregue o nvm (ex: ssh sem shell ` +
      `interativo não carrega) ou passe --node-bin <path absoluto> (#13136).`,
  );
}

// ---------------------------------------------------------------------------
// Check de unit instalada divergente do gerado (#13136 item 2)
// ---------------------------------------------------------------------------

export type InstalledUnitStatus = "same" | "differs" | "not-installed";

export interface InstalledUnitDiff {
  fileName: string;
  status: InstalledUnitStatus;
  /** Linhas que só existem no gerado (status `differs`). */
  onlyGenerated: string[];
  /** Linhas que só existem na instalada (status `differs`). */
  onlyInstalled: string[];
}

function normalizedLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l !== "");
}

/**
 * Compara cada unit gerada com a instalada de mesmo nome. Pura: `readInstalled`
 * devolve o conteúdo ou `null` (não instalada). Igualdade ignora espaço no fim
 * de linha e linhas vazias; a diferença sai como multiconjunto de linhas, que
 * basta para mostrar `ExecStart=`/`Description=` divergentes sem um diff
 * completo.
 */
export function diffInstalledUnits(
  generated: { fileName: string; content: string }[],
  readInstalled: (fileName: string) => string | null,
): InstalledUnitDiff[] {
  return generated.map(({ fileName, content }) => {
    const installed = readInstalled(fileName);
    if (installed === null) return { fileName, status: "not-installed", onlyGenerated: [], onlyInstalled: [] };
    const gen = normalizedLines(content);
    const inst = normalizedLines(installed);
    const remaining = new Map<string, number>();
    for (const l of inst) remaining.set(l, (remaining.get(l) ?? 0) + 1);
    const onlyGenerated: string[] = [];
    for (const l of gen) {
      const n = remaining.get(l) ?? 0;
      if (n > 0) remaining.set(l, n - 1);
      else onlyGenerated.push(l);
    }
    const genCount = new Map<string, number>();
    for (const l of gen) genCount.set(l, (genCount.get(l) ?? 0) + 1);
    const onlyInstalled: string[] = [];
    for (const l of inst) {
      const n = genCount.get(l) ?? 0;
      if (n > 0) genCount.set(l, n - 1);
      else onlyInstalled.push(l);
    }
    const same = onlyGenerated.length === 0 && onlyInstalled.length === 0 && gen.join("\n") === inst.join("\n");
    return { fileName, status: same ? "same" : "differs", onlyGenerated, onlyInstalled };
  });
}
