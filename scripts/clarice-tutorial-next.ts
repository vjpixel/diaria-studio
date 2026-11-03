/**
 * scripts/clarice-tutorial-next.ts (#11836)
 *
 * Escolhe o CLARICE — TUTORIAL do ciclo da mensal a partir do Doc
 * "Laboratório Clarice" (id 1KiuwIGyUP3JDhxoCPxV_EgWINWc-osIsSZ_Y1ZCjIIY) e do
 * registro do que já saiu (`data/monthly/clarice-tutorial-log.json`, fora do
 * git: `data/` sincroniza entre as máquinas, #5227).
 *
 * Sem rede: o coordenador lê o Doc pelo conector Google Docs
 * (`mcp__claude_ai_Google_Docs__read_doc`) e grava o texto (ou o JSON) antes.
 *
 * Uso:
 *   npx tsx scripts/clarice-tutorial-next.ts --cycle 2611-12 \
 *     (--doc-text <arquivo.txt> | --doc-json <arquivo.json>) \
 *     [--record] [--out data/monthly/2611-12/_internal/clarice-tutorial.json] \
 *     [--log data/monthly/clarice-tutorial-log.json]
 *
 * Imprime JSON `{ kind, cycle, ... }` no stdout:
 *   - kind "tutorial": `tutorial` + `reused` (o ciclo já estava no log) +
 *     `recorded` (`--record` gravou a entrada agora). `--out` grava o
 *     tutorial ANTES do log (falha no `--out` não deixa o ciclo registrado sem
 *     arquivo de tutorial).
 *   - kind "esgotado": todos os tutoriais do Doc já saíram — o writer mantém o
 *     placeholder. Não grava `--out` nem o log.
 *   - kind "fora-da-lista": o ciclo já está no log com tutorial fora do Doc.
 *     Não grava `--out` nem o log.
 * Exit 0 nesses três casos. Exit 1 com `{ kind: "erro", reason, message }` no
 * stdout e `clarice-tutorial-next [reason]: message` no stderr; `reason`:
 *   - `uso`: argumento inválido ou sem valor.
 *   - `doc-invalido`: o texto/JSON do Doc não parseia (estrutura mudou).
 *   - `log-ausente`: o log não existe — nunca recomeça do #1 em silêncio.
 *   - `log-invalido`: o log existe mas está malformado.
 *   - `log-diverge-do-doc`: entrada do log não bate (número + título) com o Doc.
 *   - `io`: falha de leitura/escrita de arquivo.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  ClariceTutorialError,
  docJsonToMarkedText,
  parseLaboratorioClarice,
  parseTutorialLog,
  pickNextTutorial,
  recordTutorial,
  type ClariceTutorialErrorReason,
} from "./lib/mensal/clarice-tutorial.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_LOG_PATH = resolve(ROOT, "data", "monthly", "clarice-tutorial-log.json");
const CYCLE_RE = /^\d{4}-\d{2}$/;

export type RunErrorReason = ClariceTutorialErrorReason | "uso" | "log-ausente" | "io";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class RunError extends Error {
  constructor(
    readonly reason: RunErrorReason,
    message: string,
  ) {
    super(message);
  }
}

function fail(reason: RunErrorReason, message: string): RunResult {
  return {
    exitCode: 1,
    stdout: JSON.stringify({ kind: "erro", reason, message }, null, 2) + "\n",
    stderr: `clarice-tutorial-next [${reason}]: ${message}\n`,
  };
}

function readOrThrow(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (what === "log" && code === "ENOENT") {
      throw new RunError(
        "log-ausente",
        `log ${path} não existe. Restaurar o arquivo (data/ sincroniza entre as máquinas) antes de rodar; ` +
          "sem ele a sequência recomeçaria do #1.",
      );
    }
    throw new RunError("io", `falha ao ler ${what} ${path}: ${(err as Error).message}`);
  }
}

function writeOrThrow(path: string, content: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  } catch (err) {
    throw new RunError("io", `falha ao gravar ${path}: ${(err as Error).message}`);
  }
}

export function run(argv: string[], now: Date = new Date()): RunResult {
  const { flags, values } = parseArgs(argv);
  for (const k of ["cycle", "doc-text", "doc-json", "out", "log"]) {
    if (flags.has(k) || values[k] === "") return fail("uso", `--${k} precisa de um valor.`);
  }
  const cycle = values["cycle"];
  const docText = values["doc-text"];
  const docJson = values["doc-json"];

  if (!cycle || !CYCLE_RE.test(cycle)) return fail("uso", "--cycle YYMM-MM obrigatório (ex.: 2611-12).");
  if (!!docText === !!docJson) return fail("uso", "Passe exatamente um de --doc-text <arquivo> ou --doc-json <arquivo>.");

  const logPath = values["log"] ? resolve(values["log"]) : DEFAULT_LOG_PATH;
  try {
    let text: string;
    if (docText) {
      text = readOrThrow(docText, "doc-text");
    } else {
      const raw = readOrThrow(docJson!, "doc-json");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new ClariceTutorialError("doc-invalido", `JSON do Doc inválido (${(err as Error).message}).`);
      }
      text = docJsonToMarkedText(parsed);
    }
    const tutorials = parseLaboratorioClarice(text);
    const log = parseTutorialLog(readOrThrow(logPath, "log"));
    const pick = pickNextTutorial(tutorials, log, cycle);

    let recorded = false;
    if (pick.kind === "tutorial") {
      if (values["out"]) {
        writeOrThrow(resolve(values["out"]), JSON.stringify({ cycle, ...pick.tutorial }, null, 2) + "\n");
      }
      if (flags.has("record") && !pick.reused) {
        const next = recordTutorial(log, cycle, pick.tutorial, now.toISOString().slice(0, 10));
        writeOrThrow(logPath, JSON.stringify(next, null, 2) + "\n");
        recorded = true;
      }
    }
    const payload =
      pick.kind === "tutorial"
        ? { kind: pick.kind, cycle, tutorial: pick.tutorial, reused: pick.reused, recorded }
        : { cycle, ...pick };
    return { exitCode: 0, stdout: JSON.stringify(payload, null, 2) + "\n", stderr: "" };
  } catch (err) {
    if (err instanceof RunError || err instanceof ClariceTutorialError) return fail(err.reason, err.message);
    return fail("io", (err as Error).message);
  }
}

if (isMainModule(import.meta.url)) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.exitCode);
}
