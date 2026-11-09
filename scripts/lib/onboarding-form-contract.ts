/**
 * onboarding-form-contract.ts (#10605)
 *
 * CONTRATO do formulário de perfil/interesses do onboarding — decisão do
 * editor (briefing do overnight 261020): formulário PRÓPRIO num Worker nosso
 * (custo zero, dados nossos, `?email=` pré-preenchido pela merge tag do Kit).
 * Puro e sem dependência de Node: importado pelo Worker
 * (`workers/onboarding-form/src/index.ts` e `src/render.ts`), pelo executor
 * das sequências (`scripts/onboarding-followup-run.ts`, que marca "preencheu"),
 * pela lista de quem aceitou conversar (`scripts/onboarding-form-conversas.ts`)
 * e pela regeneração do perfil de audiência (`scripts/audience-run.ts` via
 * `scripts/lib/audience-survey-questions.ts`), pra os lados nunca divergirem
 * sobre o formato.
 *
 * ## Endpoints do Worker
 *
 *  - `GET  /?email={e-mail}&sig={assinatura}` — página do formulário para
 *    aquele e-mail (fixo, em campo oculto). Sem assinatura válida: página de
 *    link inválido (#10657, `onboarding-form-link-sig.ts`). A página leva a
 *    hora em que foi gerada, assinada (`FORM_RENDERED_FIELD`), para o envio
 *    gravar o tempo de preenchimento (`duration_s`).
 *  - `POST /enviar` (form-urlencoded) — exige a assinatura do e-mail enviado
 *    (senão 403, nada gravado); valida com `parseFormSubmission` e grava a
 *    resposta (KV, chave `resp:{email normalizado}` = a mais recente por
 *    pessoa) e, desde o #12490, também no histórico (`hist:{e-mail}:{submitted_at}`,
 *    uma chave por envio, nunca sobrescrita; `planFormResponseWrites`). Cada
 *    envio leva `form_version` e, com a hora assinada da página, `duration_s`.
 *  - `GET  /api/respostas` com `Authorization: Bearer {token}` — lista as
 *    respostas no formato `FormResponsesPayload` (a mais recente por pessoa).
 *    É o que o executor lê a cada rodada para marcar "preencheu" no store e
 *    parar os lembretes. Com `?historico=1` (#12490) lista TODAS as respostas
 *    guardadas (`hist:`), uma por envio, para comparar um ano com o outro.
 *    Paginado desde o #12509: cada chamada devolve até
 *    `FORM_RESPONSES_PAGE_SIZE` respostas e `next_cursor` (repassar como
 *    `?cursor=`); quem lê usa `fetchAllFormResponses`. Falha do KV = 503 com
 *    `{error: "kv_failure", reason}`.
 *    Quem consome ainda passa por `latestFormResponses` (defesa: a lista do
 *    histórico tem várias por pessoa).
 *
 * ## Perguntas (v3, aprovada pelo editor em 09/11/2026)
 *
 * Doze perguntas numeradas, mais três subperguntas sem número
 * (`subOf`): o relato de falha (texto livre, dentro das dificuldades), a
 * escolha de um formato só (aparece com 2 ou mais formatos marcados) e o
 * gasto mensal (aparece só para quem paga do próprio bolso). Toda pergunta de
 * escolha é renderizada como rádio ou caixa, nunca menu suspenso. Só as
 * marcadas como opcionais podem ficar em branco (`required` em todas as
 * outras, inclusive as condicionais quando aparecem).
 *
 * Condicionais: `hiddenWhen` (tema some com "Nada disso") e `shownWhen`
 * (escolha única e gasto mensal). Pergunta que não aparece é tratada como
 * ausente: o cliente desabilita os campos e o servidor descarta o que vier.
 * `optionsFrom` restringe as opções às que a pessoa marcou em outra pergunta
 * (sem JavaScript todas aparecem e o servidor confere). `maxChoices` limita
 * as caixas ("Marque até 3").
 *
 * "Outro/Outra" com campo de texto curto (`otherOption`, texto em
 * `{id}_outro`) e o relato de falha ficam só no KV do Worker (lidos por
 * `/api/respostas` e pela lista local de conversas) e nunca entram no perfil.
 *
 * Respostas antigas (v1/v2) seguem legíveis: `parseFormResponsesPayload`
 * guarda qualquer chave, e os ids que saíram (`LEGACY_FORM_ANSWER_IDS`) são
 * contados à parte na conversão para o perfil, como aviso.
 *
 * O envio segue travado pelo marcador de texto pendente (`formContentGate`)
 * até o editor destravar os textos em `data/snippets`.
 *
 * Cada pergunta casa com exatamente um matcher de
 * `scripts/lib/audience-survey-questions.ts`, travado por
 * `test/onboarding-form-questions-10605.test.ts`: mudar o rótulo sem mexer no
 * matcher tiraria a pergunta do perfil em silêncio.
 */

