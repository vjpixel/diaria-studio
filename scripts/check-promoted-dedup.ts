/**
 * check-promoted-dedup.ts (#2315)
 *
 * Pós-checagem de dedup para itens promovidos de radar→lançamento (regra #160).
 *
 * Problema: `dedup.ts` roda cedo no Stage 1 (passo 1l), antes da etapa de
 * busca ativa de fonte primária (passo 1m-ter). Quando o orchestrator substitui
 * a URL de pesquisa pela URL oficial e promove o artigo de `radar` para
 * `lancamento`, a nova URL NUNCA passou pelo dedup — e pode repetir uma URL
 * já publicada nas últimas N edições.
 *
 * Este script é chamado APÓS o passo 1m-ter. Para cada artigo em `lancamento`
 * com `primary_source_substituted: { from, to }`, verifica se a URL oficial
 * (`to`) está em `data/past-editions.md`. Se sim, DEMOTE o artigo de volta
 * para `radar`, restaurando a URL original (`from`), e adiciona
 * `primary_source_demoted: { url_oficial, reason }` para rastreabilidade.
 *
 * Escolha de resolução: DEMOTE → radar (mantém o artigo sem violar o invariante).
 *   - Mais seguro que DROP (preserva o item, editor vê no gate).
 *   - Mais correto que PUBLICAR com URL repetida.
 *   - Preferível a FLAG-ONLY (gate já está sobrecarregado; demote é determinístico).
 *
 * Input: `tmp-categorized.json` (shape flat: { lancamento, radar, use_melhor, video })
 * produzido por `categorize.ts` e modificado in-place pelo passo 1m-ter.
 *
 * CLI:
 *   npx tsx scripts/check-promoted-dedup.ts \
 *     --categorized data/editions/AAMMDD/_internal/tmp-categorized.json \
 *     [--past-editions data/past-editions.md] \
 *     [--window 3]
 *
 * Modifica --categorized in-place. Retorna JSON em stdout:
 *   { demoted: [{ url_from, url_to, title, reason }], checked: N }
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize, extractPastUrls, readPastEditionsMd, DEFAULT_PAST_WINDOW } from "./dedup.ts";
import { isMainModule } from "./lib/cli-args.ts";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface PrimarySourceSubstituted {
  from: string;
  to: string;
}

export interface Article {
  url: string;
  title?: string;
  primary_source_substituted?: PrimarySourceSubstituted;
  primary_source_demoted?: { url_oficial: string; reason: string };
  [key: string]: unknown;
}

export interface CategorizedFlat {
  lancamento?: Article[];
  radar?: Article[];
  use_melhor?: Article[];
  video?: Article[];
  [key: string]: unknown;
}

export interface DemotedEntry {
  url_from: string;
  url_to: string;
  title?: string;
  reason: string;
}

export interface CheckPromotedDedupResult {
  demoted: DemotedEntry[];
  checked: number;
}

// ---------------------------------------------------------------------------
// Lógica principal (exportada para testes)
// ---------------------------------------------------------------------------

/**
 * Verifica artigos promovidos de radar→lançamento (via passo 1m-ter, campo
 * `primary_source_substituted`) contra o conjunto de URLs de edições passadas.
 *
 * Muta `buckets` in-place: move itens com URL repetida de `lancamento` para
 * `radar`, restaurando a URL original.
 *
 * @param buckets  Buckets { lancamento, radar, ... } — mutado in-place.
 * @param pastUrls Set de URLs canonicalizadas das últimas N edições (de extractPastUrls).
 * @returns        { demoted[], checked } — demoted = promoções revertidas.
 */
