/**
 * extract-inbox-topics.ts (#662)
 *
 * Extrai submissões de texto-puro (sem URL) do inbox editorial para uso como
 * queries adicionais para o `discovery-searcher` no Stage 1f.
 *
 * Análogo ao `inject-inbox-urls.ts` para URLs, mas para tópicos. Resolve o
 * mesmo risco do #594 para topics: sem script automático, o orchestrator
 * dependia de lembrar de extrair manualmente — passível de ser skipado.
 *
 * Entradas de texto-puro são identificadas pela presença do campo
 * `- **topic:**` no bloco (gravado pelo `inbox-drain.ts` quando o corpo do
 * e-mail não tem URLs). A extração itera diretamente pelos segmentos do
 * markdown verificando o campo `**from:**` inline — sem depender de alinhamento
 * por índice com `filterEditorBlocks` (#688).
 *
 * Uso:
 *   npx tsx scripts/extract-inbox-topics.ts \
 *     --inbox-md data/inbox.md \
 *     [--editor diariaeditor@gmail.com] \
 *     [--out <path.json>]
 *
 * Output (stdout ou --out): JSON array de strings
 *   ["IA no mercado de trabalho brasileiro", "open source LLM benchmark"]
 *
 * Exit codes:
 *   0 = ok (pode retornar array vazio se não há topics)
 *   1 = erro de leitura/parse
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Core logic — extraído para testar isoladamente
// ---------------------------------------------------------------------------

/**
 * Extrai tópicos de texto-puro do inbox iterando diretamente pelos segmentos
 * do markdown e verificando o campo `**from:**` inline (#688).
 *
 * Não usa alinhamento por índice com `filterEditorBlocks` — que falhava quando
 * havia blocos de não-editores antes dos blocos do editor (ex: newsletters
 * originais ingeridas pelo inbox-drain após #656).
 */
export function extractTopicsFromInbox(inboxText: string, editorEmail: string): string[] {
  const topics: string[] = [];
  const seen = new Set<string>();
  const lowerEditor = editorEmail.toLowerCase();

  const segments = inboxText.split(/^## /m).slice(1);

  for (const seg of segments) {
    // Verificar se é bloco do editor antes de procurar topic
    const fromMatch = seg.match(/^-\s*\*\*from:\*\*\s*(.+)$/m);
    if (!fromMatch?.[1]?.toLowerCase().includes(lowerEditor)) continue;

    const topicMatch = seg.match(/^-\s*\*\*topic:\*\*\s*(.+)$/m);
    if (!topicMatch) continue;

    const topic = topicMatch[1].trim();
    if (topic.length < 5) continue;

    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
  }

  return topics;
}

/**
 * Pipeline completa: lê inbox.md e extrai topics do editor.
 */
export function extractInboxTopics(inboxMdPath: string, editorEmail: string): string[] {
  if (!existsSync(inboxMdPath)) return [];
  const text = readFileSync(inboxMdPath, "utf8");
  return extractTopicsFromInbox(text, editorEmail);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const inboxMd = args["inbox-md"] ?? "data/inbox.md";
  const editor = args["editor"] ?? process.env.EDITOR_EMAIL ?? resolveEditorEmail(resolve(ROOT, "platform.config.json"));
  const outPath = args["out"];

  const inboxAbs = resolve(ROOT, inboxMd);

  const topics = extractInboxTopics(inboxAbs, editor);

  const json = JSON.stringify(topics, null, 2) + "\n";
  if (outPath) {
    writeFileSync(resolve(ROOT, outPath), json, "utf8");
    console.error(`[extract-inbox-topics] ${topics.length} topic(s) → ${outPath}`);
  } else {
    process.stdout.write(json);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  try {
    main();
  } catch (e) {
    console.error("[extract-inbox-topics] erro:", e);
    process.exit(1);
  }
}
