/**
 * test/lib-boundary.test.ts (#2747)
 *
 * Fronteira lint-enforced entre código genérico/diária/mensal DENTRO do
 * monorepo (sem separar repo). Regras (as 3 direções proibidas):
 *
 *   1. `scripts/lib/shared/**` NÃO importa de `scripts/lib/diaria/**` nem de
 *      `scripts/lib/mensal/**` — shared é a base; dependência invertida
 *      significa que o módulo não é genérico de verdade.
 *   2. `scripts/lib/diaria/**` NÃO importa de `scripts/lib/mensal/**`.
 *   3. `scripts/lib/mensal/**` NÃO importa de `scripts/lib/diaria/**`.
 *      (2/3: fluxo cruzado só passando por shared/ — o forcing function que
 *      motivaria um repo separado, mas o erro custa `git mv`, não pacote.)
 *
 * Arquivos na RAIZ de `scripts/lib/` estão fora das regras: são o legado
 * não-classificado (implicitamente diária ou genérico-ainda-não-movido) e
 * migram sob demanda — quando um deles for importado por shared/, é sinal de
 * que deve ser movido pra shared/ (a falha da regra 1 força essa decisão).
 *
 * Scan estático de specifiers de import — sem executar os módulos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "scripts", "lib");

const DOMAINS = ["shared", "diaria", "mensal"] as const;
type Domain = (typeof DOMAINS)[number];

/** Lista .ts recursivamente sob um diretório (retorna [] se não existe). */
function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

/** Extrai specifiers de import estático, re-export e import() dinâmico. */
function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /(?:from|import\s*\()\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1]);
  return out;
}

/** Domínio (shared/diaria/mensal) de um path absoluto sob scripts/lib, ou null. */
function domainOf(absPath: string): Domain | null {
  for (const d of DOMAINS) {
    if (absPath.startsWith(join(LIB, d) + sep)) return d;
  }
  return null;
}

/** Violações de fronteira de um domínio: imports relativos que caem em domínio proibido. */
function violations(fromDomain: Domain, forbidden: Domain[]): string[] {
  const found: string[] = [];
  for (const file of tsFilesUnder(join(LIB, fromDomain))) {
    for (const spec of importSpecifiers(file)) {
      if (!spec.startsWith(".")) continue; // node:/npm — fora da regra
      const target = resolve(dirname(file), spec);
      const d = domainOf(target);
      if (d && forbidden.includes(d)) {
        found.push(`${file.slice(ROOT.length + 1)} -> ${spec} (${fromDomain} não pode importar de ${d}/)`);
      }
    }
  }
  return found;
}

describe("fronteira scripts/lib shared/diaria/mensal (#2747)", () => {
  it("shared/ não importa de diaria/ nem mensal/", () => {
    const v = violations("shared", ["diaria", "mensal"]);
    assert.deepEqual(v, [], `shared/ importando domínio específico:\n  ${v.join("\n  ")}`);
  });

  it("diaria/ não importa de mensal/", () => {
    const v = violations("diaria", ["mensal"]);
    assert.deepEqual(v, [], `cruzamento diaria->mensal (passe por shared/):\n  ${v.join("\n  ")}`);
  });

  it("mensal/ não importa de diaria/", () => {
    const v = violations("mensal", ["diaria"]);
    assert.deepEqual(v, [], `cruzamento mensal->diaria (passe por shared/):\n  ${v.join("\n  ")}`);
  });

  it("sanity: a estrutura existe e o scan enxerga os módulos movidos", () => {
    // Se alguém achatar a estrutura de volta, este teste deixa de proteger —
    // falhar aqui avisa que o scan ficou vazio (silêncio ≠ fronteira ok).
    assert.ok(tsFilesUnder(join(LIB, "shared")).length >= 2, "shared/ tem os módulos base");
    assert.ok(tsFilesUnder(join(LIB, "mensal")).length >= 3, "mensal/ tem os monthly-*");
  });
});
