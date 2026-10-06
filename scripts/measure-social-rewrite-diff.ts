/**
 * measure-social-rewrite-diff.ts (#9692)
 *
 * Mede o que mudou no `03-social.md` entre a SAÍDA DO STAGE 2 e o texto
 * APROVADO, por seção, casando destaque por URL (nunca por posição) e
 * rotulando cada mudança com heurísticas transparentes (ver
 * `scripts/lib/social-rewrite-diff.ts`). Só leitura de `data/` — nada ao vivo.
 *
 * @one-off-validity: expira=2027-01-06 pergunta="as reescritas de social no gate 4 têm padrão comum que justifique mudar o prompt do social-writer/social-curto? (#9692)"
 *
 * Uso:
 *   npx tsx scripts/measure-social-rewrite-diff.ts                       # 260928,261005,261006
 *   npx tsx scripts/measure-social-rewrite-diff.ts --editions 261005,261006
 *   npx tsx scripts/measure-social-rewrite-diff.ts --from 260901 --to 261006
 *   npx tsx scripts/measure-social-rewrite-diff.ts --editions-root /caminho/data/editions --json
 *   npx tsx scripts/measure-social-rewrite-diff.ts --editions 260928 --baseline-file _internal/editor-request-snapshots/stage2-post-gate/03-social.md
 *
 * Baseline: snapshot `stage2-post-gate` quando carimbado (#9356); senão o
 * intermediário do social escrito até o fim do Stage 2 (mtime); senão
 * "irrecuperável" (a edição sai da tabela com o motivo). Aprovado:
 * `stage4-post-gate/03-social.md` (estado na aprovação do gate 4) quando
 * existe, senão o `03-social.md` da raiz.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";
import { editionsRoot } from "./lib/edition-paths.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import {
  SNAPSHOT_DIR,
  STAGE2_BASELINE_LABEL,
  STAGE4_POST_GATE_LABEL,
  assessStage2BaselineOnDisk,
  readStep2CompletedAt,
} from "./lib/editor-request-snapshots.ts";
import {
  STAGE2_INTERMEDIATE_CANDIDATES,
  chooseBaseline,
  destaqueUrlMapFromApproved,
  measureEdition,
  renderMarkdown,
  summarize,
  type EditionMeasurement,
} from "./lib/social-rewrite-diff.ts";

const DEFAULT_EDITIONS = ["260928", "261005", "261006"];

interface Args {
  editions: string[] | null;
  from: string | null;
  to: string | null;
  root: string;
  json: boolean;
  baselineFile: string | null;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { editions: null, from: null, to: null, root: editionsRoot(), json: false, baselineFile: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const val = argv[++i];
      if (val === undefined) throw new Error(`${k} exige um valor`);
      return val;
    };
    if (k === "--editions") a.editions = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--from") a.from = v();
    else if (k === "--to") a.to = v();
    else if (k === "--editions-root") a.root = v();
    else if (k === "--baseline-file") a.baselineFile = v();
    else if (k === "--json") a.json = true;
    else throw new Error(`argumento desconhecido: ${k}`);
  }
  return a;
}

const readIf = (p: string): string | undefined => (existsSync(p) ? readFileSync(p, "utf8") : undefined);

type EditionResult = { measurement: EditionMeasurement } | { edition: string; unrecoverable: string };

/** `_internal/03-social.pre-{tag}.md` em ordem de mtime (o nome não carrega ordem). */
function readNamedCheckpoints(dir: string) {
  const internal = join(dir, "_internal");
  if (!existsSync(internal)) return [];
  return readdirSync(internal)
    .map((f) => ({ f, m: f.match(/^03-social\.pre-(.+)\.md$/) }))
    .filter((x): x is { f: string; m: RegExpMatchArray } => x.m !== null)
    .map(({ f, m }) => ({ tag: `pre-${m[1]}`, path: join(internal, f), mtime: statSync(join(internal, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)
    .map(({ tag, path }) => ({ tag, md: readFileSync(path, "utf8") }));
}

function measureOne(edition: string, dir: string, baselineOverride: string | null): EditionResult {
  const snapDir = join(SNAPSHOT_DIR, STAGE2_BASELINE_LABEL);
  const snapshotPath = join(snapDir, "03-social.md");
  let baselinePath: string;
  let baselineNote: string;
  if (baselineOverride) {
    baselinePath = baselineOverride;
    baselineNote = "baseline forçado por --baseline-file";
  } else {
    const step2 = readStep2CompletedAt(dir);
    const choice = chooseBaseline({
      snapshotPath,
      snapshotHealth: assessStage2BaselineOnDisk(dir).status,
      step2CompletedAtMs: step2 ? Date.parse(step2) : null,
      candidates: STAGE2_INTERMEDIATE_CANDIDATES.filter((p) => existsSync(join(dir, p))).map((p) => ({
        path: p,
        mtimeMs: statSync(join(dir, p)).mtimeMs,
      })),
    });
    if (choice.kind === "unrecoverable") return { edition, unrecoverable: choice.note };
    baselinePath = choice.path;
    baselineNote = choice.note;
  }
  const baselineMd = readIf(join(dir, baselinePath));
  if (baselineMd === undefined) return { edition, unrecoverable: `baseline ${baselinePath} não existe` };

  const s4 = join(SNAPSHOT_DIR, STAGE4_POST_GATE_LABEL, "03-social.md");
  const approvedPath = existsSync(join(dir, s4)) ? s4 : "03-social.md";
  const approvedMd = readIf(join(dir, approvedPath));
  if (approvedMd === undefined) return { edition, unrecoverable: "03-social.md aprovado não existe" };

  // URLs dos destaques: só quando o baseline É o snapshot carimbado — o
  // `01-approved.json` dele é do mesmo instante. Intermediário legado não tem
  // par confiável → casamento por similaridade.
  const baselineUrls =
    baselinePath === snapshotPath ? destaqueUrlMapFromApproved(readIf(join(dir, snapDir, "_internal/01-approved.json"))) : undefined;
  const approvedJsonPath =
    approvedPath === s4
      ? join(dir, SNAPSHOT_DIR, STAGE4_POST_GATE_LABEL, "_internal/01-approved.json")
      : join(dir, "_internal/01-approved.json");
  const approvedUrls = destaqueUrlMapFromApproved(readIf(approvedJsonPath));

  return {
    measurement: measureEdition({
      edition,
      baselineMd,
      approvedMd,
      baselineSource: baselinePath,
      baselineNote,
      approvedSource: approvedPath,
      baselineUrls,
      approvedUrls,
      editorRequestsJsonl: readIf(join(dir, "_internal/editor-requests.jsonl")),
      namedCheckpoints: readNamedCheckpoints(dir),
    }),
  };
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  const root = resolve(args.root);
  const dirs = enumerateEditionDirs(root);
  let editions: string[];
  if (args.editions) editions = args.editions;
  else if (args.from || args.to) {
    editions = [...dirs.keys()]
      .filter((e) => (!args.from || e >= args.from) && (!args.to || e <= args.to))
      .sort();
  } else editions = DEFAULT_EDITIONS;

  const results: EditionResult[] = [];
  for (const e of editions) {
    const dir = dirs.get(e);
    if (!dir) {
      results.push({ edition: e, unrecoverable: `edição não encontrada em ${root}` });
      continue;
    }
    results.push(measureOne(e, dir, args.baselineFile));
  }
  const measured = results.flatMap((r) => ("measurement" in r ? [r.measurement] : []));
  const missing = results.flatMap((r) => ("unrecoverable" in r ? [{ edition: r.edition, motivo: r.unrecoverable }] : []));

  if (args.json) {
    console.log(JSON.stringify({ editions: measured, unrecoverable: missing, summary: summarize(measured) }, null, 2));
  } else {
    console.log(renderMarkdown(measured));
    for (const m of missing) console.log(`- ${m.edition}: baseline do Stage 2 IRRECUPERÁVEL — ${m.motivo}`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`[measure-social-rewrite-diff] ${(err as Error).message}`);
    process.exit(2);
  }
}
