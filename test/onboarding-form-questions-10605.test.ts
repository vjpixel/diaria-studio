/**
 * test/onboarding-form-questions-10605.test.ts (#10605)
 *
 * Perguntas v3 do formulário do onboarding (aprovadas pelo editor em
 * 09/11/2026), validação no servidor, o HTML do Worker (rádio sempre,
 * condicionais, hora assinada), os rascunhos dos 5 e-mails (base, D+6, 3
 * lembretes) como semente do
 * `--init-snippets` (com o marcador pendente que trava o envio) e o perfil de
 * audiência só do formulário (`update-audience.ts`, decisão 10).
 * Nada toca rede nem `data/` do repo: tudo em `mkdtempSync`, `fetch` e env
 * injetados.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FORM_QUESTIONS,
  FORM_ANSWER_MAX_LEN,
  FORM_CONVERSA_SIM,
  FORM_MULTI_SEPARATOR,
  FORM_NADA_DISSO,
  FORM_OTHER_TEXT_MAX_LEN,
  FORM_PAGA_DO_BOLSO,
  LEGACY_FORM_ANSWER_IDS,
  cleanOtherText,
  latestFormResponses,
  numberedQuestions,
  validateFormQuestions,
  otherTextFieldId,
  parseFormSubmission,
  summarizeFormResponses,
  type ChoiceQuestion,
  type FormResponse,
} from "../scripts/lib/onboarding-form-contract.ts";
import { FORM_RENDERED_FIELD, MAX_FORM_DURATION_S, formDurationFromToken, signFormEmail, signFormRenderedAt } from "../scripts/lib/onboarding-form-link-sig.ts";
import {
  OPEN_ANSWER_MARK,
  SURVEY_MATCHERS,
  onboardingFormToSurveyResponses,
  isOnboardingFormResponse,
  type SurveyMatcherKey,
} from "../scripts/lib/audience-survey-questions.ts";
import { collectFormFields, escapeHtml, renderFormHtml, renderThanksHtml, FORM_SCRIPT } from "../workers/onboarding-form/src/render.ts";
import {
  FORM_URL_PLACEHOLDER,
  baseInviteContentGate,
  formContentGate,
  parseFollowupSnippet,
  resolveFollowupConfig,
  snippetTemplate,
  type FollowupSnippets,
} from "../scripts/lib/onboarding-followup.ts";
import { PENDING_BODY_MARKER } from "../scripts/lib/onboarding-state.ts";
import { FOLLOWUP_DRAFTS_DIR, initFollowupSnippets, loadFollowupSnippets } from "../scripts/onboarding-followup-run.ts";
import {
  main as updateAudienceMain,
  renderProductInterestSection,
  renderDeclaredUseBlocks,
  renderWhoTheyAreBlocks,
  renderRecentUseBlock,
  formRespondentsNote,
  carryOverDeclaredSections,
  PREVIOUS_DECLARED_SUFFIX,
} from "../scripts/update-audience.ts";
import { buildAudienceSummary } from "../scripts/build-diaria-dashboard-data.ts";
import {
  loadOnboardingFormSurveyResponses,
  fetchOnboardingFormResponsesReal,
  AudienceAbort,
  type PlatformConfig,
} from "../scripts/audience-run.ts";

const EXPECTED_MATCHER: Record<string, SurveyMatcherKey> = {
  uso_ia: "aiUse",
  situacao: "situation",
  area: "areas",
  uso_recente: "recentUse",
  ferramentas: "tools",
  motivacao: "goals",
  dificuldades: "obstacles",
  relato_falha: "failureStory",
  produto_formato: "productFormats",
  produto_escolha: "productChoice",
  produto_tema: "courseTopics",
  quem_paga: "whoPays",
  gasto_mensal: "monthlySpend",
  maior_gasto: "biggestSpend",
  conversa: "interview",
};

/** Prompts REAIS da survey de perfil antiga da Beehiiv (conferidos em
 *  21/10/2026) — só para provar que ela não entra mais no perfil. */
const BEEHIIV_SURVEY_PROMPTS = [
  "Como você classificaria seu nível de conhecimento em IA?",
  "Quais seções ou tipos de conteúdo mais te interessam?",
  "Qual o setor de atuação da organização onde você trabalha?",
  "Qual é a sua principal área de atuação?",
];

const ARROWS = /[←→]/;
const LEGACY_BRAND = /Diar\.ia(?!\.br)/;
const DRAFTS = ["pesquisa-base.md", "onboarding-formulario.md", "formulario-lembrete-1.md", "formulario-lembrete-2.md", "formulario-lembrete-3.md"];

function matchersOf(label: string): SurveyMatcherKey[] {
  return (Object.keys(SURVEY_MATCHERS) as SurveyMatcherKey[]).filter((k) => SURVEY_MATCHERS[k].test(label));
}

function choice(id: string): ChoiceQuestion {
  const q = FORM_QUESTIONS.find((x) => x.id === id);
  assert.ok(q && (q.kind === "select" || q.kind === "checkbox"), id);
  return q as ChoiceQuestion;
}

/** Envio mínimo válido: todas as obrigatórias, sem as condicionais. */
const BASE: Record<string, string | string[]> = {
  email: "a@x.com",
  uso_ia: "Uso pouco: só testei ou uso de vez em quando",
  situacao: "Estudante",
  area: "Contabilidade",
  uso_recente: "Mudei a forma de fazer uma tarefa",
  ferramentas: "ChatGPT",
  motivacao: "Ganhar tempo nas tarefas do meu trabalho",
  dificuldades: "Falta tempo para aprender",
  produto_formato: FORM_NADA_DISSO,
  quem_paga: "Ninguém: só uso versões gratuitas",
  maior_gasto: "Até R$ 100",
};
const parse = (extra: Record<string, string | string[] | undefined> = {}) => parseFormSubmission({ ...BASE, ...extra });

