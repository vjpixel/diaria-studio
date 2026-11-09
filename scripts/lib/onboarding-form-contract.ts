/**
 * onboarding-form-contract.ts (#10605)
 *
 * CONTRATO do formulário de perfil/interesses do onboarding — decisão do
 * editor (briefing do overnight 261020): formulário PRÓPRIO num Worker nosso
 * (custo zero, dados nossos, `?email=` pré-preenchido pela merge tag do Kit).
 * Puro e sem dependência de Node: importado pelo Worker
 * (`workers/onboarding-form/src/index.ts` e `src/render.ts`), pelo executor
 * das sequências (`scripts/onboarding-followup-run.ts`, que marca "preencheu")
 * e pela regeneração do perfil de audiência (`scripts/audience-run.ts` via
 * `scripts/lib/audience-survey-questions.ts`), pra os três lados nunca
 * divergirem sobre o formato.
 *
 * ## Endpoints do Worker
 *
 *  - `GET  /?email={e-mail}&sig={assinatura}` — página do formulário para
 *    aquele e-mail (fixo, em campo oculto). Sem assinatura válida: página de
 *    link inválido (#10657, `onboarding-form-link-sig.ts`).
 *  - `POST /enviar` (form-urlencoded) — exige a assinatura do e-mail enviado
 *    (senão 403, nada gravado); valida com `parseFormSubmission` e grava a
 *    resposta (KV, chave `resp:{email normalizado}`; a última resposta vence).
 *  - `GET  /api/respostas` com `Authorization: Bearer {token}` — lista as
 *    respostas no formato `FormResponsesPayload` (a mais recente por pessoa).
 *    É o que o executor lê a cada rodada para marcar "preencheu" no store e
 *    parar os lembretes. Com `?historico=1` (#12490) lista TODAS as respostas
 *    guardadas (`hist:`), uma por envio, para comparar um ano com o outro.
 *    Paginado desde o #12509: cada chamada devolve até
 *    `FORM_RESPONSES_PAGE_SIZE` respostas e `next_cursor` (repassar como
 *    `?cursor=`); quem lê usa `fetchAllFormResponses`. Falha do KV = 503 com
 *    `{error: "kv_failure", reason}`.
 *
 * ## Perguntas (v2, decisões do editor de 08/11/2026)
 *
 * Duas frentes: (1) perfil e interesses, para as notícias refletirem o
 * público; (2) sondagem de produto (que cursos, aulas, guias ou mentorias
 * oferecer). Decisões do editor (/diaria-develop 261108): nível sem jargão;
 * conteúdo perguntado pelas SEÇÕES da newsletter; foco em B2C (preço só por
 * faixas, sem "quem pagaria"; o único sinal B2B é a opção "Treinamento para a
 * equipe da empresa onde trabalho"); tema e preço somem quando a pessoa marca
 * "Nada disso" no que ela faria além da newsletter (`hiddenWhen`); sem
 * pergunta de ferramentas nem de porte de empresa; só nível e área são
 * obrigatórias. Depois das seções, uma pergunta opcional sobre o que a pessoa
 * faz quando o link abre em inglês (`leitura_ingles`, decisão do editor de
 * 08/11/2026). O envio segue travado pelo marcador de texto pendente
 * (`formContentGate`) até o editor aprovar o texto final.
 *
 * Desde a decisão 10 do editor (08/11/2026) o perfil de audiência sai SÓ
 * deste formulário: as respostas da survey antiga da Beehiiv (e do Tally)
 * foram descartadas. Cada pergunta casa com exatamente um matcher de
 * `scripts/lib/audience-survey-questions.ts`, travado por
 * `test/onboarding-form-questions-10605.test.ts`: mudar o rótulo sem mexer no
 * matcher tiraria a pergunta do perfil em silêncio.
 */

