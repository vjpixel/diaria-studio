#!/usr/bin/env tsx
/**
 * generic-study-gate-feedback.ts (#9673, regra do editor de 05/10/2026)
 *
 * Pergunta explícita do gate 4 sobre os itens 🔎 (modo sombra da penalidade
 * de estudo/case genérico, #9462) e registro da resposta do editor.
 *
 * Dois modos:
 *
 *   --questions  Imprime no stdout o bloco de perguntas (um "responda sim/não"
 *                por item) para o TOPO do resumo do gate. Sem item em modo
 *                sombra imprime nada (o playbook omite a seção).
 *
 *   --record     Grava `_internal/04-generic-study-feedback.json`, um registro
 *                por item: {url, titulo, resposta, respondido_em,
 *                acao_no_final}. `--answers "1=sim,2=nao"` traz o que o editor
 *                RESPONDEU (índice = número da pergunta). Item sem resposta ⇒
 *                `nao_lido` — silêncio nunca é concordância, e manter/tirar o
 *                item no `02-reviewed.md` NÃO é resposta (vai só para
 *                `acao_no_final`). Sem item em modo sombra não grava nada.
 *
 * Uso:
 *   npx tsx scripts/generic-study-gate-feedback.ts --edition-dir <dir> --questions
 *   npx tsx scripts/generic-study-gate-feedback.ts --edition-dir <dir> --record [--answers "1=sim,2=nao"]
 *
 * Exit: 0 ok; 1 uso inválido ou `--answers` mal formado (nada é gravado).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { runMain } from "./lib/exit-handler.ts";
import {
  FEEDBACK_FILE,
  buildFeedback,
  formatGateQuestions,
  parseAnswersArg,
  readShadowItems,
  type GenericStudyFeedbackFile,
  type GenericStudyFeedbackItem,
} from "./lib/generic-study-feedback.ts";

export function feedbackPath(editionDir: string): string {
  return join(editionDir, "_internal", FEEDBACK_FILE);
}

function readPrevious(path: string): GenericStudyFeedbackItem[] {
  if (!existsSync(path)) return [];
  try {
    const f = JSON.parse(readFileSync(path, "utf8")) as { items?: unknown };
    return Array.isArray(f.items) ? (f.items as GenericStudyFeedbackItem[]) : [];
  } catch {
    return [];
  }
}

/**
 * Núcleo testável do `--record`. Retorna o arquivo gravado, ou `null` quando
 * a edição não tem item em modo sombra. Lança em `--answers` inválido.
 */
export function recordGenericStudyFeedback(opts: {
  editionDir: string;
  answers?: string;
  now?: string;
}): GenericStudyFeedbackFile | null {
  const items = readShadowItems(opts.editionDir);
  if (items.length === 0) return null;
  const answers = parseAnswersArg(opts.answers, items.length);
  const reviewedPath = join(opts.editionDir, "02-reviewed.md");
  const reviewedMd = existsSync(reviewedPath) ? readFileSync(reviewedPath, "utf8") : null;
  const now = opts.now ?? new Date().toISOString();
  const out = feedbackPath(opts.editionDir);
  const edition = basename(opts.editionDir.replace(/[\\/]+$/, ""));
  const file: GenericStudyFeedbackFile = {
    edition: /^\d{6}$/.test(edition) ? edition : null,
    recorded_at: now,
    items: buildFeedback({ items, answers, reviewedMd, now, previous: readPrevious(out) }),
  };
  writeFileSync(out, JSON.stringify(file, null, 2) + "\n", "utf8");
  return file;
}

async function main(): Promise<void> {
  const { flags, values } = parseCliArgs(process.argv.slice(2));
  const editionDir = values["edition-dir"];
  const mode = flags.has("questions") ? "questions" : flags.has("record") ? "record" : null;
  if (!editionDir || !mode) {
    console.error(
      "Uso: generic-study-gate-feedback.ts --edition-dir <dir> (--questions | --record [--answers \"1=sim,2=nao\"])",
    );
    process.exit(1);
  }
  if (mode === "questions") {
    const block = formatGateQuestions(readShadowItems(editionDir));
    if (block) process.stdout.write(block + "\n");
    return;
  }
  let file: GenericStudyFeedbackFile | null;
  try {
    file = recordGenericStudyFeedback({ editionDir, answers: values["answers"] });
  } catch (err) {
    console.error(`[generic-study-feedback] ❌ ${err instanceof Error ? err.message : String(err)} — nada gravado.`);
    process.exit(1);
  }
  if (!file) {
    console.error("[generic-study-feedback] nenhum item 🔎 em modo sombra nesta edição — nada a registrar.");
    return;
  }
  for (const it of file.items) {
    console.error(`[generic-study-feedback] ${it.resposta.padEnd(8)} · final: ${it.acao_no_final ?? "?"} · ${it.titulo}`);
  }
  process.stdout.write(JSON.stringify(file) + "\n");
}

if (isMainModule(import.meta.url)) {
  runMain(main);
}