describe("#10605 v3: perguntas do formulário (aprovadas em 09/11/2026)", () => {
  it("12 numeradas na ordem aprovada, 3 subperguntas sem número, ids únicos", () => {
    assert.deepEqual(numberedQuestions().map((q) => q.id), [
      "uso_ia", "situacao", "area", "uso_recente", "ferramentas", "motivacao", "dificuldades",
      "produto_formato", "produto_tema", "quem_paga", "maior_gasto", "conversa",
    ]);
    assert.deepEqual(FORM_QUESTIONS.filter((q) => q.subOf).map((q) => [q.id, q.subOf]), [
      ["relato_falha", "dificuldades"], ["produto_escolha", "produto_formato"], ["gasto_mensal", "quem_paga"],
    ]);
    assert.equal(new Set(FORM_QUESTIONS.map((q) => q.id)).size, FORM_QUESTIONS.length);
    for (const q of FORM_QUESTIONS.filter((x) => x.subOf)) {
      const i = FORM_QUESTIONS.indexOf(q);
      assert.equal(FORM_QUESTIONS[i - 1].id, q.subOf, `${q.id} logo depois da mãe`);
    }
  });

  it("validateFormQuestions: FORM_QUESTIONS coerente; pega referência para frente, opção inexistente e campo no tipo errado", () => {
    assert.deepEqual(validateFormQuestions(FORM_QUESTIONS), []);
    const bad = validateFormQuestions([
      { id: "a", label: "A", kind: "select", options: ["x", "y"], otherOption: "z", hiddenWhen: { questionId: "b", option: "x" } },
      { id: "b", label: "B", kind: "checkbox", options: ["x"], maxChoices: 0, exclusiveOption: "w" },
      { id: "c", label: "C", kind: "select", options: ["x", "q"], optionsFrom: "b", shownWhen: { questionId: "a", anyOf: ["nada"] } },
      { id: "d", label: "D", kind: "textarea", maxChoices: 2 } as never,
      { id: "a", label: "A2", kind: "text" },
    ]);
    for (const re of [/a: otherOption/, /a: hiddenWhen aponta para "b"/, /b: maxChoices/, /b: exclusiveOption/, /c: opção "q" fora de b/, /c: shownWhen.anyOf "nada"/, /d: maxChoices só em pergunta de escolha/, /a: id repetido/]) {
      assert.ok(bad.some((e) => re.test(e)), String(re));
    }
  });

  it("só gasto mensal, relato e conversa são opcionais", () => {
    assert.deepEqual(FORM_QUESTIONS.filter((q) => !q.required).map((q) => q.id), ["relato_falha", "gasto_mensal", "conversa"]);
  });

  it("saíram nível, seções, inglês, preço e o 'mais alguma coisa' (lidos como legado)", () => {
    for (const id of ["nivel_ia", "conteudo", "leitura_ingles", "produto_preco", "sugestao"]) {
      assert.ok(!FORM_QUESTIONS.some((q) => q.id === id), id);
      assert.ok(LEGACY_FORM_ANSWER_IDS.includes(id), id);
    }
  });

  it("rótulos e opções exatos (fonte: aprovado-261109.html)", () => {
    assert.equal(choice("uso_ia").label, "Como você usa IA hoje?");
    assert.deepEqual(choice("uso_ia").options, [
      "Uso pouco: só testei ou uso de vez em quando",
      "Uso com frequência em tarefas do dia a dia (textos, resumos, pesquisas)",
      "Já montei coisas mais elaboradas (assistentes personalizados, automações, prompts reutilizáveis)",
      "Trabalho com a tecnologia em si: programo, integro por API, treino ou ajusto modelos",
    ]);
    assert.equal(choice("area").options.length, 13);
    assert.equal(choice("area").options[9], "Saúde (medicina, enfermagem, psicologia, farmácia…)");
    assert.equal(choice("area").help, "Se está aposentado(a) ou sem trabalho, marque a área em que trabalhou por último.");
    assert.equal(choice("uso_recente").label, "Pense na última vez que algo que você leu na diar.ia.br foi útil. O que você fez com isso?");
    assert.deepEqual(choice("uso_recente").options.slice(2, 4), ["Comentei ou compartilhei com alguém", "Usei para tomar uma decisão na empresa ou na equipe"]);
    assert.equal(choice("ferramentas").options.length, 14);
    assert.equal(choice("dificuldades").options.length, 10);
    assert.equal(choice("produto_tema").options.length, 12);
    assert.equal(choice("produto_formato").label, "Além da newsletter, o que mais você gostaria que a diar.ia.br oferecesse, mesmo que fosse pago?");
    assert.deepEqual(choice("gasto_mensal").options, ["Até R$ 50", "De R$ 51 a R$ 150", "De R$ 151 a R$ 400", "De R$ 401 a R$ 900", "Mais de R$ 900"]);
    assert.ok(choice("gasto_mensal").help!.startsWith("Conte só a parte que sai do seu bolso"), "sem a 1ª frase, que só explicava a prévia");
    assert.deepEqual(choice("maior_gasto").options, ["Não paguei por nenhum", "Até R$ 100", "De R$ 101 a R$ 300", "De R$ 301 a R$ 1.000", "De R$ 1.001 a R$ 3.000", "Mais de R$ 3.000", "Prefiro não dizer"]);
    assert.deepEqual(choice("conversa").options, [FORM_CONVERSA_SIM]);
    assert.equal(choice("conversa").helpAfter, true);
    const relato = FORM_QUESTIONS.find((q) => q.id === "relato_falha")!;
    assert.equal(relato.kind, "textarea");
    assert.equal((relato as { placeholder?: string }).placeholder, "Ex.: pedi um resumo de um PDF e ele inventou números.");
  });

  it("'Outro/Outra' com texto, exclusivas e 'até 3' onde a spec pede", () => {
    const withOther = FORM_QUESTIONS.filter((q) => (q.kind === "select" || q.kind === "checkbox") && q.otherOption);
    assert.deepEqual(withOther.map((q) => q.id), ["area", "uso_recente", "ferramentas", "motivacao", "dificuldades", "produto_tema"]);
    for (const q of withOther) {
      const c = q as ChoiceQuestion;
      assert.equal(c.options[c.options.length - 1], c.otherOption, `${q.id}: Outro por último`);
      assert.ok(!FORM_QUESTIONS.some((x) => x.id === otherTextFieldId(c)), "a chave do texto não colide com pergunta");
    }
    assert.deepEqual(
      FORM_QUESTIONS.filter((q) => (q.kind === "checkbox") && (q as ChoiceQuestion).exclusiveOption).map((q) => [q.id, (q as ChoiceQuestion).exclusiveOption]),
      [["ferramentas", "Nenhuma"], ["dificuldades", "Nada me atrapalha"], ["produto_formato", FORM_NADA_DISSO]],
    );
    assert.deepEqual(FORM_QUESTIONS.filter((q) => (q as ChoiceQuestion).maxChoices).map((q) => [q.id, (q as ChoiceQuestion).maxChoices]), [["dificuldades", 3], ["produto_tema", 3]]);
  });

  it("toda opção é não vazia, única e não contém o separador", () => {
    for (const q of FORM_QUESTIONS) {
      if (q.kind !== "select" && q.kind !== "checkbox") continue;
      assert.equal(new Set(q.options).size, q.options.length, q.id);
      for (const o of q.options) assert.ok(o.trim() !== "" && !o.includes(FORM_MULTI_SEPARATOR.trim()), `${q.id}: ${o}`);
    }
  });

  it("cada pergunta cai em exatamente um matcher do perfil (o esperado)", () => {
    for (const q of FORM_QUESTIONS) assert.deepEqual(matchersOf(q.label), [EXPECTED_MATCHER[q.id]], `${q.id}: "${q.label}"`);
  });

  it("condicionais: tema some com 'Nada disso'; escolha única com 2+ formatos; gasto mensal só para quem paga do bolso", () => {
    assert.deepEqual(choice("produto_tema").hiddenWhen, { questionId: "produto_formato", option: FORM_NADA_DISSO });
    assert.deepEqual(choice("produto_escolha").shownWhen, { questionId: "produto_formato", minChecked: 2 });
    assert.equal(choice("produto_escolha").optionsFrom, "produto_formato");
    assert.ok(!choice("produto_escolha").options.includes(FORM_NADA_DISSO));
    assert.deepEqual(choice("gasto_mensal").shownWhen?.anyOf, [...FORM_PAGA_DO_BOLSO]);
    for (const o of FORM_PAGA_DO_BOLSO) assert.ok(choice("quem_paga").options.includes(o));
  });

  it("copy do leitor sem seta, sem marca antiga", () => {
    for (const q of FORM_QUESTIONS) {
      const opts = q.kind === "select" || q.kind === "checkbox" ? q.options : [];
      for (const t of [q.label, q.help ?? "", ...opts]) assert.ok(!ARROWS.test(t) && !LEGACY_BRAND.test(t), t);
    }
  });
});

