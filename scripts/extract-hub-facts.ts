/**
 * extract-hub-facts.ts (#5060 Parte B2)
 *
 * Achata o conteúdo de um hub temático (`scripts/lib/hubs/{slug}.ts`, via
 * `HUB_LOADERS`) + o dataset bruto de fontes
 * (`scripts/lib/hubs/{slug}-sources.generated.json`) num único manifesto
 * JSON fácil de consumir por um agente LLM sem parsear TypeScript — insumo
 * do `fact-checker` em `mode: "hub"` (ver `.claude/agents/fact-checker.md`).
 *
 * **Por que este script existe.** O `fact-checker` só tem `Read, Write,
 * WebFetch` (sem `Bash`) — não consegue rodar `tsx` pra importar o módulo
 * do hub e chamar `get{Hub}Hub()` ele mesmo, nem tem como parsear com
 * segurança os array literals de `paragraphs: [...]` dentro do `.ts` (a
 * prosa contém aspas escapadas, template literals com `${...}`, links
 * markdown com parênteses aninhados — terreno fértil pra um LLM "quase
 * acertar" a extração). Este script é PENSADO pra rodar ANTES do dispatch do
 * fact-checker (pelo orchestrator/skill top-level, que TEM Bash), gravando o
 * manifesto num path que o agente só precisa `Read`.
 *
 * **Call site real desde #5102:** `scripts/build-hub-page.ts --check-facts`
 * já roda este script automaticamente (via subprocess, `runTsx` — import
 * direto criaria um ciclo de módulo, já que este arquivo importa
 * `HUB_LOADERS`/`loadHubContent` de `build-hub-page.ts`), gravando o
 * manifesto em `data/hub-fact-check/{slug}-facts.json`. **O que ainda NÃO
 * existe:** o dispatch do `fact-checker` em `mode: "hub"` propriamente dito
 * — nem este script nem `build-hub-page.ts` têm como chamar um subagente
 * LLM (#207); alguém (orchestrator/skill top-level, ou o editor manualmente)
 * ainda precisa rodar o agente sobre o manifesto preparado aqui pra que
 * `{slug}-report.json` passe a existir. Até isso acontecer, todo
 * `--check-facts` cai no ramo "sem relatório" do gate (ver
 * `.claude/agents/fact-checker.md` seção "Modo hub").
 *
 * Para cada parágrafo de seção e cada resposta de FAQ, extrai os links
 * markdown `[texto](url)` presentes (via `findParagraphLinks`, o mesmo
 * parser que os hubs já usam pra renderizar) e classifica cada um:
 *   - `"edition"`: aponta pra uma edição da diária (`diar.ia.br/p/...`) —
 *     cruzado por URL contra o dataset de fontes, anexando
 *     `matchedHeadlines` + `primarySourceUrls` dessa edição quando existirem
 *     (nem toda entrada tem — `primarySourceUrls` é opcional/alinhado por
 *     índice, ver `HubSourceEntry`).
 *   - `"external"`: qualquer outro link (tipicamente `[fonte primária](...)`
 *     colado logo depois de um link de edição) — candidato de verificação
 *     direta, sem cruzamento.
 *
 * Uso:
 *   npx tsx scripts/extract-hub-facts.ts --hub brasil-regulacao [--out path.json]
 * Sem `--out`, imprime o JSON em stdout (útil pra inspecionar via `| jq`).
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { writeFileAtomicIfChanged } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { HUB_LOADERS, loadHubContent } from "./build-hub-page.ts";
import { findParagraphLinks } from "./lib/shared/markdown-links.ts";
import type { HubSourceEntry } from "./generate-hub-sources.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Só presente em links `kind === "edition"` E cuja URL bate com uma entrada
 * do dataset de fontes (match por `url` — a prosa cita a URL final, não o
 * `editionSlug`, que é metadado interno do dataset). */
export interface MatchedSource {
  date: string;
  editionSlug: string;
  matchedHeadlines: string[];
  /** Passa adiante exatamente como está no dataset — pode conter `null`
   * nas posições em que `generate-hub-sources.ts` não achou âncora pra
   * aquela manchete (ver docstring de `HubSourceEntry.primarySourceUrls`).
   * O consumidor (agente `fact-checker`) pula posições `null`. */
  primarySourceUrls: (string | null)[];
}

/** União discriminada por `kind` — só links `"edition"` podem carregar
 * `matchedSource` (e mesmo assim é opcional: só presente quando a URL bate
 * com uma entrada do dataset). Antes disso, `kind`/`matchedSource` eram só
 * acoplados por convenção — nada impedia construir
 * `{kind: "external", matchedSource: {...}}` (#5060 fleet review item 6). */
export type ExtractedLink =
  | { label: string; url: string; kind: "external" }
  | { label: string; url: string; kind: "edition"; matchedSource?: MatchedSource };

export interface ExtractedParagraph {
  index: number;
  text: string;
  links: ExtractedLink[];
}

export interface ExtractedSection {
  index: number;
  heading: string;
  paragraphs: ExtractedParagraph[];
}

