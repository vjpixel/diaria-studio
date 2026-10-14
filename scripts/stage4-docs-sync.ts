/**
 * stage4-docs-sync.ts (#9964) — CLI fina sobre `scripts/lib/stage4-docs-sync.ts`.
 *
 * Documento editável do gate do Stage 4 (Claude Docs). O top-level cria,
 * substitui e exporta o doc pelo conector; este script só gera o markdown,
 * guarda a base e faz o merge de 3 vias de volta para
 * `02-reviewed.md`/`03-social.md`.
 *
 * Uso:
 *   # Gera o markdown do doc (_internal/04-docs-gate.md). Sem doc: grava a base.
 *   # Com doc (doc_url no estado): --doc-export obrigatório, recusa edição não
 *   # puxada e grava a base como PENDENTE (efetivar com `confirm`).
 *   npx tsx scripts/stage4-docs-sync.ts render --edition-dir <dir> --edition AAMMDD \
 *     [--out <arquivo.md>] [--summary-file <resumo.md>] [--doc-export <export.md> --doc-version <container.version do export>]
 *
 *   # Grava o link do doc recém-criado (não mexe na base). --doc-version =
 *   # `container.version` devolvida pela criação (#10177, habilita --no-edits)
 *   npx tsx scripts/stage4-docs-sync.ts set-url --edition-dir <dir> --doc-url <url> [--doc-version <v>]
 *
 *   # Logo após criar o doc: export do doc intocado tem de voltar equivalente;
 *   # senão grava `sync_disabled` (o doc deixa de ser sincronizado)
 *   npx tsx scripts/stage4-docs-sync.ts check-roundtrip --edition-dir <dir> --doc-export <export.md>
 *
 *   # Depois de substituir o doc com o render pendente: efetiva a base nova
 *   npx tsx scripts/stage4-docs-sync.ts confirm --edition-dir <dir> [--doc-export <export.md>] [--doc-version <v>]  (obrigatório se o render gravou version)
 *
 *   # Puxa as edições do doc (export markdown) de volta para os arquivos
 *   npx tsx scripts/stage4-docs-sync.ts apply --edition-dir <dir> --doc-export <arquivo.md> \
 *     [--resolve "02-reviewed.md=arquivo|doc@<resolve_token>,03-social.md=..."] [--final] [--expected-bytes <n>]
 *     (--final = apply final do ramo `sim`; o `check` exige que seja o último apply)
 *     (#10116: export com U+FFFD é recusado com exit 2, nada gravado — cópia
 *     corrompida; --expected-bytes = tamanho devolvido pelo conector, opcional:
 *     se o arquivo tiver outro tamanho, exit 2, nada gravado)
 *
 *   # Sem export (#10177): a version lida agora do doc é a mesma da criação →
 *   # o editor não editou; aplica como se o export fosse a própria base.
 *   # Version diferente/ausente → exit 4, nada gravado (fazer o export normal)
 *   npx tsx scripts/stage4-docs-sync.ts apply --edition-dir <dir> --no-edits --doc-version <v> [--final]
 *
 *   # Desliga o sync (ex.: editor aprovou "sem as edições do doc")
 *   npx tsx scripts/stage4-docs-sync.ts disable --edition-dir <dir> --reason "<motivo>"
 *
 *   # Religa o sync (#10078): só se o export do doc voltar equivalente à base
 *   # (mesmo critério do check-roundtrip); reprovado → segue desligado, exit 1
 *   npx tsx scripts/stage4-docs-sync.ts enable --edition-dir <dir> --doc-export <export.md>
 *
 *   # Estado do doc SEM export (#10078): doc_url, sync ligado/desligado,
 *   # arquivos que o pipeline mudou desde o conteúdo do doc, conflito pendente
 *   npx tsx scripts/stage4-docs-sync.ts status --edition-dir <dir>
 *
 *   # Antes do sentinel do Stage 4: último apply ok e arquivos sem mudança desde
 *   npx tsx scripts/stage4-docs-sync.ts check --edition-dir <dir>
 *
 * Saída: sempre 1 JSON no stdout. `apply` imprime o relatório (`files[]`,
 * `pulled[]`, `pulled_changes`, `doc_stale[]`, `kept_file[]`, `conflicts[]` —
 * cada conflito com `resolve_token`, `current_sha256`, `doc_sha256`).
 *
 * Exit codes:
 *   0 — ok
 *   1 — apply com CONFLITO em ao menos 1 arquivo (nada gravado nele);
 *       check-roundtrip reprovado (sync desativado); enable reprovado (sync
 *       segue desativado); check reprovado
 *   2 — uso inválido, estado/arquivo ausente ou corrompido, sentinela
 *       ausente/corrompida no export, edição pendente no render, sync
 *       desativado (nada gravado)
 *   3 — falha inesperada (I/O, EBUSY do OneDrive, ...). JSON
 *       `{ ok:false, error, written:[...] }` diz o que já tinha sido gravado.
 *   4 — `apply --no-edits` recusado: version do doc mudou desde a criação (ou
 *       não foi registrada). Nada gravado — fazer o export normal (#10177).
 */

