#!/usr/bin/env tsx
/**
 * session-handoff.ts (#9374) — CLI do handoff da 1ª sessão da edição.
 *
 * A 1ª sessão (`/diaria-edicao`, Etapas 1–4) registra aqui o que hoje só
 * existia no contexto dela e sumia quando a sessão terminava: halts, MCP
 * caindo, retries, reclamações do editor no gate do Stage 4, outros
 * problemas. O `collect-edition-signals.ts` do Stage 6 (2ª sessão) lê o
 * arquivo e vira sinal pro `auto-reporter`. Lógica em
 * `scripts/lib/session-handoff.ts`.
 *
 * Uso:
 *   npx tsx scripts/session-handoff.ts add --edition-dir data/editions/2610/261001/ \
 *     --kind halt|mcp_drop|retry|editor_complaint|problem --stage 0-4 \
 *     --summary "..." [--severity low|medium|high] [--component nome]
 *   npx tsx scripts/session-handoff.ts close   --edition-dir ...   # fim da 1ª sessão (mesmo sem ocorrências)
 *   npx tsx scripts/session-handoff.ts summary --edition-dir ...   # linha pro resumo do Stage 6
 *
 * Remediação não prevista no playbook continua em `log-runtime-fix.ts`.
 * Exit: 0 ok; 2 uso inválido; 1 erro de escrita (arquivo ilegível etc).
 */

import { resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  HANDOFF_KINDS,
  HANDOFF_SEVERITIES,
  appendHandoffEntry,
  closeHandoff,
  isHandoffKind,
  isHandoffSeverity,
  readHandoff,
  summarizeHandoffForStage6,
} from "./lib/session-handoff.ts";

const USAGE =
  "Uso: session-handoff.ts add --edition-dir DIR --kind <" +
  HANDOFF_KINDS.join("|") +
  "> --stage 0-4 --summary \"...\" [--severity <" +
  HANDOFF_SEVERITIES.join("|") +
  ">] [--component nome]\n       session-handoff.ts close|summary --edition-dir DIR";

export function editionFromDir(editionDir: string): string {
  const name = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
  return /^\d{6}$/.test(name) ? name : "unknown";
}

function fail(msg: string, code: number): never {
  console.error(msg);
  process.exit(code);
}

function main(): void {
  const { positional, values } = parseArgs(process.argv.slice(2));
  const sub = positional[0];
  if (!values["edition-dir"]) fail(USAGE, 2);
  const editionDir = resolve(values["edition-dir"]);
  const edition = editionFromDir(editionDir);

  if (sub === "summary") {
    console.log(summarizeHandoffForStage6(readHandoff(editionDir)));
    return;
  }
  try {
    if (sub === "close") {
      const doc = closeHandoff(editionDir, edition);
      console.log(JSON.stringify({ ok: true, closed_at: doc.closed_at, entries: doc.entries.length }));
      return;
    }
    if (sub === "add") {
      const kind = values.kind;
      if (!isHandoffKind(kind)) fail(`--kind inválido: ${kind ?? "(ausente)"}\n${USAGE}`, 2);
      const stage = Number(values.stage);
      if (!values.stage || !Number.isInteger(stage)) fail(`--stage inválido: ${values.stage ?? "(ausente)"}\n${USAGE}`, 2);
      if (!values.summary?.trim()) fail(`--summary ausente\n${USAGE}`, 2);
      const severity = values.severity;
      if (severity !== undefined && !isHandoffSeverity(severity)) fail(`--severity inválida: ${severity}\n${USAGE}`, 2);
      const doc = appendHandoffEntry(editionDir, edition, {
        kind,
        stage,
        summary: values.summary,
        ...(severity ? { severity } : {}),
        ...(values.component ? { component: values.component } : {}),
      });
      console.log(JSON.stringify({ ok: true, entries: doc.entries.length }));
      return;
    }
  } catch (e) {
    fail(`[session-handoff] ${e instanceof Error ? e.message : String(e)}`, 1);
  }
  fail(USAGE, 2);
}

if (isMainModule(import.meta.url)) main();