export function checkPromotedDedup(
  buckets: CategorizedFlat,
  pastUrls: Set<string>,
): CheckPromotedDedupResult {
  if (!Array.isArray(buckets.lancamento)) {
    return { demoted: [], checked: 0 };
  }

  const demoted: DemotedEntry[] = [];
  let checked = 0;

  // Iterar in-place (splice conforme demotamos)
  const lancamentos = buckets.lancamento;

  // Detectar duplicatas within-edition: duas promoções para a mesma URL oficial
  // na mesma rodada (passo 1m-ter pode substituir dois artigos pro mesmo destino).
  // Estratégia: manter o PRIMEIRO encontrado; demote todos os subsequentes.
  // allocatedUrls rastreia URLs oficiais já "alocadas" a um item nesta edição.
  const allocatedOfficialUrls = new Set<string>();

  for (let i = 0; i < lancamentos.length; i++) {
    const article = lancamentos[i];
    const sub = article.primary_source_substituted;
    if (!sub?.to) continue; // não promovido via 1m-ter — skip
    // Guard: empty from ('') is not the same as "no substitution" — sub.to was set,
    // so the item IS promoted. Don't skip; from just has no original URL (#2338 fix 2).
    // (The old combined guard `!sub.from || !sub.to` would silently skip from:'' items
    // even when sub.to is a valid official URL that needs to be checked for repeats.)

    checked++;
    const canonicalTo = canonicalize(sub.to);

    // Verificar repetição histórica (past-editions) OU duplicata within-edition
    const repeatsHistory = pastUrls.has(canonicalTo);
    // Duplicata within-edition: já alocamos esta URL oficial a outro item nesta edição
    const isWithinEditionDuplicate = !repeatsHistory && allocatedOfficialUrls.has(canonicalTo);

    if (!repeatsHistory && !isWithinEditionDuplicate) {
      // URL nova e não duplicada: alocar (manter em lancamento)
      allocatedOfficialUrls.add(canonicalTo);
      continue;
    }

    // Guarda: from === to (1m-ter anotou no-op) — avisar que ambas as URLs repetem.
    // Also check sub.from against pastUrls: when from===to, the restored URL is the
    // same repeated URL, so the editor must not re-promote thinking it's safe (#2338 fix 2).
    const fromAlsoRepeats = sub.from === sub.to && pastUrls.has(canonicalize(sub.from));
    if (sub.from === sub.to) {
      console.error(
        `[check-promoted-dedup] WARN: artigo "${article.title ?? sub.from}" tem from===to na substituição — ` +
          `ambas as URLs repetem. Rebaixando para radar sem restaurar URL (restauração seria a mesma URL repetida).`,
      );
    }

    // Guarda: from === '' (orquestrador não preencheu URL de pesquisa) — a URL
    // restaurada no radar SERÁ a URL oficial repetida (article.url === sub.to).
    // Anotar explicitamente que a URL do próprio item radar também repete, para
    // que o editor não re-promova pensando que apenas a URL oficial estava repetida
    // e que o item original (radar) está limpo (#2356 fix 1).
    const fromEmptyRadarAlsoRepeats =
      sub.from === "" && pastUrls.has(canonicalize(article.url));
    if (fromEmptyRadarAlsoRepeats) {
      console.error(
        `[check-promoted-dedup] WARN: artigo "${article.title ?? sub.to}" tem from='' (sem URL de pesquisa original) ` +
          `e a URL do radar restaurada (${article.url}) TAMBÉM repete past-editions — não re-promover sem trocar a URL.`,
      );
    }

    const fromRepeatSuffix = fromAlsoRepeats
      ? `; URL de pesquisa original (from=${sub.from}) também repete — não re-promover sem trocar a URL`
      : fromEmptyRadarAlsoRepeats
        ? `; a URL do radar TAMBÉM repete — não re-promover sem trocar a URL`
        : "";

    const reason = isWithinEditionDuplicate
      ? `URL oficial (${sub.to}) duplicada within-edition (duas promoções para o mesmo destino) — rebaixado para radar${fromRepeatSuffix}`
      : `URL oficial (${sub.to}) repete últimas edições — rebaixado para radar${fromRepeatSuffix}`;

    // Restaurar URL de pesquisa original, EXCETO quando from===to (ambas repetem — manter from mesmo assim
    // para rastreabilidade, mas anotar o fato no primary_source_demoted).
    // Quando from==='' (orquestrador não preencheu URL de pesquisa), cair de volta para
    // article.url (a URL oficial) para que o item em radar permaneça navegável pelo editor.
    const restoredUrl = sub.from || article.url;

    const demotedArticle: Article = {
      ...article,
      url: restoredUrl, // restaura URL de pesquisa original
      primary_source_demoted: {
        url_oficial: sub.to,
        reason,
      },
    };
    // Remover marcador de substituição (promoção foi revertida)
    delete demotedArticle.primary_source_substituted;

    demoted.push({
      url_from: sub.from,
      url_to: sub.to,
      title: article.title,
      reason,
    });

    // Remover de lancamento e mover para radar
    lancamentos.splice(i, 1);
    i--; // ajustar índice após remoção

    if (!Array.isArray(buckets.radar)) {
      buckets.radar = [];
    }
    buckets.radar.push(demotedArticle);
  }

  return { demoted, checked };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  categorized: string;
  pastEditions: string;
  window: number;
} {
  let categorized = "";
  let pastEditions = resolve(import.meta.dirname, "..", "data", "past-editions.md");
  let window = DEFAULT_PAST_WINDOW;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--categorized" && argv[i + 1]) categorized = argv[++i];
    else if (argv[i] === "--past-editions" && argv[i + 1]) pastEditions = argv[++i];
    else if (argv[i] === "--window" && argv[i + 1]) {
      const w = parseInt(argv[++i], 10);
      if (!Number.isInteger(w) || w < 1) {
        console.error(
          `[check-promoted-dedup] --window deve ser um inteiro positivo (recebido: ${argv[i]})`,
        );
        process.exit(1);
      }
      window = w;
    }
  }

  if (!categorized) {
    console.error(
      "Uso: check-promoted-dedup.ts --categorized <path> [--past-editions <path>] [--window <N>]",
    );
    process.exit(1);
  }

  return { categorized, pastEditions, window };
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.categorized)) {
    console.error(
      `[check-promoted-dedup] ERRO: arquivo não encontrado: ${args.categorized}`,
    );
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(args.categorized, "utf8")) as CategorizedFlat;

  // Ler URLs das edições passadas
  // required: true → falha explícita se o arquivo estiver ausente (fresh clone,
  // Stage 0 offline, typo no path) — evita dedup silencioso sem histórico.
  const pastMd = readPastEditionsMd(args.pastEditions, { required: true });
  const pastUrls = extractPastUrls(pastMd, args.window);

  // Verificar e demote in-place
  const result = checkPromotedDedup(raw, pastUrls);

  if (result.demoted.length > 0) {
    console.warn(
      `[check-promoted-dedup] ${result.demoted.length} promoção(ões) revertidas (URL oficial repete past-editions):`,
    );
    for (const d of result.demoted) {
      const label = d.title ? `"${d.title}"` : d.url_from;
      console.warn(`  - ${label} | oficial: ${d.url_to} → restaurado: ${d.url_from}`);
    }
  } else {
    console.error(
      `[check-promoted-dedup] ${result.checked} promoção(ões) verificadas — nenhuma repete past-editions.`,
    );
  }

  // Gravar in-place (preservando todos os campos extras)
  writeFileSync(args.categorized, JSON.stringify(raw, null, 2), "utf8");

  process.stdout.write(
    JSON.stringify({
      demoted: result.demoted,
      checked: result.checked,
    }) + "\n",
  );
}