import { readFileSync } from "node:fs";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  DocsSyncFormatError,
  DocsSyncNeedsExportError,
  DocsSyncUnexpectedError,
  parseResolutions,
  runApply,
  runCheck,
  runCheckRoundtrip,
  runConfirm,
  runDisable,
  runEnable,
  runRender,
  runSetUrl,
  runStatus,
} from "./lib/stage4-docs-sync.ts";

class UsageError extends Error {}

function usage(msg: string): never {
  throw new UsageError(msg);
}

const USAGE =
  "uso: stage4-docs-sync.ts render --edition-dir <dir> --edition AAMMDD [--out <md>] [--summary-file <md>] [--doc-export <md> [--doc-version <v>]]\n" +
  "     stage4-docs-sync.ts set-url --edition-dir <dir> --doc-url <url> [--doc-version <v>]\n" +
  "     stage4-docs-sync.ts check-roundtrip --edition-dir <dir> --doc-export <md>\n" +
  "     stage4-docs-sync.ts confirm --edition-dir <dir> [--doc-export <md>] [--doc-version <v>]\n" +
  '     stage4-docs-sync.ts apply --edition-dir <dir> --doc-export <md> [--resolve "02-reviewed.md=arquivo|doc@<token>,..."] [--final] [--expected-bytes <n>]\n' +
  "     stage4-docs-sync.ts apply --edition-dir <dir> --no-edits --doc-version <v> [--final]\n" +
  '     stage4-docs-sync.ts disable --edition-dir <dir> --reason "<motivo>"\n' +
  "     stage4-docs-sync.ts enable --edition-dir <dir> --doc-export <md>\n" +
  "     stage4-docs-sync.ts status --edition-dir <dir>\n" +
  "     stage4-docs-sync.ts check --edition-dir <dir>";

