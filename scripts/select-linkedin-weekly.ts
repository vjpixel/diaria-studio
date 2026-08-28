#!/usr/bin/env tsx
/**
 * select-linkedin-weekly.ts (#4456)
 *
 * Orquestra a seleção por clique da newsletter semanal do LinkedIn:
 *   1. Resolve ciclo + janela de conteúdo (segunda a sexta) a partir do
 *      AAMMDD da segunda de PUBLICAÇÃO.
 *   2. Lê `02-reviewed.md` de cada edição da janela, extrai candidatos
 *      (destaques + itens de seção).
 *   3. Cruza com o cache local de cliques (#6185: Beehiiv `data/beehiiv-cache/posts/*.json`
 *      E Kit `data/kit-cache/broadcasts/*.json`, via `loadUnifiedPostsForRanking`
 *      — mesma partição por origem que o #6048 aplicou à verificação de
 *      assinante; o manifest de enriquecimento via MCP continua Beehiiv-only,
 *      ver `loadBeehiivCache`/`identifyWeeklyPostsNeedingClicks` abaixo).
 *   4. Ranqueia por taxa (cliques verificados ÷ aberturas), filtra links
 *      comerciais/próprios, seleciona manchetes + Use Melhor + Edições da
 *      semana (link + destaques de cada edição, até 5).
 *   5. Escreve `data/weekly/{cycle}/_internal/ln-selection.json`.
 *
 * **`--manifest-only`**: só resolve a janela + cruza com o cache pra emitir
 * o manifest de posts que precisam de enriquecimento de clicks via MCP
 * (mesmo shape de `posts_needing_clicks` do `beehiiv-sync.ts`) — NÃO calcula
 * seleção. A skill usa isso pra decidir se despacha o agent
 * `beehiiv-clicks-enricher` ANTES de rodar a seleção de verdade (sem isso, a
 * 1ª passada rodaria com clicks todos zerados).
 *
 * **`--picks url1,url2,...`** (#5109): resolve o `pendingGroup` de uma
 * invocação anterior — quando `selectHeadlines` (`weekly-linkedin-select.ts`)
 * defere um empate dentro do ruído de 1 clique maior que as vagas restantes
 * pro editor decidir (ver docstring de `selectHeadlines`), a 1ª invocação
 * (sem `--picks`) grava `pendingGroup` no output e o `headlines` sai mais
 * curto que o cap. A skill apresenta o grupo ao editor no gate (Passo 3) e
 * re-invoca este script com `--picks` (URLs na ordem escolhida) pra
 * finalizar a seleção. Erro explícito (exit 2) se `--picks` não bater
 * EXATAMENTE com o `pendingGroup` da rodada mais recente (contagem errada,
 * URL fora do grupo, repetida) — nunca completa/trunca em silêncio. Passar
 * `--picks` quando não há `pendingGroup` pendente também é erro.
 *
 * Uso:
 *   npx tsx scripts/select-linkedin-weekly.ts --publish-monday AAMMDD [--manifest-only]
 *   npx tsx scripts/select-linkedin-weekly.ts --publish-monday AAMMDD --picks url1,url2
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts";
import { resolveWeeklyLinkedinCycle, weeklyLinkedinRelDir, parseAAMMDD } from "./lib/weekly-linkedin-cycle.ts";
import { extractWeeklyCandidates, detectDeadSectionHeaders, type WeeklyRawCandidate } from "./lib/weekly-linkedin-parse.ts";
import { deriveEditionUrl } from "./lib/edition-url.ts";
import {
  matchPostsToWindow,
  identifyWeeklyPostsNeedingClicks,
  clickCountsForUrl,
  uniqueOpensOf,
  type BeehiivCachePost,
} from "./lib/weekly-linkedin-clicks.ts";
import {
  loadBeehiivCache as loadUnifiedBeehiivCache,
  loadKitCache,
  mergeEditionsByDate,
} from "./lib/shared/edition-cache-reader.ts";
import {
  toRankedCandidate,
  computeHeadlineCap,
  selectHeadlines,
  selectUseMelhor,
  applyPendingPicks,
  editorialTiebreakScore,
  type WeeklyRankedCandidate,
} from "./lib/weekly-linkedin-select.ts";
import { normalizeUrl } from "./lib/weekly-linkedin-clicks.ts";
import { hasSuspiciousCommercialLanguage } from "./lib/weekly-linkedin-filter.ts";
import { parseDestaques } from "./extract-destaques.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface EditionRead {
  date: string;
  found: boolean;
  d1Title?: string;
  /** Títulos dos destaques (1-3, na ordem) — usado pra montar "Edições da semana" (#4456). */
  destaqueTitles: string[];
  candidates: WeeklyRawCandidate[];
  /** #4491: labels de seção (RADAR/LANÇAMENTOS/USE MELHOR/VÍDEOS) com header
   * reconhecível no markdown bruto mas ZERO candidatos extraídos — falha
   * PARCIAL de parse, distinta de `candidates.length === 0` (falha total). */
  deadSections: string[];
}

