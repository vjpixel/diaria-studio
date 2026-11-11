/**
 * onboarding-form-partial-results.ts (#12583)
 *
 * Resultado PARCIAL do formulário (formulario.diar.ia.br, #10605) para o
 * editor acompanhar sozinho, pelo Studio (Assinantes > Formulário), sem pedir
 * a uma sessão. Lógica pura: recebe as respostas como o Worker as devolve
 * (`GET /api/respostas`, já lidas por `fetchFormResponsesReal`) e as pessoas
 * do store (`data/onboarding/store.json` → `followup.people`) e monta:
 *
 *  - total de respondentes (resposta mais recente por e-mail), separado por
 *    origem do convite: lote da base (`form_base`), onboarding (`form`, o D+6
 *    da escada) ou sem convite registrado no store;
 *  - contagem por opção em cada pergunta de marcar de `FORM_QUESTIONS`
 *    (só respostas da versão atual das perguntas; as de versões anteriores
 *    são contadas à parte, porque as opções eram outras);
 *  - respostas abertas (`relato_falha` e os textos de "Outro/Outra"), SEM
 *    e-mail, mais recentes primeiro;
 *  - quantas pessoas toparam a conversa de 20 minutos e, num bloco separado,
 *    quem (e-mail + data), para o editor escrever, com a marcação da persona 2
 *    e as faixas de gasto, ordenado por potencial de compra (#12715);
 *  - quantos respondentes estão na persona 2, "Quem já paga para aprender".
 *
 * Respostas de teste (os endereços do editor, `EDITOR_SEED_EMAILS`, inclusive
 * com `+sufixo`) ficam fora de tudo e são só contadas.
 *
 * A visão agregada nunca carrega e-mail: o único campo com e-mail é
 * `conversa.pessoas`, que a página mostra num bloco à parte.
 */

import {
  FORM_NADA_DISSO,
  FORM_PAGA_DO_BOLSO,
  FORM_QUESTIONS,
  FORM_VERSION,
  formVersionOf,
  isChoiceQuestion,
  latestFormResponses,
  normalizeFormEmail,
  otherTextFieldId,
  splitMultiAnswer,
  type FormQuestion,
  type FormResponse,
} from "./onboarding-form-contract.ts";
import { formInviteOf, type FollowupPerson } from "./onboarding-followup.ts";
import { EDITOR_SEED_EMAILS } from "./editor-copy.ts";

/** Origem do convite que a pessoa recebeu primeiro. */
export type FormResponseOrigin = "base" | "onboarding" | "sem_convite";

export interface FormOptionCount {
  opcao: string;
  n: number;
}

export interface FormChoiceTally {
  id: string;
  pergunta: string;
  /** `select` = escolha única; `checkbox` = várias opções. */
  tipo: "select" | "checkbox";
  /** Quantas pessoas responderam esta pergunta (pergunta condicional pode ter menos que o total). */
  responderam: number;
  /** Na ordem das opções da pergunta, inclusive as com zero. */
  opcoes: FormOptionCount[];
  /** Respostas com valor que não está entre as opções atuais (não deveria acontecer na versão atual). */
  fora_da_lista: number;
}

export interface FormOpenAnswer {
  /** Dia (AAAA-MM-DD) do envio. */
  data: string;
  texto: string;
}

export interface FormOpenAnswersBlock {
  id: string;
  pergunta: string;
  respostas: FormOpenAnswer[];
}

export interface FormConversaPerson {
  email: string;
  data: string;
  origem: FormResponseOrigin;
  /** #12715: se encaixa na persona 2, "Quem já paga para aprender" (`isPersona2`). */
  persona2: boolean;
  /** #12715: faixa de `maior_gasto` (curso ou material mais caro), como respondida; `null` = em branco. */
  maior_gasto: string | null;
  /** #12715: faixa de `gasto_mensal` (ferramentas de IA), como respondida; `null` = em branco ou pergunta não exibida. */
  gasto_mensal: string | null;
}

