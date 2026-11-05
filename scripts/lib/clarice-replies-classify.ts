/**
 * clarice-replies-classify.ts (#12227) — miolo PURO da triagem das respostas à
 * newsletter Clarice News ("Notícias do mês sobre IA", reply-to
 * `pixel@diar.ia.br`).
 *
 * Classifica cada resposta por regras de texto (sem LLM) em 5 tipos:
 *   - `quero`   — resposta ao CTA de prioridade → `priority_optin` (+40);
 *   - `saida`   — pedido de descadastro/exclusão (LGPD incluída) → blacklist
 *                 na Brevo da Clarice + supressão imediata no store. Quando o
 *                 texto pede também exclusão de DADOS, `data_deletion: true`
 *                 (tratada à mão pelo editor, só listada);
 *   - `suporte` — assunto do produto Clarice (cancelar compra, reembolso,
 *                 "dados do projeto", acesso) → lista de encaminhamento;
 *   - `ruido`   — resposta automática (férias/ausência), remetente de sistema
 *                 ou corpo vazio → nenhuma ação;
 *   - `ambiguo` — nenhuma regra casou, ou regras em conflito → pendente, sem
 *                 ação.
 *
 * Decisão do editor (05/11/2026, registrada na issue): triagem ASSISTIDA. Este
 * módulo só classifica e monta o plano; quem aplica é
 * `scripts/clarice-replies-triage.ts --apply --confirm {lote}`, depois que o
 * editor viu o plano. Na dúvida a regra cai em `ambiguo` (nunca aplica ação
 * por palpite).
 */

import { createHash } from "node:crypto";

export type ReplyKind = "quero" | "saida" | "suporte" | "ruido" | "ambiguo";

/** Uma resposta já extraída da caixa (forma independente do Gmail). */
export interface ReplyMessage {
  message_id: string;
  thread_id: string;
  /** Endereço do remetente, já sem nome (`Fulano <a@b>` → `a@b`). */
  from: string;
  from_name?: string;
  subject: string;
  /** ISO 8601. */
  date: string;
  /** Corpo em texto puro (com citação; o classificador remove). */
  body: string;
  /** Headers relevantes pra detectar resposta automática (nomes em minúsculas). */
  headers?: Record<string, string>;
}

export interface ReplyClassification {
  kind: ReplyKind;
  reason: string;
  data_deletion: boolean;
  /** Texto da resposta sem citação/assinatura (o que foi classificado). */
  cleaned: string;
}

// ---------------------------------------------------------------------------
// Normalização e remoção de citação
// ---------------------------------------------------------------------------

/** minúsculas, sem acento, espaços colapsados. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[ \t ]+/g, " ");
}

/**
 * Remove a parte citada do e-mail original e a assinatura: corta no 1º
 * marcador de citação ("Em ... escreveu:", "On ... wrote:", "-----Original
 * Message-----", bloco "De:/From:" do Outlook, linha de sublinhados) e
 * descarta linhas `>` e "Enviado do meu iPhone"/"Sent from my ...".
 */
/** Rodapé fixo da newsletter (ver `stripQuoted`). */
const FOOTER_CUT_RES: RegExp[] = [
  /^[ \t]*caso n[aã]o queira receber (a|esta|essa) newsletter\b/im,
  /^[ \t]*voc[eê] est[aá] recebendo (esse|este) e-?mail porque\b/im,
];