function readEdition(date: string, editionsRootDir: string): EditionRead {
  const dir = resolveEditionDir(editionsRootDir, date);
  const mdPath = join(dir, "02-reviewed.md");
  if (!existsSync(mdPath)) return { date, found: false, destaqueTitles: [], candidates: [], deadSections: [] };
  const raw = readFileSync(mdPath, "utf8");
  const destaques = parseDestaques(raw)
    .filter((d) => d.n >= 1 && d.n <= 3)
    .sort((a, b) => a.n - b.n);
  const d1 = destaques.find((d) => d.n === 1);
  const candidates = extractWeeklyCandidates(raw, date);
  return {
    date,
    found: true,
    d1Title: d1?.title,
    destaqueTitles: destaques.map((d) => d.title),
    candidates,
    deadSections: detectDeadSectionHeaders(raw, candidates),
  };
}

/**
 * Wrapper fail-soft de leitura unificada Beehiiv+Kit (#6185, mesmas peças de
 * `edition-cache-reader.ts` que `loadUnifiedEditionCache` combina) —
 * diretório Beehiiv ausente vira `[]` em vez de lançar.
 * `loadUnifiedEditionCache` cru lança nesse caso porque trata Beehiiv como
 * fonte PRIMÁRIA obrigatória; este script não pode ter essa exigência
 * porque `--publish-monday` roda em qualquer edição, inclusive em tmpdir de
 * teste sem `data/beehiiv-cache/` (mesmo raciocínio de
 * `loadUnifiedPostsCache`, `box-click-report.ts`). `loadKitCache` já é
 * fail-soft (diretório ausente → `[]`) — sem mudança necessária desse lado.
 * Usada só pra SELEÇÃO por clique (ranking) — o manifest de enriquecimento
 * via MCP (`identifyWeeklyPostsNeedingClicks`) continua Beehiiv-only de
 * propósito e usa `loadBeehiivCache` (RAW, abaixo) em vez desta função.
 */
function loadUnifiedPostsForRanking(beehiivPostsDir: string, kitBroadcastsDir: string) {
  const beehiiv = existsSync(beehiivPostsDir) ? loadUnifiedBeehiivCache(beehiivPostsDir) : [];
  const kit = loadKitCache(kitBroadcastsDir);
  return mergeEditionsByDate(beehiiv, kit);
}

/**
 * Lê o cache RAW do Beehiiv (shape `BeehiivCachePost`, com `id` — usado só
 * pelo manifest de enriquecimento via MCP, `identifyWeeklyPostsNeedingClicks`,
 * que é Beehiiv-only de propósito — ver docstring de `weekly-linkedin-clicks.ts`).
 * A SELEÇÃO por clique (ranking) usa `loadUnifiedPostsForRanking` (#6185,
 * cache Beehiiv+Kit) em vez desta função — ver `main()`.
 */
function loadBeehiivCache(beehiivPostsDir: string): BeehiivCachePost[] {
  if (!existsSync(beehiivPostsDir)) return [];
  const out: BeehiivCachePost[] = [];
  for (const f of readdirSync(beehiivPostsDir)) {
    if (f === "index.json" || !f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(beehiivPostsDir, f), "utf8")));
    } catch {
      // cache corrompido — ignora (mesmo comportamento de monthly-click-sections.ts)
    }
  }
  return out;
}