function run(argv: string[]): number {
  const { positional, values, flags } = parseArgs(argv);
  const cmd = positional[0];
  for (const k of ["edition-dir", "edition", "out", "summary-file", "doc-url", "doc-export", "resolve", "reason", "doc-version", "expected-bytes"]) {
    if (flags.has(k)) usage(`--${k} requer um valor`);
  }
  const editionDir = values["edition-dir"];
  if (!editionDir) usage("--edition-dir obrigatório");
  const docExport = values["doc-export"];

  switch (cmd) {
    case "render": {
      const edition = values["edition"];
      if (!edition) usage("--edition obrigatório no render");
      if (values["doc-url"]) usage("render não aceita mais --doc-url — use `set-url`");
      // ENOENT/EBUSY aqui é falha inesperada (exit 3), não erro de formato.
      const summary = values["summary-file"] ? readFileSync(values["summary-file"], "utf8") : undefined;
      const r = runRender({ editionDir, edition, out: values["out"], summary, docExport, docVersion: values["doc-version"] });
      console.log(JSON.stringify({ ok: true, ...r }));
      return 0;
    }
    case "set-url": {
      const docUrl = values["doc-url"];
      if (!docUrl) usage("--doc-url obrigatório no set-url");
      const docVersion = values["doc-version"];
      runSetUrl({ editionDir, docUrl, docVersion });
      console.log(JSON.stringify({ ok: true, doc_url: docUrl, ...(docVersion ? { base_doc_version: docVersion } : {}) }));
      return 0;
    }
    case "check-roundtrip": {
      if (!docExport) usage("--doc-export obrigatório no check-roundtrip");
      const r = runCheckRoundtrip({ editionDir, docExport });
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case "confirm": {
      const r = runConfirm({ editionDir, docExport, docVersion: values["doc-version"] });
      console.log(JSON.stringify({ ok: true, ...r }));
      return 0;
    }
    case "apply": {
      if (flags.has("no-edits")) {
        const docVersion = values["doc-version"];
        if (!docVersion) usage("--no-edits exige --doc-version (container.version lida agora do doc)");
        if (docExport || values["expected-bytes"] || values["resolve"]) {
          usage("--no-edits não aceita --doc-export/--expected-bytes/--resolve");
        }
        const report = runApply({ editionDir, noEdits: { docVersion }, final: flags.has("final") });
        console.log(JSON.stringify({ ...report, no_edits: true }, null, 2));
        return report.ok ? 0 : 1;
      }
      if (!docExport) usage("--doc-export obrigatório no apply");
      const resolutions = values["resolve"] ? parseResolutions(values["resolve"]) : undefined;
      const rawBytes = values["expected-bytes"];
      let expectedBytes: number | undefined;
      if (rawBytes !== undefined) {
        if (!/^\d+$/.test(rawBytes)) usage(`--expected-bytes inválido: ${rawBytes} (inteiro ≥ 0)`);
        expectedBytes = Number(rawBytes);
      }
      const report = runApply({ editionDir, docExport, resolutions, final: flags.has("final"), expectedBytes });
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    case "disable": {
      const reason = values["reason"];
      if (!reason) usage("--reason obrigatório no disable");
      runDisable({ editionDir, reason });
      console.log(JSON.stringify({ ok: true, sync_disabled: reason }));
      return 0;
    }
    case "enable": {
      if (!docExport) usage("--doc-export obrigatório no enable (o sync só religa com o round-trip verde)");
      const r = runEnable({ editionDir, docExport });
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case "status": {
      console.log(JSON.stringify({ ok: true, ...runStatus({ editionDir }) }));
      return 0;
    }
    case "check": {
      const r = runCheck({ editionDir });
      console.log(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    default:
      usage(`subcomando desconhecido: ${cmd ?? "(nenhum)"}`);
  }
}

export function main(argv: string[]): number {
  try {
    return run(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`stage4-docs-sync: ${e.message}\n${USAGE}`);
      console.log(JSON.stringify({ ok: false, error: e.message }));
      return 2;
    }
    if (e instanceof DocsSyncNeedsExportError) {
      console.error(`stage4-docs-sync: ${e.message}`);
      console.log(JSON.stringify({ ok: false, needs_export: true, error: e.message }));
      return 4;
    }
    if (e instanceof DocsSyncFormatError) {
      console.error(`stage4-docs-sync: ${e.message}`);
      console.log(JSON.stringify({ ok: false, error: e.message }));
      return 2;
    }
    // Qualquer outra coisa é falha inesperada — nunca o exit 1 do conflito.
    const written = e instanceof DocsSyncUnexpectedError ? e.written : [];
    const message = e instanceof Error ? e.message : String(e);
    console.error(`stage4-docs-sync: falha inesperada: ${message}`);
    console.log(JSON.stringify({ ok: false, error: message, written }));
    return 3;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