export interface FormPartialResults {
  /** Respondentes (mais recente por e-mail), sem as respostas de teste. */
  total: number;
  por_origem: Record<FormResponseOrigin, number>;
  /** Respostas de teste (endereços do editor) deixadas de fora. */
  testes_excluidos: number;
  /** Respondentes cuja resposta mais recente é de uma versão anterior das perguntas (fora das contagens por opção). */
  versao_anterior: number;
  /** Versão das perguntas que as contagens usam. */
  versao_atual: number;
  /** Data (AAAA-MM-DD) da resposta mais antiga e da mais recente consideradas. */
  primeira: string | null;
  ultima: string | null;
  perguntas: FormChoiceTally[];
  abertas: FormOpenAnswersBlock[];
  /** #12715: respondentes (sobre `total`) na persona 2, "Quem já paga para aprender". */
  persona2: number;
  conversa: {
    toparam: number;
    /**
     * Único bloco com e-mail. Ordem por potencial de compra (#12715,
     * `comparePurchasePotential`): persona 2 primeiro; dentro de cada grupo,
     * maior faixa de `maior_gasto`, depois maior faixa de `gasto_mensal`; no
     * empate, mais recente primeiro.
     */
    pessoas: FormConversaPerson[];
  };
}

/** #12715: opções de `maior_gasto` que não contam como "já paga para aprender". */
export const FORM_MAIOR_GASTO_NENHUM = "Não paguei por nenhum";
export const FORM_MAIOR_GASTO_NAO_DIZ = "Prefiro não dizer";

/**
 * @pure — persona 2, "Quem já paga para aprender" (#12715): os três critérios
 * juntos.
 *  - `maior_gasto` respondido e diferente de "Não paguei por nenhum" e de
 *    "Prefiro não dizer";
 *  - `quem_paga` é "Eu, do próprio bolso" ou "Eu e a empresa, uma parte cada"
 *    (`FORM_PAGA_DO_BOLSO`);
 *  - `produto_formato` não contém "Nada disso, a newsletter já me basta".
 * A comparação é pelo texto exato da opção: resposta de versão anterior com
 * outro texto não entra (não se adivinha equivalência).
 */
export function isPersona2(answers: Readonly<Record<string, string | undefined>>): boolean {
  const maior = (answers.maior_gasto ?? "").trim();
  if (maior === "" || maior === FORM_MAIOR_GASTO_NENHUM || maior === FORM_MAIOR_GASTO_NAO_DIZ) return false;
  const quem = (answers.quem_paga ?? "").trim();
  if (!(FORM_PAGA_DO_BOLSO as readonly string[]).includes(quem)) return false;
  return !splitMultiAnswer(answers.produto_formato ?? "").includes(FORM_NADA_DISSO);
}

/**
 * @pure — posição da faixa na escala crescente da pergunta (índice da opção
 * em `FORM_QUESTIONS`). Em branco, fora da lista ou "Prefiro não dizer" = -1:
 * sem informação fica abaixo da menor faixa conhecida, inclusive de "Não
 * paguei por nenhum" (#12715, premissa conservadora: não se presume gasto que
 * a pessoa não declarou).
 */
export function spendBandRank(
  questionId: "maior_gasto" | "gasto_mensal",
  value: string | null | undefined,
  questions: readonly FormQuestion[] = FORM_QUESTIONS,
): number {
  const v = (value ?? "").trim();
  if (v === "" || v === FORM_MAIOR_GASTO_NAO_DIZ) return -1;
  const q = questions.find((x) => x.id === questionId);
  if (!q || !isChoiceQuestion(q)) return -1;
  return q.options.indexOf(v);
}

/**
 * @pure — comparador de potencial de compra (#12715) para `Array.sort`
 * (estável): persona 2 primeiro; dentro de cada grupo, maior faixa de
 * `maior_gasto`; no empate, maior faixa de `gasto_mensal`. Empate total
 * devolve 0, e a ordem anterior (mais recente primeiro) se mantém.
 * Faixas, não score: a amostra é pequena e as respostas são faixas.
 */
