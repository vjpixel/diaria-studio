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
 * #4095: cada reply filtrada também é marcada com `trivial: boolean` —
 * `true` quando o corpo, depois de limpo de citação/assinatura
 * (`stripQuotedAndSignature`), não tem substância (saudação/agradecimento
 * isolado, corpo vazio, ou só emoji/pontuação — `isTrivialReply`). A marcação
 * NÃO remove a reply do array: o consumidor (orchestrator §0-replies) decide
 * não criar rascunho pra threads `trivial: true`, mas o caminho de crédito do
 * concurso "ache o erro" (que roda sobre o mesmo array `replies`) continua
 * vendo TODAS — pular o rascunho não pode pular a checagem do erro
 * intencional (decisão explícita da issue).
 *
 * Uso:
 *   npx tsx scripts/filter-subscriber-replies.ts --in captured-replies.json
 *
 * Input: JSON array de { thread_id, from, subject, date?, body? }.
 * Output JSON: { total, replies: CapturedReply[] } (cada reply com `trivial`).
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
  /** #4095: `true` quando o corpo (limpo de citação/assinatura) não tem
   * substância — ver docstring do módulo. Ausente no input; preenchido por
   * `filterSubscriberReplies`. */
  trivial?: boolean;
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

/**
 * #4095: linha de header que introduz o bloco citado ("Em {data}, {nome}
 * escreveu:" / "No dia {data}, {nome} escreveu:" / Outlook-EN "On {data},
 * {nome} wrote:"). Tudo a PARTIR dessa linha é presumido citação (o corpo
 * original da newsletter, tipicamente sem prefixo `>` quando o cliente cola a
 * citação como texto rico em vez de blockquote) — não só a linha em si.
 */
const QUOTE_HEADER_RE = /^\s*(?:em|no dia|on)\s+.{0,160}?(?:escreveu|wrote)\s*:\s*$/im;

/**
 * #4095: assinatura de app mobile ("Enviado do meu iPhone/Android", "Sent
 * from my iPhone", "Get Outlook for iOS") — tipicamente a ÚLTIMA linha do
 * texto novo do leitor, logo antes do histórico citado começar (às vezes sem
 * header de citação explícito). Tudo a partir dela também é descartado.
 */
const MOBILE_SIGNATURE_RE = /^\s*(?:enviado (?:do|pelo|via) meu \S+|sent from my \S+|get outlook for \S+)\s*$/im;

/** #4095: delimitador de assinatura plain-text convencional ("-- " numa linha própria). */
const PLAIN_SIGNATURE_DELIM_RE = /^--\s*$/m;

/**
 * #4095: reduz o corpo bruto de um reply (que vem de `get_thread` com
 * `FULL_CONTENT`, tipicamente = texto novo do leitor + newsletter inteira
 * citada + assinatura/disclaimer) ao texto novo do leitor.
 *
 * Estratégia: corta o texto no primeiro boundary estrutural (header de
 * citação, assinatura mobile, ou delimitador `--`) — o que vier primeiro —
 * pois tudo dali em diante é citação/assinatura, nunca texto novo. Depois
 * remove linhas prefixadas com `>` (1+ níveis de blockquote) que possam
 * aparecer ANTES desse boundary (clientes que blockquote sem header).
 *
 * Pura, nunca lança. `body` ausente/vazio → `""`.
 */
export function stripQuotedAndSignature(body: string | undefined | null): string {
  if (!body) return "";
  let text = body.replace(/\r\n/g, "\n");

  const boundaryIndices = [QUOTE_HEADER_RE, MOBILE_SIGNATURE_RE, PLAIN_SIGNATURE_DELIM_RE].map(
    (re) => re.exec(text)?.index ?? Infinity,
  );
  const cutAt = Math.min(...boundaryIndices);
  if (cutAt !== Infinity) text = text.slice(0, cutAt);

  text = text
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");

  return text.trim();
}

/** #4095: saudação isolada — pt-BR + variantes comuns em EN, sem substância. */
const GREETING_ONLY_RE = /^(?:oi+|ol[áa]|e a[íi]|opa|bom dia|boa tarde|boa noite|hey|hi|hello)[!.,;\s]*$/iu;

/** #4095: agradecimento isolado. */
const THANKS_ONLY_RE = /^(?:obrigad[oa]s?|(?:muito\s+)?obrigad[oa]o?|brigad[ãa]o|vlw|valeu|show|top|thanks?|thank you|ty)[!.,;\s]*$/iu;

/**
 * #4095: string inteira composta só por emoji (pictográficos, incl.
 * sequências com seletor de variação U+FE0E/U+FE0F, ZWJ U+200D, ou
 * modificador de tom de pele) e/ou pontuação/whitespace — sem NENHUMA letra
 * ou dígito. Casa também string vazia (`""`), mas isso é filtrado antes por
 * `!t` no caller.
 */
const EMOJI_OR_PUNCT_ONLY_RE = new RegExp(
  "^[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\u200d\\ufe0e\\ufe0f\\s!?.,;:()\\-\\u2013\\u2014'\"]*$",
  "u",
);

/** #4095: heurística de tamanho — saudação/agradecimento isolado só conta
 * como trivial em corpo CURTO; evita falso-positivo em pergunta legítima que
 * comece com "Oi" ou "Valeu" seguida de conteúdo real. */
const TRIVIAL_GREETING_MAX_LEN = 40;

/**
 * #4095: `true` quando `cleanBody` (já passado por `stripQuotedAndSignature`)
 * não tem substância — corpo vazio, saudação isolada, agradecimento isolado,
 * ou só emoji/pontuação. `false` pra qualquer outro conteúdo (inclusive
 * pergunta curta de 1 linha). Pura, nunca lança.
 */
export function isTrivialReply(cleanBody: string | undefined | null): boolean {
  const t = (cleanBody ?? "").trim();
  if (!t) return true;
  if (EMOJI_OR_PUNCT_ONLY_RE.test(t)) return true; // só emoji e/ou pontuação, nenhuma letra/dígito
  if (t.length <= TRIVIAL_GREETING_MAX_LEN) {
    if (GREETING_ONLY_RE.test(t)) return true;
    if (THANKS_ONLY_RE.test(t)) return true;
  }
  return false;
}

export interface FilterResult {
  total: number;
  replies: CapturedReply[];
}

export function filterSubscriberReplies(threads: CapturedReply[]): FilterResult {
  const replies = threads
    .filter((t) => looksLikeSubscriberReply({ subject: t.subject, from: t.from }))
    .map((t) => ({
      ...t,
      trivial: isTrivialReply(stripQuotedAndSignature(t.body)),
    }));
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
    const trivialCount = result.replies.filter((r) => r.trivial).length;
    const draftable = result.replies.filter((r) => !r.trivial);
    console.error(
      `\n📬 ${result.replies.length} de ${result.total} thread(s) são respostas de assinante — rascunhar resposta pessoal (NUNCA enviar):`,
    );
    for (const r of draftable) {
      console.error(`  ${r.from} — "${(r.subject ?? "").slice(0, 60)}"`);
    }
    // #4095: reply trivial (só saudação/agradecimento/emoji, sem substância)
    // aparece agregada numa linha — não gera rascunho, mas não some em
    // silêncio (decisão do editor: recomendação da própria issue #4095).
    if (trivialCount > 0) {
      console.error(`  ⚪ ${trivialCount} resposta(s) trivial(is) ignorada(s) (sem rascunho)`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