describe("#10605 v3: validação no servidor", () => {
  it("envio mínimo passa; cada obrigatória ausente recusa", () => {
    const r = parse();
    assert.ok(r.ok, r.ok ? "" : r.error);
    for (const id of Object.keys(BASE).filter((k) => k !== "email")) {
      const bad = parse({ [id]: undefined });
      assert.equal(bad.ok, false, id);
    }
  });

  it("caixas: ordem da pergunta, sem repetição; opção desconhecida recusa", () => {
    const opts = choice("ferramentas").options;
    const r = parse({ ferramentas: [opts[3], opts[0], opts[3]] });
    assert.ok(r.ok && r.submission.answers.ferramentas === `${opts[0]}${FORM_MULTI_SEPARATOR}${opts[3]}`);
    assert.equal(parse({ ferramentas: ["ChatGPT", "inventada"] }).ok, false);
  });

  it("exclusivas: 'Nenhuma', 'Nada me atrapalha' e 'Nada disso' não combinam com outra", () => {
    assert.equal(parse({ ferramentas: ["Nenhuma", "ChatGPT"] }).ok, false);
    assert.equal(parse({ dificuldades: ["Nada me atrapalha", "Falta tempo para aprender"] }).ok, false);
    const bad = parse({ produto_formato: [FORM_NADA_DISSO, "Aula ou workshop ao vivo"] });
    assert.ok(!bad.ok && /não combina/.test(bad.error));
    assert.ok(parse({ ferramentas: "Nenhuma" }).ok);
  });

  it("'até 3': quarta opção recusa nas dificuldades e no tema", () => {
    const d = choice("dificuldades").options;
    assert.ok(parse({ dificuldades: d.slice(0, 3) }).ok);
    const four = parse({ dificuldades: d.slice(0, 4) });
    assert.ok(!four.ok && /no máximo 3/.test(four.error));
    const t = choice("produto_tema").options;
    const formato = { produto_formato: "Aula ou workshop ao vivo" };
    assert.ok(parse({ ...formato, produto_tema: t.slice(0, 3) }).ok);
    assert.equal(parse({ ...formato, produto_tema: t.slice(0, 4) }).ok, false);
  });

  it("tema: obrigatório quando aparece, descartado com 'Nada disso'", () => {
    assert.equal(parse({ produto_formato: "Aula ou workshop ao vivo" }).ok, false, "tema obrigatório quando visível");
    const nada = parse({ produto_tema: ["inventada"], produto_tema_outro: "x" });
    assert.ok(nada.ok && !("produto_tema" in nada.submission.answers) && !("produto_tema_outro" in nada.submission.answers));
  });

  it("escolha única: só com 2+ formatos, obrigatória então, e só entre os marcados", () => {
    const um = { produto_formato: "Aula ou workshop ao vivo", produto_tema: "Como escrever bons prompts" };
    const r1 = parse({ ...um, produto_escolha: "Aula ou workshop ao vivo" });
    assert.ok(r1.ok && !("produto_escolha" in r1.submission.answers), "1 formato: escolha descartada");
    const dois = { ...um, produto_formato: ["Aula ou workshop ao vivo", "Mentoria individual ou em grupo pequeno"] };
    assert.equal(parse(dois).ok, false, "2 formatos: escolha obrigatória");
    const ok = parse({ ...dois, produto_escolha: "Mentoria individual ou em grupo pequeno" });
    assert.ok(ok.ok && ok.submission.answers.produto_escolha === "Mentoria individual ou em grupo pequeno");
    assert.equal(parse({ ...dois, produto_escolha: "Curso online gravado, no meu ritmo" }).ok, false, "formato não marcado recusa");
  });

  it("gasto mensal: opcional para quem paga do bolso, descartado para os demais", () => {
    for (const quem of FORM_PAGA_DO_BOLSO) {
      assert.ok(parse({ quem_paga: quem }).ok, "opcional");
      const r = parse({ quem_paga: quem, gasto_mensal: "Até R$ 50" });
      assert.ok(r.ok && r.submission.answers.gasto_mensal === "Até R$ 50");
      assert.equal(parse({ quem_paga: quem, gasto_mensal: "R$ 1 milhão" }).ok, false);
    }
    const empresa = parse({ quem_paga: "A empresa ou instituição onde trabalho ou estudo", gasto_mensal: "Até R$ 50" });
    assert.ok(empresa.ok && !("gasto_mensal" in empresa.submission.answers));
  });

  it("conversa: caixa única opcional", () => {
    assert.ok(parse({ conversa: FORM_CONVERSA_SIM }).ok);
    assert.equal(parse({ conversa: "sim" }).ok, false);
  });

  it("texto do 'Outro/Outra': só com a opção marcada; limpo e truncado", () => {
    const r = parse({ area: "Outra", area_outro: "  Arquitetura\n  e urbanismo  " });
    assert.ok(r.ok && r.submission.answers.area_outro === "Arquitetura e urbanismo");
    const sem = parse({ area: "Contabilidade", area_outro: "Arquitetura" });
    assert.ok(sem.ok && !("area_outro" in sem.submission.answers));
    const fer = parse({ ferramentas: ["ChatGPT", "Outra"], ferramentas_outro: "Mistral" });
    assert.ok(fer.ok && fer.submission.answers.ferramentas_outro === "Mistral");
    const longo = parse({ area: "Outra", area_outro: "a".repeat(FORM_OTHER_TEXT_MAX_LEN + 50) });
    assert.ok(longo.ok && longo.submission.answers.area_outro.length === FORM_OTHER_TEXT_MAX_LEN);
  });

  it("truncamento por caractere: emoji na fronteira nunca vira meia surrogate (thread da PR #12471)", () => {
    const raw = "a".repeat(FORM_OTHER_TEXT_MAX_LEN - 1) + "😀😀";
    const t = cleanOtherText(raw);
    assert.equal(Array.from(t).length, FORM_OTHER_TEXT_MAX_LEN);
    assert.ok(t.endsWith("😀"));
    assert.ok(!/[\uD800-\uDBFF]$/.test(t), "sem surrogate alta solta no fim");
  });

  it("relato de falha: opcional, multilinha, sem HTML nem controle, truncado em FORM_ANSWER_MAX_LEN", () => {
    const r = parse({ relato_falha: "<b>Pedi</b> um resumo\r\n\r\n\r\ne ele\u0000 inventou <script>x</script>" });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.submission.answers.relato_falha, "Pedi um resumo\n\ne ele inventou x");
    const longo = parse({ relato_falha: "b".repeat(FORM_ANSWER_MAX_LEN + 10) });
    assert.ok(longo.ok && longo.submission.answers.relato_falha.length === FORM_ANSWER_MAX_LEN);
    const vazio = parse({ relato_falha: "   " });
    assert.ok(vazio.ok && !("relato_falha" in vazio.submission.answers));
  });

  it("campos de versões anteriores não são gravados", () => {
    const r = parse({ nivel_ia: "x", conteudo: "Radar", leitura_ingles: "Leio normalmente", produto_preco: "Até R$ 100", sugestao: "oi" });
    assert.ok(r.ok);
    if (r.ok) for (const id of LEGACY_FORM_ANSWER_IDS) assert.ok(!(id in r.submission.answers), id);
  });

  it("cleanOtherText: sem HTML, sem controle, uma linha só", () => {
    assert.equal(cleanOtherText('<script>alert("x")</script>Jornalismo'), 'alert("x") Jornalismo');
    assert.equal(cleanOtherText("3 < 5 e 7 > 2"), "3 5 e 7 2");
    assert.equal(cleanOtherText("linha 1\r\nlinha\t2\u0000"), "linha 1 linha 2");
    assert.equal(cleanOtherText("<b></b>"), "");
  });

  it("collectFormFields preserva campos repetidos do POST", () => {
    const f = collectFormFields([["email", "a@x.com"], ["produto_tema", "A"], ["produto_tema", "B"], ["arquivo", {}]]);
    assert.deepEqual(f, { email: "a@x.com", produto_tema: ["A", "B"] });
  });
});