interface FormQuestionBase {
  /** Chave da resposta (`answers[id]`) — estável, sem espaço. */
  id: string;
  label: string;
  /** Obrigatória QUANDO aparece (condicional escondida nunca é exigida). */
  required?: boolean;
  /** Linha de ajuda curta abaixo do rótulo. */
  help?: string;
  /** Ajuda depois das opções em vez de antes (pergunta da conversa). */
  helpAfter?: boolean;
  /**
   * Pergunta escondida quando a pessoa marca `option` na pergunta `questionId`
   * (uma pergunta que vem ANTES desta na lista). Escondida, a resposta é
   * tratada como ausente: o cliente desabilita os campos e o servidor
   * descarta o que vier (`parseFormSubmission`).
   */
  hiddenWhen?: { questionId: string; option: string };
  /**
   * Pergunta que só aparece quando a resposta de `questionId` (anterior)
   * marca uma das opções de `anyOf`, ou tem pelo menos `minChecked` opções
   * marcadas. Fora disso é tratada como ausente, igual a `hiddenWhen`.
   */
  shownWhen?: { questionId: string; anyOf?: readonly string[]; minChecked?: number };
  /** Subpergunta sem número própria, renderizada logo depois da pergunta `subOf`. */
  subOf?: string;
}

/** Pergunta de escolha: `select` = uma opção (rádio); `checkbox` = várias
 *  (gravadas numa string só, separadas por `FORM_MULTI_SEPARATOR`). */
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
  /** Só `checkbox`: no máximo N opções marcadas ("Marque até 3"). */
  maxChoices?: number;
  /** Só `select`: a resposta precisa estar entre as opções marcadas na
   *  pergunta `optionsFrom` (a escolha de um formato só). */
  optionsFrom?: string;
}

/** Pergunta aberta, sempre texto livre limpo e truncado em `FORM_ANSWER_MAX_LEN`. */
export interface OpenQuestion extends FormQuestionBase {
  kind: "text" | "textarea";
  placeholder?: string;
}

export type FormQuestion = ChoiceQuestion | OpenQuestion;

export function isChoiceQuestion(q: FormQuestion): q is ChoiceQuestion {
  return q.kind === "select" || q.kind === "checkbox";
}

/** Separador das opções marcadas numa pergunta `checkbox`, dentro da string
 *  única de `answers[id]`. Nenhuma opção pode conter este texto (teste). */
export const FORM_MULTI_SEPARATOR = " | ";

/** Opção de `produto_formato` que esconde o tema (decisão 5 do editor). */
export const FORM_NADA_DISSO = "Nada disso, a newsletter já me basta";

/** Opções de `quem_paga` que mostram o gasto mensal. */
export const FORM_PAGA_DO_BOLSO = ["Eu, do próprio bolso", "Eu e a empresa, uma parte cada"] as const;

/** Única opção da pergunta da conversa (caixa única). */
export const FORM_CONVERSA_SIM = "Sim, topo. Pode me escrever para combinar.";

/** Ids das versões anteriores (v1/v2) que saíram do contrato — lidos sem
 *  quebrar, contados à parte e ignorados no perfil. */
export const LEGACY_FORM_ANSWER_IDS: readonly string[] = ["nivel_ia", "conteudo", "leitura_ingles", "produto_preco", "sugestao"];

