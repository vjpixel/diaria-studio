/**
 * monthly-paths.ts (#1962)
 *
 * Resolução de caminhos do digest mensal, namespaceada por **ciclo**
 * no formato `{conteúdo}-{envio}` (ex: `2605-06` = digest de maio
 * enviado em junho). Análogo ao `clarice-paths.ts` do #1961 para o
 * lado de contatos.
 *
 * Por que `{conteúdo}-{envio}`: o digest mensal é batizado pelo mês
 * do CONTEÚDO ("Diar.ia Mensal 2605"), mas o envio ocorre no mês
 * SEGUINTE. Carregar os dois no nome da pasta elimina a ambiguidade
 * que antes confundia na virada do mês ("esse 2605/ é de maio ou junho?").
 *
 * Estrutura nova:
 *   data/monthly/
 *     {conteúdo}-{envio}/   (ex: 2605-06/)
 *       raw-posts/
 *       prioritized.md
 *       draft.md
 *       _internal/
 *       ...
 *
 * Compat: se a pasta nova `{conteúdo}-{envio}/` não existe mas a pasta
 * legada `{YYMM}/` existe, `monthlyDir()` usa a legada com um `console.warn`
 * (transição suave; escrita sempre usa o formato novo).
 *
 * Worker KV key: `m{YYMM}-{MM}` (ex: `m2605-06`). Retrocompat de leitura:
 * tentar key nova, fallback `m{YYMM}` — lógica implementada **no Worker** (#2046,
 * `workers/draft/src/index.ts` `legacyKeyFromNew`). Callers NÃO precisam fazer
 * fallback — o Worker KV aceita qualquer string ≤512 bytes, hífens são válidos.
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, parseArgs } from "../cli-args.ts";
import { isValidCycle } from "../clarice-paths.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Raiz dos digests mensais (`data/monthly/`). */
export const MONTHLY_BASE = resolve(REPO_ROOT, "data/monthly");

// ── Validação do ciclo ─────────────────────────────────────────────────────

/**
 * Pure: valida o rótulo de ciclo `{conteúdo}-{envio}` = `YYMM-MM`
 * (ex: `2605-06`).
 *
 * #2048 item 8: alias direto de `isValidCycle` de `clarice-paths.ts` (#1961) —
 * as duas funções tinham implementação idêntica. Ao importar do mesmo helper,
 * a semântica é garantidamente consistente se a regra do ciclo mudar.
 */
export const isValidMonthlyCycle = isValidCycle;

/**
 * Pure: valida o formato legado `YYMM` (ex: `2605`).
 * Útil para a compat path e para scripts que ainda recebem o argumento
 * posicional antigo.
 */
export function isValidYymm(s: string | undefined | null): s is string {
  if (!s || !/^\d{4}$/.test(s)) return false;
  const month = Number(s.slice(2, 4));
  return month >= 1 && month <= 12;
}

/**
 * Deriva o ciclo `{YYMM}-{MM+1}` a partir do formato legado `YYMM`.
 * Ex: `"2605"` → `"2605-06"`, `"2612"` → `"2612-01"`.
 *
 * Nome correto: `yymmToCycle` (dois y). O nome antigo `yyymmToCycle` (três y, typo)
 * foi removido em #2048 item 1 — todos os callers e testes foram atualizados.
 */
export function yymmToCycle(yymm: string): string {
  const contentMonth = Number(yymm.slice(2, 4));
  const sendMonth = (contentMonth % 12) + 1;
  return `${yymm}-${String(sendMonth).padStart(2, "0")}`;
}


/**
 * Extrai o `YYMM` (mês do conteúdo) a partir do rótulo de ciclo.
 * Ex: `"2605-06"` → `"2605"`.
 */
export function cycleToYymm(cycle: string): string {
  return cycle.slice(0, 4);
}

// ── Resolução de diretório ─────────────────────────────────────────────────

/**
 * Retorna o path do diretório do digest mensalpara um dado identificador.
 *
 * Aceita:
 *   - ciclo `{conteúdo}-{envio}` (ex: `2605-06`) — formato NOVO (preferido)
 *   - legado `YYMM` (ex: `2605`) — deriva o ciclo `{YYMM}-{MM+1}` com warning
 *
 * **Fallback de leitura:** se o diretório no formato novo não existe mas o
 * legado `{YYMM}` existe, usa o legado com `console.warn` (transição suave).
 * Escrita sempre usa o formato novo — callers que criam o diretório devem
 * chamar `ensureMonthlyDir` que já escreve no novo formato.
 *
 * @param identifier ciclo `2605-06` ou legado `2605`
 * @param opts.allowLegacyFallback default true — usa pasta legada se nova ausente
 */