export function stripQuoted(body: string): string {
  let text = body.replace(/\r\n?/g, "\n");
  const cutPatterns: RegExp[] = [
    // Gmail/Yahoo pt-BR/en: a atribuição pode quebrar em até 3 linhas. A linha do "Em/On" precisa ter
    // um dígito (data/hora), senão "Em primeiro lugar…\n…\nMeu chefe escreveu:" cortava o texto do assinante (re-review #12261).
    // As linhas de continuação não podem ser vazias: a atribuição é um bloco contíguo (re-review #12261).
    /^[ \t]*(em|on)[ \t][^\n]*\d[^\n]*(\n(?=[ \t]*\S)[^\n]*){0,3}?\b(escreveu|wrote)[ \t]*:/im,
    /^[ \t]*-{2,}[ \t]*(original message|mensagem original)[ \t]*-{2,}/im,
    /^[ \t]*_{10,}[ \t]*$/m,
    // Outlook (inclusive Mac): `De:` seguido de até 4 linhas `Campo:` (Responder a, Para, Assunto) antes de Enviado/Data (review da PR #12261).
    /^[ \t]*(de|from)[ \t]*:[^\n]*\n(?:[ \t]*[^\n:]{1,30}:[^\n]*\n){0,4}?[ \t]*(enviad[ao]|sent|data|date)[ \t]*:/im,
    // Rodapé fixo da própria newsletter, se a citação vazou sem marcador. Ancorado no INÍCIO da linha e
    // na frase do rodapé: o assinante citando essa frase no meio do próprio texto não é cortado (re-review #12261).
    ...FOOTER_CUT_RES,
    /^-- ?$/m, // delimitador de assinatura
  ];
  for (const re of cutPatterns) {
    let m: RegExpExecArray | null;
    if (re === cutPatterns[0]) {
      // Atribuição de verdade traz o endereço do remetente (`<ti@clarice.ai>`); sem `@`, "Em 05/11 a
      // Clarice escreveu: …" é texto do próprio assinante: pula essa e procura a próxima (re-review #12261).
      const g = new RegExp(re.source, "gim");
      m = null;
      for (let c = g.exec(text); c; c = g.exec(text)) {
        if (c[0].includes("@")) { m = c; break; }
        g.lastIndex = c.index + 1;
      }
    } else {
      m = re.exec(text);
    }
    if (m) text = text.slice(0, m.index);
  }
  return text
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .filter((l) => !/^\s*(enviado d[eo] (meu|minha)|sent from my|obter o outlook)/i.test(l))
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------

/** Remetentes que nunca são assinante respondendo (sistema ou nós mesmos). */
const SYSTEM_SENDER_RE =
  /^(mailer-daemon|postmaster|no-?reply|noreply|do-?not-?reply|bounce[s]?)@|@(diar\.ia\.br|clarice\.ai)$/i;

const AUTO_SUBJECT_RE =
  /^\s*(resposta autom[aá]tica|automatic reply|auto(matic)?[- ]?reply|out of (the )?office|aus[eê]ncia|fora do escrit[oó]rio|f[eé]rias|autoreply|respuesta autom[aá]tica|undeliverable|delivery status notification|n[aã]o entregue)/i;

const AUTO_BODY_RE =
  /\b(estou (de|em) ferias|estarei (de|em) ferias|estou fora do escritorio|estarei fora|estou ausente|estarei ausente|retorno (no dia|em|a partir)|resposta automatica|mensagem automatica|i am (currently )?out of (the )?office|i will be out of)\b/;

/** Pedido de exclusão de DADOS (LGPD) — também conta como saída. */
const DATA_DELETION_RES: RegExp[] = [
  // "lgpd" sozinho é menção, não pedido ("a Clarice está adequada à LGPD?", review da PR #12261): exige verbo de pedido/exclusão perto.
  /\b(exclu|apag|delet|remov|elimin|solicit|pe[cç]o|requeir|requer|exij|exerc)\w*\b[^.!?\n]{0,40}\blgpd\b/,
  /\blgpd\b[^.!?\n]{0,40}\b(exclu|apag|delet|remov|elimin)\w*/,
  /\b(exclu|apag|delet|remov|elimin)\w*\b[^.!?\n]{0,30}\b(meus|todos os meus|os meus) dados\b/,
  /\bexclusao (dos |de )?(meus )?dados\b/,
  /\bdireito ao esquecimento\b/,
];

const SAIDA_RES: RegExp[] = [
  /\bdescadastr/,
  /\bunsubscribe\b/,
  /\b(sair|ser removid[oa]|ser retirad[oa]|ser excluid[oa]) d[ae] (sua |vossa )?(lista|newsletter|mailing|base)\b/,
  /\bquero sair\b/,
  /\b(me )?(tire|tira|tirar|tirem|retire|retirar|retirem|remova|removam|remove|remover|exclua|excluam|excluir|apague|apaguem|apagar|delete|deletar)\b[^.!?\n]{0,40}\b(lista|newsletter|mailing|e-?mails?|cadastro|base|contatos?|envios?)\b/,
  // "não preciso receber com prioridade" recusa o CTA do "quero", não pede saída (review da PR #12261).
  /\bnao (quero|desejo|gostaria de|preciso) (mais )?receber\b(?![^.!?\n]{0,30}\bprioridade\b)/,
  /\b(parar|pare|parem|deixar) de (me )?(receber|enviar|mandar)\b/,
  /\bnao (me )?(envie|enviem|mande|mandem) mais\b/,
  /\bcancel\w* (a |minha )?(inscricao|newsletter)\b/,
];

const SUPORTE_RES: RegExp[] = [
  /\bcancel\w* (a |o |minha |meu )?(compra|assinatura|plano|pagamento|cobranca|renovacao|conta)\b/,
  /\b(reembolso|estorno|cobranca|cobrad[oa]|fatura|nota fiscal|boleto|cartao de credito)\b/,
  /\bdados do projeto\b/,
  /\b(senha|nao consigo (acessar|entrar|logar)|acesso a (minha )?conta|meu login)\b/,
  /\b(suporte|atendimento)\b/,
];

/** `quero`/`sim` SEM ser "não quero" nem "quero sair/cancelar/que me tire". */
const QUERO_RE =
  /\b(eu )?(quero|queremos|tenho interesse|me inclua|pode me incluir|aceito|com certeza)\b(?! (sair|cancelar|me descadastrar|descadastr|ser (removid|excluid|retirad)|que (me )?(tire|remova|exclua|retire|apague)|parar|deixar de))/;
const QUERO_NEGADO_RE = /\bnao (\w+ )?(quero|tenho interesse|aceito)\b/;
const SIM_SOZINHO_RE = /^\W*(sim|s)\W*(,?\W*(obrigad[oa]|valeu))?\W*$/;

/** "quero" acima disso é texto de conversa, não a resposta curta ao CTA. */
export const QUERO_MAX_CHARS = 200;

function anyMatch(res: RegExp[], text: string): boolean {
  return res.some((re) => re.test(text));
}

function isAutoReply(msg: ReplyMessage, normBody: string): string | null {
  const h = msg.headers ?? {};
  const autoSubmitted = (h["auto-submitted"] ?? "").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return `header Auto-Submitted: ${autoSubmitted}`;
  if (h["x-autoreply"] || h["x-autorespond"]) return "header X-Autoreply";
  const precedence = (h["precedence"] ?? "").toLowerCase();
  if (/^(auto_reply|bulk|junk)$/.test(precedence)) return `header Precedence: ${precedence}`;
  if (AUTO_SUBJECT_RE.test(msg.subject)) return "assunto de resposta automática";
  if (AUTO_BODY_RE.test(normBody)) return "texto de resposta automática (férias/ausência)";
  return null;
}

export function classifyReply(msg: ReplyMessage): ReplyClassification {
  const cleaned = stripQuoted(msg.body);
  const norm = normalizeText(cleaned).trim();
  const out = (kind: ReplyKind, reason: string, data_deletion = false): ReplyClassification => ({
    kind,
    reason,
    data_deletion,
    cleaned,
  });

  if (SYSTEM_SENDER_RE.test(msg.from.trim())) return out("ruido", `remetente de sistema/próprio (${msg.from})`);
  const auto = isAutoReply(msg, norm);
  if (auto) return out("ruido", auto);
  if (norm.replace(/\W/g, "") === "") {
    // O corte pelo rodapé apagou a 1ª linha do próprio assinante (ele abriu a resposta com a frase do
    // rodapé): pode ter levado o pedido junto. Fica pendente, nunca some como ruído (re-review #12261).
    // Resposta só com citação (1ª linha = atribuição ou `>`) segue ruído.
    const firstLine = msg.body.replace(/\r\n?/g, "\n").split("\n").find((l) => l.trim() !== "") ?? "";
    if (FOOTER_CUT_RES.some((re) => re.test(firstLine))) return out("ambiguo", "o corte do rodapé removeu todo o texto — revisar o corpo");
    return out("ruido", "resposta vazia (só citação)");
  }

  const dataDeletion = anyMatch(DATA_DELETION_RES, norm);
  const saida = dataDeletion || anyMatch(SAIDA_RES, norm);
  const suporte = anyMatch(SUPORTE_RES, norm);
  const quero = (QUERO_RE.test(norm) && !QUERO_NEGADO_RE.test(norm)) || SIM_SOZINHO_RE.test(norm);

  if (saida && suporte) return out("ambiguo", "saída e suporte na mesma resposta", dataDeletion);
  if (saida && quero) return out("ambiguo", "saída e \"quero\" na mesma resposta", dataDeletion);
  if (saida)
    return out("saida", dataDeletion ? "pedido de exclusão de dados (LGPD)" : "pedido de saída da lista", dataDeletion);
  if (suporte && quero) return out("ambiguo", "suporte e \"quero\" na mesma resposta");
  if (suporte) return out("suporte", "assunto de suporte da Clarice");
  if (quero) {
    if (norm.length > QUERO_MAX_CHARS) return out("ambiguo", `"quero" num texto longo (${norm.length} chars)`);
    return out("quero", "resposta ao CTA de prioridade");
  }
  return out("ambiguo", "nenhuma regra casou");
}

// ---------------------------------------------------------------------------
// Plano do lote
// ---------------------------------------------------------------------------

export interface TriageItem {
  message_id: string;
  thread_id: string;
  email: string;
  from_name?: string;
  subject: string;
  date: string;
  kind: ReplyKind;
  reason: string;
  data_deletion: boolean;
  snippet: string;
}

export interface TriageActions {
  /** Emails que ganham `priority_optin`. */
  optin: string[];
  /** Emails que vão pra blacklist da Brevo + supressão no store. */
  saida: string[];
  /** Subconjunto de `saida` que também pediu exclusão de dados — tratado à mão. */
  data_deletion: string[];
  /** Respostas a encaminhar à Clarice (o script nunca encaminha sozinho). */
  suporte: Array<{ email: string; subject: string; date: string; thread_id: string; snippet: string }>;
  /** Ambíguos — ficam sem ação. */
  pendentes: Array<{ email: string; reason: string; thread_id: string; snippet: string }>;
  /** Emails com quero E saída em mensagens diferentes: a saída prevalece. */
  conflitos: string[];
}

export interface TriageApplyState {
  optin_done: string[];
  saida_store_done: string[];
  saida_brevo_done: string[];
  failures: Array<{ email: string; step: "brevo" | "store" | "optin"; error: string }>;
  last_applied_at: string | null;
}

export interface TriagePlan {
  schema: 1;
  batch_id: string;
  created_at: string;
  query: string | null;
  counts: Record<ReplyKind, number>;
  items: TriageItem[];
  actions: TriageActions;
  applied: TriageApplyState;
}

export function emptyApplyState(): TriageApplyState {
  return { optin_done: [], saida_store_done: [], saida_brevo_done: [], failures: [], last_applied_at: null };
}

function snippetOf(s: string, max = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/**
 * id do lote = hash dos pares (message_id, kind) ordenados. Determinístico:
 * listar de novo a mesma caixa dá o mesmo id (o plano anterior e seu estado
 * de aplicação são preservados); qualquer resposta nova muda o id, e o
 * `--confirm` antigo deixa de valer.
 */
export function computeBatchId(items: Array<Pick<TriageItem, "message_id" | "kind"> & { email?: string }>): string {
  // O e-mail entra na chave (review da PR #12261): com `--input`, dois exports com os mesmos ids e
  // classes mas remetentes diferentes davam o mesmo lote, e o `--apply` aplicaria a ação de outra pessoa.
  const key = items
    .map((i) => `${i.message_id}:${i.kind}:${(i.email ?? "").toLowerCase()}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export function buildTriagePlan(
  messages: ReplyMessage[],
  opts: { now?: string; query?: string | null } = {},
): TriagePlan {
  const seen = new Set<string>();
  const items: TriageItem[] = [];
  for (const m of messages) {
    if (seen.has(m.message_id)) continue;
    seen.add(m.message_id);
    const c = classifyReply(m);
    items.push({
      message_id: m.message_id,
      thread_id: m.thread_id,
      email: m.from.trim().toLowerCase(),
      ...(m.from_name ? { from_name: m.from_name } : {}),
      subject: m.subject,
      date: m.date,
      kind: c.kind,
      reason: c.reason,
      data_deletion: c.data_deletion,
      snippet: snippetOf(c.cleaned || m.body),
    });
  }
  items.sort((a, b) => a.date.localeCompare(b.date));

  const counts: Record<ReplyKind, number> = { quero: 0, saida: 0, suporte: 0, ruido: 0, ambiguo: 0 };
  for (const i of items) counts[i.kind]++;

  const queroSet = new Set(items.filter((i) => i.kind === "quero").map((i) => i.email));
  const saidaSet = new Set(items.filter((i) => i.kind === "saida").map((i) => i.email));
  const conflitos = [...queroSet].filter((e) => saidaSet.has(e)).sort();
  const actions: TriageActions = {
    optin: [...queroSet].filter((e) => !saidaSet.has(e)).sort(),
    saida: [...saidaSet].sort(),
    data_deletion: [...new Set(items.filter((i) => i.kind === "saida" && i.data_deletion).map((i) => i.email))].sort(),
    suporte: items
      .filter((i) => i.kind === "suporte")
      .map((i) => ({ email: i.email, subject: i.subject, date: i.date, thread_id: i.thread_id, snippet: i.snippet })),
    pendentes: items
      .filter((i) => i.kind === "ambiguo")
      .map((i) => ({ email: i.email, reason: i.reason, thread_id: i.thread_id, snippet: i.snippet })),
    conflitos,
  };

  return {
    schema: 1,
    batch_id: computeBatchId(items),
    created_at: opts.now ?? new Date().toISOString(),
    query: opts.query ?? null,
    counts,
    items,
    actions,
    applied: emptyApplyState(),
  };
}

// ---------------------------------------------------------------------------
// Gmail REST → ReplyMessage (puro: recebe o JSON de `messages/{id}?format=full`)
// ---------------------------------------------------------------------------

interface GmailPartLike {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPartLike[];
  headers?: Array<{ name: string; value: string }>;
}

export interface GmailMessageLike {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: GmailPartLike;
}

function decodeB64Url(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function findPart(part: GmailPartLike | undefined, mime: string): string {
  if (!part) return "";
  if (part.mimeType === mime && part.body?.data) return decodeB64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const t = findPart(child, mime);
    if (t) return t;
  }
  return "";
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, "\n")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** `Fulano <a@b.com>` → { email: "a@b.com", name: "Fulano" }. */
export function parseFromHeader(value: string): { email: string; name?: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (m) {
    const name = m[1].trim();
    return { email: m[2].trim().toLowerCase(), ...(name ? { name } : {}) };
  }
  return { email: value.trim().toLowerCase() };
}

export function gmailMessageToReply(msg: GmailMessageLike): ReplyMessage {
  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  const from = parseFromHeader(headers["from"] ?? "");
  const ms = Number(msg.internalDate);
  const date = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "";
  const plain = findPart(msg.payload, "text/plain");
  const body = plain || htmlToText(findPart(msg.payload, "text/html"));
  return {
    message_id: msg.id,
    thread_id: msg.threadId,
    from: from.email,
    ...(from.name ? { from_name: from.name } : {}),
    subject: headers["subject"] ?? "",
    date,
    body,
    headers,
  };
}