interface FormQuestionBase {
  /** Chave da resposta (`answers[id]`) — estável, sem espaço. */
  id: string;
  label: string;
  required?: boolean;
  /** Linha de ajuda curta abaixo do rótulo. */
  help?: string;
  /**
   * Pergunta escondida quando a pessoa marca `option` na pergunta `questionId`
   * (um `checkbox` que vem ANTES desta na lista). Escondida, a resposta é
   * tratada como ausente: o cliente desabilita os campos e o servidor
   * descarta o que vier (`parseFormSubmission`). Nunca combina com `required`.
   */
  hiddenWhen?: { questionId: string; option: string };
}

/** Pergunta de escolha: `select` = uma opção; `checkbox` = várias (gravadas
 *  numa string só, separadas por `FORM_MULTI_SEPARATOR`). */
export interface ChoiceQuestion extends FormQuestionBase {
  kind: "select" | "checkbox";
  options: readonly string[];
  /** Só `checkbox`: opção que não pode ser marcada junto com outras
   *  (ex.: "Nada disso"). Precisa estar em `options`. */
  exclusiveOption?: string;
}

/** Pergunta aberta, sempre texto livre truncado em `FORM_ANSWER_MAX_LEN`. */
export interface OpenQuestion extends FormQuestionBase {
  kind: "text" | "textarea";
}

export type FormQuestion = ChoiceQuestion | OpenQuestion;

export function isChoiceQuestion(q: FormQuestion): q is ChoiceQuestion {
  return q.kind === "select" || q.kind === "checkbox";
}

/** Separador das opções marcadas numa pergunta `checkbox`, dentro da string
 *  única de `answers[id]`. Nenhuma opção pode conter este texto (teste). */
export const FORM_MULTI_SEPARATOR = " | ";

/** Opção de `produto_formato` que esconde tema e preço (decisão 5 do editor). */
export const FORM_NADA_DISSO = "Nada disso, a newsletter já me basta";

/** v2 (#10605, decisões do editor de 08/11/2026). */
export const FORM_QUESTIONS: readonly FormQuestion[] = [
  {
    id: "nivel_ia",
    label: "Qual seu nível de conhecimento em IA?",
    kind: "select",
    required: true,
    options: [
      "Estou começando: uso IA de vez em quando",
      "Uso ChatGPT ou parecidos para tarefas simples todo dia",
      "Entendo como a IA funciona e acompanho as novidades",
      "Consigo usar um modelo por API ou preparar dados para ele",
      "Trabalho com IA: ajusto modelos ou planejo como uma empresa vai usar IA",
    ],
  },
  {
    id: "area",
    label: "Qual sua principal área de atuação?",
    kind: "select",
    required: true,
    options: [
      "Engenharia/Software/Dados/TI",
      "Contabilidade/Bancos/Finanças",
      "Pesquisa/Academia/Educação",
      "Administrativo/Escritório",
      "Marketing/Relações Públicas/Mídia/Conteúdo",
      "Gerenciamento de Produtos/Projetos",
      "Saúde/Biotecnologia/Farmacêutico",
      "Fundador(a) / Empreendedor(a)",
      "Jurídico",
      "RH",
      "Vendas",
      "Atendimento ao Cliente/Suporte Técnico",
      "Design/Criação",
      "Operações",
      "Estudante",
      "Outra",
    ],
  },
  {
    id: "conteudo",
    label: "Quais seções da newsletter você mais gosta de ler?",
    kind: "checkbox",
    help: "Pode marcar mais de uma.",
    options: [
      "Destaques (as notícias principais do dia, com contexto)",
      "Lançamentos (ferramentas e modelos novos)",
      "Use Melhor (dicas e tutoriais práticos)",
      "Radar (outras notícias, em poucas linhas)",
      "É IA? (o jogo de adivinhar se a imagem é de IA)",
    ],
  },
  {
    id: "leitura_ingles",
    label: "Quando você abre um link da diar.ia.br e o texto está em inglês, o que costuma fazer?",
    kind: "select",
    options: [
      "Leio normalmente",
      "Leio com o tradutor do navegador ou do celular",
      "Continuo só se o assunto me interessar muito",
      "Fecho e sigo para o próximo",
    ],
  },
  {
    id: "produto_formato",
    label: "Além da newsletter, o que você teria interesse em fazer com a diar.ia.br?",
    kind: "checkbox",
    help: "Pode marcar mais de um.",
    options: [
      "Curso online gravado, no meu ritmo",
      "Aula ou workshop ao vivo",
      "Mentoria individual ou em grupo pequeno",
      "Treinamento para a equipe da empresa onde trabalho",
      "Guias e modelos prontos (prompts, fluxos de trabalho)",
      "Comunidade para trocar experiências com outros leitores",
      FORM_NADA_DISSO,
    ],
    exclusiveOption: FORM_NADA_DISSO,
  },
  {
    id: "produto_tema",
    label: "Sobre qual tema você gostaria de aprender com a diar.ia.br (curso, aula, guia ou mentoria)?",
    kind: "checkbox",
    help: "Pode marcar mais de um.",
    hiddenWhen: { questionId: "produto_formato", option: FORM_NADA_DISSO },
    options: [
      "IA no trabalho do dia a dia (textos, planilhas, e-mails)",
      "Como escrever bons prompts",
      "Automatizar tarefas e montar agentes",
      "IA aplicada à minha área",
      "Programar com ajuda de IA",
      "Criar imagens, vídeos e áudio com IA",
      "Como levar IA para dentro de uma empresa",
      "Riscos, ética e regulação",
    ],
  },
  {
    id: "produto_preco",
    label: "Quanto você investiria para aprender algo que resolvesse uma necessidade sua?",
    kind: "select",
    hiddenWhen: { questionId: "produto_formato", option: FORM_NADA_DISSO },
    options: ["Só faria se fosse gratuito", "Até R$ 100", "R$ 100 a R$ 300", "R$ 300 a R$ 1.000", "Mais de R$ 1.000"],
  },
  {
    id: "sugestao",
    label: "Quer contar mais alguma coisa? Um assunto que falta na newsletter, ou algo que você gostaria de aprender com a gente.",
    kind: "textarea",
    help: "Opcional.",
  },
];

