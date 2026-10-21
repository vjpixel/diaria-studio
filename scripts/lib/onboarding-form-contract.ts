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
 *    respostas no formato `FormResponsesPayload`. É o que o executor lê a
 *    cada rodada para marcar "preencheu" no store e parar os lembretes.
 *
 * ## Perguntas (rascunho da sessão, aguardando aprovação do editor)
 *
 * Decisão do editor (/diaria-develop 261020b): a sessão RASCUNHA, o editor
 * aprova. Duas frentes: (1) perfil e interesses, para as notícias refletirem
 * o público; (2) sondagem de produto, que cursos ou outros produtos o editor
 * poderia vender a esse público. Enquanto o editor não aprovar, o envio dos
 * e-mails do formulário segue travado pelo marcador de texto pendente
 * (`formContentGate`), então nenhum leitor chega ao formulário antes disso.
 *
 * As 3 primeiras perguntas (nível, área, tipos de conteúdo) têm rótulo
 * DIFERENTE do da survey de perfil antiga da Beehiiv, mas casam com os mesmos
 * matchers de `scripts/lib/audience-survey-questions.ts` e usam opções
 * compatíveis (as mesmas da survey, mais "Estudante" em área), para as
 * respostas somarem nas mesmas seções de `context/audience-profile.md`.
 * `test/onboarding-form-questions-10605.test.ts` trava o casamento e congela
 * as opções. Mudar o rótulo sem mexer no matcher tiraria a pergunta do perfil
 * em silêncio; o teste existe para pegar isso.
 */

interface FormQuestionBase {
  /** Chave da resposta (`answers[id]`) — estável, sem espaço. */
  id: string;
  label: string;
  required?: boolean;
  /** Linha de ajuda curta abaixo do rótulo. */
  help?: string;
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

/** Rascunho da sessão (#10605), aguardando aprovação do editor. */
export const FORM_QUESTIONS: readonly FormQuestion[] = [
  {
    id: "nivel_ia",
    label: "Qual seu nível de conhecimento em IA?",
    kind: "select",
    required: true,
    options: [
      "Uso casual (uso ferramentas eventualmente)",
      "Uso consciente (uso GenAI para tarefas simples diariamente)",
      "Entusiasta (sei diferenciar IA, Machine Learning e Deep Learning)",
      "Praticante (consigo usar um modelo via API e/ou limpar e coletar dados)",
      "Especialista (sei otimizar modelos e/ou traduzir um problema de negócio em uma estratégia que use IA eficientemente)",
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
    label: "Que tipos de conteúdo você mais quer ver na newsletter?",
    kind: "checkbox",
    help: "Pode marcar mais de um.",
    options: [
      "Tutoriais práticos",
      "Curadoria de novas ferramentas",
      "Notícias do mundo de IA",
      "Estudos de caso (como uma empresa usa IA)",
      "Análises mais aprofundadas sobre um tema específico",
      "Pesquisas sobre IA",
      "Artigos de opinião e editoriais",
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
      "Nada disso, a newsletter já me basta",
    ],
    exclusiveOption: "Nada disso, a newsletter já me basta",
  },
  {
    id: "produto_tema",
    label: "Sobre qual tema você faria um curso?",
    kind: "checkbox",
    help: "Pode marcar mais de um.",
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
    label: "Quanto você investiria num curso que resolvesse uma necessidade sua?",
    kind: "select",
    options: [
      "Só faria se fosse gratuito",
      "Até R$ 100",
      "De R$ 100 a R$ 300",
      "De R$ 300 a R$ 1.000",
      "Mais de R$ 1.000",
      "Quem pagaria é a empresa onde trabalho",
    ],
  },
  {
    id: "sugestao",
    label: "Quer contar mais alguma coisa? Um assunto que falta na newsletter, ou um curso que você gostaria que a gente fizesse.",
    kind: "textarea",
    help: "Opcional.",
  },
];

export const FORM_ANSWER_MAX_LEN = 2000;

export interface FormSubmission {
  email: string;
  answers: Record<string, string>;
}

export interface FormResponse extends FormSubmission {
  submitted_at: string;
}

export interface FormResponsesPayload {
  responses: FormResponse[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @pure — e-mail pré-preenchido a partir do `?email=` do link (review #10623).
 * O link vai SEM filtro Liquid (`url_encode` não foi confirmado no Kit), então
 * o e-mail chega cru na query: `@` e `.` passam intactos, mas um `+` do local
 * part vira espaço no `URLSearchParams`. E-mail não tem espaço, então espaço
 * aqui é sempre um `+` decodificado — restaurado. Caracteres raros que a query
 * corta (`&`, `#`) deixam o campo incompleto, nunca errado em silêncio: o
 * campo é visível, editável e validado no envio.
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
 * recusado; obrigatória = pelo menos uma marcada.
 */
export function parseFormSubmission(
  fields: Readonly<Record<string, string | readonly string[] | undefined>>,
  questions: readonly FormQuestion[] = FORM_QUESTIONS,
): { ok: true; submission: FormSubmission } | { ok: false; error: string } {
  const email = normalizeFormEmail(firstValue(fields.email));
  if (!EMAIL_RE.test(email)) return { ok: false, error: "e-mail inválido" };
  const answers: Record<string, string> = {};
  for (const q of questions) {
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
    out.push({ email, submitted_at: at, answers });
  }
  return out;
}

/** Chave KV de uma resposta (1 por e-mail; a última vence). */
export function formResponseKey(email: string): string {
  return `resp:${normalizeFormEmail(email)}`;
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