/**
 * @param rootDirOverride Opcional. Default = raiz do repo. Em testes, passar
 *   tempdir com fixture controlado (`data/editions/`, `data/beehiiv-cache/posts/`)
 *   pra evitar tocar `data/` real (#4489 finding 4, mesmo padrão de
 *   `publish-monthly.ts main(monthlyDirOverride)`).
 */
export function main(rootDirOverride?: string) {
  const rootDir = rootDirOverride ?? ROOT;
  const editionsRootDir = join(rootDir, "data/editions");
  const beehiivPostsDir = join(rootDir, "data/beehiiv-cache/posts");
  // #6185: dir Kit relativo ao MESMO rootDir de teste (nunca o repo real) —
  // mesmo padrão de `beehiivPostsDir` acima (#4489 finding 4). Equivale a
  // `DEFAULT_KIT_BROADCASTS_DIR` quando `rootDirOverride` está ausente (os
  // dois resolvem pro mesmo `ROOT` do repo) — join explícito em vez do
  // default importado pra manter os dois dirs consistentes sob o MESMO
  // rootDir de teste. Sem escritor ainda (`kit-sync.ts`), então na prática
  // hoje é sempre "diretório ausente" → `[]` (ver `loadKitCache`,
  // `edition-cache-reader.ts`).
  const kitBroadcastsDir = join(rootDir, "data/kit-cache/broadcasts");

  const argv = process.argv.slice(2);
  const publishMonday = getArg(argv, "publish-monday");
  const manifestOnly = hasFlag(argv, "manifest-only");
  const picksArg = getArg(argv, "picks");
  const picks = picksArg
    ? picksArg.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  if (!publishMonday) {
    console.error("Uso: select-linkedin-weekly.ts --publish-monday AAMMDD [--manifest-only] [--picks url1,url2]");
    process.exit(2);
  }

  const resolution = resolveWeeklyLinkedinCycle(publishMonday);
  if (!resolution) {
    console.error(`--publish-monday inválido: "${publishMonday}" (esperado AAMMDD)`);
    process.exit(2);
  }

  // #4489 finding 7: guard explícito — `resolveWeeklyLinkedinCycle` só valida
  // FORMATO (AAMMDD), não que a data seja de fato uma segunda-feira. Sem
  // isso, um AAMMDD de outro dia da semana desliza a janela de conteúdo
  // silenciosamente (contentWindowFromPublishMonday assume segunda sem checar).
  const publishMondayDate = parseAAMMDD(publishMonday)!; // não-null: resolution já validou o formato acima
  if (publishMondayDate.getDay() !== 1) {
    const DAY_NAMES = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
    console.error(
      `--publish-monday ${publishMonday} não é uma segunda-feira (é ${DAY_NAMES[publishMondayDate.getDay()]}) — ` +
        `a janela de conteúdo desliza incorretamente se a data não for uma segunda.`,
    );
    process.exit(2);
  }

  const { cycle, contentWindow } = resolution;

  const editions = contentWindow.map((d) => readEdition(d, editionsRootDir));
  const editionsFound = editions.filter((e) => e.found);

  // Manifest de enriquecimento via MCP — Beehiiv-only de propósito (ver
  // docstring de `loadBeehiivCache` acima e de `weekly-linkedin-clicks.ts`).
  const cachePosts = loadBeehiivCache(beehiivPostsDir);
  const windowPosts = matchPostsToWindow(cachePosts, contentWindow);

  if (manifestOnly) {
    const manifest = identifyWeeklyPostsNeedingClicks(windowPosts);
    console.log(JSON.stringify({ cycle, contentWindow, editionsFound: editionsFound.length, posts_needing_clicks: manifest }, null, 2));
    return;
  }

  // #6185: seleção por clique lê Beehiiv+Kit unificado — mesma partição por
  // origem que o #6048 aplicou à verificação de assinante (edição de origem
  // Kit também compete por clique real, quando existir escritor Kit; hoje
  // `loadKitCache` devolve `[]` sem `kit-sync.ts`, então o comportamento
  // observável não muda até esse escritor existir — a camada já fica pronta).
  const windowPostsUnified = matchPostsToWindow(
    loadUnifiedPostsForRanking(beehiivPostsDir, kitBroadcastsDir),
    contentWindow,
  );

  if (editionsFound.length === 0) {
    console.error(`Nenhuma edição encontrada na janela ${contentWindow.join(", ")} — nada pra selecionar.`);
    process.exit(1);
  }

  const allCandidates: WeeklyRawCandidate[] = editionsFound.flatMap((e) => e.candidates);

  const ranked: WeeklyRankedCandidate[] = allCandidates.map((c) => {
    const post = windowPostsUnified.get(c.editionDate);
    const clicks = clickCountsForUrl(c.url, post?.stats?.clicks);
    const opens = uniqueOpensOf(post);
    return toRankedCandidate(c, clicks, opens, windowPostsUnified.has(c.editionDate));
  });

  const headlineCap = computeHeadlineCap(editionsFound.length);
  const headlineResult = selectHeadlines(ranked, headlineCap);

  // #5109: `--picks` resolve o pendingGroup de uma invocação anterior.
  // Exatidão obrigatória — nunca completa/trunca em silêncio (ver
  // docstring de `applyPendingPicks`).
  let finalHeadlines: WeeklyRankedCandidate[] = headlineResult.selected;
  let pendingGroupForOutput = headlineResult.pendingGroup;
  if (picks !== null) {
    if (headlineResult.pendingGroup === null) {
      console.error(
        `--picks foi passado mas não há empate pendente nesta seleção (${headlineResult.selected.length}/${headlineCap} manchete(s) já resolvida(s) sem ambiguidade) — rode sem --picks.`,
      );
      process.exit(2);
    }
    const applied = applyPendingPicks(headlineResult.selected, headlineResult.pendingGroup, headlineResult.pendingSlots, picks);
    if (applied.error) {
      console.error(`--picks inválido: ${applied.error}`);
      process.exit(2);
    }
    finalHeadlines = applied.selected;
    pendingGroupForOutput = null;
  }

  // #5109: dica de desempate editorial (ângulo Brasil > implicação
  // profissional > diversidade de categoria) calculada só pra EXIBIÇÃO no
  // gate — nunca decide automaticamente qual candidato do pendingGroup
  // entra (ver docstring de `selectHeadlines`).
  const pendingGroupWithHint = pendingGroupForOutput
    ? (() => {
        const selectedCategoriesSoFar = new Set(finalHeadlines.map((c) => c.category.toUpperCase()));
        return pendingGroupForOutput.map((c) => ({
          ...c,
          editorialTiebreakHint: editorialTiebreakScore(c, selectedCategoriesSoFar),
        }));
      })()
    : null;

  const headlineUrls = new Set(finalHeadlines.map((c) => normalizeUrl(c.url)));

  const useMelhor = selectUseMelhor(ranked, headlineUrls);

  // #4456 (decisão do editor, 260802): "Edições da semana" lista as
  // edições da janela com D1 parseável (até 5), não só as que perderam a
  // manchete — é o índice da semana inteira, com link + os até-3 destaques
  // de cada dia, independente de um deles já ter virado manchete acima.
  // Precisa de d1Title pra derivar a URL (deriveEditionUrl usa o slug do
  // D1) — sem D1 parseável, a edição fica de fora (mesmo guard de antes,
  // ver warning `missingD1` abaixo).
  const weeklyEditions = editionsFound
    .filter((e) => e.d1Title)
    .map((e) => ({
      editionDate: e.date,
      url: deriveEditionUrl(e.d1Title as string),
      destaques: e.destaqueTitles,
    }));

  const warnings: string[] = [];

  // #4489 finding 1 (item 1): edição com 02-reviewed.md presente mas cujo
  // post NUNCA entrou no cache Beehiiv com status=confirmed+publish_date
  // (gap de sync, status errado, etc.) fica inteiramente AUSENTE de
  // `windowPosts` — diferente de "post presente sem stats.clicks" (isso o
  // manifest de enriquecimento abaixo já cobre). Sem este warning, os
  // candidatos dessa edição caem em ratePct=0 e perdem a disputa por
  // manchete sem NENHUM sinal de que foi por falta de dado, não de
  // engajamento real.
  const editionsMissingClickData = editionsFound.filter((e) => !windowPostsUnified.has(e.date)).map((e) => e.date);
  for (const date of editionsMissingClickData) {
    warnings.push(
      `Sem dados de clique pra edição ${date} — post não encontrado/confirmado no cache Beehiiv/Kit; candidatos dessa edição não competiram por clique real.`,
    );
  }

  warnings.push(...headlineResult.warnings);

  const manifest = identifyWeeklyPostsNeedingClicks(windowPosts);
  if (manifest.length > 0) {
    warnings.push(
      `${manifest.length} post(s) da janela ainda sem clicks enriquecidos no cache — rode beehiiv-clicks-enricher e re-rode este script antes de confiar na seleção.`,
    );
  }
  const missingD1 = editionsFound.filter((e) => !e.d1Title);
  if (missingD1.length > 0) {
    warnings.push(
      `${missingD1.length} edição(ões) sem DESTAQUE 1 parseável — não entram na lista "Edições da semana" (sem D1 não dá pra derivar a URL): ${missingD1.map((e) => e.date).join(", ")}`,
    );
  }

  // #4501 (review PR): `deriveEditionUrl` trunca o slug em 60 caracteres —
  // 2 D1 com prefixo idêntico (ou D1 idênticos) produzem a MESMA URL sem
  // nenhum aviso, e o link de uma das edições em "Edições da semana" aponta
  // pro post ERRADO em silêncio (o rótulo do link, "Edição de DD/MM", segue
  // correto — só o href fica errado, imperceptível na revisão visual do
  // gate). Correção de dado, não estilo — sempre checar antes de aprovar.
  const urlToDates = new Map<string, string[]>();
  for (const e of weeklyEditions) {
    urlToDates.set(e.url, [...(urlToDates.get(e.url) ?? []), e.editionDate]);
  }
  for (const [url, dates] of urlToDates) {
    if (dates.length > 1) {
      warnings.push(
        `Edições da semana: URL derivada colide entre ${dates.join(" e ")} (slug idêntico "${url}") — pelo menos uma dessas edições vai linkar pro post ERRADO. Confira o slug real de cada post no Beehiiv antes de publicar.`,
      );
    }
  }

  // #4489 finding 6: `found && candidates.length === 0` é uma falha TOTAL de
  // parse (seção existe no markdown mas em formato que `parseSections`/
  // `parseDestaques` não reconhece) — diferente de missingD1 (que só cobre
  // a manchete). Sem isso, uma edição inteira perde TODOS os candidatos de
  // RADAR/LANÇAMENTOS/USE MELHOR em silêncio, indistinguível de "edição
  // genuinamente sem mais nada notável".
  const emptyParseEditions = editionsFound.filter((e) => e.candidates.length === 0);
  if (emptyParseEditions.length > 0) {
    warnings.push(
      `${emptyParseEditions.length} edição(ões) com 02-reviewed.md presente mas ZERO candidatos extraídos (seção vazia ou formato não reconhecido pelo parser) — não competiram por seleção: ${emptyParseEditions.map((e) => e.date).join(", ")}`,
    );
  }

  // #4491: falha PARCIAL de parse — diferente de emptyParseEditions acima
  // (que só pega candidates.length===0 pra edição INTEIRA), aqui uma edição
  // pode ter candidatos de OUTRAS seções (candidates.length > 0 no total) e
  // ainda assim ter UMA seção específica com header reconhecido no markdown
  // bruto mas zero candidatos extraídos dela — sinal de regressão no parser
  // (formato de item não reconhecido), não de seção genuinamente vazia (sem
  // header). Sem isso, os itens da seção quebrada sumiam da disputa de
  // seleção sem nenhum sinal, sempre que ao menos uma outra seção da mesma
  // edição continuasse parseando normalmente.
  for (const e of editionsFound) {
    if (e.deadSections.length === 0) continue;
    warnings.push(
      `Edição ${e.date}: se${e.deadSections.length > 1 ? "ções" : "ção"} ${e.deadSections.join(", ")} tem header reconhecido no 02-reviewed.md mas ZERO candidatos extraídos — possível regressão no parser (formato de item não reconhecido), não seção genuinamente vazia.`,
    );
  }

  // #4489 finding 2 (finding 1 item 2): `editionsMissing` já era computado
  // (linha abaixo, no output) mas NUNCA empurrado pro array `warnings` —
  // mesmo tratamento que `missingD1` já recebe.
  const editionsMissing = editions.filter((e) => !e.found).map((e) => e.date);
  if (editionsMissing.length > 0) {
    warnings.push(
      `${editionsMissing.length} edição(ões) da janela sem 02-reviewed.md no disco (nunca criada ou já arquivada) — fora da seleção: ${editionsMissing.join(", ")}`,
    );
  }

  // #4489 finding 5: heurística de baixa confiança — a exclusão comercial
  // (weekly-linkedin-filter.ts) é allowlist ESTÁTICA de domínio; um parceiro
  // novo não cadastrado passa despercebido do mesmo jeito que
  // `prepara.com.br` quase virou destaque por engano em julho/2026. Sinaliza
  // pro gate humano (Passo 3 do SKILL.md) — nunca bloqueia automaticamente.
  const suspiciousPicks = [...finalHeadlines, ...(useMelhor ? [useMelhor] : [])].filter((c) =>
    hasSuspiciousCommercialLanguage(`${c.title} ${c.body}`),
  );
  for (const c of suspiciousPicks) {
    warnings.push(
      `"${c.title}" (${c.editionDate}) contém linguagem comercial (parceria/patrocinado/divulgação/cupom/desconto) apesar de não estar na blocklist de domínio — confira antes de aprovar.`,
    );
  }

  const output = {
    cycle,
    publishMonday: resolution.publishMonday,
    contentWindow,
    editionsFound: editionsFound.map((e) => e.date),
    editionsMissing,
    headlines: finalHeadlines,
    // #5109: presente (não-null) só quando ainda há empate aguardando escolha
    // manual do editor (Passo 3 da skill) — `editorialTiebreakHint` é
    // DICA, não decisor (ver docstring de `selectHeadlines`).
    pendingGroup: pendingGroupWithHint,
    pendingSlots: pendingGroupForOutput ? headlineResult.pendingSlots : 0,
    headlineCandidatesRanked: headlineResult.headlineEligible,
    excludedCandidates: headlineResult.excluded,
    useMelhor: useMelhor ?? null,
    weeklyEditions,
    postsNeedingClicks: manifest,
    warnings,
    generatedAt: new Date().toISOString(),
  };

  const outDir = join(rootDir, weeklyLinkedinRelDir(cycle), "_internal");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "ln-selection.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");

  // Colunas de exibição pedidas pelo gate (#5109): taxa, cliques/opens
  // absolutos ("3cl/177op") e tipo (destaque/section), além de
  // título/edição/seção já existentes.
  function fmtCandidate(c: WeeklyRankedCandidate): string {
    const totalClicks = c.uniqueVerifiedClicks + c.webUniqueClicks;
    return `[${c.ratePct.toFixed(2)}% · ${totalClicks}cl/${c.opens}op · ${c.kind}] ${c.title} (${c.editionDate}, ${c.section})`;
  }

  console.log(`OK: ciclo ${cycle} — ${finalHeadlines.length} manchete(s), Use Melhor ${useMelhor ? "✓" : "✗"}, ${weeklyEditions.length} em Edições da semana → ${outPath}`);
  for (const h of finalHeadlines) {
    console.log(`  ${fmtCandidate(h)}`);
  }
  if (pendingGroupWithHint) {
    console.log(
      `\nEmpate pendente — ${headlineResult.pendingSlots} vaga(s) restante(s), ${pendingGroupWithHint.length} candidato(s) disputando (escolha manual no gate, re-rode com --picks url1,url2,...):`,
    );
    for (const c of pendingGroupWithHint) {
      console.log(`  ${fmtCandidate(c)} (dica de desempate editorial: ${c.editorialTiebreakHint})`);
    }
  }
  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