/** @pure — a pergunta fica escondida dadas as respostas JÁ validadas das anteriores. */
export function isQuestionHidden(q: FormQuestion, answers: Readonly<Record<string, string>>): boolean {
  if (!q.hiddenWhen) return false;
  const v = answers[q.hiddenWhen.questionId];
  return v != null && splitMultiAnswer(v).includes(q.hiddenWhen.option);
}

export const FORM_ANSWER_MAX_LEN = 2000;

export interface FormSubmission {
  email: string;
  answers: Record<string, string>;
}

export interface FormResponse extends FormSubmission {
  submitted_at: string;
  /**
   * #12490: versão das perguntas em que a resposta foi dada (`FORM_VERSION`
   * no momento do envio). Ausente = resposta gravada antes do campo existir
   * (perguntas v2). A comparação entre um ano e outro só vale entre respostas
   * da mesma versão (ou de perguntas que não mudaram entre as duas).
   */
  form_version?: number;
}

export interface FormResponsesPayload {
  responses: FormResponse[];
  /**
   * #12509: cursor da próxima página de `GET /api/respostas` (repassado como
   * `?cursor=`). Ausente ou `null` = esta é a última página.
   */
  next_cursor?: string | null;
}

/**
 * #12490: versão ATUAL das perguntas. Sobe sempre que `FORM_QUESTIONS` muda
 * (id, tipo, rótulo ou opções); `test/onboarding-form-history-12490.test.ts`
 * trava a impressão digital das perguntas contra este número, então mudar a
 * pergunta sem subir a versão quebra o teste. O Worker grava o número em
 * cada resposta (`FormResponse.form_version`).
 */
export const FORM_VERSION = 2;

/** Versão das respostas antigas, gravadas antes do campo `form_version`. */
export const FORM_VERSION_LEGACY = 2;

/** @pure — versão de uma resposta (ausente = `FORM_VERSION_LEGACY`). */
export function formVersionOf(r: Pick<FormResponse, "form_version">): number {
  return typeof r.form_version === "number" && Number.isInteger(r.form_version) && r.form_version > 0 ? r.form_version : FORM_VERSION_LEGACY;
}