export function comparePurchasePotential(
  a: Pick<FormConversaPerson, "persona2" | "maior_gasto" | "gasto_mensal">,
  b: Pick<FormConversaPerson, "persona2" | "maior_gasto" | "gasto_mensal">,
  questions: readonly FormQuestion[] = FORM_QUESTIONS,
): number {
  if (a.persona2 !== b.persona2) return a.persona2 ? -1 : 1;
  const maior = spendBandRank("maior_gasto", b.maior_gasto, questions) - spendBandRank("maior_gasto", a.maior_gasto, questions);
  if (maior !== 0) return maior;
  return spendBandRank("gasto_mensal", b.gasto_mensal, questions) - spendBandRank("gasto_mensal", a.gasto_mensal, questions);
}

function answerOrNull(r: FormResponse, id: string): string | null {
  const v = (r.answers[id] ?? "").trim();
  return v === "" ? null : v;
}

/** Tira o `+sufixo` da parte local do e-mail (para casar os testes do editor). */
function stripPlusTag(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return email;
  const local = email.slice(0, at);
  const plus = local.indexOf("+");
  return plus < 0 ? email : `${local.slice(0, plus)}${email.slice(at)}`;
}

/** @pure — o e-mail é um dos endereços de teste do editor (com ou sem `+sufixo`). */
export function isFormTestEmail(email: string, testEmails: readonly string[] = EDITOR_SEED_EMAILS): boolean {
  const e = stripPlusTag(normalizeFormEmail(email));
  return testEmails.some((t) => stripPlusTag(normalizeFormEmail(t)) === e);
}

/** @pure — índice e-mail → pessoa do store, casando também pelos `previous_emails` (#10774). */
function indexPeopleByEmail(people: Readonly<Record<string, FollowupPerson>>): Map<string, FollowupPerson> {
  const byEmail = new Map<string, FollowupPerson>();
  for (const p of Object.values(people)) byEmail.set(normalizeFormEmail(p.email), p);
  for (const p of Object.values(people)) {
    for (const e of p.previous_emails ?? []) {
      const k = normalizeFormEmail(e);
      if (k !== "" && !byEmail.has(k)) byEmail.set(k, p);
    }
  }
  return byEmail;
}

/**
 * @pure — origem do respondente pelo convite registrado no store. Sem convite
 * registrado por pessoa, mas entre os destinatários do e-mail da base
 * (`followup.base_invite.recipient_emails`): lote da base. Cobre o intervalo
 * entre o envio e o registro `form_base` por pessoa (passo `confirm` do
 * `onboarding-form-base-prep.ts` ou o executor diário), e o
 * `sent_unverified`, que nunca grava esse registro.
 */
export function formResponseOrigin(person: FollowupPerson | undefined, inBaseRecipients = false): FormResponseOrigin {
  const invite = formInviteOf(person);
  if (invite === "form_base") return "base";
  if (invite === "form") return "onboarding";
  return inBaseRecipients ? "base" : "sem_convite";
}

function day(iso: string): string {
  return String(iso ?? "").slice(0, 10);
}

/** Valores marcados numa resposta: lista para caixa, valor único para escolha única. */
function chosenValues(q: FormQuestion, raw: string): string[] {
  if (q.kind === "checkbox") return splitMultiAnswer(raw);
  const v = raw.trim();
  return v === "" ? [] : [v];
}

export interface BuildFormPartialResultsOptions {
  /** `followup.people` do store; ausente = todos caem em `sem_convite`. */
  people?: Readonly<Record<string, FollowupPerson>>;
  /** `followup.base_invite.recipient_emails` do store (ver `formResponseOrigin`). */
  baseRecipientEmails?: readonly string[];
  questions?: readonly FormQuestion[];
  testEmails?: readonly string[];
  currentVersion?: number;
}

/**
 * @pure — agrega as respostas do formulário (ver o cabeçalho do módulo).
 * `responses` pode trazer o histórico inteiro (várias por e-mail): vale a
 * mais recente de cada pessoa, como no executor e no perfil de audiência.
 */