describe("#10605 v3: HTML do formulário", () => {
  const html = renderFormHtml('a+b@x.com"><script>', "SIG", undefined, "123.TOKEN");

  it("e-mail fixo e escapado, hora assinada em campo oculto, textos do topo aprovados", () => {
    assert.ok(html.includes('<input type="hidden" name="email" value="a+b@x.com&quot;&gt;&lt;script&gt;">'));
    assert.ok(html.includes('<input type="hidden" name="sig" value="SIG">'));
    assert.ok(html.includes(`<input type="hidden" name="${FORM_RENDERED_FIELD}" value="123.TOKEN">`));
    assert.ok(html.includes("<h1>Pode me contar um pouco sobre você?</h1>"));
    assert.ok(html.includes("As respostas ficam comigo e servem só para planejar a newsletter e o que oferecer além dela. São até 12 perguntas. Só as marcadas como opcionais podem ficar em branco."));
    assert.ok(!/dois minutos|tr[êe]s minutos/.test(html), "sem promessa de tempo na página");
    assert.ok(!ARROWS.test(html) && !LEGACY_BRAND.test(html));
    assert.ok(!renderFormHtml("a@x.com", "S").includes(`name="${FORM_RENDERED_FIELD}"`), "sem token, sem campo");
  });

  it("nenhum menu suspenso: escolha única vira rádio (inclusive a de 13 opções), múltipla vira caixa", () => {
    assert.ok(!html.includes("<select"));
    for (const q of FORM_QUESTIONS) {
      if (q.kind === "checkbox") assert.ok(html.includes(`type="checkbox" id="${q.id}-0" name="${q.id}"`), q.id);
      else if (q.kind === "select") assert.ok(html.includes(`type="radio" id="${q.id}-0" name="${q.id}"`), q.id);
      else assert.ok(html.includes(`id="${q.id}" name="${q.id}" maxlength="${FORM_ANSWER_MAX_LEN}"`), q.id);
    }
    assert.ok(html.includes('id="area-12" name="area" value="Outra"'));
  });

  it("numeração 1..12 só nas perguntas principais; obrigatória sem marca, opcional com 'opcional'", () => {
    const nums = [...html.matchAll(/<span class="n">(\d+)<\/span>/g)].map((m) => Number(m[1]));
    assert.deepEqual(nums, Array.from({ length: 12 }, (_, i) => i + 1));
    assert.equal((html.match(/<span class="req">opcional<\/span>/g) ?? []).length, 3);
    assert.ok(html.includes(`<legend><span class="n">12</span>${escapeHtml(choice("conversa").label)} <span class="req">opcional</span></legend>`));
    assert.ok(html.includes(`<legend>${escapeHtml(choice("produto_escolha").label)}</legend>`), "subpergunta sem número");
  });

  it("relato dentro do fieldset das dificuldades; ajuda da conversa depois da caixa", () => {
    const i = html.indexOf('name="dificuldades"');
    const end = html.indexOf("</fieldset>", i);
    assert.ok(html.indexOf('id="relato_falha"') > i && html.indexOf('id="relato_falha"') < end);
    assert.ok(html.includes(`placeholder="Ex.: pedi um resumo de um PDF e ele inventou números."`));
    const c = html.indexOf('name="conversa"');
    assert.ok(html.indexOf("Por chamada de vídeo", c) > c);
  });

  it("condicionais e regras de cliente marcadas no fieldset; sem required no HTML das condicionais", () => {
    const fsOf = (id: string) => html.slice(html.lastIndexOf("<fieldset", html.indexOf(`name="${id}"`)), html.indexOf(`name="${id}"`));
    assert.ok(fsOf("produto_tema").includes(`data-hide-q="produto_formato" data-hide-opt="${escapeHtml(FORM_NADA_DISSO)}"`));
    assert.ok(fsOf("produto_tema").includes('data-max="3"'));
    assert.ok(fsOf("produto_escolha").includes('data-show-q="produto_formato" data-show-min="2"'));
    assert.ok(fsOf("produto_escolha").includes('data-pick-from="produto_formato"'));
    assert.ok(fsOf("gasto_mensal").includes(`data-show-any="${escapeHtml(FORM_PAGA_DO_BOLSO.join(FORM_MULTI_SEPARATOR))}"`));
    assert.ok(fsOf("ferramentas").includes('data-exclusive="Nenhuma"'));
    assert.ok(fsOf("dificuldades").includes('data-max="3"') && fsOf("dificuldades").includes('data-exclusive="Nada me atrapalha"'));
    assert.ok(!/name="(produto_escolha|gasto_mensal)" value="[^"]*" required/.test(html));
    assert.ok(/name="uso_ia" value="[^"]*" required/.test(html), "rádio obrigatório leva required");
    assert.ok(html.includes(`<script>${FORM_SCRIPT}</script>`));
    assert.doesNotThrow(() => new Function(FORM_SCRIPT));
    for (const k of ["data-exclusive", "data-max", "data-pick-from", "data-show-q", "data-hide-q", ".other[data-other-for]"]) assert.ok(FORM_SCRIPT.includes(k), k);
  });

  it("'Outro/Outra': campo curto logo depois da opção, visível sem JS", () => {
    for (const q of FORM_QUESTIONS.filter((x) => (x as ChoiceQuestion).otherOption)) {
      const c = q as ChoiceQuestion;
      const field = `<span class="other" data-other-for="${c.id}" data-other-opt="${c.otherOption}"><input type="text" id="${c.id}_outro" name="${c.id}_outro" maxlength="${FORM_OTHER_TEXT_MAX_LEN}"`;
      const i = html.indexOf(field);
      assert.ok(i > 0, c.id);
      assert.match(html.slice(Math.max(0, i - 200), i), new RegExp(`value="${c.otherOption}"( required)?><span>${c.otherOption}</span></label>$`), c.id);
    }
  });

  it("agradecimento não promete parar lembrete na hora", () => {
    const t = renderThanksHtml();
    assert.ok(t.includes("Em breve você para de receber lembretes"));
  });
});