const FORMATOS = [
  "Curso online gravado, no meu ritmo",
  "Aula ou workshop ao vivo",
  "Mentoria individual ou em grupo pequeno",
  "Treinamento para a equipe da empresa onde trabalho",
  "Guias e modelos prontos (prompts, fluxos de trabalho)",
  "Comunidade para trocar experiências com outros leitores",
] as const;

/** v3 (#10605, aprovada pelo editor em 09/11/2026). */
export const FORM_QUESTIONS: readonly FormQuestion[] = [
  {
    id: "uso_ia",
    label: "Como você usa IA hoje?",
    kind: "select",
    required: true,
    options: [
      "Uso pouco: só testei ou uso de vez em quando",
      "Uso com frequência em tarefas do dia a dia (textos, resumos, pesquisas)",
      "Já montei coisas mais elaboradas (assistentes personalizados, automações, prompts reutilizáveis)",
      "Trabalho com a tecnologia em si: programo, integro por API, treino ou ajusto modelos",
    ],
  },
  {
    id: "situacao",
    label: "Qual é a sua situação hoje?",
    kind: "select",
    required: true,
    options: [
      "Empregado(a) em empresa ou organização privada",
      "Servidor(a) público(a)",
      "Autônomo(a) ou freelancer",
      "Tenho meu próprio negócio",
      "Estudante",
      "Aposentado(a) ou sem trabalho no momento",
    ],
  },
  {
    id: "area",
    label: "Em que área você trabalha ou estuda?",
    kind: "select",
    required: true,
    help: "Se está aposentado(a) ou sem trabalho, marque a área em que trabalhou por último.",
    options: [
      "Administração, gestão ou consultoria",
      "Contabilidade",
      "Direito (advocacia, área jurídica)",
      "Educação (professor, coordenação)",
      "Engenharia",
      "Finanças, bancos ou investimentos",
      "Fiscalização",
      "Marketing, comunicação, design ou criação de conteúdo",
      "RH ou gestão de pessoas",
      "Saúde (medicina, enfermagem, psicologia, farmácia…)",
      "Tecnologia (programação, dados, TI)",
      "Vendas ou atendimento",
      "Outra",
    ],
    otherOption: "Outra",
  },
  {
    id: "uso_recente",
    label: "Pense na última vez que algo que você leu na diar.ia.br foi útil. O que você fez com isso?",
    kind: "select",
    required: true,
    options: [
      "Testei ou passei a usar uma ferramenta",
      "Mudei a forma de fazer uma tarefa",
      "Comentei ou compartilhei com alguém",
      "Usei para tomar uma decisão na empresa ou na equipe",
      "Só fiquei por dentro, sem usar para nada específico",
      "Não lembro de nenhuma vez",
      "Outro",
    ],
    otherOption: "Outro",
  },
  {
    id: "ferramentas",
    label: "Quais ferramentas de IA você usou no último mês?",
    kind: "checkbox",
    required: true,
    help: "Pode marcar mais de uma.",
    options: [
      "ChatGPT",
      "Gemini",
      "Claude",
      "Microsoft Copilot",
      "Meta AI (no WhatsApp ou Instagram)",
      "Perplexity",
      "NotebookLM",
      "DeepSeek",
      "Grok",
      "Ferramentas de imagem ou vídeo (Midjourney, Leonardo, Sora, recursos de IA do Canva…)",
      "Ferramentas de programação ou criação de apps (Cursor, Lovable, Replit, Claude Code, Codex…)",
      "Ferramentas de automação (n8n, Make, Zapier)",
      "Nenhuma",
      "Outra",
    ],
    exclusiveOption: "Nenhuma",
    otherOption: "Outra",
  },
  {
    id: "motivacao",
    label: "O que você mais quer conseguir com IA nos próximos meses?",
    kind: "select",
    required: true,
    options: [
      "Ganhar tempo nas tarefas do meu trabalho",
      "Crescer ou melhorar meu negócio",
      "Mudar de carreira ou conseguir um emprego melhor",
      "Não ficar para trás e entender o que está acontecendo",
      "Ensinar ou ajudar outras pessoas a usar (equipe, alunos, família)",
      "Criar coisas por conta própria (textos, imagens, vídeos, apps)",
      "Só curiosidade, sem objetivo definido",
      "Outro",
    ],
    otherOption: "Outro",
  },
  {
    id: "dificuldades",
    label: "O que mais atrapalha você a usar IA hoje?",
    kind: "checkbox",
    required: true,
    help: "Marque até 3.",
    maxChoices: 3,
    options: [
      "Não sei direito o que pedir, nem como pedir",
      "As respostas vêm erradas ou inventadas, e eu não confio",
      "Não sei qual ferramenta usar para cada coisa",
      "Falta tempo para aprender",
      "A versão gratuita não dá conta, e a paga é cara",
      "Minha empresa não permite ou não oferece ferramenta",
      "Muita coisa só em inglês",
      "Preocupação com privacidade ou com os dados que envio",
      "Nada me atrapalha",
      "Outro",
    ],
    exclusiveOption: "Nada me atrapalha",
    otherOption: "Outro",
  },
  {
    id: "relato_falha",
    label: "Se quiser, conte a última vez que você tentou usar IA e não deu certo. O que aconteceu?",
    kind: "textarea",
    subOf: "dificuldades",
    placeholder: "Ex.: pedi um resumo de um PDF e ele inventou números.",
  },
  {
    id: "produto_formato",
    label: "Além da newsletter, o que mais você gostaria que a diar.ia.br oferecesse, mesmo que fosse pago?",
    kind: "checkbox",
    required: true,
    help: "Pode marcar mais de um.",
    options: [...FORMATOS, FORM_NADA_DISSO],
    exclusiveOption: FORM_NADA_DISSO,
  },
  {
    id: "produto_escolha",
    label: "Se só um deles existisse, qual você escolheria?",
    kind: "select",
    required: true,
    subOf: "produto_formato",
    shownWhen: { questionId: "produto_formato", minChecked: 2 },
    optionsFrom: "produto_formato",
    options: FORMATOS,
  },
  {
    id: "produto_tema",
    label: "Sobre qual tema você gostaria de aprender com a diar.ia.br (curso, aula, guia ou mentoria)?",
    kind: "checkbox",
    required: true,
    help: "Marque até 3.",
    maxChoices: 3,
    hiddenWhen: { questionId: "produto_formato", option: FORM_NADA_DISSO },
    options: [
      "Entender o básico: o que a IA faz bem, o que faz mal e como funciona",
      "IA no trabalho do dia a dia (textos, planilhas, e-mails)",
      "Como escrever bons prompts",
      "Automatizar tarefas repetitivas",
      "IA aplicada à minha área",
      "Aplicar IA no meu próprio negócio",
      "Programar com ajuda de IA",
      "Criar e editar imagens, vídeos e áudio com IA",
      "Como levar IA para dentro de uma empresa",
      "Checar informações e evitar erros da IA",
      "Usar IA com segurança no trabalho (privacidade, regras e riscos)",
      "Outro",
    ],
    otherOption: "Outro",
  },
  {
    id: "quem_paga",
    label: "Quem paga pelas ferramentas de IA que você usa?",
    kind: "select",
    required: true,
    options: [
      FORM_PAGA_DO_BOLSO[0],
      "A empresa ou instituição onde trabalho ou estudo",
      FORM_PAGA_DO_BOLSO[1],
      "Ninguém: só uso versões gratuitas",
      "Não uso ferramentas de IA",
    ],
  },
  {
    id: "gasto_mensal",
    label: "Quanto você paga por mês, somando todas as ferramentas de IA?",
    kind: "select",
    subOf: "quem_paga",
    shownWhen: { questionId: "quem_paga", anyOf: FORM_PAGA_DO_BOLSO },
    help: "Conte só a parte que sai do seu bolso; se o plano for anual, divida por 12. Para referência: planos como ChatGPT Plus, Claude Pro e Google AI Pro custam cerca de R$ 100 por mês.",
    options: ["Até R$ 50", "De R$ 51 a R$ 150", "De R$ 151 a R$ 400", "De R$ 401 a R$ 900", "Mais de R$ 900"],
  },
  {
    id: "maior_gasto",
    label: "Nos últimos dois anos, quanto custou, no total, o curso, mentoria ou material de estudo mais caro que você pagou do próprio bolso?",
    kind: "select",
    required: true,
    help: "De qualquer assunto: inclui aulas, workshops, eventos, livros e guias. Conte o preço cheio, mesmo parcelado. Não conte faculdade nem pós-graduação.",
    options: [
      "Não paguei por nenhum",
      "Até R$ 100",
      "De R$ 101 a R$ 300",
      "De R$ 301 a R$ 1.000",
      "De R$ 1.001 a R$ 3.000",
      "Mais de R$ 3.000",
      "Prefiro não dizer",
    ],
  },
  {
    id: "conversa",
    label: "Toparia uma conversa de 20 minutos comigo sobre o que você quer fazer com IA e o que falta para chegar lá?",
    kind: "checkbox",
    help: "Por chamada de vídeo ou telefone, no horário que for melhor para você. Não precisa entender de IA, e a conversa não é para vender nada. Escolho algumas pessoas por vez e escrevo para o e-mail com que você está respondendo, então nem todo mundo recebe o convite.",
    helpAfter: true,
    options: [FORM_CONVERSA_SIM],
  },
];