export interface ExtractedFaqItem {
  index: number;
  question: string;
  answer: string;
  links: ExtractedLink[];
}

export interface HubFactsManifest {
  hub: string;
  updatedDate: string;
  sections: ExtractedSection[];
  faq: ExtractedFaqItem[];
  /** Dataset bruto completo — pra qualquer cruzamento que o agente precise
   * fazer além do que `matchedSource` já resolveu (ex: contradição entre
   * seções que cita uma edição sem link direto no trecho). */
  sourceEntries: HubSourceEntry[];
}

function loadSourceEntries(slug: string): HubSourceEntry[] {
  const path = resolve(ROOT, `scripts/lib/hubs/${slug}-sources.generated.json`);
  return JSON.parse(readFileSync(path, "utf8")) as HubSourceEntry[];
}

/** `true` só para `https://diar.ia.br/p/...` — parsing real de URL, não
 * substring matching. `.includes("diar.ia.br/p/")` (versão anterior, #5060
 * fleet review item 5) classificaria erroneamente um link redirecionador/
 * UTM-wrapped que contivesse essa substring em qualquer parte da URL (ex:
 * `https://tracker.example/go?dest=https://diar.ia.br/p/foo`) como
 * "edition". URL malformada (não parseável) nunca é "edition" — cai no
 * `catch` e o caller trata como "external". */
function isEditionUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "diar.ia.br" && u.pathname.startsWith("/p/");
  } catch {
    return false;
  }
}

/** Exportada (não só interna) — testável isoladamente com um `sourceEntries`
 * sintético, sem precisar de um hub real no disco (`extractHubFacts` cobre
 * a integração real; este export cobre os modos de falha de classificação
 * em isolamento, mesmo padrão de `buildAnthropicClaudeFaq`/`countMatching`
 * nos módulos de hub). */
export function classifyLinks(text: string, sourceEntries: HubSourceEntry[]): ExtractedLink[] {
  const byUrl = new Map(sourceEntries.map((s) => [s.url, s]));
  return findParagraphLinks(text).map((l): ExtractedLink => {
    if (!isEditionUrl(l.url)) {
      return { label: l.label, url: l.url, kind: "external" };
    }
    const matched = byUrl.get(l.url);
    return {
      label: l.label,
      url: l.url,
      kind: "edition",
      ...(matched
        ? {
            matchedSource: {
              date: matched.date,
              editionSlug: matched.editionSlug,
              matchedHeadlines: matched.matchedHeadlines,
              primarySourceUrls: matched.primarySourceUrls ?? [],
            },
          }
        : {}),
    };
  });
}

/** Pure — recebe o slug, devolve o manifesto. Único ponto de montagem;
 * `main()` só faz I/O de CLI em volta dela (mesmo padrão de `loadHubContent`
 * em `build-hub-page.ts`, que este módulo reusa por import). */
export function extractHubFacts(slug: string): HubFactsManifest {
  const hub = loadHubContent(slug);
  const sourceEntries = loadSourceEntries(slug);
  return {
    hub: slug,
    updatedDate: hub.updatedDate,
    sections: hub.sections.map((s, i) => ({
      index: i,
      heading: s.heading,
      paragraphs: s.paragraphs.map((p, j) => ({ index: j, text: p, links: classifyLinks(p, sourceEntries) })),
    })),
    faq: hub.faq.map((f, i) => ({ index: i, question: f.question, answer: f.answer, links: classifyLinks(f.answer, sourceEntries) })),
    sourceEntries,
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const hubIdx = argv.indexOf("--hub");
  const hub = hubIdx >= 0 ? argv[hubIdx + 1] : undefined;
  const outIdx = argv.indexOf("--out");
  const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;

  if (!hub) {
    console.error("[extract-hub-facts] uso: --hub <slug> [--out <path>]");
    process.exit(2);
  }
  if (!HUB_LOADERS[hub]) {
    console.error(`[extract-hub-facts] hub desconhecido: "${hub}". Disponíveis: ${Object.keys(HUB_LOADERS).join(", ")}`);
    process.exit(2);
  }

  const manifest = extractHubFacts(hub);
  const json = JSON.stringify(manifest, null, 2);
  if (out) {
    const outPath = resolve(ROOT, out);
    // #5102: writeFileAtomicIfChanged (não writeFileAtomic incondicional) —
    // o caller (build-hub-page.ts --check-facts) compara o mtime deste
    // manifesto contra o mtime do relatório de fact-check pra decidir se o
    // relatório ainda reflete o conteúdo atual do hub. Bumpar o mtime a
    // cada regeneração idêntica destruiria esse sinal.
    const wrote = writeFileAtomicIfChanged(outPath, json + "\n");
    process.stderr.write(
      wrote
        ? `[extract-hub-facts] ${hub}: escrito em ${outPath}\n`
        : `[extract-hub-facts] ${hub}: ${outPath} já reflete o conteúdo atual — mtime preservado.\n`,
    );
    console.log(outPath);
  } else {
    console.log(json);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