describe("#10605 v3: hora assinada e tempo de preenchimento", () => {
  const secret = "segredo-de-teste-com-32-caracteres-ou-mais";
  it("token válido dá a duração; adulterado, de outro e-mail, futuro ou velho demais não", async () => {
    const tok = await signFormRenderedAt("A@x.com", 1000, secret);
    assert.equal(await formDurationFromToken("a@x.com", tok, secret, 1180), 180);
    assert.equal(await formDurationFromToken("b@x.com", tok, secret, 1180), null);
    assert.equal(await formDurationFromToken("a@x.com", tok.replace(/^1000/, "900"), secret, 1180), null);
    assert.equal(await formDurationFromToken("a@x.com", tok, secret, 999), null);
    assert.equal(await formDurationFromToken("a@x.com", tok, secret, 1000 + MAX_FORM_DURATION_S + 1), null);
    assert.equal(await formDurationFromToken("a@x.com", undefined, secret, 1180), null);
    assert.equal(await formDurationFromToken("a@x.com", tok, "outro-segredo-de-teste-com-32-caracteres", 1180), null);
    const linkSig = await signFormEmail("a@x.com", secret);
    assert.notEqual(tok.split(".")[1], linkSig, "contexto próprio: não vale como assinatura de link");
  });

  it("resumo: mais recente por e-mail, versão, mediana e p75", () => {
    const rs: FormResponse[] = [
      { email: "a@x.com", submitted_at: "2026-11-10T10:00:00Z", answers: {}, form_version: "v3", duration_s: 100 },
      { email: "a@x.com", submitted_at: "2026-11-11T10:00:00Z", answers: {}, form_version: "v3", duration_s: 300 },
      { email: "b@x.com", submitted_at: "2026-11-10T10:00:00Z", answers: {}, form_version: "v3", duration_s: 200 },
      { email: "c@x.com", submitted_at: "2026-11-10T10:00:00Z", answers: {}, form_version: "v3", duration_s: 400 },
      { email: "d@x.com", submitted_at: "2026-10-10T10:00:00Z", answers: {} },
    ];
    const s = summarizeFormResponses(rs);
    assert.deepEqual(s.by_version, { v3: 3, "v1/v2": 1 });
    assert.equal(s.submissions, 5);
    assert.equal(s.with_duration, 3);
    assert.equal(s.median_s, 300);
    assert.equal(s.p75_s, 400);
    assert.deepEqual(summarizeFormResponses([]).median_s, null);
  });
});

