/**
 * node-modules-integrity.ts (#14070) — miolo puro do
 * `scripts/check-node-modules-integrity.ts`.
 *
 * O defeito que motivou: no checkout do Neo o `npx knip` saía com
 * `ERR_MODULE_NOT_FOUND node_modules/formatly/lib/types.js`. A causa foi do
 * ambiente, não do lockfile: em 08/11/2026 11:32 BRT todos os 9 arquivos de 0
 * byte do `node_modules` principal sumiram de uma vez (o `types.js` do
 * formatly é um deles; um clone novo tem os 9). O `npm install` seguinte não
 * repôs nada, porque o npm confia no `node_modules/.package-lock.json` e não
 * confere arquivo por arquivo de um pacote já instalado.
 *
 * O check importa cada dependência direta do `package.json` (um processo filho
 * por pacote) e conta como instalação pela metade (`broken`):
 *  - arquivo de DENTRO do `node_modules` importando outro que não existe;
 *  - o arquivo de entrada que o pacote DECLARA (`main` não vazio ou `exports`)
 *    faltando no disco;
 *  - binário nativo que não carrega (`ERR_DLOPEN_FAILED`, ou o erro próprio do
 *    sharp quando o `.node` da plataforma some).
 * Pacote que não declara entrada (só tipos, como `@types/node`, com `main: ""`)
 * sai como `not-importable` e não reprova. Import que derruba o processo filho
 * sem devolver resultado sai como `crashed`, com o nome do pacote.
 */
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** O que o probe filho devolve por pacote. */
export interface ImportProbe {
  pkg: string;
  ok: boolean;
  code?: string;
  message?: string;
  /** `requireStack` do erro CJS (`MODULE_NOT_FOUND`), quando houver. */
  requireStack?: string[];
  /** O `package.json` do pacote declara entrada JS (`main` não vazio ou `exports`). */
  declaresEntry?: boolean;
  /** O processo filho saiu sem devolver resultado (crash ou `process.exit` no import). */
  crashed?: { status: number | null; signal: string | null; stderr: string };
}

export type ImportVerdict =
  | { kind: "ok"; pkg: string }
  | { kind: "broken"; pkg: string; brokenPackages: string[]; missing: string; importer: string }
  | { kind: "crashed"; pkg: string; reason: string }
  | { kind: "not-importable"; pkg: string; reason: string };

const ESM_NOT_FOUND = /Cannot find (?:module|package) '([^']+)' imported from (.+?)\s*$/m;
const CJS_NOT_FOUND = /Cannot find module '([^']+)'/;
const SHARP_RUNTIME = /Could not load the "sharp" module using the (\S+) runtime/;
const NATIVE_PATH = /([A-Za-z]:\\[^\r\n]*?\.node|\/[^\s\r\n]*?\.node)\b/;

function toPath(p: string): string {
  return p.startsWith("file://") ? fileURLToPath(p) : p;
}