/**
 * @pure — confere a coerência interna da lista de perguntas; devolve os
 * problemas (lista vazia = ok). Travado pelo teste do contrato:
 *  - ids únicos; `otherOption`/`exclusiveOption` entre as opções;
 *  - `hiddenWhen`/`shownWhen`/`optionsFrom`/`subOf` só apontam para pergunta
 *    ANTERIOR (a validação no servidor avalia em ordem), e as opções citadas
 *    existem nela; `optionsFrom` só com opções da pergunta de origem;
 *  - `maxChoices >= 1`; campos de um tipo só no tipo dele (`exclusiveOption`
 *    e `maxChoices` só em caixa, `optionsFrom` só em escolha única,
 *    `placeholder` só em aberta).
 */
export function validateFormQuestions(qs: readonly FormQuestion[]): string[] {
  const errs: string[] = [];
  const before = new Map<string, FormQuestion>();
  for (const q of qs) {
    if (before.has(q.id)) errs.push(`${q.id}: id repetido`);
    const ref = (field: string, id: string | undefined): FormQuestion | null => {
      if (id == null) return null;
      const t = before.get(id);
      if (!t) errs.push(`${q.id}: ${field} aponta para "${id}", que não é uma pergunta anterior`);
      return t ?? null;
    };
    const optsOf = (t: FormQuestion | null) => (t && isChoiceQuestion(t) ? t.options : []);
    const hw = ref("hiddenWhen", q.hiddenWhen?.questionId);
    if (q.hiddenWhen && hw && !optsOf(hw).includes(q.hiddenWhen.option)) errs.push(`${q.id}: hiddenWhen.option fora das opções de ${hw.id}`);
    const sw = ref("shownWhen", q.shownWhen?.questionId);
    if (q.shownWhen && sw) {
      for (const o of q.shownWhen.anyOf ?? []) if (!optsOf(sw).includes(o)) errs.push(`${q.id}: shownWhen.anyOf "${o}" fora das opções de ${sw.id}`);
      if (q.shownWhen.minChecked != null && (sw.kind !== "checkbox" || q.shownWhen.minChecked < 1)) errs.push(`${q.id}: shownWhen.minChecked exige caixa e valor >= 1`);
      if (q.shownWhen.anyOf == null && q.shownWhen.minChecked == null) errs.push(`${q.id}: shownWhen sem anyOf nem minChecked`);
    }
    ref("subOf", q.subOf);
    if (isChoiceQuestion(q)) {
      if (q.options.length === 0) errs.push(`${q.id}: sem opções`);
      if (q.otherOption != null && !q.options.includes(q.otherOption)) errs.push(`${q.id}: otherOption fora das opções`);
      if (q.exclusiveOption != null && (q.kind !== "checkbox" || !q.options.includes(q.exclusiveOption))) errs.push(`${q.id}: exclusiveOption só em caixa e entre as opções`);
      if (q.maxChoices != null && (q.kind !== "checkbox" || !Number.isInteger(q.maxChoices) || q.maxChoices < 1)) errs.push(`${q.id}: maxChoices só em caixa e >= 1`);
      if (q.optionsFrom != null) {
        if (q.kind !== "select") errs.push(`${q.id}: optionsFrom só em escolha única`);
        const src = ref("optionsFrom", q.optionsFrom);
        if (src) for (const o of q.options) if (!optsOf(src).includes(o)) errs.push(`${q.id}: opção "${o}" fora de ${src.id}`);
      }
      if ("placeholder" in q) errs.push(`${q.id}: placeholder só em pergunta aberta`);
    } else {
      for (const f of ["options", "exclusiveOption", "otherOption", "maxChoices", "optionsFrom"]) if (f in q) errs.push(`${q.id}: ${f} só em pergunta de escolha`);
    }
    before.set(q.id, q);
  }
  return errs;
}