export function buildFormPartialResults(responses: readonly FormResponse[], opts: BuildFormPartialResultsOptions = {}): FormPartialResults {
  const questions = opts.questions ?? FORM_QUESTIONS;
  const testEmails = opts.testEmails ?? EDITOR_SEED_EMAILS;
  const currentVersion = opts.currentVersion ?? FORM_VERSION;
  const byEmail = indexPeopleByEmail(opts.people ?? {});
  const baseRecipients = new Set((opts.baseRecipientEmails ?? []).map(normalizeFormEmail));

  const latest = latestFormResponses(responses);
  const kept: FormResponse[] = [];
  let testes = 0;
  for (const r of latest) {
    if (isFormTestEmail(r.email, testEmails)) testes++;
    else kept.push(r);
  }

  const porOrigem: Record<FormResponseOrigin, number> = { base: 0, onboarding: 0, sem_convite: 0 };
  const origemOf = new Map<FormResponse, FormResponseOrigin>();
  for (const r of kept) {
    const email = normalizeFormEmail(r.email);
    const o = formResponseOrigin(byEmail.get(email), baseRecipients.has(email));
    origemOf.set(r, o);
    porOrigem[o]++;
  }

  const current = kept.filter((r) => formVersionOf(r) === currentVersion);
  const dates = kept.map((r) => day(r.submitted_at)).filter((d) => d !== "").sort();

  const perguntas: FormChoiceTally[] = [];
  const abertas: FormOpenAnswersBlock[] = [];
  // Mais recentes primeiro, para a lista de abertas e a da conversa.
  const newestFirst = [...current].sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : a.submitted_at > b.submitted_at ? -1 : 0));

  for (const q of questions) {
    if (!isChoiceQuestion(q)) {
      const respostas = newestFirst
        .map((r) => ({ data: day(r.submitted_at), texto: (r.answers[q.id] ?? "").trim() }))
        .filter((a) => a.texto !== "");
      abertas.push({ id: q.id, pergunta: q.label, respostas });
      continue;
    }
    if (q.id === "conversa") continue; // bloco próprio, abaixo
    const counts = new Map<string, number>(q.options.map((o) => [o, 0]));
    let responderam = 0;
    let fora = 0;
    for (const r of current) {
      const vals = chosenValues(q, r.answers[q.id] ?? "");
      if (vals.length === 0) continue;
      responderam++;
      for (const v of vals) {
        if (counts.has(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
        else fora++;
      }
    }
    perguntas.push({
      id: q.id,
      pergunta: q.label,
      tipo: q.kind,
      responderam,
      opcoes: q.options.map((o) => ({ opcao: o, n: counts.get(o) ?? 0 })),
      fora_da_lista: fora,
    });
    if (q.otherOption) {
      const respostas = newestFirst
        .map((r) => ({ data: day(r.submitted_at), texto: (r.answers[otherTextFieldId(q)] ?? "").trim() }))
        .filter((a) => a.texto !== "");
      abertas.push({ id: otherTextFieldId(q), pergunta: `${q.label} (${q.otherOption})`, respostas });
    }
  }

  // A conversa conta em qualquer versão, pelo mesmo critério da lista de
  // `onboarding-form-conversas.ts`: resposta não vazia (a pergunta é uma
  // caixa única, `FORM_CONVERSA_SIM`).
  const pessoas: FormConversaPerson[] = [...kept]
    .filter((r) => (r.answers.conversa ?? "").trim() !== "")
    .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : a.submitted_at > b.submitted_at ? -1 : 0))
    .map((r) => ({
      email: normalizeFormEmail(r.email),
      data: day(r.submitted_at),
      origem: origemOf.get(r) ?? "sem_convite",
      persona2: isPersona2(r.answers),
      maior_gasto: answerOrNull(r, "maior_gasto"),
      gasto_mensal: answerOrNull(r, "gasto_mensal"),
    }))
    // #12715: estável, então o empate segue mais recente primeiro.
    .sort((a, b) => comparePurchasePotential(a, b, questions));

  return {
    total: kept.length,
    por_origem: porOrigem,
    testes_excluidos: testes,
    versao_anterior: kept.length - current.length,
    versao_atual: currentVersion,
    primeira: dates[0] ?? null,
    ultima: dates[dates.length - 1] ?? null,
    perguntas,
    abertas,
    persona2: kept.filter((r) => isPersona2(r.answers)).length,
    conversa: { toparam: pessoas.length, pessoas },
  };
}
