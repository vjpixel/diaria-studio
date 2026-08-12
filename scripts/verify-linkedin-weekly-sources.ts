#!/usr/bin/env tsx
/**
 * scripts/verify-linkedin-weekly-sources.ts (#5108 item 3)
 *
 * Checa a acessibilidade da fonte primária de cada manchete SELECIONADA
 * (após o Passo 3/gate — nunca antes, escolha ambígua ainda pendente não
 * tem fonte "final" pra checar) da newsletter semanal do LinkedIn, ANTES de
 * escrever o resumo próprio (#5108 item 5). Um link que estava acessível na
 * edição de origem (dias atrás) pode ter virado paywall/indisponível desde
 * então — resumir um stub é pior que não resumir. Reusa `verify()` de
 * `scripts/verify-accessibility.ts` (mesmo verificador do Stage 1 diário) —
 * não reinventa checagem própria, e não passa `browser` (fallback Puppeteer
 * fica de fora de propósito — volume aqui é 2-3 URLs, não o pool inteiro
 * de uma edição diária; um HEAD/GET direto que dê `uncertain` já é sinal
 * suficiente pra tratar como "não usar pra resumo", ver
 * `isSourceUsableForSummary`).
 *
 * Lê `data/weekly/{cycle}/_internal/ln-selection.json` (escrito por
 * `select-linkedin-weekly.ts`, já com `--picks` resolvido se havia
 * `pendingGroup`), verifica CADA `headlines[].url`, e grava de volta o
 * campo `sourceAccessibility` em cada headline — SEM tocar `title`/`body`/
 * `why` (a skill escreve o resumo autoral DEPOIS, num passo separado que lê
 * este resultado pra decidir resumir vs. manter literal).
 *
 * Uso:
 *   npx tsx scripts/verify-linkedin-weekly-sources.ts --cycle 26w32
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { isValidWeeklyCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import { verify } from "./verify-accessibility.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface LinkedinWeeklySourceAccessibility {
  url: string;
  verdict: string;
  accessible: boolean;
}

/**
 * Pure: dado o `verdict`/`access_uncertain` bruto de `verify()`, decide se a
 * fonte está acessível o bastante pra basear um resumo próprio. Espelha a
 * leitura do Stage 1 diário (`scripts/verify-accessibility.ts` main()):
 * `anti_bot` em publisher confiável (#320) fica no pool com flag de
 * incerteza, não é tratado como bloqueado — mesma leitura aqui, porque
 * negar resumo a toda fonte anti-bot descartaria publishers tier-1
 * (Bloomberg, WSJ, etc.) que bloqueiam bot mas servem humano normalmente.
 * Todo resto (`paywall`, `blocked`, `aggregator`, `uncertain` sem
 * `access_uncertain`, `needs_reverify`) é tratado como INACESSÍVEL — nunca
 * arrisca resumir um stub/página de erro.
 */
export function isSourceUsableForSummary(verdict: string, accessUncertain: boolean | undefined): boolean {
  if (verdict === "accessible") return true;
  if (verdict === "anti_bot" && accessUncertain) return true;
  return false;
}

interface SelectionHeadline {
  url: string;
  title: string;
  [key: string]: unknown;
}

/**
 * @param rootDirOverride Opcional. Default = raiz do repo. Em testes, passar
 *   tempdir com `ln-selection.json` já escrito (mesmo padrão de
 *   `select-linkedin-weekly.ts main(rootDirOverride)`).
 * @param verifyFn Opcional. Injeção do verificador — testes passam um stub
 *   determinístico em vez de bater rede de verdade.
 */
export async function main(
  rootDirOverride?: string,
  verifyFn: typeof verify = verify,
): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  const argv = process.argv.slice(2);
  const cycle = getArg(argv, "cycle");
  if (!isValidWeeklyCycle(cycle)) {
    console.error("Uso: verify-linkedin-weekly-sources.ts --cycle {YY}w{WW}");
    process.exit(2);
  }

  const selectionPath = join(rootDir, weeklyLinkedinRelDir(cycle), "_internal", "ln-selection.json");
  if (!existsSync(selectionPath)) {
    console.error(`${selectionPath} não existe — rode select-linkedin-weekly.ts (com --picks se houve pendingGroup) primeiro.`);
    process.exit(1);
  }
  const selection = JSON.parse(readFileSync(selectionPath, "utf8"));
  const headlines: SelectionHeadline[] = selection.headlines ?? [];
  if (headlines.length === 0) {
    console.log("Nenhuma manchete selecionada ainda — nada pra verificar.");
    return;
  }

  const results: LinkedinWeeklySourceAccessibility[] = [];
  for (const h of headlines) {
    const r = await verifyFn(h.url);
    const accessible = isSourceUsableForSummary(r.verdict, r.access_uncertain);
    results.push({ url: h.url, verdict: r.verdict, accessible });
    console.log(`${accessible ? "OK" : "INACESSÍVEL"} [${r.verdict}] ${h.title} — ${h.url}`);
  }

  selection.headlines = headlines.map((h, i) => ({ ...h, sourceAccessibility: results[i] }));
  writeFileSync(selectionPath, JSON.stringify(selection, null, 2), "utf8");

  const inaccessible = results.filter((r) => !r.accessible);
  if (inaccessible.length > 0) {
    console.log(
      `\n${inaccessible.length}/${results.length} fonte(s) inacessível(is) — essas manchetes ficam com texto LEVANTADO ` +
        `(literal, o corpo já extraído pela seleção), sem resumo autoral (#5108).`,
    );
  } else {
    console.log(`\nTodas as ${results.length} fontes acessíveis — elegíveis pra resumo autoral (Passo seguinte).`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[verify-linkedin-weekly-sources] erro:", e);
    process.exit(1);
  });
}
