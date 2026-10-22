/**
 * build-hub-divulgacao-box.ts (#5263)
 *
 * Gera o conteúdo do box rotativo de divulgação dos hubs temáticos e escreve
 * em `data/snippets/hub-divulgacao-rotativo.md` (#5227: migrado de
 * `context/snippets/`, junto com o resto do pool de snippets — deixou de ser
 * um asset COMMITADO; `scripts/build-hub-page.ts` continua com o padrão
 * GERADO/COMMITADO original pras páginas de hub, que não migraram). Ver
 * docstring de
 * `scripts/lib/shared/hub-divulgacao-box.ts` pro racional completo.
 *
 * **Fora da newsletter desde o #10832:** o stitch não chama mais este gerador
 * e a seleção de boxes recusa o arquivo (`NON_BOX_SNIPPET_FILES` em
 * `scripts/select-boxes-by-clicks.ts`) — o editor decidiu que o hub não sai
 * como box. O CLI segue só pra gerar o texto à mão.
 *
 * Uso:
 *   npx tsx scripts/build-hub-divulgacao-box.ts --edition AAMMDD
 *   npx tsx scripts/build-hub-divulgacao-box.ts --edition AAMMDD --check   # não escreve
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { hubCoverageWindow } from "./lib/shared/hub-page.ts";
import {
  selectHubIndexForRotation,
  buildHubDivulgacaoBoxMarkdown,
  type HubDivulgacaoBoxSource,
} from "./lib/shared/hub-divulgacao-box.ts";
import { HUB_LOADERS } from "./build-hub-page.ts";
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function outPath(): string {
  // #5227: asset GERADO passou a viver junto do resto do pool de snippets em
  // `data/snippets/` (gitignored, junction OneDrive) — não é mais commitado.
  return resolve(ROOT, "data/snippets/hub-divulgacao-rotativo.md");
}

/** Resolve o `HubDivulgacaoBoxSource` do hub em rotação nesta edição — pure
 * dado `HUB_LOADERS`/`HUB_META` (que só existem carregados em Node). Exportado
 * pra teste chamar o MESMO caminho que `main()` usa (mesmo racional de
 * `loadHubContent`/`buildHubIndexEntries` em `build-hub-page.ts`). */
export function resolveHubDivulgacaoBoxSource(editionDate: string): HubDivulgacaoBoxSource {
  const idx = selectHubIndexForRotation(editionDate, HUB_META.length);
  const meta = HUB_META[idx];
  const hub = HUB_LOADERS[meta.slug]();
  const { since } = hubCoverageWindow(hub.sourceEditions);
  // #4922: totalEditions é sempre sources.length (mesmo cálculo de
  // hubTotals) — sourceEditions não carrega matchedHeadlines (só
  // HubSourceEntry, o dataset cru, tem esse campo), então não dá pra usar
  // hubTotals aqui direto; .length sozinho já é o valor certo.
  return { slug: meta.slug, label: meta.label, since, totalEditions: hub.sourceEditions.length };
}

export function renderGeneratedSnippet(editionDate: string, markdown: string): string {
  return `<!--
nome: Cobertura completa dos hubs (rotativo)
GERADO, NÃO EDITAR À MÃO — fonte: scripts/lib/shared/hub-divulgacao-box.ts
→ scripts/build-hub-divulgacao-box.ts. Regenerar (edição AAMMDD):

  npx tsx scripts/build-hub-divulgacao-box.ts --edition AAMMDD

Conteúdo gerado pra edição ${editionDate} — 1 hub em rotação determinística
entre os 6 de HUB_META (#5263). Formato bold-line/mid-callout, mesma família
de clarice-divulgacao.md/livros-divulgacao.md (ver context/snippets/README.md,
que continua a spec do formato mesmo com o conteúdo em data/snippets/).

Desde o #10832 este arquivo NÃO sai como box na newsletter (o stitch não o
regenera e a seleção de boxes o recusa); o CLI só gera o texto à mão.
-->
${markdown}
`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const editionIdx = argv.indexOf("--edition");
  const editionDate = editionIdx >= 0 ? argv[editionIdx + 1] : undefined;
  if (!editionDate || !/^\d{6}$/.test(editionDate)) {
    console.error("[build-hub-divulgacao-box] uso: --edition AAMMDD");
    process.exit(2);
  }

  const source = resolveHubDivulgacaoBoxSource(editionDate);
  const markdown = buildHubDivulgacaoBoxMarkdown(source);
  const content = renderGeneratedSnippet(editionDate, markdown);

  if (check) {
    process.stderr.write(`[build-hub-divulgacao-box] --check, não escreve. Hub em rotação: ${source.slug}\n`);
    console.log(content);
    return;
  }
  const path = outPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, content);
  process.stderr.write(`[build-hub-divulgacao-box] ${editionDate}: hub "${source.slug}" — escrito em ${path}\n`);
  console.log(path);
}

if (isMainModule(import.meta.url)) {
  main();
}
