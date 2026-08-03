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
 * #4324: reply a e-mail de AUTOMAÇÃO da Beehiiv (ex: o boas-vindas, que pede
 * explicitamente "responda com um oi" como truque de entregabilidade) é
 * excluída TOTALMENTE de `replies[]` — diferente de `trivial` acima, aqui não
 * há rascunho pulado nem crédito de concurso a checar: quem responde ao
 * boas-vindas ainda não recebeu edição nenhuma, então atribuí-lo a uma edição
 * seria sempre falso. Detecção por ASSUNTO normalizado (`normalizeSubject`)
 * contra uma lista pequena de assuntos de automação conhecidos
 * (`AUTOMATED_SUBJECTS` — adicionar um novo é uma linha). O total excluído é
 * reportado em `automatedSubjectCount` — nunca some em silêncio (mesmo
 * princípio do #4095).
 *
 * #4509: essa blacklist só bate enquanto a publicação/automação Beehiiv não
 * for renomeada (#4424 rebrand "Diar.ia" → "diar.ia.br") — no dia em que
 * isso acontecer, a comparação exata para de bater SEM erro nem log. Fix:
 * `possibleStaleAutomatedSubjects` (`FilterResult`) sinaliza (nunca exclui)
 * candidatos cujo assunto "parece" o boas-vindas (`WELCOME_SUBJECT_HINT_RE`
 * — contém a palavra "bem-vindo", que sobrevive à troca de marca) mas não
 * bateu a blacklist exata — `main()` emite um warning quando isso acontece.
 *
 * Uso:
 *   npx tsx scripts/filter-subscriber-replies.ts --in captured-replies.json
 *
 * Input: JSON array de { thread_id, from, subject, date?, body? }.
 * Output JSON: { total, replies: CapturedReply[], automatedSubjectCount } (cada reply com `trivial`).
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

/**
 * #4324: prefixo de resposta/encaminhamento a remover (repetidamente) do
 * assunto antes de comparar contra a lista de automações. Superset de
 * `REPLY_PREFIX_RE` — inclui `Fwd:`/`Enc:` porque, pra fins de NORMALIZAÇÃO de
 * assunto, um "Fwd: Bem-vindo(a) à Diar.ia!" deve casar igual a um "Re:"
 * (a exclusão aqui é sobre o e-mail de automação em si, não sobre se é
 * resposta ou encaminhamento — `looksLikeSubscriberReply` já decidiu isso
 * antes de `isAutomatedSubject` ser chamado).
 */
const SUBJECT_PREFIX_STRIP_RE = /^\s*(?:re|res|fwd|enc)\s*(?:\[\d+\])?\s*:\s*/i;

/** Remove diacríticos (á→a, ã→a, ç→c, …) preservando o restante do texto. */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * #4324: normaliza um assunto pra comparação contra `AUTOMATED_SUBJECTS` —
 * remove prefixos `Re:`/`Res:`/`Fwd:`/`Enc:` repetidos (qualquer quantidade,
 * em qualquer combinação), minúsculas, sem acento, espaços de borda
 * colapsados. Pura, nunca lança; assunto ausente → `""`.
 */
export function normalizeSubject(subject: string | undefined | null): string {
  let s = (subject ?? "").trim();
  let prev: string;
  do {
    prev = s;
    s = s.replace(SUBJECT_PREFIX_STRIP_RE, "").trim();
  } while (s !== prev);
  return stripAccents(s.toLowerCase()).replace(/\s+/g, " ").trim();
}

/**
 * #4324: assuntos de e-mails de AUTOMAÇÃO da Beehiiv cuja resposta nunca deve
 * virar rascunho nem entrar na resolução de edição/matcher do concurso "ache o
 * erro" — a exclusão é total (ver docstring do módulo), diferente de
 * `trivial`. Comparados via `normalizeSubject`, então cada entry aqui cobre
 * qualquer variação de prefixo Re:/Res:/Fwd:/Enc:, caixa e acento.
 *
 * Blacklist de propósito (decisão da issue #4324): assuntos de EDIÇÃO variam
 * por teste A/B — uma whitelist descartaria retorno legítimo em silêncio.
 *
 * Adicionar uma nova automação é UMA LINHA aqui.
 */
const AUTOMATED_SUBJECTS = [
  "Bem-vindo(a) à Diar.ia!", // atual
  "Bem-vindo à Diar.ia!", // usado até ~2026-07-09, sem o "(a)"
];
const AUTOMATED_SUBJECTS_NORMALIZED = new Set(AUTOMATED_SUBJECTS.map(normalizeSubject));

/**
 * #4509: sinal ESTRUTURAL de "quase bateu" a blacklist exata acima — o
 * assunto normalizado contém a palavra "bem-vindo" (sobrevive a uma troca
 * de MARCA na publicação/automação Beehiiv, ex: #4424 renomeando "Diar.ia"
 * pra "diar.ia.br" — a saudação de boas-vindas tende a preservar essa
 * palavra mesmo quando o nome da marca no resto do assunto muda), mas o
 * texto INTEIRO não bate nenhuma entry de `AUTOMATED_SUBJECTS`.
 *
 * NUNCA usado pra EXCLUIR nada — a blacklist exata continua sendo a única
 * fonte de verdade pra exclusão de `replies[]` (decisão #4324: inferir por
 * substring arriscaria excluir retorno legítimo, ex: assinante que
 * literalmente escreve "bem-vindo" numa resposta de verdade). Só alimenta
 * `possibleStaleAutomatedSubjects` (`FilterResult`) pra o warning em
 * `main()` — sem isso, o dia em que o rename acontecer (#4424), o filtro do
 * #4324 pararia de bater 100% em silêncio (achado #4509).
 */
const WELCOME_SUBJECT_HINT_RE = /\bbem-?vindo\b/;

/**
 * #4509: `true` quando o assunto (já normalizado por `normalizeSubject`),
 * despojado de qualquer pontuação/hífen, ainda contém o fragmento "diaria" —
 * tanto "Diar.ia" (marca atual) quanto "diar.ia.br" (marca pós-rebrand
 * #4424) colapsam pra esse mesmo fragmento assim que period/hífen somem.
 * Usado SÓ pra reduzir falso-positivo do near-miss (evita marcar o
 * boas-vindas de OUTRA newsletter na mesma caixa pessoal, ex: "Bem-vindo ao
 * AYA Books", como suspeito — esse assunto não contém "diaria" nenhuma) —
 * nunca pra excluir replies (`isAutomatedSubject`/`AUTOMATED_SUBJECTS`
 * continuam a única fonte de exclusão real).
 */
function hasOwnBrandFragment(normalizedSubject: string): boolean {
  return normalizedSubject.replace(/[^a-z0-9]/g, "").includes("diaria");
}

/**
 * `true` se o assunto (normalizado) casa com um e-mail de automação conhecido
 * da Beehiiv (ex: o boas-vindas). Compara o assunto INTEIRO normalizado —
 * `"Re: Bem-vindo ao AYA Books"` (outra newsletter, mesma caixa) nunca casa
 * porque o texto normalizado difere de qualquer entry de `AUTOMATED_SUBJECTS`
 * (a âncora em "diar.ia" vem de cada entry conhecida já conter o nome da
 * publicação, não de um teste de substring separado).
 */
export function isAutomatedSubject(subject: string | undefined | null): boolean {
  return AUTOMATED_SUBJECTS_NORMALIZED.has(normalizeSubject(subject));
}

export interface FilterResult {
  total: number;
  replies: CapturedReply[];
  /**
   * #4324: quantas threads que passariam no filtro de assinante (Re: +
   * remetente humano) foram excluídas por casar um assunto de automação da
   * Beehiiv (ex: reply ao boas-vindas) — excluídas de `replies[]` por
   * completo, antes de qualquer resolução de edição/matcher do concurso.
   * Reportado agregado pelo consumidor (nunca some em silêncio).
   */
  automatedSubjectCount: number;
  /** #4509: candidatos (Re: + remetente humano) cujo assunto "parece" ser o
   * boas-vindas (contém "bem-vindo" E o fragmento de marca "diaria" —
   * `WELCOME_SUBJECT_HINT_RE` + `hasOwnBrandFragment`) mas NÃO bateu a
   * blacklist exata de `AUTOMATED_SUBJECTS` — sinal indireto de que o
   * rename da publicação/automação Beehiiv (#4424) tornou a blacklist
   * obsoleta. Assuntos brutos (não normalizados), pra o warning de `main()`
   * mostrar o texto real que precisa virar uma nova entry. `[]` no caso
   * comum (nenhum near-miss). NUNCA exclui nada de `replies[]` — só
   * sinaliza.
   */
  possibleStaleAutomatedSubjects: string[];
}

export function filterSubscriberReplies(threads: CapturedReply[]): FilterResult {
  const candidates = threads.filter((t) => looksLikeSubscriberReply({ subject: t.subject, from: t.from }));
  const automatedSubjectCount = candidates.filter((t) => isAutomatedSubject(t.subject)).length;
  // #4509: near-miss ANTES do filtro final — roda sobre os mesmos candidatos
  // que alimentam automatedSubjectCount, nunca sobre `replies` (que já
  // excluiu os automáticos exatos).
  const possibleStaleAutomatedSubjects = candidates
    .filter((t) => {
      if (isAutomatedSubject(t.subject)) return false;
      const normalized = normalizeSubject(t.subject);
      return WELCOME_SUBJECT_HINT_RE.test(normalized) && hasOwnBrandFragment(normalized);
    })
    .map((t) => t.subject ?? "");
  const replies = candidates
    .filter((t) => !isAutomatedSubject(t.subject))
    .map((t) => ({
      ...t,
      trivial: isTrivialReply(stripQuotedAndSignature(t.body)),
    }));
  return { total: threads.length, replies, automatedSubjectCount, possibleStaleAutomatedSubjects };
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
  // #4324: reply ao e-mail de automação da Beehiiv (ex: boas-vindas) é
  // excluída de replies[] por completo — reportada aqui mesmo quando
  // result.replies está vazio (cenário: toda thread capturada era boas-vindas).
  if (result.automatedSubjectCount > 0) {
    console.error(
      `  📧 ${result.automatedSubjectCount} resposta(s) ao e-mail de boas-vindas ignorada(s)`,
    );
  }
  // #4509: near-miss — assunto "parece" boas-vindas mas não bateu a
  // blacklist EXATA. Sinal indireto (não dependente de histórico) de que o
  // rename do workspace/automação Beehiiv (#4424) pode ter tornado
  // AUTOMATED_SUBJECTS obsoleta — nunca deixar essa quebra 100% silenciosa.
  if (result.possibleStaleAutomatedSubjects.length > 0) {
    console.error(
      `  ⚠️  AVISO: ${result.possibleStaleAutomatedSubjects.length} resposta(s) com assunto parecido com o ` +
        "boas-vindas, mas que NÃO bateu a blacklist exata (AUTOMATED_SUBJECTS em filter-subscriber-replies.ts) — " +
        "possível sinal de que o workspace/automação Beehiiv foi renomeado (#4424) e o filtro do #4324 parou de " +
        `bater. Assunto(s): ${result.possibleStaleAutomatedSubjects.map((s) => `"${s}"`).join(", ")}`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
