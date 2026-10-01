/**
 * clarice-ab-test.ts (#9308) — teste A/B de CONTEÚDO (ex: caixa de
 * divulgação) no envio Clarice mensal.
 *
 * Config declarativa por ciclo, opcional:
 *
 *   data/monthly/{ciclo}/_internal/ab-test.json
 *   { "label": "caixa",
 *     "arms": { "a": "_internal/cloudflare-preview-caixa-a.html",
 *               "b": "_internal/cloudflare-preview-caixa-b.html" } }
 *
 * Paths dos braços são RELATIVOS ao dir do ciclo mensal. Presente → cada
 * onda diária de `clarice-envio-run.ts` é dividida 50/50 (estratificado, como
 * as células de assunto/horário) em duas células `-VA`/`-VB`, mesmo horário,
 * mesmo assunto; `clarice-schedule-group.ts` envia o HTML do braço A pra key
 * terminada em `-VA` e o do B pra `-VB`. Ausente → comportamento de sempre
 * (`_internal/cloudflare-preview.html` pra tudo).
 *
 * Sufixo `V{A,B}` (variante) e não `-A`/`-B`: `-A/-B/-C` já é a célula do
 * teste de ASSUNTO, que o dashboard (`parseAbcAudienceCampaign`) lê como tal
 * — reusar o sufixo rotularia este teste como teste de assunto.
 *
 * PURO exceto `readClariceAbTest` (lê disco, sem rede).
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type VariantArm = "a" | "b";

export interface ClariceAbTestConfig {
  label: string;
  /** Paths ABSOLUTOS já resolvidos contra o dir do ciclo. */
  arms: Record<VariantArm, string>;
}

export const AB_TEST_FILE = "ab-test.json";

/**
 * Valida o JSON cru. Lança em config presente mas inválida — config quebrada
 * nunca pode cair em silêncio no "sem teste" (todo mundo receberia o HTML
 * default e o teste sumiria sem sinal).
 */
export function parseClariceAbTest(raw: unknown, monthlyDir: string): ClariceAbTestConfig {
  const o = raw as { label?: unknown; arms?: { a?: unknown; b?: unknown } } | null;
  if (!o || typeof o !== "object") throw new Error(`${AB_TEST_FILE}: esperado objeto JSON.`);
  const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : null;
  if (!label) throw new Error(`${AB_TEST_FILE}: "label" obrigatório (string não-vazia).`);
  if (!/^[a-z0-9-]{1,20}$/i.test(label)) {
    throw new Error(`${AB_TEST_FILE}: "label" "${label}" inválido — use [a-z0-9-], até 20 chars (vai pro utm/nome da lista).`);
  }
  const arms = o.arms;
  if (!arms || typeof arms.a !== "string" || typeof arms.b !== "string" || !arms.a || !arms.b) {
    throw new Error(`${AB_TEST_FILE}: "arms.a" e "arms.b" obrigatórios (paths relativos ao dir do ciclo).`);
  }
  const resolveArm = (p: string) => (isAbsolute(p) ? p : resolve(monthlyDir, p));
  const a = resolveArm(arms.a);
  const b = resolveArm(arms.b);
  if (a === b) throw new Error(`${AB_TEST_FILE}: os dois braços apontam pro MESMO arquivo (${a}).`);
  return { label, arms: { a, b } };
}

/** Lê `{monthlyDir}/_internal/ab-test.json`; `null` quando ausente. */
export function readClariceAbTest(monthlyDir: string): ClariceAbTestConfig | null {
  const p = resolve(monthlyDir, "_internal", AB_TEST_FILE);
  if (!existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`${p}: JSON inválido — ${(e as Error).message}`);
  }
  const config = parseClariceAbTest(raw, monthlyDir);
  // Checado AQUI (antes de qualquer lista/campanha) e não só no
  // `clarice-schedule-group` da célula: lá o VA já estaria agendado quando o
  // VB falhasse — teste saindo com um braço só (achado do review do PR).
  for (const arm of ["a", "b"] as const) {
    if (!existsSync(config.arms[arm])) throw new Error(`${p}: HTML do braço ${arm.toUpperCase()} não existe: ${config.arms[arm]}`);
  }
  assertArmsDiffer(readFileSync(config.arms.a, "utf8"), readFileSync(config.arms.b, "utf8"));
  return config;
}

/** `d6-qui06-VA` → "a"; key sem sufixo de variante → null. */
export function variantArmFromKey(key: string): VariantArm | null {
  const m = /-V([AB])$/.exec(key);
  return m ? (m[1].toLowerCase() as VariantArm) : null;
}

/**
 * HTML a usar pra campanha `key`.
 *   - key `-VA`/`-VB` + config → HTML do braço.
 *   - key `-VA`/`-VB` SEM config → lança (célula de variante sem os HTMLs
 *     enviaria o mesmo conteúdo aos dois braços sem sinal).
 *   - key sem variante → HTML default (`cloudflare-preview.html`) — inclui
 *     fluxos fora da onda diária (ex: clarice-novos), que seguem o braço
 *     default mesmo com o teste ativo.
 */
export function resolveCampaignHtmlPath(
  monthlyDir: string,
  key: string,
  config: ClariceAbTestConfig | null,
): string {
  const arm = variantArmFromKey(key);
  if (arm === null) return resolve(monthlyDir, "_internal", "cloudflare-preview.html");
  if (!config) {
    throw new Error(
      `key "${key}" é célula de variante (-V${arm.toUpperCase()}) mas não existe ${AB_TEST_FILE} no ciclo — ` +
        "sem ele os dois braços receberiam o mesmo HTML.",
    );
  }
  return config.arms[arm];
}

/**
 * A diferenciação por `utm_content` já vem embutida nos HTMLs dos braços
 * (cada caixa tem utm próprio). Aqui só se recusa braços idênticos — teste
 * A/B com conteúdo igual é config errada.
 */
export function assertArmsDiffer(htmlA: string, htmlB: string): void {
  if (htmlA === htmlB) throw new Error("teste A/B: os HTMLs dos braços A e B são idênticos — confira ab-test.json.");
}

/**
 * Guard pros caminhos LEGADOS que aplicam UM html a todas as campanhas
 * (`clarice-schedule-sends.ts`, `clarice-reapply-scheduled-html.ts`): com
 * teste A/B ativo, eles mandariam o HTML default pros dois braços (ou
 * sobrescreveriam o braço B com o A). Aborta alto.
 */
export function assertNoAbTestForSingleHtmlPath(monthlyDir: string, scriptName: string): void {
  if (readClariceAbTest(monthlyDir)) {
    throw new Error(
      `${scriptName}: ciclo tem ${AB_TEST_FILE} (teste A/B de conteúdo, #9308) e este script aplica UM html a todas ` +
        "as campanhas — usar clarice-envio-run.ts / clarice-schedule-group.ts (resolvem o html por braço).",
    );
  }
}
