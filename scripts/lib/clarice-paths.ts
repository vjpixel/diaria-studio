/**
 * clarice-paths.ts (#1961)
 *
 * Resolução de caminhos do programa Clarice/Brevo, namespaceada por **ciclo de
 * envio** no formato `{conteúdo}-{envio}` (ex: `2604-05` = digest de abril
 * enviado em maio; `2605-06` = maio enviado em junho).
 *
 * Por que `{conteúdo}-{envio}` e não só o mês: o nome da campanha na Brevo usa o
 * mês do **conteúdo** (digest de abril → "Diar.ia Mensal 2604"), mas o envio
 * acontece no mês **seguinte**. Carregar os dois no nome da pasta elimina a
 * ambiguidade ("2604 ou 2605?") que confundia na virada do mês. (#1961)
 *
 * Estrutura:
 *
 *   data/clarice-subscribers/
 *     stripe-customers-*.csv            ← inputs-base (root, não por-ciclo)
 *     brevo-import-excluded.csv         ← idem
 *     brevo-import-t01.csv … t10.csv    ← base segmentada (output da merge, root)
 *     {conteúdo}-{envio}/               ← artefatos POR-CICLO (ex: 2605-06/)
 *       brevo-import-t02-verified.csv / -rejected.csv / -unknown.csv
 *       .mv-cache-*.json
 *       waves/
 *         t1-openers.csv · t1-non-openers.csv · t2-w3.csv · t2-w4.csv
 *         waves-summary.json
 *
 * O `--cycle {conteúdo}-{envio}` é OBRIGATÓRIO nos scripts por-ciclo (como
 * "data da edição é sempre explícita") — sem default, pra não rotular/ler o
 * ciclo errado perto da virada do mês.
 */
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Raiz da base Clarice (junction → OneDrive). Inputs-base + tiers moram aqui. */
export const CLARICE_BASE = resolve(REPO_ROOT, "data/clarice-subscribers");

/** Pure: valida o rótulo de ciclo `{conteúdo}-{envio}` = `YYMM-MM` (ex: 2605-06). */
export function isValidCycle(c: string | undefined | null): c is string {
  return !!c && /^\d{4}-\d{2}$/.test(c);
}

/** Diretório do ciclo (`…/clarice-subscribers/{conteúdo}-{envio}`). Pure (path join). */
export function clariceCycleDir(cycle: string): string {
  if (!isValidCycle(cycle)) {
    throw new Error(`ciclo inválido: ${cycle} (esperado {conteúdo}-{envio}, ex: 2605-06)`);
  }
  return resolve(CLARICE_BASE, cycle);
}

/** Diretório de waves do ciclo (`…/{conteúdo}-{envio}/waves`). */
export function clariceWavesDir(cycle: string): string {
  return resolve(clariceCycleDir(cycle), "waves");
}

/** Caminho de um arquivo de input-base (root, não por-ciclo): stripe, excluded, tiers. */
export function clariceBaseFile(name: string): string {
  return resolve(CLARICE_BASE, name);
}

/** Cria o diretório (recursivo) se faltar e devolve o próprio path. */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Extrai `--cycle {conteúdo}-{envio}` do argv. OBRIGATÓRIO: aborta o processo
 * (exit 1) com mensagem clara se ausente/inválido. Use no `main()` dos scripts.
 */
export function requireCycleArg(argv: string[]): string {
  const i = argv.indexOf("--cycle");
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (!isValidCycle(v)) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2605-06).");
    process.exit(1);
  }
  return v;
}

/** Pure (testável): parseia `--cycle`; "" quando ausente/inválido (caller valida). */
export function parseCycleArg(argv: string[]): string {
  const i = argv.indexOf("--cycle");
  const v = i >= 0 ? argv[i + 1] : undefined;
  return isValidCycle(v) ? v : "";
}
