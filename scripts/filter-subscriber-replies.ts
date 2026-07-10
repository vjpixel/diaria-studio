/**
 * filter-subscriber-replies.ts (#1797)
 *
 * Filtra, de um conjunto de threads capturadas do Gmail (vjpixel@gmail.com via
 * Gmail MCP no playbook §0-replies do Stage 0), quais são **respostas de
 * assinante** à newsletter — pra o orchestrator rascunhar uma resposta pessoal
 * (Gmail `create_draft`, NUNCA enviar).
 *
 * Heurística determinística (testável; a parte MCP fica no playbook, análogo ao
 * §0b-bis de newsletter capture):
 *  - assunto começa com "Re:" (é uma resposta);
 *  - remetente é uma pessoa real — exclui automáticos (no-reply, mailer-daemon,
 *    beehiiv, notifications) e os próprios endereços do editor (não rascunhar
 *    resposta a si mesmo).
 *
 * Uso:
 *   npx tsx scripts/filter-subscriber-replies.ts --in captured-replies.json
 *
 * Input: JSON array de { thread_id, from, subject, date?, body? }.
 * Output JSON: { total, replies: CapturedReply[] }.
 * Exit: 0 (sempre — é filtro, não gate; o draft+gate é no playbook).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { canonicalizeGmail } from "./lib/canonicalize-gmail.ts";

export interface CapturedReply {
  thread_id?: string;
  from?: string;
  subject?: string;
  date?: string;
  body?: string;
  [k: string]: unknown;
}

/**
 * Remetentes automáticos / não-humanos que não merecem rascunho de resposta.
 * Testado contra o EMAIL (não o header com display-name) — review #1827: senão
 * um assinante chamado "João Bounceiro" ou hospedado em beehiiv/substack seria
 * excluído pelo nome de exibição.
 */
const AUTOMATED_FROM_RE =
  /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?@|bounce|beehiiv|mailchimp|substack\.com|sendgrid|unsubscribe@)/i;

/**
 * Endereços do próprio editor — não rascunhar resposta a si mesmo.
 * #1969: comparados via `canonicalizeGmail`, então as variantes Gmail com ponto
 * / `+tag` (`diaria.editor@`, `vj.pixel@`, `diariaeditor+x@`) casam sozinhas —
 * sem precisar listar cada forma na regex (que antes só tinha `diariaeditor@`).
 */
const EDITOR_ADDRESSES = ["vjpixel@gmail.com", "pixel@memelab.com.br", "diariaeditor@gmail.com"];
const EDITOR_CANON = new Set(EDITOR_ADDRESSES.map((a) => canonicalizeGmail(a)));

/** `true` se o e-mail é de um endereço do editor (canonicalizado). */
export function isEditorAddress(email: string): boolean {
  return EDITOR_CANON.has(canonicalizeGmail(email));
}

/**
 * Prefixo de resposta — cobre `Re:`, `RE :`, `Res:` (Outlook PT-BR) e `Re[2]:`
 * (review #1827). NÃO cobre forward (`Enc:`/`Fwd:`) nem replies sem prefixo onde
 * só o header In-Reply-To marca — limitação conhecida (v1 cobre o caso comum).
 */
const REPLY_PREFIX_RE = /^\s*re(s)?\s*(\[\d+\])?\s*:/i;

/** Extrai só o email do header From (`"Nome" <email>` → `email`). */
export function extractEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

/**
 * `true` se a thread parece uma resposta de ASSINANTE à newsletter: assunto com
 * prefixo de resposta + remetente humano (não automático, não o editor). Pura e
 * testável. O match de automático/editor é contra o EMAIL, não o header inteiro.
 */
export function looksLikeSubscriberReply(msg: {
  subject?: string;
  from?: string;
}): boolean {
  const subject = (msg.subject ?? "").trim();
  if (!REPLY_PREFIX_RE.test(subject)) return false;
  const email = extractEmail(msg.from ?? "");
  if (!email) return false;
  if (AUTOMATED_FROM_RE.test(email)) return false;
  if (isEditorAddress(email)) return false;
  return true;
}

export interface FilterResult {
  total: number;
  replies: CapturedReply[];
}

export function filterSubscriberReplies(threads: CapturedReply[]): FilterResult {
  const replies = threads.filter((t) =>
    looksLikeSubscriberReply({ subject: t.subject, from: t.from }),
  );
  return { total: threads.length, replies };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseCliArgs(process.argv.slice(2));
  const inArg = values["in"];
  if (!inArg) {
    console.error("Uso: filter-subscriber-replies.ts --in <captured-replies.json>");
    process.exit(2);
  }
  const inPath = resolve(ROOT, inArg);
  if (!existsSync(inPath)) {
    console.error(`Arquivo não existe: ${inPath}`);
    process.exit(2);
  }
  let threads: CapturedReply[];
  try {
    const parsed = JSON.parse(readFileSync(inPath, "utf8"));
    threads = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.threads) ? parsed.threads : [];
  } catch (err) {
    console.error(`Falha ao parsear ${inPath}: ${(err as Error).message}`);
    process.exit(2);
  }

  const result = filterSubscriberReplies(threads);
  console.log(JSON.stringify(result, null, 2));
  if (result.replies.length > 0) {
    console.error(
      `\n📬 ${result.replies.length} de ${result.total} thread(s) são respostas de assinante — rascunhar resposta pessoal (NUNCA enviar):`,
    );
    for (const r of result.replies) {
      console.error(`  ${r.from} — "${(r.subject ?? "").slice(0, 60)}"`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