describe("#10605 v3: rascunhos dos e-mails (semente do --init-snippets)", () => {
  const cfgOk = resolveFollowupConfig({ form_url: "https://f.example/", form_responses_url: "https://f.example/api/respostas" });
  const read = (f: string) => readFileSync(join(FOLLOWUP_DRAFTS_DIR, f), "utf8");
  const snipOf = (f: string) => parseFollowupSnippet(read(f))!;
  const unlock = (f: string) => parseFollowupSnippet(read(f).split("\n").filter((l) => !l.includes(PENDING_BODY_MARKER)).join("\n"));
  const secret = "segredo-de-teste-com-32-caracteres-ou-mais";

  for (const file of DRAFTS) {
    it(`${file}: travado pelo marcador, sem markdown, abre com "Olá! Tudo bem?" em parágrafo próprio`, () => {
      const raw = read(file);
      assert.ok(raw.includes(PENDING_BODY_MARKER));
      const snip = snipOf(file);
      assert.ok(snip.assunto && snip.previewText && snip.body.includes(FORM_URL_PLACEHOLDER));
      assert.ok(!ARROWS.test(raw) && !LEGACY_BRAND.test(raw));
      assert.ok(!snip.body.includes("**"));
      assert.ok(snip.body.startsWith("<p>Olá! Tudo bem?</p>\n"));
      assert.equal(baseInviteContentGate(snip, cfgOk, secret).blocked, true);
    });
  }

  it("o gate do formulário destrava só com os 4 textos aprovados (convite + 3 lembretes)", () => {
    const all: FollowupSnippets = {
      form: unlock("onboarding-formulario.md"),
      form_lembrete: unlock("formulario-lembrete-1.md"),
      form_lembrete2: unlock("formulario-lembrete-2.md"),
      form_lembrete3: unlock("formulario-lembrete-3.md"),
    };
    assert.deepEqual(formContentGate(all, cfgOk, secret), { blocked: false, linkSecret: secret });
    assert.equal((formContentGate({ ...all, form_lembrete3: snipOf("formulario-lembrete-3.md") }, cfgOk, secret) as { motivo: string }).motivo, "texto_pendente");
    assert.equal((formContentGate({ ...all, form_lembrete2: null }, cfgOk, secret) as { motivo: string }).motivo, "snippet_ausente");
    assert.deepEqual(baseInviteContentGate(unlock("pesquisa-base.md"), cfgOk, secret), { blocked: false, linkSecret: secret });
  });

  it("textos exatos aprovados (assunto, prévia, corpo)", () => {
    const p = (s: string) => `<p>${s}</p>`;
    const e1 = snipOf("pesquisa-base.md");
    assert.equal(e1.assunto, "Me ajuda a decidir o que vem por aí na diar.ia.br?");
    assert.equal(e1.previewText, "Uns três minutos, e as perguntas obrigatórias são todas de marcar.");
    assert.ok(e1.body.includes(p("São até doze perguntas sobre o seu trabalho, como você usa IA e o que você quer aprender. Leva uns três minutos, e as obrigatórias são todas de marcar.")));
    assert.ok(e1.body.includes(p("Se você respondeu a pesquisa do ano passado, responde essa também? Mudei quase todas as perguntas.")));
    assert.ok(e1.body.includes(">Responder a pesquisa</a>"));
    const e2 = snipOf("onboarding-formulario.md");
    assert.equal(e2.assunto, e1.assunto);
    assert.equal(e2.previewText, e1.previewText);
    assert.ok(e2.body.includes(p("Montei um formulário com até doze perguntas sobre o seu trabalho, como você usa IA e o que você quer aprender. Leva uns três minutos, e as obrigatórias são todas de marcar. Com as respostas, eu ajusto o que entra nas edições.")));
    const l1 = snipOf("formulario-lembrete-1.md");
    assert.deepEqual([l1.assunto, l1.previewText], ["Viu meu pedido?", "Até doze perguntas, uns três minutos."]);
    assert.ok(l1.body.includes(">Responder agora</a>"));
    const l2 = snipOf("formulario-lembrete-2.md");
    assert.deepEqual([l2.assunto, l2.previewText], ["Ainda queria te ouvir", "Três minutos pra me ajudar a decidir o que vem além da newsletter."]);
    assert.ok(l2.body.includes(p("Se não quiser responder, sem problema: a newsletter continua igual.")));
    const l3 = snipOf("formulario-lembrete-3.md");
    assert.deepEqual([l3.assunto, l3.previewText], ["Último lembrete sobre o formulário", "Depois desse, prometo que paro."]);
    assert.ok(l3.body.includes(p("Depois desse, não te mando mais lembrete. Obrigado por ler a diar.ia.br.")));
  });

  it("ajuste do editor de 09/11: 'Quando você enviar, os lembretes param.' no e-mail 2 e no lembrete 1", () => {
    for (const f of ["onboarding-formulario.md", "formulario-lembrete-1.md"]) {
      const b = snipOf(f).body;
      assert.ok(b.includes("<p>Quando você enviar, os lembretes param.</p>"), f);
      assert.ok(!b.includes("Respondeu, os lembretes param."), f);
    }
  });

  it("'doze' acompanha as perguntas numeradas onde o e-mail cita o número", () => {
    assert.equal(numberedQuestions().length, 12);
    for (const f of ["pesquisa-base.md", "onboarding-formulario.md", "formulario-lembrete-1.md"]) {
      assert.match(snipOf(f).body, /até doze perguntas/i, f);
    }
    for (const f of DRAFTS) assert.ok(!/oito|dois minutos/i.test(read(f)), `${f} sem o número antigo`);
  });

  it("--init-snippets semeia do rascunho, troca o modelo vazio antigo e nunca sobrescreve texto editado", () => {
    const dir = mkdtempSync(join(tmpdir(), "followup-drafts-"));
    writeFileSync(join(dir, "formulario-lembrete-2.md"), snippetTemplate("form_lembrete2"));
    writeFileSync(join(dir, "apoio-30.md"), "editado");
    const { written, skipped } = initFollowupSnippets(dir);
    for (const f of DRAFTS) assert.ok(written.some((p) => p.endsWith(f)), f);
    assert.deepEqual(skipped, [{ path: join(dir, "apoio-30.md"), reason: "texto_existente" }]);
    const snips = loadFollowupSnippets(dir);
    for (const k of ["form", "form_lembrete", "form_lembrete2", "form_lembrete3", "form_base"] as const) {
      assert.ok(snips[k]?.body.includes(FORM_URL_PLACEHOLDER) && snips[k]!.hasPendingMarker, k);
    }
    assert.notEqual(snips.form_lembrete!.assunto, snips.form_lembrete2!.assunto, "um texto por lembrete");
    writeFileSync(join(dir, "onboarding-formulario.md"), "texto do editor");
    const again = initFollowupSnippets(dir);
    assert.deepEqual(again.written, []);
    assert.equal(readFileSync(join(dir, "onboarding-formulario.md"), "utf8"), "texto do editor");
  });

  it("um rascunho sem o marcador recusa o init inteiro antes de gravar qualquer arquivo", () => {
    const drafts = mkdtempSync(join(tmpdir(), "followup-bad-draft-"));
    writeFileSync(join(drafts, "onboarding-formulario.md"), read("onboarding-formulario.md"));
    writeFileSync(join(drafts, "formulario-lembrete-1.md"), `<!--\nassunto: "x"\n-->\n<p>${FORM_URL_PLACEHOLDER}</p>`);
    const dir = mkdtempSync(join(tmpdir(), "followup-snip-"));
    assert.throws(() => initFollowupSnippets(dir, drafts), /ONBOARDING-CORPO-PENDENTE/);
    assert.equal(existsSync(join(dir, "onboarding-formulario.md")), false);
    assert.equal(existsSync(join(dir, "apoio-30.md")), false);
  });
});

const R = (answers: Record<string, string>, email = "a@x.com", submitted_at = "2026-11-10T12:00:00Z"): FormResponse => ({ email, submitted_at, answers, form_version: "v3" });
const J = (...xs: string[]) => xs.join(FORM_MULTI_SEPARATOR);

