#!/usr/bin/env tsx
/**
 * scripts/verify-linkedin-weekly-sources.ts (#5108 item 3, swap #5538)
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
 * **#5538 (troca de candidato, não stub):** pra manchete `kind === "section"`
 * (item de RADAR/LANÇAMENTOS/VÍDEOS que virou manchete por clique, não por
 * ser destaque), o corpo levantado é só 1 linha — publicável como "corpo
 * literal" quando a fonte segue acessível, mas fraco demais pra sustentar
 * uma manchete inteira quando a fonte ficou inacessível e não dá pra
 * escrever resumo. Nesse caso este script troca automaticamente pelo
 * PRÓXIMO candidato elegível ainda não usado (`headlineCandidatesRanked`,
 * já ranqueado por `select-linkedin-weekly.ts` — exclui comercial/própria/
 * use_melhor/já-selecionados), verificando a fonte de cada candidato de
 * reposição até achar um usável (`kind === "destaque"` é aceito
 * incondicionalmente — corpo já completo/literal, isento por definição,
 * #5108) ou esgotar o pool (nesse caso mantém o stub original, mesmo
 * comportamento de antes, com warning explícito). `kind === "destaque"`
 * SEMPRE mantém o comportamento anterior (nunca troca, mesmo inacessível —
 * o corpo levantado já é substancial). Decisão do editor registrada no
 * corpo do #5538: troca automática, sem reabrir o gate do Passo 3 — o
 * `pendingGroup`/escolha manual já aconteceu ali; aqui é só o "próxima
 * fonte da fila" que uma manchete `section` inacessível precisa, análogo a
 * qualquer outro candidato que perdeu a disputa original por não ter clique
 * suficiente.
 *
 * Lê `data/weekly/{cycle}/_internal/ln-selection.json` (escrito por
 * `select-linkedin-weekly.ts`, já com `--picks` resolvido se havia
 * `pendingGroup`), verifica CADA `headlines[].url`, e grava de volta o
 * campo `sourceAccessibility` em cada headline — SEM tocar `title`/`body`/
 * `why` de manchetes que NÃO trocaram (a skill escreve o resumo autoral
 * DEPOIS, num passo separado que lê este resultado pra decidir resumir vs.
 * manter literal). Manchetes trocadas (`section` inacessível → próximo
 * candidato) saem com `title`/`body`/`why`/`kind`/`url`/etc do candidato de
 * reposição — o campo `sourceAccessibility` reflete a fonte NOVA, não a
 * original.
 *
 * Uso:
 *   npx tsx scripts/verify-linkedin-weekly-sources.ts --cycle 26w32
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { isValidWeeklyCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import { normalizeUrl } from "./lib/weekly-linkedin-clicks.ts";
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
  kind?: string;
  editionDate?: string;
  [key: string]: unknown;
}

/**
 * Pure (#5538): dado o pool de candidatos elegíveis a manchete (já
 * ranqueado por `select-linkedin-weekly.ts`, gravado em
 * `headlineCandidatesRanked` — exclui comercial/própria/use_melhor) e o
 * conjunto de URLs JÁ USADAS nesta seleção (normalizadas — manchetes atuais
 * + trocas já aplicadas em manchetes anteriores do mesmo loop), retorna os
 * candidatos ainda disponíveis pra reposição, na mesma ordem do ranking
 * (melhor taxa primeiro).
 */
export function candidatesAvailableForSwap(
  pool: SelectionHeadline[],
  usedUrls: Set<string>,
): SelectionHeadline[] {
  return pool.filter((c) => !usedUrls.has(normalizeUrl(String(c.url))));
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
  const candidatePool: SelectionHeadline[] = selection.headlineCandidatesRanked ?? [];

  // #5538: URLs já ocupadas por manchete (seed com as manchetes originais —
  // atualizado a cada troca aplicada, pra nunca 2 manchetes convergirem pro
  // mesmo candidato de reposição dentro do mesmo loop).
  const usedUrls = new Set(headlines.map((h) => normalizeUrl(String(h.url))));

  const results: LinkedinWeeklySourceAccessibility[] = [];
  const finalHeadlines: SelectionHeadline[] = [];
  const swapNotes: string[] = [];

  for (const original of headlines) {
    let current = original;
    let r = await verifyFn(current.url);
    let accessible = isSourceUsableForSummary(r.verdict, r.access_uncertain);

    // #5538: só `kind === "section"` troca — `kind === "destaque"`
    // inacessível mantém o comportamento anterior (corpo levantado já é
    // substancial, publicável como stub literal, ver docstring do módulo).
    if (!accessible && current.kind === "section") {
      const pool = candidatesAvailableForSwap(candidatePool, usedUrls);
      let swapped = false;
      for (const candidate of pool) {
        const cr = await verifyFn(candidate.url);
        const cAccessible = isSourceUsableForSummary(cr.verdict, cr.access_uncertain);
        // `destaque` é aceito incondicionalmente (corpo já completo/literal,
        // isento — #5108); `section` só entra se a própria fonte for usável.
        const accept = candidate.kind === "destaque" || cAccessible;
        if (!accept) continue;

        swapNotes.push(
          `Manchete "${original.title}" (${original.editionDate}) trocada por "${candidate.title}" (${candidate.editionDate}, ${candidate.kind}) — ` +
            `fonte original [${r.verdict}] inacessível (#5538).`,
        );
        usedUrls.delete(normalizeUrl(String(current.url)));
        usedUrls.add(normalizeUrl(String(candidate.url)));
        current = candidate;
        r = cr;
        accessible = cAccessible;
        swapped = true;
        break;
      }
      if (!swapped) {
        swapNotes.push(
          `Manchete "${original.title}" (${original.editionDate}) com fonte inacessível [${r.verdict}] — nenhum candidato de reposição elegível ` +
            `restou no pool (${pool.length} tentado(s)) — mantendo corpo levantado original (stub, #5538).`,
        );
      }
    }

    results.push({ url: current.url, verdict: r.verdict, accessible });
    finalHeadlines.push(current);
    console.log(`${accessible ? "OK" : "INACESSÍVEL"} [${r.verdict}] ${current.title} — ${current.url}`);
  }

  selection.headlines = finalHeadlines.map((h, i) => ({ ...h, sourceAccessibility: results[i] }));
  if (swapNotes.length > 0) {
    selection.warnings = [...(selection.warnings ?? []), ...swapNotes];
    console.log("\nTrocas de candidato (#5538):");
    for (const note of swapNotes) console.log(`  - ${note}`);
  }
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
