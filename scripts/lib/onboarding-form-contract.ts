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
 * foco em B2C (preço só por
 * faixas, sem "quem pagaria"; o único sinal B2B é a opção "Treinamento para a
 * equipe da empresa onde trabalho"); tema e preço somem quando a pessoa marca
 * "Nada disso" no que ela faria além da newsletter (`hiddenWhen`); sem
 * pergunta de ferramentas nem de porte de empresa; só nível e área são
 * obrigatórias. A 3ª pergunta, `uso_recente` (decisão do editor de
 * 08/11/2026), substituiu a das seções da newsletter (`conteudo`): pergunta
 * para que a pessoa usou a última coisa útil que leu. Resposta antiga com
 * `conteudo` continua legível (`parseFormResponsesPayload` guarda qualquer
 * chave) e é ignorada no perfil, contada como pergunta que não existe mais.
 * Depois dela, uma pergunta opcional sobre o que a pessoa faz quando o link
 * abre em inglês (`leitura_ingles`). Área, uso e tema têm a opção
 * "Outro/Outra" com campo de texto curto (`otherOption`, texto em
 * `{id}_outro`), que fica só no KV do Worker (lido por `/api/respostas`) e
 * nunca entra no perfil. O envio segue travado pelo marcador de texto pendente
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
  /**
   * Opção "Outro/Outra" com campo de texto curto acoplado (decisão do editor
   * de 08/11/2026). Precisa estar em `options`. O texto vai em
   * `answers[otherTextFieldId(q)]` (`{id}_outro`), só quando esta opção foi
   * marcada, limpo por `cleanOtherText`. O texto NUNCA entra no perfil de
   * audiência (o perfil vai para prompts): lá só conta a opção.
   */
  otherOption?: string;
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
    otherOption: "Outra",
  },
  {
    id: "uso_recente",
    label: "Pense na última vez que algo que você leu na diar.ia.br foi útil. Para que você usou?",
    kind: "select",
    options: [
      "Testei ou passei a usar uma ferramenta",
      "Mudei a forma de fazer uma tarefa",
      "Levei o assunto para uma conversa ou reunião",
      "Ajudou numa decisão na empresa ou na equipe",
      "Outro",
      "Só fiquei por dentro, sem usar para nada específico",
      "Não lembro de nenhuma vez",
    ],
    otherOption: "Outro",
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
      "Outro",
    ],
    otherOption: "Outro",
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

/** Limite do texto do campo "Outro/Outra" (curto; acima disso é truncado). */
export const FORM_OTHER_TEXT_MAX_LEN = 120;

/** Sufixo da chave do texto do "Outro/Outra": `answers["area_outro"]`. */
export const FORM_OTHER_TEXT_SUFFIX = "_outro";

/** Chave (e `name` do campo HTML) do texto do "Outro/Outra" da pergunta `q`. */
export function otherTextFieldId(q: { id: string }): string {
  return `${q.id}${FORM_OTHER_TEXT_SUFFIX}`;
}

/**
 * @pure — limpa o texto do "Outro/Outra": tira marcação HTML (tags e `<`/`>`
 * soltos), caracteres de controle e quebras de linha (vira uma linha só, com
 * espaços colapsados), faz trim e TRUNCA em `FORM_OTHER_TEXT_MAX_LEN` (o
 * campo já tem `maxlength`, então só um envio fora do navegador passa disso;
 * truncar não perde a resposta inteira por um excesso). `""` = sem texto.
 */
export function cleanOtherText(raw: string): string {
  return raw
    .replace(/<\/?[a-zA-Z!][^<>]*>/g, " ")
    .replace(/[<>]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FORM_OTHER_TEXT_MAX_LEN)
    .trim();
}

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
 * Pergunta com `otherOption`: o texto de `{id}_outro` (opcional) só é gravado
 * quando essa opção foi marcada, limpo e truncado por `cleanOtherText`; sem a
 * opção marcada, o texto é descartado sem erro (sem JavaScript o campo
 * aparece sempre, e a pessoa pode ter digitado e trocado de opção).
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
      addOtherText(q, chosen, fields, answers);
      continue;
    }
    const v = firstValue(raw).trim();
    if (v === "") {
      if (q.required) return { ok: false, error: `resposta obrigatória ausente: ${q.label}` };
      continue;
    }
    if (q.kind === "select" && !q.options.includes(v)) return { ok: false, error: `opção inválida em: ${q.label}` };
    answers[q.id] = v.slice(0, FORM_ANSWER_MAX_LEN);
    if (q.kind === "select") addOtherText(q, [v], fields, answers);
  }
  return { ok: true, submission: { email, answers } };
}

/** Grava o texto do "Outro/Outra" só se a opção foi marcada e o texto não é vazio. */
function addOtherText(
  q: ChoiceQuestion,
  chosen: readonly string[],
  fields: Readonly<Record<string, string | readonly string[] | undefined>>,
  answers: Record<string, string>,
): void {
  if (!q.otherOption || !chosen.includes(q.otherOption)) return;
  const text = cleanOtherText(firstValue(fields[otherTextFieldId(q)]));
  if (text !== "") answers[otherTextFieldId(q)] = text;
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
