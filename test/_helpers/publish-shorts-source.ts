/**
 * #14054: fonte de `scripts/publish-shorts.ts` para os guards estáticos.
 *
 * O código do publisher dos verticais saiu da entrada para um módulo por
 * destino em `scripts/publish-shorts/`. Os testes que leem o texto do
 * publisher (ligação de alarme, ordem de efeitos, ausência de caminho antigo)
 * leem esta concatenação: os módulos na ordem em que o código estava no
 * arquivo único, e a entrada por último (é onde fica o `if (isMainModule`).
 * Um módulo novo em `scripts/publish-shorts/` entra aqui sozinho; a ordem dos
 * conhecidos fica fixa.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DIR = join(ROOT, "scripts", "publish-shorts");

/** Ordem em que cada parte começava no arquivo único (antes do #14054). */
const ORDER = [
  "_shared",
  "plan",
  "instagram",
  "linkedin",
  "facebook",
  "instagram-confirm",
  "youtube",
  "run-checks",
  "buffer",
  "update-scheduled",
  "cli",
  "corte",
  "update-published",
  "run",
  "confirm",
];

/** Arquivos `.ts` de `scripts/publish-shorts/`, na ordem do arquivo antigo (desconhecidos no fim, por nome). */
export function publishShortsModuleFiles(): string[] {
  const names = readdirSync(DIR).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3));
  const rank = (n: string) => (ORDER.includes(n) ? ORDER.indexOf(n) : ORDER.length);
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((n) => join(DIR, `${n}.ts`));
}

/**
 * #14327: texto de UM módulo de `scripts/publish-shorts/` (sem `.ts`). Os guards
 * de ordem leem o módulo onde a fase mora, e não a concatenação: nela, a ordem
 * entre módulos é a deste arquivo, não a de execução.
 */
export function publishShortsModuleSource(name: string): string {
  return readFileSync(join(DIR, `${name}.ts`), "utf8");
}

/**
 * #14327: corpo de `mainUnlocked` (`run.ts`), que chama as fases da rodada em
 * ordem. Guard de ordem entre fases lê daqui: a chamada de cada fase, não o
 * texto dela (que mora no módulo da fase).
 */
export function publishShortsMainUnlockedSource(): string {
  const run = publishShortsModuleSource("run");
  const at = run.indexOf("async function mainUnlocked(): Promise<number>");
  if (at < 0) throw new Error("mainUnlocked não encontrado em scripts/publish-shorts/run.ts");
  return run.slice(at);
}

/** Texto de todo o publisher dos verticais: módulos de `scripts/publish-shorts/` + a entrada. */
export function publishShortsSource(): string {
  return [...publishShortsModuleFiles(), join(ROOT, "scripts", "publish-shorts.ts")]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}