describe("#10605 v3: respostas do formulário no perfil de audiência", () => {
  const sample = [
    R({
      uso_ia: choice("uso_ia").options[1],
      situacao: "Tenho meu próprio negócio",
      area: "Outra",
      area_outro: "Texto livre da área",
      uso_recente: "Outro",
      uso_recente_outro: "Texto livre do uso",
      ferramentas: J("ChatGPT", "Claude"),
      motivacao: "Crescer ou melhorar meu negócio",
      dificuldades: J("Falta tempo para aprender", "Muita coisa só em inglês"),
      relato_falha: "Texto livre do relato",
      produto_formato: J("Aula ou workshop ao vivo", "Comunidade para trocar experiências com outros leitores"),
      produto_escolha: "Aula ou workshop ao vivo",
      produto_tema: J("Como escrever bons prompts", "Outro"),
      produto_tema_outro: "Texto livre do tema",
      quem_paga: "Eu, do próprio bolso",
      gasto_mensal: "De R$ 51 a R$ 150",
      maior_gasto: "De R$ 301 a R$ 1.000",
      conversa: FORM_CONVERSA_SIM,
      campo_antigo: "ignorado",
    }),
    R({ uso_ia: choice("uso_ia").options[0], situacao: "Estudante", area: "Engenharia", produto_formato: "Aula ou workshop ao vivo" }, "b@x.com"),
  ];

  it("conversão: uma entrada por opção, sem e-mail, sem texto livre; desconhecida e legada contadas à parte", () => {
    const legacy = R({ nivel_ia: "x", conteudo: "Radar", area: "Engenharia" }, "c@x.com");
    const { responses, unknownAnswers, legacyAnswers } = onboardingFormToSurveyResponses([...sample, legacy]);
    assert.equal(responses.length, 3);
    assert.equal(unknownAnswers, 1);
    assert.equal(legacyAnswers, 2);
    assert.ok(responses.every(isOnboardingFormResponse));
    const dump = JSON.stringify(responses);
    assert.ok(!dump.includes("@x.com"));
    assert.ok(!dump.includes("Texto livre"), "nem Outro nem relato saem com o texto");
    assert.deepEqual(responses[0].answers.filter((a) => a.question_id === "form:relato_falha").map((a) => a.answer), [OPEN_ANSWER_MARK]);
    assert.deepEqual(responses[0].answers.filter((a) => a.question_id === "form:ferramentas").map((a) => a.answer), ["ChatGPT", "Claude"]);
  });

  it("opção de versão anterior em pergunta que continua (área, formato, tema) fica fora dos blocos v3", () => {
    const old = R({ area: "Engenharia/Software/Dados/TI", produto_formato: J("Aula ou workshop ao vivo", "Formato que saiu"), produto_tema: "Riscos, ética e regulação", uso_ia: choice("uso_ia").options[0] }, "v2@x.com");
    const conv = onboardingFormToSurveyResponses([old]);
    assert.equal(conv.legacyOptionAnswers, 3);
    const answers = conv.responses[0].answers.map((a) => a.answer);
    assert.ok(answers.includes("Aula ou workshop ao vivo") && !answers.includes("Engenharia/Software/Dados/TI") && !answers.includes("Formato que saiu"));
  });

  it("histórico: vale a resposta mais recente de cada e-mail", () => {
    const old = R({ uso_ia: choice("uso_ia").options[3], area: "RH ou gestão de pessoas" }, "a@x.com", "2026-11-01T00:00:00Z");
    const conv = onboardingFormToSurveyResponses([old, ...sample]).responses;
    assert.equal(conv.length, 2);
    assert.ok(!JSON.stringify(conv).includes("RH ou gestão de pessoas"));
    assert.deepEqual(latestFormResponses([sample[0], old]).map((r) => r.submitted_at), [sample[0].submitted_at]);
  });

  it("seções 2, 3 e 4: blocos com contagem, sem texto livre, sem os blocos antigos", () => {
    const conv = onboardingFormToSurveyResponses(sample).responses;
    const s2 = renderDeclaredUseBlocks(conv).join("\n");
    assert.ok(s2.includes("### Nível de uso de IA"));
    assert.ok(s2.includes(`- **${choice("uso_ia").options[1]}** — weight 0.5 (1 respostas)`));
    for (const t of ["### Uso do que lê", "### Ferramentas de IA usadas no último mês", "### O que quer conseguir com IA nos próximos meses", "### O que mais atrapalha o uso de IA"]) assert.ok(s2.includes(t), t);
    assert.ok(s2.includes("Relatos de quando a IA não deu certo: 1"));
    const s3 = renderWhoTheyAreBlocks(conv).join("\n");
    for (const t of ["### Situação profissional", "### Áreas de atuação", "### Quem paga as ferramentas de IA", "### Gasto mensal com IA, do próprio bolso", "### Maior gasto com curso ou material de estudo (dois anos)"]) assert.ok(s3.includes(t), t);
    const s4 = renderProductInterestSection(conv).join("\n");
    assert.ok(s4.includes("## 4. Interesse em produtos"));
    assert.ok(s4.includes("- **Aula ou workshop ao vivo** — weight 0.667 (2 respostas)"));
    assert.ok(s4.includes("### Formato escolhido se só um existisse\n\n- **Aula ou workshop ao vivo** — weight 1 (1 respostas)"));
    assert.ok(s4.includes("### Temas para aprender"));
    for (const t of [s2, s3, s4]) assert.ok(!t.includes("Texto livre") && !t.includes("@x.com"));
    const beehiivOnly = BEEHIIV_SURVEY_PROMPTS.map((p, i) => ({ id: `b${i}`, answers: [{ question_id: "q", question_prompt: p, answer: "x" }] }));
    assert.deepEqual(renderProductInterestSection(beehiivOnly), []);
    assert.deepEqual(renderDeclaredUseBlocks(beehiivOnly), []);
    assert.equal(formRespondentsNote(conv), " (2 do formulário do onboarding)");
  });

  const ctrCsv = () => {
    const date = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const header = "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";
    const rows = Array.from({ length: 5 }, (_, i) => [date, `Post ${i}`, "Seção", `Título ${i}`, `https://example.com/t-${i}`, "example.com", "200", "8", "8", "0", "Treinamento", "BR"].join(","));
    return [header, ...rows].join("\n");
  };
  const runMain = (dir: string, survey: unknown[], warns: string[] = []) => {
    writeFileSync(join(dir, "audience-raw.json"), JSON.stringify(survey), "utf8");
    writeFileSync(join(dir, "ctr.csv"), ctrCsv(), "utf8");
    const outPath = join(dir, "audience-profile.md");
    const result = updateAudienceMain({
      outPath,
      historyDir: join(dir, "audience-history"),
      ctrCsvPath: join(dir, "ctr.csv"),
      surveyJsonPath: join(dir, "audience-raw.json"),
      pubJsonPath: join(dir, "publication.json"),
      h4HistoryPath: join(dir, "h4.jsonl"),
      editionsDir: join(dir, "editions-nao-existe"),
      subscriberBackend: "beehiiv",
      spawnFn: (() => ({})) as unknown as typeof import("node:child_process").spawnSync,
      warnFn: (m) => warns.push(m),
    });
    assert.equal(result.ok, true, result.reason);
    return readFileSync(outPath, "utf8");
  };

  it("update-audience main(): só o formulário entra, blocos novos, nada dos antigos nem texto livre", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-audience-10605-"));
    const warns: string[] = [];
    const doc = runMain(dir, [
      { id: "r1", status: "active", answers: [{ question_id: "q1", question_prompt: BEEHIIV_SURVEY_PROMPTS[0], answer: "Setor antigo" }] },
      ...onboardingFormToSurveyResponses(sample).responses,
    ], warns);
    assert.match(doc, /\*\*respondentes survey:\*\* 2 \(2 do formulário do onboarding\)/);
    assert.ok(warns.some((w) => /1 resposta\(s\) de survey antiga/.test(w)));
    assert.ok(!doc.includes("Setor antigo"));
    const s2 = doc.slice(doc.indexOf("## 2. "), doc.indexOf("## 3. "));
    assert.match(s2, /^## 2\. Preferências declaradas \(formulário\)\n\n.*\n\n### Nível de uso de IA\n/);
    assert.match(doc.slice(doc.indexOf("## 3. ")), /### Situação profissional/);
    assert.match(doc, /## 4\. Interesse em produtos \(formulário do onboarding\)/);
    for (const old of ["### Nível de conhecimento em IA", "### Leitura de links em inglês", "Quanto investiria", "Respostas abertas", "### Seções preferidas"]) assert.ok(!doc.includes(old), old);
    assert.ok(!doc.includes("Texto livre"));
  });

  it("painel: nível vem do uso_ia, setores das áreas, conteúdo preferido fica vazio (documentado)", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-audience-panel-10605-"));
    runMain(dir, onboardingFormToSurveyResponses(sample).responses);
    const summary = buildAudienceSummary(join(dir, "audience-profile.md"))!;
    assert.ok(summary, "perfil parseado");
    assert.deepEqual(summary.content_preferences, []);
    assert.deepEqual(summary.knowledge_levels.map((k) => k.label).sort(), [choice("uso_ia").options[0], choice("uso_ia").options[1]].sort());
    assert.deepEqual(summary.sectors.map((k) => k.label).sort(), ["Engenharia", "Outra"]);
  });

  it("sem resposta do formulário: mantém as seções 2 e 3 do perfil anterior, marcadas, sem acumular o sufixo", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-audience-carry-10605-"));
    const previous = [
      "# Perfil", "", "## 1. Engajamento real (CTR por categoria)", "", "## 2. Preferências declaradas (survey)", "",
      "### Conteúdo preferido", "", "- **Tutoriais práticos** — weight 0.6 (30 respostas)", "",
      "## 3. Quem são (demographics)", "", "### Setores", "", "- **Tecnologia** — weight 0.4 (20 respostas)", "", "---", "", "_rodapé_",
    ].join("\n");
    writeFileSync(join(dir, "audience-profile.md"), previous, "utf8");
    const beehiivOnly = [{ id: "r1", status: "active", answers: [{ question_id: "q1", question_prompt: BEEHIIV_SURVEY_PROMPTS[0], answer: "x" }] }];
    const doc1 = runMain(dir, beehiivOnly);
    assert.ok(doc1.includes(`## 2. Preferências declaradas (survey)${PREVIOUS_DECLARED_SUFFIX}`));
    const doc2 = runMain(dir, beehiivOnly);
    assert.equal(doc2.split(PREVIOUS_DECLARED_SUFFIX).length - 1, 2, "sufixo não acumula");
    const doc3 = runMain(dir, onboardingFormToSurveyResponses(sample).responses);
    assert.ok(!doc3.includes(PREVIOUS_DECLARED_SUFFIX) && !doc3.includes("Tecnologia"));
    assert.deepEqual(carryOverDeclaredSections(null), []);
  });

  it("resposta só com perguntas desconhecidas/legadas (ou em branco) não conta como respondente", () => {
    const conv = onboardingFormToSurveyResponses([R({ campo_antigo: "x" }, "z@x.com"), R({ conteudo: "Radar" }, "y@x.com"), R({ area: "  " }, "c@x.com"), ...sample]);
    assert.equal(conv.responses.length, 2);
    assert.equal(conv.emptyResponses, 3);
    assert.deepEqual(conv.responses.map((r) => r.id), ["onboarding-form:1", "onboarding-form:2"]);
  });

  it("uso do que lê: 'Outro' só como contagem; sem resposta, sem título", () => {
    const conv = onboardingFormToSurveyResponses(sample).responses;
    assert.ok(renderRecentUseBlock(conv).join("\n").includes("- **Outro** — weight 1 (1 respostas)"));
    assert.deepEqual(renderRecentUseBlock(onboardingFormToSurveyResponses([sample[1]]).responses), []);
  });
});

