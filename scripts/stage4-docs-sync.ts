/**
 * stage4-docs-sync.ts (#9964) — CLI fina sobre `scripts/lib/stage4-docs-sync.ts`.
 *
 * Documento editável do gate do Stage 4 (Claude Docs). O top-level cria,
 * substitui e exporta o doc pelo conector; este script só gera o markdown e
 * faz o merge de 3 vias de volta para `02-reviewed.md`/`03-social.md`.
 *
 * Uso:
 *   # Gera o markdown do doc + grava a base em _internal/04-docs-gate.json
 *   npx tsx scripts/stage4-docs-sync.ts render --edition-dir <dir> --edition AAMMDD \
 *     [--out <arquivo.md>] [--summary-file <resumo.md>] [--doc-url <url>]
 *
 *   # Puxa as edições do doc (export markdown) de volta para os arquivos
 *   npx tsx scripts/stage4-docs-sync.ts apply --edition-dir <dir> --doc-export <arquivo.md> \
 *     [--resolve "02-reviewed.md=arquivo|doc,03-social.md=arquivo|doc"]
 *
 * `render` imprime `{ out, doc_url?, rendered_at }`. `apply` imprime o
 * relatório JSON (`files[]`, `pulled[]`, `doc_stale[]`, `conflicts[]`).
 *
 * Exit codes:
 *   0 — ok (render feito / apply sem conflito; `pulled[]` diz o que foi puxado)
 *   1 — apply com CONFLITO em ao menos 1 arquivo (nada gravado nele)
 *   2 — uso inválido, estado/arquivo ausente, sentinela ausente/corrompida no
 *       export (nada gravado)
 */

import { readFileSync } from "node:fs";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { DocsSyncFormatError, parseResolutions, runApply, runRender } from "./lib/stage4-docs-sync.ts";

function usage(msg: string): never {
  console.error(`stage4-docs-sync: ${msg}`);
  console.error(
    "uso: stage4-docs-sync.ts render --edition-dir <dir> --edition AAMMDD [--out <md>] [--summary-file <md>] [--doc-url <url>]\n" +
      "     stage4-docs-sync.ts apply --edition-dir <dir> --doc-export <md> [--resolve \"02-reviewed.md=arquivo|doc,...\"]",
  );
  process.exit(2);
}

export function main(argv: string[]): number {
  const { positional, values, flags } = parseArgs(argv);
  const cmd = positional[0];
  for (const k of ["edition-dir", "edition", "out", "summary-file", "doc-url", "doc-export", "resolve"]) {
    if (flags.has(k)) usage(`--${k} requer um valor`);
  }
  const editionDir = values["edition-dir"];
  if (!editionDir) usage("--edition-dir obrigatório");

  try {
    if (cmd === "render") {
      const edition = values["edition"];
      if (!edition) usage("--edition obrigatório no render");
      const summary = values["summary-file"] ? readFileSync(values["summary-file"], "utf8") : undefined;
      const { out, state } = runRender({
        editionDir,
        edition,
        out: values["out"],
        docUrl: values["doc-url"],
        summary,
      });
      console.log(JSON.stringify({ out, doc_url: state.doc_url, rendered_at: state.rendered_at }));
      return 0;
    }
    if (cmd === "apply") {
      const docExport = values["doc-export"];
      if (!docExport) usage("--doc-export obrigatório no apply");
      const resolutions = values["resolve"] ? parseResolutions(values["resolve"]) : undefined;
      const report = runApply({ editionDir, docExport, resolutions });
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    usage(`subcomando desconhecido: ${cmd ?? "(nenhum)"}`);
  } catch (e) {
    if (e instanceof DocsSyncFormatError) {
      console.error(`stage4-docs-sync: ${e.message}`);
      console.log(JSON.stringify({ ok: false, error: e.message }));
      return 2;
    }
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