/** Perguntas numeradas (sem `subOf`) — "São até 12 perguntas". */
export function numberedQuestions(questions: readonly FormQuestion[] = FORM_QUESTIONS): FormQuestion[] {
  return questions.filter((q) => !q.subOf);
}

/** @pure — a pergunta fica escondida dadas as respostas JÁ validadas das anteriores. */
export function isQuestionHidden(q: FormQuestion, answers: Readonly<Record<string, string>>): boolean {
  if (q.hiddenWhen) {
    const v = answers[q.hiddenWhen.questionId];
    if (v != null && splitMultiAnswer(v).includes(q.hiddenWhen.option)) return true;
  }
  if (q.shownWhen) {
    const v = answers[q.shownWhen.questionId];
    const picked = v == null ? [] : splitMultiAnswer(v);
    if (q.shownWhen.anyOf && !q.shownWhen.anyOf.some((o) => picked.includes(o))) return true;
    if (q.shownWhen.minChecked != null && picked.length < q.shownWhen.minChecked) return true;
  }
  return false;
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

/** Trunca por caractere (code point), nunca no meio de um par UTF-16. */
function truncateCodePoints(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join("");
}

/**
 * @pure — limpa texto livre: tira marcação HTML (tags e `<`/`>` soltos) e
 * caracteres de controle, faz trim e TRUNCA em `max` caracteres (code points:
 * um emoji na fronteira nunca vira meia surrogate). `multiline` mantém as
 * quebras de linha (no máximo uma linha em branco seguida); sem ele vira uma
 * linha só. O campo já tem `maxlength`, então só um envio fora do navegador
 * passa do limite; truncar não perde a resposta inteira por um excesso.
 * `""` = sem texto.
 */
export function cleanFreeText(raw: string, max: number, multiline = false): string {
  let s = String(raw ?? "")
    .replace(/<\/?[a-zA-Z!][^<>]*>/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\r\n?/g, "\n");
  if (multiline) {
    s = s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  } else {
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
  }
  return truncateCodePoints(s.trim(), max).trim();
}

/** @pure — texto do "Outro/Outra": uma linha, até `FORM_OTHER_TEXT_MAX_LEN`. */
export function cleanOtherText(raw: string): string {
  return cleanFreeText(raw, FORM_OTHER_TEXT_MAX_LEN, false);
}

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
  /** Segundos entre a página ser gerada e o envio (só com a hora assinada válida). */
  duration_s?: number;
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
export const FORM_VERSION = 3;

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

type Fields = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * @pure — valida a submissão: e-mail válido, só respostas de perguntas
 * conhecidas (campo desconhecido é descartado, nunca gravado), obrigatórias
 * presentes QUANDO a pergunta aparece, `select` só aceita uma das opções (e,
 * com `optionsFrom`, só uma das marcadas na outra pergunta). `checkbox`:
 * aceita string única ou lista (um valor por caixa marcada); toda opção
 * precisa ser conhecida, a gravação segue a ordem da pergunta e descarta
 * repetição; `exclusiveOption` junto com outra opção é recusado; acima de
 * `maxChoices` é recusado. Pergunta que não aparece (`hiddenWhen`/`shownWhen`
 * avaliados sobre as respostas já validadas) é tratada como ausente: o valor
 * que vier é descartado sem validar (o cliente esconde e desabilita o campo,
 * mas um navegador sem JavaScript ainda pode mandá-lo). Texto livre é limpo
 * por `cleanFreeText` (multilinha no `textarea`). Pergunta com `otherOption`:
 * o texto de `{id}_outro` (opcional) só é gravado quando essa opção foi
 * marcada, limpo e truncado por `cleanOtherText`; sem a opção marcada, o
 * texto é descartado sem erro.
 */
export function parseFormSubmission(
  fields: Fields,
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
      if (q.maxChoices != null && chosen.length > q.maxChoices) {
        return { ok: false, error: `marque no máximo ${q.maxChoices} opções em: ${q.label}` };
      }
      answers[q.id] = chosen.join(FORM_MULTI_SEPARATOR);
      addOtherText(q, chosen, fields, answers);
      continue;
    }
    if (q.kind === "select") {
      const v = firstValue(raw).trim();
      if (v === "") {
        if (q.required) return { ok: false, error: `resposta obrigatória ausente: ${q.label}` };
        continue;
      }
      const allowed = q.optionsFrom != null ? q.options.filter((o) => splitMultiAnswer(answers[q.optionsFrom!] ?? "").includes(o)) : q.options;
      if (!allowed.includes(v)) return { ok: false, error: `opção inválida em: ${q.label}` };
      answers[q.id] = v;
      addOtherText(q, [v], fields, answers);
      continue;
    }
    const text = cleanFreeText(firstValue(raw), FORM_ANSWER_MAX_LEN, q.kind === "textarea");
    if (text === "") {
      if (q.required) return { ok: false, error: `resposta obrigatória ausente: ${q.label}` };
      continue;
    }
    answers[q.id] = text;
  }
  return { ok: true, submission: { email, answers } };
}