describe("#10605 leitura do formulário do onboarding", () => {
  const cfgUrl: PlatformConfig = { onboarding: { followup: { form_responses_url: "https://f.example/api/respostas" } } };
  const okPayload = { responses: [{ email: "a@x.com", submitted_at: "2026-10-20T12:00:00Z", answers: { area: "RH" } }] };

  it("loadOnboardingFormSurveyResponses: não configurado, falha e 0 respostas ABORTAM (única fonte)", async () => {
    await assert.rejects(loadOnboardingFormSurveyResponses({}, async () => null), AudienceAbort);
    await assert.rejects(loadOnboardingFormSurveyResponses({}, async () => { throw new Error("HTTP 500"); }), AudienceAbort);
    await assert.rejects(loadOnboardingFormSurveyResponses({}, async () => []), AudienceAbort);
    assert.equal((await loadOnboardingFormSurveyResponses({}, async () => [R({ area: "Engenharia" })])).length, 1);
  });

  it("fetchOnboardingFormResponsesReal: sem URL = null, sem chamar fetch", async () => {
    let called = false;
    const r = await fetchOnboardingFormResponsesReal({}, { fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch, env: {} });
    assert.equal(r, null);
    assert.equal(called, false);
  });

  it("fetchOnboardingFormResponsesReal: token ausente, HTTP de erro e payload malformado lançam", async () => {
    const okFetch = (async () => new Response(JSON.stringify(okPayload))) as typeof fetch;
    await assert.rejects(fetchOnboardingFormResponsesReal(cfgUrl, { fetchImpl: okFetch, env: {} }), /ONBOARDING_FORM_TOKEN ausente/);
    const env = { ONBOARDING_FORM_TOKEN: "t" };
    await assert.rejects(fetchOnboardingFormResponsesReal(cfgUrl, { fetchImpl: (async () => new Response("x", { status: 401 })) as typeof fetch, env }), /HTTP 401/);
    await assert.rejects(fetchOnboardingFormResponsesReal(cfgUrl, { fetchImpl: (async () => new Response(JSON.stringify({ nada: 1 }))) as typeof fetch, env }), /sem o array/);
  });

  it("fetchOnboardingFormResponsesReal: sucesso manda o token e devolve as respostas", async () => {
    let auth = "";
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(okPayload));
    }) as typeof fetch;
    const r = await fetchOnboardingFormResponsesReal(cfgUrl, { fetchImpl, env: { ONBOARDING_FORM_TOKEN: "t" } });
    assert.equal(auth, "Bearer t");
    assert.equal(r?.[0].answers.area, "RH");
  });
});