/**
 * @pure — impressão digital das perguntas (id, tipo, rótulo, opções, ordem),
 * para o teste travar `FORM_VERSION`. Texto estável, sem hash: o diff do
 * teste mostra o que mudou.
 */
export function formQuestionsFingerprint(questions: readonly FormQuestion[] = FORM_QUESTIONS): string {
  return questions
    .map((q) => [q.id, q.kind, q.label, ...(isChoiceQuestion(q) ? q.options : [])].join("\u001f"))
    .join("\u001e");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @pure — e-mail do `?email=` do link (review #10623, #10657). O link vai SEM
 * filtro Liquid (`url_encode` não foi confirmado no Kit), então o e-mail chega
 * cru na query: `@` e `.` passam intactos, mas um `+` do local part vira
 * espaço no `URLSearchParams`. E-mail não tem espaço, então espaço aqui é
 * sempre um `+` decodificado — restaurado, e é isso que faz a assinatura de
 * `a+b@x.com` conferir. Resíduo aceito (#10657): `&` ou `#` no local part
 * cortam o e-mail na query, a assinatura não confere e a pessoa vê "Link
 * inválido" — nunca grava para o e-mail errado.
 */
export function prefillEmailFromQuery(raw: string | null | undefined): string {
  return String(raw ?? "").trim().replace(/ /g, "+");
}

export function normalizeFormEmail(raw: string): string {
  return String(raw ?? "").trim().toLowerCase();
}

/**
 * @pure — valida a submissão: e-mail válido, só respostas de perguntas
 * conhecidas (campo desconhecido é descartado, nunca gravado), obrigatórias
 * presentes, texto truncado em `FORM_ANSWER_MAX_LEN`, `select` só aceita uma
 * das opções. `checkbox`: aceita string única ou lista (um valor por caixa
 * marcada); toda opção precisa ser conhecida, a gravação segue a ordem da
 * pergunta e descarta repetição; `exclusiveOption` junto com outra opção é
 * recusado; obrigatória = pelo menos uma marcada. Pergunta com `hiddenWhen`
 * cuja condição vale (resposta já validada da pergunta de controle) é tratada
 * como ausente: o valor que vier é descartado sem validar (o cliente esconde e
 * desabilita o campo, mas um navegador sem JavaScript ainda pode mandá-lo).
 */
export function parseFormSubmission(
  fields: Readonly<Record<string, string | readonly string[] | undefined>>,
  questions: readonly FormQuestion[] = FORM_QUESTIONS,
): { ok: true; submission: FormSubmission } | { ok: false; error: string } {
  const email = normalizeFormEmail(firstValue(fields.email));
  if (!EMAIL_RE.test(email)) return { ok: false, error: "e-mail inválido" };
  const answers: Record<string, string> = {};
  for (const q of questions) {
    if (isQuestionHidden(q, answers)) continue;
    const raw = fields[q.id];
    if (q.kind === "checkbox") {
      // Várias opções: todas precisam ser conhecidas; a ordem gravada segue a
      // da pergunta (não a do envio) e repetição some.
      const picked = allValues(raw).map((x) => x.trim()).filter((x) => x !== "");
      if (picked.length === 0) {
        if (q.required) return { ok: false, error: `resposta obrigatória ausente: ${q.label}` };
        continue;
      }
      const opts = q.options;
      if (picked.some((x) => !opts.includes(x))) return { ok: false, error: `opção inválida em: ${q.label}` };
      const chosen = opts.filter((o) => picked.includes(o));
      if (q.exclusiveOption && chosen.includes(q.exclusiveOption) && chosen.length > 1) {
        return { ok: false, error: `"${q.exclusiveOption}" não combina com outras opções em: ${q.label}` };
      }
      answers[q.id] = chosen.join(FORM_MULTI_SEPARATOR);
      continue;
    }
    const v = firstValue(raw).trim();
    if (v === "") {
      if (q.required) return { ok: false, error: `resposta obrigatória ausente: ${q.label}` };
      continue;
    }
    if (q.kind === "select" && !q.options.includes(v)) return { ok: false, error: `opção inválida em: ${q.label}` };
    answers[q.id] = v.slice(0, FORM_ANSWER_MAX_LEN);
  }
  return { ok: true, submission: { email, answers } };
}

function allValues(v: string | readonly string[] | undefined): string[] {
  if (v == null) return [];
  return typeof v === "string" ? [v] : [...v];
}

function firstValue(v: string | readonly string[] | undefined): string {
  return allValues(v)[0] ?? "";
}

/** @pure — opções de uma resposta `checkbox` gravada (inverso do join). */
export function splitMultiAnswer(value: string): string[] {
  return value.split(FORM_MULTI_SEPARATOR).map((x) => x.trim()).filter((x) => x !== "");
}

/**
 * @pure — valida o payload de `GET /api/respostas` (lado do executor).
 * Qualquer forma inesperada LANÇA: resposta malformada nunca vira "ninguém
 * preencheu" (o que reenviaria lembretes a quem já respondeu).
 */
export function parseFormResponsesPayload(data: unknown): FormResponse[] {
  if (data == null || typeof data !== "object" || !Array.isArray((data as { responses?: unknown }).responses)) {
    throw new Error("[onboarding-form] payload de respostas sem o array `responses`");
  }
  const out: FormResponse[] = [];
  for (const r of (data as FormResponsesPayload).responses) {
    if (r == null || typeof r !== "object") throw new Error("[onboarding-form] resposta malformada no payload");
    const email = normalizeFormEmail((r as FormResponse).email);
    const at = (r as FormResponse).submitted_at;
    if (!EMAIL_RE.test(email) || typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
      throw new Error("[onboarding-form] resposta sem e-mail/submitted_at válidos no payload");
    }
    const answersRaw = (r as FormResponse).answers;
    const answers: Record<string, string> = {};
    if (answersRaw && typeof answersRaw === "object") {
      for (const [k, v] of Object.entries(answersRaw)) if (typeof v === "string") answers[k] = v;
    }
    const rec: FormResponse = { email, submitted_at: at, answers };
    // #12490: versão só quando veio válida; ausente = legado (`formVersionOf`).
    const version = (r as FormResponse).form_version;
    if (typeof version === "number" && Number.isInteger(version) && version > 0) rec.form_version = version;
    out.push(rec);
  }
  return out;
}

/**
 * #12509: o Workers limita as operações de KV por invocação a 1000. O
 * `GET /api/respostas` fazia um `list` e um `get` por chave da lista inteira
 * na mesma invocação, então passava do teto quando o número de chaves
 * passasse de ~1000 (e com ele falhavam a rodada de follow-up, o `--status`,
 * o `--tag-respondents` e o perfil de audiência). Agora cada chamada lê UMA
 * página: 1 `list` com `limit` = `FORM_RESPONSES_PAGE_SIZE` + no máximo esse
 * número de `get`, e devolve `next_cursor`; quem lê segue os cursores
 * (`fetchAllFormResponses`). 500 deixa folga: 501 operações por invocação.
 */
export const FORM_RESPONSES_PAGE_SIZE = 500;

/** #12509: teto de páginas do lado de quem lê (500 mil chaves): cursor que
 *  nunca termina vira erro, nunca laço infinito. */
const FORM_RESPONSES_MAX_PAGES = 1000;

/** `get` simultâneos dentro de uma página (não muda a contagem de operações,
 *  só o tempo da invocação). */
const FORM_RESPONSES_GET_CONCURRENCY = 50;

/** O mínimo do `KVNamespace` que a leitura paginada usa (testável sem Workers). */
export interface FormResponsesKv {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
  get(key: string): Promise<string | null>;
}

export interface FormResponsesPage {
  responses: FormResponse[];
  next_cursor: string | null;
  /** Chaves cujo valor não é JSON legível (puladas, nunca derrubam a página). */
  unreadable: number;
}

/**
 * #12509: lê UMA página de respostas do KV (lado do Worker). Faz exatamente 1
 * `list` e no máximo `pageSize` `get`. Chave que sumiu entre o `list` e o
 * `get` é pulada; valor ilegível também (contado em `unreadable`, para o
 * Worker registrar no log sem o e-mail). Falha do KV LANÇA: o Worker responde
 * 5xx com o motivo, nunca uma lista parcial com cara de completa.
 */
export async function readFormResponsesPage(
  kv: FormResponsesKv,
  prefix: string,
  cursor: string | undefined,
  pageSize: number = FORM_RESPONSES_PAGE_SIZE,
): Promise<FormResponsesPage> {
  const list = await kv.list({ prefix, cursor, limit: pageSize });
  const names = list.keys.slice(0, pageSize).map((k) => k.name);
  const raws: (string | null)[] = [];
  for (let i = 0; i < names.length; i += FORM_RESPONSES_GET_CONCURRENCY) {
    raws.push(...(await Promise.all(names.slice(i, i + FORM_RESPONSES_GET_CONCURRENCY).map((n) => kv.get(n)))));
  }
  const responses: FormResponse[] = [];
  let unreadable = 0;
  for (const raw of raws) {
    if (raw == null) continue;
    try {
      responses.push(JSON.parse(raw) as FormResponse);
    } catch {
      unreadable++;
    }
  }
  const next = !list.list_complete && typeof list.cursor === "string" && list.cursor !== "" ? list.cursor : null;
  return { responses, next_cursor: next, unreadable };
}

/**
 * @pure — #12509: valida uma página de `GET /api/respostas` (lado de quem lê):
 * as respostas como em `parseFormResponsesPayload` e o `next_cursor`, que só
 * pode ser string não vazia, `null` ou ausente. Qualquer outra forma LANÇA.
 */
export function parseFormResponsesPage(data: unknown): { responses: FormResponse[]; next_cursor: string | null } {
  const responses = parseFormResponsesPayload(data);
  const next = (data as FormResponsesPayload).next_cursor;
  if (next == null) return { responses, next_cursor: null };
  if (typeof next !== "string" || next === "") throw new Error("[onboarding-form] next_cursor inválido no payload de respostas");
  return { responses, next_cursor: next };
}

export interface FetchAllFormResponsesIo {
  fetchImpl?: typeof fetch;
  /** Timeout de CADA página (default 30 s). */
  timeoutMs?: number;
  maxPages?: number;
}

/**
 * #12509: lê TODAS as respostas de `GET /api/respostas`, seguindo
 * `next_cursor` página a página (1ª chamada na URL configurada, sem
 * `cursor`). Usado pelo executor (`onboarding-followup-run.ts`), pela
 * preparação do convite da base e pelo perfil de audiência. Qualquer falha
 * LANÇA: HTTP de erro (o 5xx do Worker leva o motivo, repassado na mensagem),
 * payload malformado, cursor repetido ou mais de `maxPages` páginas. Nunca
 * devolve uma lista parcial, que viraria "essas pessoas não preencheram".
 */
export async function fetchAllFormResponses(url: string, token: string, io: FetchAllFormResponsesIo = {}): Promise<FormResponse[]> {
  const fetchImpl = io.fetchImpl ?? fetch;
  const maxPages = io.maxPages ?? FORM_RESPONSES_MAX_PAGES;
  const out: FormResponse[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    let target = url;
    if (cursor != null) {
      const u = new URL(url);
      u.searchParams.set("cursor", cursor);
      target = u.toString();
    }
    const res = await fetchImpl(target, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(io.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      let reason = "";
      try {
        const body = (await res.json()) as { reason?: unknown };
        if (typeof body?.reason === "string") reason = ` (${body.reason})`;
      } catch {
        // corpo sem JSON: fica só o status
      }
      throw new Error(`GET respostas do formulário: HTTP ${res.status}${reason}`);
    }
    const parsed = parseFormResponsesPage(await res.json());
    out.push(...parsed.responses);
    if (parsed.next_cursor == null) return out;
    if (seen.has(parsed.next_cursor)) throw new Error("[onboarding-form] next_cursor repetido: paginação de respostas não avança");
    seen.add(parsed.next_cursor);
    cursor = parsed.next_cursor;
  }
  throw new Error(`[onboarding-form] respostas passaram de ${maxPages} páginas sem terminar`);
}

/** Chave KV de uma resposta (1 por e-mail; a última vence). */
export function formResponseKey(email: string): string {
  return `resp:${normalizeFormEmail(email)}`;
}

/**
 * #12490: chave KV do HISTÓRICO — uma por resposta, nunca sobrescrita
 * (`hist:{e-mail}:{submitted_at}`). A `resp:` continua sendo a mais recente
 * por pessoa (é a que o executor e o perfil de audiência leem); o histórico
 * serve à comparação de um ano com o outro (`GET /api/respostas?historico=1`).
 * O `submitted_at` é ISO em UTC, então a ordem lexicográfica das chaves de
 * uma pessoa é a ordem cronológica.
 */
export function formHistoryKey(email: string, submittedAt: string): string {
  return `${FORM_HISTORY_PREFIX}${normalizeFormEmail(email)}:${submittedAt}`;
}

export const FORM_HISTORY_PREFIX = "hist:";

/**
 * @pure — #12490: o que gravar no KV quando chega uma resposta nova. Sempre
 * `resp:` (a mais recente) e o `hist:` dela; e, quando a resposta anterior da
 * pessoa existe e é de antes do histórico (gravada só em `resp:`), também o
 * `hist:` dela — senão a 1ª resposta de quem respondeu antes do histórico
 * existir seria apagada pela 2ª. Regravar um `hist:` que já existe escreve o
 * mesmo conteúdo (a chave inclui o `submitted_at`), então é idempotente.
 */
export function planFormResponseWrites(
  record: FormResponse,
  previousRaw: string | null,
): { key: string; value: string }[] {
  const value = JSON.stringify(record);
  const writes = [
    { key: formHistoryKey(record.email, record.submitted_at), value },
    { key: formResponseKey(record.email), value },
  ];
  if (previousRaw != null) {
    try {
      const prev = JSON.parse(previousRaw) as Partial<FormResponse>;
      if (
        prev &&
        typeof prev.submitted_at === "string" &&
        Number.isFinite(Date.parse(prev.submitted_at)) &&
        prev.submitted_at !== record.submitted_at
      ) {
        writes.unshift({ key: formHistoryKey(record.email, prev.submitted_at), value: previousRaw });
      }
    } catch {
      // Anterior ilegível: não há o que preservar com segurança; a nova vale.
    }
  }
  return writes;
}

/**
 * #12495: resultados da pesquisa já publicados (a edição especial para quem
 * respondeu, decisão do editor de 09/11/2026), com a versão web restrita —
 * fora da busca, link entregue só a quem respondeu. O editor registra os dois
 * valores DEPOIS do envio da edição especial: `url` é a versão web e
 * `published_at` é o instante do envio. Quem respondeu antes dele já recebeu
 * a edição especial; quem responde depois recebe o link na página de obrigado
 * e por e-mail (`form_resultados` do executor).
 */
export interface FormResults {
  url: string;
  published_at: string;
}

/**
 * @pure — os resultados só valem com os DOIS valores válidos: URL https e
 * instante ISO. Qualquer um ausente ou malformado = `null` = nada muda (a
 * página de obrigado continua a genérica, ninguém recebe o e-mail). Usado pelo
 * Worker (vars do `wrangler.toml`) e pelo executor
 * (`onboarding.followup.results_*` no `platform.config.json`).
 */
export function resolveFormResults(url: unknown, publishedAt: unknown): FormResults | null {
  if (typeof url !== "string" || typeof publishedAt !== "string") return null;
  const u = url.trim();
  const at = publishedAt.trim();
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(u)) return null;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !Number.isFinite(Date.parse(at))) return null;
  return { url: u, published_at: at };
}

/** @pure — compara o token do header `Authorization` em tempo constante. */
export function isAuthorizedResponsesRequest(authHeader: string | null, token: string | undefined): boolean {
  if (!token) return false;
  const expected = `Bearer ${token}`;
  const got = authHeader ?? "";
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