/** `true` se `p` é um caminho dentro de `nodeModulesDir`. */
function isInside(p: string, nodeModulesDir: string): boolean {
  if (!isAbsolute(p)) return false;
  const rel = relative(nodeModulesDir, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Nome do pacote dono de um caminho dentro do `node_modules` (escopado ou não,
 * e o mais interno quando há `node_modules` aninhado). `null` fora dele.
 */
export function packageNameFromPath(p: string, nodeModulesDir: string): string | null {
  if (!isInside(p, nodeModulesDir)) return null;
  const parts = relative(nodeModulesDir, p).split(/[\\/]+/);
  const last = parts.lastIndexOf("node_modules");
  const rest = last >= 0 ? parts.slice(last + 1) : parts;
  if (rest.length === 0) return null;
  if (rest[0].startsWith("@")) return rest.length >= 2 ? `${rest[0]}/${rest[1]}` : null;
  return rest[0];
}

/** `true` se `p` é a própria pasta de um pacote (não um arquivo dentro dela). */
function isPackageRoot(p: string, nodeModulesDir: string): boolean {
  const name = packageNameFromPath(p, nodeModulesDir);
  if (!name) return false;
  const rel = relative(nodeModulesDir, p).split(/[\\/]+/);
  const last = rel.lastIndexOf("node_modules");
  const rest = last >= 0 ? rel.slice(last + 1) : rel;
  return rest.length === name.split("/").length;
}

/** O `package.json` declara entrada JS: `main` string não vazia, ou `exports`. */
export function manifestDeclaresEntry(manifest: { main?: unknown; exports?: unknown } | null): boolean {
  if (!manifest) return false;
  if (typeof manifest.main === "string" && manifest.main.trim() !== "") return true;
  return manifest.exports !== undefined && manifest.exports !== null;
}

function firstLine(s: string): string {
  return s.split(/\r?\n/)[0];
}

/** Classifica o resultado do probe de um pacote. */
export function classifyImportProbe(probe: ImportProbe, nodeModulesDir: string): ImportVerdict {
  if (probe.ok) return { kind: "ok", pkg: probe.pkg };
  if (probe.crashed) {
    const { status, signal, stderr } = probe.crashed;
    const tail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
    return {
      kind: "crashed",
      pkg: probe.pkg,
      reason: `o import encerrou o processo (status ${status ?? "-"}, sinal ${signal ?? "-"})${tail ? `: ${tail}` : ""}`,
    };
  }
  const message = probe.message ?? "";
  const reason = `${probe.code ?? "erro"}: ${firstLine(message)}`;
  const ownerOf = (p: string) => packageNameFromPath(p, nodeModulesDir) ?? probe.pkg;

  if (probe.code === "ERR_MODULE_NOT_FOUND") {
    const m = ESM_NOT_FOUND.exec(message);
    if (m) {
      const missing = toPath(m[1]);
      const importer = toPath(m[2]);
      // Arquivo de um pacote importando outro que sumiu (o caso do formatly).
      if (isInside(importer, nodeModulesDir)) {
        return { kind: "broken", pkg: probe.pkg, brokenPackages: [ownerOf(importer)], missing, importer };
      }
      // Entrada declarada (`main`/`exports`) faltando. Sem entrada declarada o
      // Node cai no `index.js` implícito ou na própria pasta: pacote só de tipos.
      if (probe.declaresEntry && isInside(missing, nodeModulesDir) && !isPackageRoot(missing, nodeModulesDir)) {
        return { kind: "broken", pkg: probe.pkg, brokenPackages: [ownerOf(missing)], missing, importer };
      }
    }
    return { kind: "not-importable", pkg: probe.pkg, reason };
  }

  if (probe.code === "MODULE_NOT_FOUND") {
    const importer = probe.requireStack?.[0];
    const m = CJS_NOT_FOUND.exec(message);
    if (importer && m && isInside(importer, nodeModulesDir)) {
      return { kind: "broken", pkg: probe.pkg, brokenPackages: [ownerOf(importer)], missing: m[1], importer };
    }
    return { kind: "not-importable", pkg: probe.pkg, reason };
  }

  // Binário nativo. O sharp embrulha o erro do dlopen numa mensagem própria
  // (sem `code`); o `.node` mora no pacote da plataforma (`@img/sharp-<os>-<cpu>`),
  // que também precisa ser reinstalado.
  const sharp = SHARP_RUNTIME.exec(message);
  if (probe.code === "ERR_DLOPEN_FAILED" || sharp || /ERR_DLOPEN_FAILED/.test(message)) {
    const native = NATIVE_PATH.exec(message)?.[1]?.replace(/^\\\\\?\\/, "");
    const owners = new Set<string>([probe.pkg]);
    if (native && isInside(native, nodeModulesDir)) owners.add(ownerOf(native));
    if (sharp) owners.add(`@img/sharp-${sharp[1]}`);
    return {
      kind: "broken",
      pkg: probe.pkg,
      brokenPackages: [...owners],
      missing: native ?? `binário nativo (${firstLine(message)})`,
      importer: probe.pkg,
    };
  }

  // Qualquer outro erro (ex.: ERR_PACKAGE_PATH_NOT_EXPORTED, pacote só de CLI)
  // não é sinal de instalação pela metade.
  return { kind: "not-importable", pkg: probe.pkg, reason };
}

/**
 * Reparo dirigido: apagar só os pacotes quebrados e rodar `npm install`. O
 * `npm install` sozinho não basta (o npm confia no `.package-lock.json` oculto
 * e não repõe arquivo que sumiu de pacote já instalado); sem a pasta do
 * pacote, ele reinstala aquele pacote e deixa o resto como está.
 */
export function repairCommand(brokenPackages: string[]): string {
  const paths = uniqueSorted(brokenPackages).map((p) => `node_modules/${p}`).join(" ");
  return `rm -rf ${paths} && npm install`;
}

/**
 * Mesmo reparo na sintaxe do PowerShell, o shell padrão do Neo: lá `rm -rf`
 * não é aceito e `&&` depende da versão. `Remove-Item` recebe a lista
 * separada por vírgula; `;` encadeia em qualquer versão.
 */
export function repairCommandPowerShell(brokenPackages: string[]): string {
  const paths = uniqueSorted(brokenPackages)
    .map((p) => `node_modules\\${p.replace("/", "\\")}`)
    .join(", ");
  return `Remove-Item -Recurse -Force ${paths}; npm install`;
}

function uniqueSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

/** `true` se algum veredito reprova o check (exit 1). */
export function hasFailure(verdicts: ImportVerdict[]): boolean {
  return verdicts.some((v) => v.kind === "broken" || v.kind === "crashed");
}

export function formatIntegrityReport(verdicts: ImportVerdict[]): string {
  const broken = verdicts.filter((v): v is Extract<ImportVerdict, { kind: "broken" }> => v.kind === "broken");
  const lines: string[] = [];
  for (const v of verdicts) {
    if (v.kind === "ok") lines.push(`[ok]   ${v.pkg}`);
    else if (v.kind === "not-importable") lines.push(`[info] ${v.pkg}: sem entrada importável (${v.reason})`);
    else if (v.kind === "crashed") lines.push(`[FALHA] ${v.pkg}: ${v.reason}`);
    else
      lines.push(
        `[FALHA] ${v.pkg}: ${v.brokenPackages.join(", ")} instalado pela metade — falta ${v.missing} (importado por ${v.importer})`,
      );
  }
  lines.push("");
  if (broken.length > 0) {
    lines.push("node_modules com arquivo faltando. Reparo (na raiz do checkout):");
    const pkgs = broken.flatMap((b) => b.brokenPackages);
    lines.push(`  bash/Git Bash: ${repairCommand(pkgs)}`);
    lines.push(`  PowerShell:    ${repairCommandPowerShell(pkgs)}`);
    lines.push("Ou reinstalar tudo com `npm ci` (apaga o node_modules antes; ver docs/setup.md).");
  }
  if (verdicts.some((v) => v.kind === "crashed")) {
    lines.push("Import que derrubou o processo: reinstalar o pacote nomeado acima ou rodar `npm ci`.");
  }
  if (!hasFailure(verdicts)) lines.push("node_modules íntegro para as dependências diretas.");
  return lines.join("\n");
}