/** Grava o texto do "Outro/Outra" só se a opção foi marcada e o texto não é vazio. */
function addOtherText(q: ChoiceQuestion, chosen: readonly string[], fields: Fields, answers: Record<string, string>): void {
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
 * preencheu" (o que reenviaria lembretes a quem já respondeu). Lê os dois
 * formatos: v1/v2 (sem `form_version`) e v3 (`form_version`, `duration_s`).
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
    const dur = (r as FormResponse).duration_s;
    if (typeof dur === "number" && Number.isFinite(dur) && dur >= 0) rec.duration_s = dur;
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

/**
 * @pure — a resposta mais recente de cada e-mail (por `submitted_at`; empate
 * fica com a que veio depois na lista). O perfil e os lembretes usam esta.
 * A ordem de saída é a da 1ª aparição de cada e-mail.
 */
export function latestFormResponses<T extends Pick<FormResponse, "email" | "submitted_at">>(responses: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const r of responses) {
    const k = normalizeFormEmail(r.email);
    const cur = best.get(k);
    if (!cur || Date.parse(r.submitted_at) >= Date.parse(cur.submitted_at)) best.set(k, r);
  }
  return [...best.values()];
}

/** Resumo do tempo de preenchimento (segundos) das respostas v3 mais recentes. */
export interface FormDurationSummary {
  /** Respostas (mais recente por e-mail) por versão (`v{formVersionOf}`; sem o campo = `v2`). */
  by_version: Record<string, number>;
  /** Envios no total, contando o histórico de quem respondeu mais de uma vez. */
  submissions: number;
  with_duration: number;
  median_s: number | null;
  p75_s: number | null;
}

/** @pure — percentil por posição mais próxima (sem interpolação). */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** @pure — contagem por versão e mediana/p75 do `duration_s` (mais recente por e-mail). */
export function summarizeFormResponses(responses: readonly FormResponse[]): FormDurationSummary {
  const latest = latestFormResponses(responses);
  const by_version: Record<string, number> = {};
  for (const r of latest) {
    const v = `v${formVersionOf(r)}`;
    by_version[v] = (by_version[v] ?? 0) + 1;
  }
  const durs = latest.map((r) => r.duration_s).filter((d): d is number => typeof d === "number").sort((a, b) => a - b);
  return { by_version, submissions: responses.length, with_duration: durs.length, median_s: percentile(durs, 0.5), p75_s: percentile(durs, 0.75) };
}

/** Chave KV LEGADA (v1/v2: uma por e-mail, a última vencia). Só leitura desde a v3. */
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
