#!/usr/bin/env npx tsx
/**
 * annotate-actor-brazil.ts (#8504)
 *
 * Shadow mode de `jev.features.actor_brazil` (método comum #8412, veredito
 * da medição #8416): anota cada artigo de `01-categorized.json` com
 * `actor`/`actor_p`/`brazil_p` via Jev, SEM alterar `category`/bucket/regex
 * já atribuídos por `categorize.ts`/#8370 — é um campo ADITIVO, lido depois
 * por `collect-monthly.ts` (fallback pro `detectBrazil()` atual quando
 * ausente) e `check-highlight-themes.ts` (eixo "ator" pra diversidade).
 *
 * Fail-soft SEMPRE (softStep no orchestrator, mas também autoprotegido):
 *   - flag `jev.features.actor_brazil` desligada (default) → no-op, exit 0.
 *   - `TYPESAFE_API_KEY` ausente → no-op, warn em data/run-log.jsonl, exit 0.
 *   - falha de transporte Jev (rede/timeout/HTTP não-2xx) → no-op, warn, exit 0.
 * Nunca lança, nunca bloqueia a pipeline — comportamento idêntico ao pré-
 * #8504 em qualquer um desses casos (teste "off ⇒ idêntico" em
 * test/jev-actor-brazil.test.ts).
 *
 * Uso (via orchestrator — Stage 1, depois de 01-categorized.json existir):
 *   npx tsx scripts/annotate-actor-brazil.ts \
 *     --in data/editions/{AAMMDD}/_internal/01-categorized.json \
 *     [--edition AAMMDD]
 *
 * Reescreve `--in` in-place com os campos `actor`/`actor_p`/`brazil_p`
 * adicionados aos artigos anotados com sucesso (artigos que falharam na
 * chamada, ou cuja resposta veio malformada, ficam sem os campos — mesmo
 * shape de antes).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import { annotateActorBrazil, type ActorBrazilItem } from "./lib/jev-actor-brazil.ts";
import type { Article } from "./lib/types/article.ts";
import type { Highlight } from "./lib/types/categorized-json.ts";

interface CategorizedInput {
  highlights?: Highlight[];
  runners_up?: Highlight[];
  lancamento?: Article[];
  radar?: Article[];
  use_melhor?: Article[];
  video?: Article[];
  [key: string]: unknown;
}

const ARTICLE_BUCKETS = ["lancamento", "radar", "use_melhor", "video"] as const;

/** Extrai `{url, title}` de um Highlight flat ou nested (#229). */
function highlightUrlTitle(h: Highlight): { url?: string; title?: string } {
  if (h.article?.url) return { url: h.article.url, title: h.article.title ?? h.title };
  return { url: h.url, title: h.title };
}

/**
 * Reúne todos os artigos anotáveis do documento (destaques + secundários),
 * exposto para teste isolado da parte pura (sem I/O de rede).
 */
export function collectAnnotatableItems(input: CategorizedInput): ActorBrazilItem[] {
  const items: ActorBrazilItem[] = [];
  const seen = new Set<string>();

  const add = (url: string | undefined, title: string | undefined, summary: string | undefined) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    items.push({ id: url, url, title: title ?? "", summary: summary ?? "" });
  };

  for (const h of [...(input.highlights ?? []), ...(input.runners_up ?? [])]) {
    const { url, title } = highlightUrlTitle(h);
    add(url, title, h.article?.summary as string | undefined);
  }
  for (const bucket of ARTICLE_BUCKETS) {
    for (const article of input[bucket] ?? []) {
      add(article.url, article.title, article.summary);
    }
  }

  return items;
}

/**
 * Aplica as anotações de volta no documento (mutação pura — sem I/O),
 * exposta para teste isolado. Artigos sem anotação (não pedidos, ou item
 * falhou na chamada) ficam inalterados.
 */
export function applyAnnotations(
  input: CategorizedInput,
  annotations: Map<string, { actor: string; actor_p: number; brazil_p: number }>,
): CategorizedInput {
  if (annotations.size === 0) return input;

  const annotateHighlight = (h: Highlight): Highlight => {
    const { url } = highlightUrlTitle(h);
    const ann = url ? annotations.get(url) : undefined;
    if (!ann) return h;
    if (h.article) {
      return { ...h, article: { ...h.article, ...ann } };
    }
    return { ...h, ...ann };
  };

  const annotateArticle = (a: Article): Article => {
    const ann = annotations.get(a.url);
    return ann ? { ...a, ...ann } : a;
  };

  const out: CategorizedInput = { ...input };
  if (input.highlights) out.highlights = input.highlights.map(annotateHighlight);
  if (input.runners_up) out.runners_up = input.runners_up.map(annotateHighlight);
  for (const bucket of ARTICLE_BUCKETS) {
    const list = input[bucket];
    if (list) out[bucket] = (list as Article[]).map(annotateArticle);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgsSimple(process.argv.slice(2));
  const inPath = args["in"];
  if (!inPath) {
    throw new Error("Uso: annotate-actor-brazil.ts --in <categorized.json> [--edition AAMMDD]");
  }
  const edition = args["edition"] ?? null;

  const absPath = resolve(inPath);
  const input: CategorizedInput = JSON.parse(readFileSync(absPath, "utf8"));

  const items = collectAnnotatableItems(input);
  const { annotations, applied } = await annotateActorBrazil(items, { edition });

  if (!applied) {
    process.stderr.write("[annotate-actor-brazil] pulado (flag off, key ausente, ou Jev indisponível) — sem alteração\n");
    return;
  }

  const output = applyAnnotations(input, annotations);
  writeFileSync(absPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  process.stderr.write(
    `[annotate-actor-brazil] ${annotations.size}/${items.length} artigo(s) anotado(s) com actor/actor_p/brazil_p (shadow mode, #8504)\n`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    // Fail-soft de última linha: qualquer erro inesperado (JSON malformado
    // em --in, etc.) não deve derrubar o Stage 1 — este script é sempre
    // dispatchado como softStep (exit 0 sempre esperado) pelo orchestrator.
    process.stderr.write(`[annotate-actor-brazil] erro inesperado, seguindo sem anotação: ${(err as Error).message}\n`);
  });
}
