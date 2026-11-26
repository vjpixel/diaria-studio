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
 * O check importa cada dependência direta do `package.json` e separa dois
 * casos pelo `imported from` da mensagem do Node:
 *  - arquivo de DENTRO do `node_modules` importando outro arquivo que não
 *    existe: instalação pela metade (`broken`), que este check denuncia;
 *  - o próprio pacote sem entrada importável (só tipos, como `@types/node`):
 *    a importação parte do nosso probe, não de um pacote, e não é defeito.
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
}

export type ImportVerdict =
  | { kind: "ok"; pkg: string }
  | { kind: "broken"; pkg: string; brokenPackage: string; missing: string; importer: string }
  | { kind: "not-importable"; pkg: string; reason: string };

const ESM_NOT_FOUND = /Cannot find (?:module|package) '([^']+)' imported from (.+?)\s*$/m;
const CJS_NOT_FOUND = /Cannot find module '([^']+)'/;

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

/** Classifica o resultado do probe de um pacote. */
export function classifyImportProbe(probe: ImportProbe, nodeModulesDir: string): ImportVerdict {
  if (probe.ok) return { kind: "ok", pkg: probe.pkg };
  const message = probe.message ?? "";
  const reason = `${probe.code ?? "erro"}: ${message.split(/\r?\n/)[0]}`;

  if (probe.code === "ERR_MODULE_NOT_FOUND") {
    const m = ESM_NOT_FOUND.exec(message);
    if (m) {
      const missing = toPath(m[1]);
      const importer = toPath(m[2]);
      if (isInside(importer, nodeModulesDir)) {
        return {
          kind: "broken",
          pkg: probe.pkg,
          brokenPackage: packageNameFromPath(importer, nodeModulesDir) ?? probe.pkg,
          missing,
          importer,
        };
      }
    }
    return { kind: "not-importable", pkg: probe.pkg, reason };
  }

  if (probe.code === "MODULE_NOT_FOUND") {
    const importer = probe.requireStack?.[0];
    const m = CJS_NOT_FOUND.exec(message);
    if (importer && m && isInside(importer, nodeModulesDir)) {
      return {
        kind: "broken",
        pkg: probe.pkg,
        brokenPackage: packageNameFromPath(importer, nodeModulesDir) ?? probe.pkg,
        missing: m[1],
        importer,
      };
    }
    return { kind: "not-importable", pkg: probe.pkg, reason };
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
  const uniq = [...new Set(brokenPackages)].sort();
  const paths = uniq.map((p) => `node_modules/${p}`).join(" ");
  return `rm -rf ${paths} && npm install`;
}

export function formatIntegrityReport(verdicts: ImportVerdict[]): string {
  const broken = verdicts.filter((v): v is Extract<ImportVerdict, { kind: "broken" }> => v.kind === "broken");
  const lines: string[] = [];
  for (const v of verdicts) {
    if (v.kind === "ok") lines.push(`[ok]   ${v.pkg}`);
    else if (v.kind === "not-importable") lines.push(`[info] ${v.pkg}: sem entrada importável (${v.reason})`);
    else
      lines.push(
        `[FALHA] ${v.pkg}: ${v.brokenPackage} instalado pela metade — falta ${v.missing} (importado por ${v.importer})`,
      );
  }
  if (broken.length > 0) {
    lines.push("");
    lines.push("node_modules com arquivo faltando. Reparo (na raiz do checkout):");
    lines.push(`  ${repairCommand(broken.map((b) => b.brokenPackage))}`);
    lines.push("Ou reinstalar tudo com `npm ci` (apaga o node_modules antes; ver docs/setup.md).");
  } else {
    lines.push("");
    lines.push("node_modules íntegro para as dependências diretas.");
  }
  return lines.join("\n");
}
