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
 * obrigatórias. O envio segue travado pelo marcador de texto pendente
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
}

export interface FormResponsesPayload {
  responses: FormResponse[];
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