export function monthlyDir(
  identifier: string,
  opts: { allowLegacyFallback?: boolean } = {},
): string {
  const allowFallback = opts.allowLegacyFallback !== false;

  // Normaliza para ciclo
  let cycle: string;
  if (isValidMonthlyCycle(identifier)) {
    cycle = identifier;
  } else if (isValidYymm(identifier)) {
    cycle = yymmToCycle(identifier);
    console.warn(
      `[monthly-paths] warn: "${identifier}" é formato legado YYMM — ` +
      `derive automaticamente como ciclo "${cycle}". ` +
      `Use --cycle ${cycle} para suprimir este aviso.`,
    );
  } else {
    throw new Error(
      `identificador de ciclo mensal inválido: "${identifier}" ` +
      `(esperado {conteúdo}-{envio} ex: 2605-06, ou legado YYMM ex: 2605)`,
    );
  }

  const newDir = resolve(MONTHLY_BASE, cycle);

  // Fallback de leitura para pasta legada
  if (allowFallback && !existsSync(newDir)) {
    const yymm = cycleToYymm(cycle);
    const legacyDir = resolve(MONTHLY_BASE, yymm);
    if (existsSync(legacyDir)) {
      console.warn(
        `[monthly-paths] warn: pasta "${cycle}" ausente, usando legada "${yymm}". ` +
        `Rode scripts/migrate-monthly-cycle-dirs.ts para migrar.`,
      );
      return legacyDir;
    }
  }

  return newDir;
}

/**
 * Cria o diretório do ciclo (formato novo, recursivo) e devolve o path.
 * Sempre escreve no formato novo — sem fallback legado.
 */
export function ensureMonthlyDir(cycle: string): string {
  if (!isValidMonthlyCycle(cycle)) {
    throw new Error(
      `ciclo inválido: "${cycle}" (esperado {conteúdo}-{envio} ex: 2605-06)`,
    );
  }
  const dir = resolve(MONTHLY_BASE, cycle);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Key do Worker KV ───────────────────────────────────────────────────────

/**
 * Key do Worker KV para o preview/draft mensal no formato NOVO.
 * Ex: `"2605-06"` → `"m2605-06"`.
 *
 * Hífens são válidos em keys KV do Cloudflare (qualquer string ≤512 bytes).
 * Não colide com diárias (AAMMDD, sem prefixo m) nem com o formato legado
 * `m{YYMM}` (4 dígitos após o m vs `{YYMM}-{MM}` com hífen).
 */
export function monthlyWorkerKey(cycle: string): string {
  if (!isValidMonthlyCycle(cycle)) {
    throw new Error(`ciclo inválido para workerKey: "${cycle}"`);
  }
  return `m${cycle}`;
}

/**
 * Key legada do Worker KV (`m{YYMM}`). Usado para retrocompat de leitura:
 * o caller tenta a key nova primeiro, depois esta como fallback.
 */
export function monthlyWorkerKeyLegacy(yymm: string): string {
  return `m${yymm}`;
}

// ── Parsing de argumentos CLI ──────────────────────────────────────────────

/**
 * Pure (testável): parseia `--cycle {ciclo}` do argv.
 *
 * Aceita o ciclo no formato novo `{YYMM}-{MM}` (ex: `2605-06`) OU o formato
 * legado `YYMM` (ex: `2605`), derivando o ciclo com warning.
 *
 * Retorna `""` se ausente/inválido (caller valida e pode abortar).
 */
export function parseMonthlyCycleArg(argv: string[]): string {
  // Tentar --cycle primeiro (novo)
  const cycleVal = getArg(argv, "cycle");
  if (isValidMonthlyCycle(cycleVal)) return cycleVal;

  // Compat: --cycle com YYMM legado (ex: --cycle 2605 → 2605-06 + warn)
  if (isValidYymm(cycleVal)) {
    const derived = yymmToCycle(cycleVal);
    console.warn(
      `[monthly-paths] warn: --cycle "${cycleVal}" é YYMM legado — ` +
      `derivando ciclo "${derived}". Use --cycle ${derived} para suprimir.`,
    );
    return derived;
  }

  // Compat: argumento posicional YYMM (ex: collect-monthly.ts 2605)
  // Detectado por: nenhum --cycle, mas tem positional[0] com formato YYMM
  // Usa parseArgs para não capturar valores de outras flags (ex: --list-id 2605).
  const pos = parseArgs(argv).positional.find((a) => isValidYymm(a));
  if (pos) {
    const derived = yymmToCycle(pos);
    console.warn(
      `[monthly-paths] warn: argumento posicional "${pos}" é YYMM legado — ` +
      `derivando ciclo "${derived}". Use --cycle ${derived} para suprimir.`,
    );
    return derived;
  }

  return "";
}

/**
 * Extrai `--cycle {ciclo}` do argv. OBRIGATÓRIO: aborta (exit 1) se
 * ausente/inválido. Use no `main()` dos scripts mensais.
 */
export function requireMonthlyCycleArg(argv: string[]): string {
  const v = parseMonthlyCycleArg(argv);
  if (!v) {
    console.error(
      "--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2605-06).\n" +
      "Compat: --cycle 2605 (YYMM legado) deriva automaticamente como 2605-06.",
    );
    process.exit(1);
  }
  return v;
}
