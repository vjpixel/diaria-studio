/**
 * scripts/clarice-tutorial-next.ts (#11836)
 *
 * Escolhe o CLARICE — TUTORIAL do ciclo da mensal a partir do Doc
 * "Laboratório Clarice" (id 1KiuwIGyUP3JDhxoCPxV_EgWINWc-osIsSZ_Y1ZCjIIY) e do
 * registro do que já saiu (`context/clarice-tutorial-log.json`).
 *
 * Sem rede: o coordenador lê o Doc pelo conector Google Docs
 * (`mcp__claude_ai_Google_Docs__read_doc`) e grava o texto (ou o JSON) antes.
 *
 * Uso:
 *   npx tsx scripts/clarice-tutorial-next.ts --cycle 2611-12 \
 *     (--doc-text <arquivo.txt> | --doc-json <arquivo.json>) \
 *     [--record] [--out data/monthly/2611-12/_internal/clarice-tutorial.json] \
 *     [--log context/clarice-tutorial-log.json]
 *
 * Imprime JSON `{ kind, cycle, ... }` no stdout:
 *   - kind "tutorial": `tutorial` + `reused` (o ciclo já estava no log) +
 *     `recorded` (`--record` gravou a entrada agora). `--out` grava o tutorial.
 *   - kind "esgotado": todos os tutoriais do Doc já saíram — o writer mantém o
 *     placeholder. `--out` não grava nada.
 *   - kind "fora-da-lista": o ciclo já está no log com tutorial fora do Doc.
 * Exit 0 nesses três casos; exit 1 em uso inválido ou Doc que não parseia.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  docJsonToMarkedText,
  parseLaboratorioClarice,
  parseTutorialLog,
  pickNextTutorial,
  recordTutorial,
} from "./lib/mensal/clarice-tutorial.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_LOG_PATH = resolve(ROOT, "context", "clarice-tutorial-log.json");
const CYCLE_RE = /^\d{4}-\d{2}$/;

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function run(argv: string[], now: Date = new Date()): RunResult {
  const { flags, values } = parseArgs(argv);
  const cycle = values["cycle"];
  const docText = values["doc-text"];
  const docJson = values["doc-json"];
  const fail = (msg: string): RunResult => ({ exitCode: 1, stdout: "", stderr: msg + "\n" });

  if (!cycle || !CYCLE_RE.test(cycle)) return fail("--cycle YYMM-MM obrigatório (ex.: 2611-12).");
  if (!!docText === !!docJson) return fail("Passe exatamente um de --doc-text <arquivo> ou --doc-json <arquivo>.");
  if (flags.has("out")) return fail("--out precisa de um caminho.");

  const logPath = values["log"] ? resolve(values["log"]) : DEFAULT_LOG_PATH;
  try {
    const text = docText
      ? readFileSync(docText, "utf8")
      : docJsonToMarkedText(JSON.parse(readFileSync(docJson!, "utf8")));
    const tutorials = parseLaboratorioClarice(text);
    const log = parseTutorialLog(readFileSync(logPath, "utf8"));
    const pick = pickNextTutorial(tutorials, log, cycle);

    let recorded = false;
    if (pick.kind === "tutorial") {
      if (flags.has("record") && !pick.reused) {
        const next = recordTutorial(log, cycle, pick.tutorial, now.toISOString().slice(0, 10));
        writeFileSync(logPath, JSON.stringify(next, null, 2) + "\n", "utf8");
        recorded = true;
      }
      if (values["out"]) {
        const out = resolve(values["out"]);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify({ cycle, ...pick.tutorial }, null, 2) + "\n", "utf8");
      }
    }
    const payload =
      pick.kind === "tutorial"
        ? { kind: pick.kind, cycle, tutorial: pick.tutorial, reused: pick.reused, recorded }
        : { cycle, ...pick };
    return { exitCode: 0, stdout: JSON.stringify(payload, null, 2) + "\n", stderr: "" };
  } catch (err) {
    return fail(`clarice-tutorial-next: ${(err as Error).message}`);
  }
}

if (isMainModule(import.meta.url)) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.exitCode);
}
