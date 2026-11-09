/**
 * test/onboarding-form-questions-10605.test.ts (#10605)
 *
 * Perguntas v2 do formulário do onboarding (decisões do editor de
 * 08/11/2026), o HTML do Worker (com tema/preço escondidos por "Nada disso"),
 * os rascunhos dos 3 e-mails (D+6, lembrete, base) como semente do
 * `--init-snippets` (com o marcador pendente que trava o envio) e o perfil de
 * audiência só do formulário (`update-audience.ts`, decisão 10).
 * Nada toca rede nem `data/` do repo: tudo em `mkdtempSync`, `fetch` e env
 * injetados.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FORM_QUESTIONS,
  FORM_ANSWER_MAX_LEN,
  FORM_MULTI_SEPARATOR,
  FORM_NADA_DISSO,
  parseFormSubmission,
  splitMultiAnswer,
  type ChoiceQuestion,
  type FormResponse,
} from "../scripts/lib/onboarding-form-contract.ts";
import {
  SURVEY_MATCHERS,
  onboardingFormToSurveyResponses,
  isOnboardingFormResponse,
  type SurveyMatcherKey,
} from "../scripts/lib/audience-survey-questions.ts";
import { collectFormFields, renderFormHtml, renderThanksHtml, RADIO_MAX_OPTIONS, HIDE_SCRIPT } from "../workers/onboarding-form/src/render.ts";
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
  renderEnglishReadingBlock,
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
  nivel_ia: "aiLevel",
  area: "areas",
  conteudo: "contentTypes",
  leitura_ingles: "englishReading",
  produto_formato: "productFormats",
  produto_tema: "courseTopics",
  produto_preco: "coursePrice",
  sugestao: "openSuggestion",
};

/** Prompts REAIS da survey de perfil antiga da Beehiiv (conferidos em
 *  21/10/2026) — só para provar que ela não entra mais no perfil. */
const BEEHIIV_SURVEY_PROMPTS = [
  "Como você classificaria seu nível de conhecimento em IA?",
  "Quais seções ou tipos de conteúdo mais te interessam?",
  "Qual o setor de atuação da organização onde você trabalha?",
  "Qual é a sua principal área de atuação?",
];

const NUMBER_WORDS: Record<number, string> = { 5: "cinco", 6: "seis", 7: "sete", 8: "oito" };
const ARROWS = /[←→]/;
const LEGACY_BRAND = /Diar\.ia(?!\.br)/;

function matchersOf(label: string): SurveyMatcherKey[] {
  return (Object.keys(SURVEY_MATCHERS) as SurveyMatcherKey[]).filter((k) => SURVEY_MATCHERS[k].test(label));
}

function choice(id: string): ChoiceQuestion {
  const q = FORM_QUESTIONS.find((x) => x.id === id);
  assert.ok(q && (q.kind === "select" || q.kind === "checkbox"), id);
  return q as ChoiceQuestion;
}

describe("#10605 perguntas do formulário", () => {
  it("curto: no máximo 8 perguntas, ids únicos, até 2 abertas, perfil obrigatório", () => {
    assert.ok(FORM_QUESTIONS.length > 0 && FORM_QUESTIONS.length <= 8);
    assert.equal(new Set(FORM_QUESTIONS.map((q) => q.id)).size, FORM_QUESTIONS.length);
    const open = FORM_QUESTIONS.filter((q) => q.kind === "text" || q.kind === "textarea");
    assert.ok(open.length >= 1 && open.length <= 2);
    assert.ok(open.every((q) => !q.required), "pergunta aberta é sempre opcional");
    assert.deepEqual(FORM_QUESTIONS.filter((q) => q.required).map((q) => q.id), ["nivel_ia", "area"]);
  });

  it("toda opção de múltipla escolha é não vazia, única e não contém o separador; exclusiva existe nas opções", () => {
    for (const q of FORM_QUESTIONS) {
      if (q.kind !== "select" && q.kind !== "checkbox") continue;
      assert.ok(q.options.length >= 2, q.id);
      assert.equal(new Set(q.options).size, q.options.length, q.id);
      for (const o of q.options) assert.ok(o.trim() !== "" && !o.includes(FORM_MULTI_SEPARATOR.trim()), `${q.id}: ${o}`);
      if (q.exclusiveOption) assert.ok(q.kind === "checkbox" && q.options.includes(q.exclusiveOption), q.id);
    }
  });

  it("cada pergunta cai em exatamente um matcher do perfil (o esperado)", () => {
    for (const q of FORM_QUESTIONS) {
      assert.deepEqual(matchersOf(q.label), [EXPECTED_MATCHER[q.id]], `${q.id}: "${q.label}"`);
    }
  });

  it("matcher de setor (só existia na survey da Beehiiv) saiu (decisão 10)", () => {
    assert.ok(!("sectors" in SURVEY_MATCHERS));
  });

  it("v2: nível sem jargão (decisão 1)", () => {
    assert.deepEqual(choice("nivel_ia").options, [
      "Estou começando: uso IA de vez em quando",
      "Uso ChatGPT ou parecidos para tarefas simples todo dia",
      "Entendo como a IA funciona e acompanho as novidades",
      "Consigo usar um modelo por API ou preparar dados para ele",
      "Trabalho com IA: ajusto modelos ou planejo como uma empresa vai usar IA",
    ]);
    for (const o of choice("nivel_ia").options) assert.ok(!/GenAI|Machine Learning|Deep Learning|via API/.test(o), o);
    assert.deepEqual(choice("area").options, [
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
    ]);
  });

  it("v2: conteúdo pelas seções da newsletter, múltipla escolha (decisão 3)", () => {
    const q = choice("conteudo");
    assert.equal(q.kind, "checkbox");
    assert.deepEqual(q.options.map((o) => o.split(" (")[0]), ["Destaques", "Lançamentos", "Use Melhor", "Radar", "É IA?"]);
  });

  it("leitura de links em inglês: opcional, uma resposta, logo depois das seções e antes do formato", () => {
    const q = choice("leitura_ingles");
    assert.equal(q.kind, "select");
    assert.equal(q.label, "Quando você abre um link da diar.ia.br e o texto está em inglês, o que costuma fazer?");
    assert.deepEqual(q.options, [
      "Leio normalmente",
      "Leio com o tradutor do navegador ou do celular",
      "Continuo só se o assunto me interessar muito",
      "Fecho e sigo para o próximo",
    ]);
    assert.notEqual(q.required, true);
    assert.equal(q.hiddenWhen, undefined);
    const ids = FORM_QUESTIONS.map((x) => x.id);
    assert.equal(ids.indexOf("leitura_ingles"), ids.indexOf("conteudo") + 1);
    assert.equal(ids.indexOf("produto_formato"), ids.indexOf("leitura_ingles") + 1);
    assert.equal(FORM_QUESTIONS.length, 8);
  });

  it("v2: B2C — formato com a única porta B2B, tema amplo, preço só por faixas (decisões 2, 4)", () => {
    const formato = choice("produto_formato");
    assert.ok(formato.options.includes("Treinamento para a equipe da empresa onde trabalho"));
    assert.equal(formato.exclusiveOption, FORM_NADA_DISSO);
    assert.equal(FORM_QUESTIONS.find((q) => q.id === "produto_tema")!.label, "Sobre qual tema você gostaria de aprender com a diar.ia.br (curso, aula, guia ou mentoria)?");
    const preco = choice("produto_preco");
    assert.equal(preco.label, "Quanto você investiria para aprender algo que resolvesse uma necessidade sua?");
    assert.deepEqual(preco.options, ["Só faria se fosse gratuito", "Até R$ 100", "R$ 100 a R$ 300", "R$ 300 a R$ 1.000", "Mais de R$ 1.000"]);
    assert.equal(FORM_QUESTIONS.find((q) => q.id === "sugestao")!.kind, "textarea");
    const all = FORM_QUESTIONS.flatMap((q) => [q.label, ...(q.kind === "select" || q.kind === "checkbox" ? q.options : [])]).join(" ");
    assert.ok(!/empresa pagaria|quem pagaria/i.test(all), "sem 'quem pagaria'");
    assert.ok(!/ferramentas? (você|voce) usa|\bporte\b|funcion[áa]rios/i.test(all), "sem ferramentas nem porte (decisão 6)");
  });

  it("tema e preço escondem com 'Nada disso'; controle vem antes; escondida nunca é obrigatória", () => {
    const hidden = FORM_QUESTIONS.filter((q) => q.hiddenWhen);
    assert.deepEqual(hidden.map((q) => q.id), ["produto_tema", "produto_preco"]);
    for (const q of hidden) {
      const ctrl = FORM_QUESTIONS.findIndex((x) => x.id === q.hiddenWhen!.questionId);
      assert.ok(ctrl >= 0 && ctrl < FORM_QUESTIONS.indexOf(q), q.id);
      assert.ok(choice(q.hiddenWhen!.questionId).options.includes(q.hiddenWhen!.option));
      assert.notEqual(q.required, true);
    }
  });

  it("copy do leitor sem seta, sem marca antiga", () => {
    for (const q of FORM_QUESTIONS) {
      const opts = q.kind === "select" || q.kind === "checkbox" ? q.options : [];
      for (const t of [q.label, q.help ?? "", ...opts]) assert.ok(!ARROWS.test(t) && !LEGACY_BRAND.test(t), t);
    }
  });
});

describe("#10605 parseFormSubmission com caixas de seleção", () => {
  const base = { email: "a@x.com", nivel_ia: choice("nivel_ia").options[0], area: "RH" };

  it("várias opções viram uma string na ordem da pergunta, sem repetição", () => {
    const opts = choice("conteudo").options;
    const r = parseFormSubmission({ ...base, conteudo: [opts[3], opts[0], opts[3]] });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.submission.answers.conteudo, `${opts[0]}${FORM_MULTI_SEPARATOR}${opts[3]}`);
    assert.deepEqual(splitMultiAnswer(r.submission.answers.conteudo), [opts[0], opts[3]]);
  });

  it("'Nada disso' descarta tema e preço sem validar; sem ela, opção inválida segue recusada", () => {
    const r = parseFormSubmission({ ...base, produto_formato: FORM_NADA_DISSO, produto_tema: ["inventada"], produto_preco: "Quem pagaria é a empresa" });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.submission.answers.produto_formato, FORM_NADA_DISSO);
      assert.ok(!("produto_tema" in r.submission.answers) && !("produto_preco" in r.submission.answers));
    }
    assert.equal(parseFormSubmission({ ...base, produto_formato: "Aula ou workshop ao vivo", produto_preco: "Quem pagaria é a empresa" }).ok, false);
    const ok = parseFormSubmission({ ...base, produto_formato: "Aula ou workshop ao vivo", produto_preco: "Até R$ 100" });
    assert.ok(ok.ok && ok.submission.answers.produto_preco === "Até R$ 100");
  });

  it("uma opção só (string) também vale; opção desconhecida é recusada", () => {
    assert.ok(parseFormSubmission({ ...base, produto_tema: "Como escrever bons prompts" }).ok);
    assert.equal(parseFormSubmission({ ...base, produto_tema: ["Como escrever bons prompts", "inventada"] }).ok, false);
  });

  it("'Nada disso' é exclusiva: sozinha passa, junto com outra é recusada", () => {
    const q = choice("produto_formato");
    assert.ok(q.exclusiveOption);
    assert.ok(parseFormSubmission({ ...base, produto_formato: q.exclusiveOption! }).ok);
    const bad = parseFormSubmission({ ...base, produto_formato: [q.exclusiveOption!, q.options[0]] });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.error, /não combina/);
  });

  it("perfil obrigatório ausente recusa; o resto é opcional", () => {
    assert.equal(parseFormSubmission({ email: "a@x.com", area: "RH" }).ok, false);
    const r = parseFormSubmission(base);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(Object.keys(r.submission.answers).sort(), ["area", "nivel_ia"]);
  });

  it("leitura_ingles: ausente passa, opção válida grava, opção inválida recusa", () => {
    const sem = parseFormSubmission(base);
    assert.ok(sem.ok && !("leitura_ingles" in sem.submission.answers));
    const ok = parseFormSubmission({ ...base, leitura_ingles: "Fecho e sigo para o próximo" });
    assert.ok(ok.ok && ok.submission.answers.leitura_ingles === "Fecho e sigo para o próximo");
    assert.equal(parseFormSubmission({ ...base, leitura_ingles: "Nunca abro" }).ok, false);
  });

  it("collectFormFields preserva campos repetidos do POST", () => {
    const f = collectFormFields([["email", "a@x.com"], ["conteudo", "A"], ["conteudo", "B"], ["arquivo", {}]]);
    assert.deepEqual(f, { email: "a@x.com", conteudo: ["A", "B"] });
  });
});

describe("#10605 HTML do formulário", () => {
  const html = renderFormHtml('a+b@x.com"><script>', "SIG");

  it("e-mail fixo (campo oculto, #10657) e escapado, página móvel em pt-BR", () => {
    assert.ok(html.includes('<input type="hidden" name="email" value="a+b@x.com&quot;&gt;&lt;script&gt;">'));
    assert.ok(html.includes('<input type="hidden" name="sig" value="SIG">'));
    assert.ok(!html.includes('type="email"'), "o e-mail não é editável");
    assert.ok(html.includes('lang="pt-BR"') && html.includes("width=device-width"));
    assert.ok(html.includes(`São até ${FORM_QUESTIONS.length} perguntas`));
    assert.ok(!ARROWS.test(html) && !LEGACY_BRAND.test(html));
  });

  it("escolha única curta vira rádio, lista longa vira menu, múltipla vira caixa, aberta respeita o limite", () => {
    for (const q of FORM_QUESTIONS) {
      if (q.kind === "checkbox") assert.ok(html.includes(`type="checkbox" id="${q.id}-0" name="${q.id}"`), q.id);
      else if (q.kind === "select" && q.options.length <= RADIO_MAX_OPTIONS) assert.ok(html.includes(`type="radio" id="${q.id}-0" name="${q.id}"`), q.id);
      else if (q.kind === "select") assert.ok(html.includes(`<select id="${q.id}" name="${q.id}"`), q.id);
      else assert.ok(html.includes(`id="${q.id}" name="${q.id}" maxlength="${FORM_ANSWER_MAX_LEN}"`), q.id);
    }
  });

  it("mostra a pergunta de leitura em inglês, com as 4 opções, entre seções e formato", () => {
    const q = choice("leitura_ingles");
    assert.ok(html.includes(q.label));
    q.options.forEach((o, i) => assert.ok(html.includes(`id="leitura_ingles-${i}" name="leitura_ingles" value="${o}"`), o));
    const at = (id: string) => html.indexOf(`name="${id}"`);
    assert.ok(at("conteudo") < at("leitura_ingles") && at("leitura_ingles") < at("produto_formato"));
    const i = at("leitura_ingles");
    assert.ok(!html.slice(html.lastIndexOf("<fieldset", i), i).includes("data-hide-q"), "nunca escondida");
  });

  it("tema e preço com data-hide e o script que esconde/desabilita", () => {
    const opt = FORM_NADA_DISSO.replace(/"/g, "&quot;");
    for (const id of ["produto_tema", "produto_preco"]) {
      const i = html.indexOf(`name="${id}"`);
      const fs = html.lastIndexOf("<fieldset", i);
      assert.ok(html.slice(fs, i).startsWith(`<fieldset data-hide-q="produto_formato" data-hide-opt="${opt}">`), id);
    }
    assert.ok(html.includes(`<script>${HIDE_SCRIPT}</script>`));
    assert.match(HIDE_SCRIPT, /disabled=on/);
  });

  it("agradecimento não promete parar lembrete na hora (lote do Kit já agendado ainda pode sair)", () => {
    const t = renderThanksHtml();
    assert.ok(t.includes("Em breve você para de receber lembretes"));
    assert.ok(!/não vai receber mais/.test(t));
  });
});

describe("#10605 rascunhos dos e-mails (semente do --init-snippets)", () => {
  const cfgOk = resolveFollowupConfig({ form_url: "https://f.example/", form_responses_url: "https://f.example/api/respostas" });

  for (const file of ["onboarding-formulario.md", "formulario-lembrete.md", "pesquisa-base.md"]) {
    it(`${file}: travado pelo marcador, mas pronto para destravar quando o editor aprovar`, () => {
      const raw = readFileSync(join(FOLLOWUP_DRAFTS_DIR, file), "utf8");
      assert.ok(raw.includes(PENDING_BODY_MARKER));
      const snip = parseFollowupSnippet(raw)!;
      assert.ok(snip.assunto && snip.previewText && snip.body.includes(FORM_URL_PLACEHOLDER));
      assert.ok(!ARROWS.test(raw) && !LEGACY_BRAND.test(raw));
      assert.ok(!snip.body.includes("**"), "corpo é HTML, sem markdown");
      const word = new RegExp(`\\b${NUMBER_WORDS[FORM_QUESTIONS.length]}\\b`, "i");
      assert.ok(word.test(snip.body), "número de perguntas no corpo bate com FORM_QUESTIONS");
      assert.ok(word.test(snip.previewText!), "número de perguntas no preview bate com FORM_QUESTIONS");

      const approved = parseFollowupSnippet(raw.split("\n").filter((l) => !l.includes(PENDING_BODY_MARKER)).join("\n"));
      const secret = "segredo-de-teste-com-32-caracteres-ou-mais";
      assert.deepEqual(formContentGate({ form: approved, form_lembrete: approved }, cfgOk, secret), { blocked: false, linkSecret: secret });
      const pend: FollowupSnippets = { form: snip, form_lembrete: snip };
      assert.equal((formContentGate(pend, cfgOk, secret) as { motivo: string }).motivo, "texto_pendente");
      assert.deepEqual(baseInviteContentGate(approved, cfgOk, secret), { blocked: false, linkSecret: secret });
      assert.equal((baseInviteContentGate(snip, cfgOk, secret) as { motivo: string }).motivo, "texto_pendente");
    });
  }

  it("D+6 diz o ganho para o leitor (decisão 8)", () => {
    const snip = parseFollowupSnippet(readFileSync(join(FOLLOWUP_DRAFTS_DIR, "onboarding-formulario.md"), "utf8"))!;
    assert.match(snip.body, /passo a mandar mais do que você marcar\./);
    assert.ok(!/você marcou/.test(snip.body), "futuro: a pessoa ainda vai marcar");
  });

  it("lembrete serve aos dois convites: fala em 'um formulário', sem citar qual (regra A)", () => {
    const snip = parseFollowupSnippet(readFileSync(join(FOLLOWUP_DRAFTS_DIR, "formulario-lembrete.md"), "utf8"))!;
    assert.match(snip.body, /mandei um formulário/);
    assert.ok(!/D\+6|pesquisa nova|pesquisa anterior|edições que você recebeu/i.test(snip.body));
    assert.ok(!/sem teto|a cada 30 dias/.test(snip.body));
  });

  it("e-mail da base: avisa da pesquisa antiga, pede de novo a quem respondeu e a quem não respondeu (decisão 11)", () => {
    const snip = parseFollowupSnippet(readFileSync(join(FOLLOWUP_DRAFTS_DIR, "pesquisa-base.md"), "utf8"))!;
    assert.match(snip.body, /mandei uma pesquisa/);
    assert.match(snip.body, /Se você respondeu a anterior, peço que responda de novo/);
    assert.match(snip.body, /Se não respondeu/);
    assert.match(snip.body, /escolha das notícias/);
    assert.match(snip.body, /Agora fiz outra, e é ela que vai orientar/);
    assert.ok(!/mais curta/.test(snip.body), "sem comparar o tamanho com a anterior");
  });

  it("--init-snippets semeia do rascunho, troca o modelo vazio antigo e nunca sobrescreve texto editado", () => {
    const dir = mkdtempSync(join(tmpdir(), "followup-drafts-"));
    writeFileSync(join(dir, "formulario-lembrete.md"), snippetTemplate("form_lembrete"));
    writeFileSync(join(dir, "apoio-30.md"), "editado");
    const { written, skipped } = initFollowupSnippets(dir);
    assert.ok(written.some((p) => p.endsWith("onboarding-formulario.md")));
    assert.ok(written.some((p) => p.endsWith("formulario-lembrete.md")), "modelo vazio intacto vira o rascunho");
    assert.deepEqual(skipped, [{ path: join(dir, "apoio-30.md"), reason: "texto_existente" }]);
    assert.equal(readFileSync(join(dir, "apoio-30.md"), "utf8"), "editado");
    const snips = loadFollowupSnippets(dir);
    assert.ok(snips.form?.body.includes(FORM_URL_PLACEHOLDER) && snips.form.hasPendingMarker);
    assert.ok(snips.form_lembrete?.body.includes(FORM_URL_PLACEHOLDER) && snips.form_lembrete.hasPendingMarker);
    assert.ok(snips.form_base?.body.includes(FORM_URL_PLACEHOLDER) && snips.form_base.hasPendingMarker);

    writeFileSync(join(dir, "onboarding-formulario.md"), "texto do editor");
    const again = initFollowupSnippets(dir);
    assert.deepEqual(again.written, []);
    assert.ok(again.skipped.some((s) => s.path.endsWith("formulario-lembrete.md") && s.reason === "ja_e_o_rascunho"));
    assert.equal(readFileSync(join(dir, "onboarding-formulario.md"), "utf8"), "texto do editor");
  });

  it("um rascunho sem o marcador recusa o init inteiro antes de gravar qualquer arquivo", () => {
    const drafts = mkdtempSync(join(tmpdir(), "followup-bad-draft-"));
    writeFileSync(join(drafts, "onboarding-formulario.md"), readFileSync(join(FOLLOWUP_DRAFTS_DIR, "onboarding-formulario.md"), "utf8"));
    writeFileSync(join(drafts, "formulario-lembrete.md"), `<!--\nassunto: "x"\n-->\n<p>${FORM_URL_PLACEHOLDER}</p>`);
    const dir = mkdtempSync(join(tmpdir(), "followup-snip-"));
    writeFileSync(join(dir, "formulario-lembrete.md"), snippetTemplate("form_lembrete"));
    assert.throws(() => initFollowupSnippets(dir, drafts), /ONBOARDING-CORPO-PENDENTE/);
    assert.equal(existsSync(join(dir, "onboarding-formulario.md")), false, "rascunho válido não foi gravado");
    assert.equal(existsSync(join(dir, "apoio-30.md")), false, "nem os modelos vazios");
    assert.equal(readFileSync(join(dir, "formulario-lembrete.md"), "utf8"), snippetTemplate("form_lembrete"));
  });
});

const R = (answers: Record<string, string>, email = "a@x.com"): FormResponse => ({ email, submitted_at: "2026-10-20T12:00:00Z", answers });
const LEVELS = () => choice("nivel_ia").options;

describe("#10605 respostas do formulário no perfil de audiência", () => {
  const sample = [
    R({
      nivel_ia: LEVELS()[0],
      area: "RH",
      conteudo: ["Tutoriais práticos", "Pesquisas sobre IA"].join(FORM_MULTI_SEPARATOR),
      leitura_ingles: "Leio com o tradutor do navegador ou do celular",
      produto_formato: "Aula ou workshop ao vivo",
      produto_preco: "Até R$ 100",
      sugestao: "mais saúde",
      campo_antigo: "ignorado",
    }),
    R({ nivel_ia: LEVELS()[1], area: "Vendas", produto_formato: "Aula ou workshop ao vivo" }, "b@x.com"),
  ];

  it("conversão: uma entrada por opção marcada, sem e-mail no id, sem status, pergunta removida contada", () => {
    const { responses, unknownAnswers } = onboardingFormToSurveyResponses(sample);
    assert.equal(responses.length, 2);
    assert.equal(unknownAnswers, 1);
    assert.ok(responses.every(isOnboardingFormResponse));
    assert.ok(responses.every((r) => r.status === undefined));
    assert.ok(!JSON.stringify(responses).includes("@x.com"));
    const conteudo = responses[0].answers.filter((a) => a.question_id === "form:conteudo").map((a) => a.answer);
    assert.deepEqual(conteudo, ["Tutoriais práticos", "Pesquisas sobre IA"]);
    assert.ok(!responses[0].answers.some((a) => a.answer === "ignorado"));
  });

  it("seção 4 do perfil: formatos/preço contados, texto livre só como contagem", () => {
    const conv = onboardingFormToSurveyResponses(sample).responses;
    const lines = renderProductInterestSection(conv).join("\n");
    assert.ok(lines.includes("## 4. Interesse em produtos"));
    assert.ok(lines.includes("- **Aula ou workshop ao vivo** — weight 1 (2 respostas)"));
    assert.ok(lines.includes("- **Até R$ 100**"));
    assert.ok(lines.includes("Respostas abertas: 1"));
    assert.ok(!lines.includes("mais saúde"), "texto livre não vai para o perfil");
    const beehiivOnly = BEEHIIV_SURVEY_PROMPTS.map((p, i) => ({ id: `b${i}`, answers: [{ question_id: "q", question_prompt: p, answer: "x" }] }));
    assert.deepEqual(renderProductInterestSection(beehiivOnly), [], "survey antiga sozinha não gera seção 4");
    assert.equal(formRespondentsNote(conv), " (2 do formulário do onboarding)");
    assert.equal(formRespondentsNote([{ id: "beehiiv-1", answers: [] }]), "");
  });

  it("update-audience main(): só o formulário entra (Beehiiv ignorada, decisão 10), seção 4, texto livre ausente", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-audience-10605-"));
    const survey = [
      { id: "r1", status: "active", answers: [{ question_id: "q1", question_prompt: BEEHIIV_SURVEY_PROMPTS[0], answer: LEVELS()[0] }] },
      { id: "r2", status: "active", answers: [{ question_id: "q3", question_prompt: BEEHIIV_SURVEY_PROMPTS[2], answer: "Setor antigo" }] },
      ...onboardingFormToSurveyResponses(sample).responses,
    ];
    const warns: string[] = [];
    writeFileSync(join(dir, "audience-raw.json"), JSON.stringify(survey), "utf8");
    const outPath = join(dir, "audience-profile.md");
    const result = updateAudienceMain({
      outPath,
      historyDir: join(dir, "audience-history"),
      ctrCsvPath: join(dir, "nao-existe.csv"),
      surveyJsonPath: join(dir, "audience-raw.json"),
      pubJsonPath: join(dir, "publication.json"),
      h4HistoryPath: join(dir, "h4.jsonl"),
      editionsDir: join(dir, "editions-nao-existe"),
      subscriberBackend: "beehiiv",
      spawnFn: (() => ({})) as unknown as typeof import("node:child_process").spawnSync,
      warnFn: (m) => warns.push(m),
    });
    assert.equal(result.ok, true, result.reason);
    const doc = readFileSync(outPath, "utf8");
    assert.match(doc, /\*\*respondentes survey:\*\* 2 \(2 do formulário do onboarding\)/);
    assert.ok(!doc.includes("Setor antigo") && !doc.includes("### Setores"), "survey da Beehiiv fora do perfil");
    assert.ok(warns.some((w) => /2 resposta\(s\) de survey antiga/.test(w)));
    assert.match(doc, /## 4\. Interesse em produtos \(formulário do onboarding\)/);
    assert.match(doc, new RegExp(`- \\*\\*${LEVELS()[0].replace(/[()]/g, "\\$&")}\\*\\* — weight 0\\.5 \\(1 respostas\\)`), "nível conta só o formulário");
    assert.ok(!doc.includes("mais saúde"));
    const s2 = doc.slice(doc.indexOf("## 2. "), doc.indexOf("## 3. "));
    assert.match(s2, /### Leitura de links em inglês\n\n- \*\*Leio com o tradutor do navegador ou do celular\*\* — weight 1 \(1 respostas\)/);
  });

  it("leitura em inglês: distribuição por opção; sem resposta, sem título", () => {
    const conv = onboardingFormToSurveyResponses([
      ...sample,
      R({ area: "RH", leitura_ingles: "Fecho e sigo para o próximo" }, "c@x.com"),
      R({ area: "RH", leitura_ingles: "Fecho e sigo para o próximo" }, "d@x.com"),
    ]).responses;
    const lines = renderEnglishReadingBlock(conv).join("\n");
    assert.ok(lines.includes("### Leitura de links em inglês"));
    assert.ok(lines.includes("- **Fecho e sigo para o próximo** — weight 0.667 (2 respostas)"));
    assert.ok(lines.includes("- **Leio com o tradutor do navegador ou do celular** — weight 0.333 (1 respostas)"));
    assert.deepEqual(renderEnglishReadingBlock(onboardingFormToSurveyResponses([sample[1]]).responses), []);
  });

  it("resposta só com perguntas desconhecidas (ou em branco) não conta como respondente", () => {
    const conv = onboardingFormToSurveyResponses([R({ campo_antigo: "x" }), R({ area: "  " }, "c@x.com"), ...sample]);
    assert.equal(conv.responses.length, 2);
    assert.equal(conv.emptyResponses, 2);
    assert.deepEqual(conv.responses.map((r) => r.id), ["onboarding-form:1", "onboarding-form:2"]);
  });

  // CTR mínimo: sem resposta do formulário o perfil sai só do CTR (e das seções herdadas).
  const ctrCsv = () => {
    const date = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const header = "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";
    const rows = Array.from({ length: 5 }, (_, i) => [date, `Post ${i}`, "Seção", `Título ${i}`, `https://example.com/t-${i}`, "example.com", "200", "8", "8", "0", "Treinamento", "BR"].join(","));
    return [header, ...rows].join("\n");
  };
  const runMain = (dir: string, survey: unknown[]) => {
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
      warnFn: () => {},
    });
    assert.equal(result.ok, true, result.reason);
    return readFileSync(outPath, "utf8");
  };

  it("sem resposta do formulário: mantém as seções 2 e 3 do perfil anterior, marcadas, sem acumular o sufixo; com resposta, só o formulário", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-audience-carry-10605-"));
    const previous = [
      "# Perfil",
      "",
      "## 1. Engajamento real (CTR por categoria)",
      "",
      "## 2. Preferências declaradas (survey)",
      "",
      "### Conteúdo preferido",
      "",
      "- **Tutoriais práticos** — weight 0.6 (30 respostas)",
      "",
      "## 3. Quem são (demographics)",
      "",
      "### Setores",
      "",
      "- **Tecnologia** — weight 0.4 (20 respostas)",
      "",
      "---",
      "",
      "_rodapé_",
    ].join("\n");
    writeFileSync(join(dir, "audience-profile.md"), previous, "utf8");
    const beehiivOnly = [{ id: "r1", status: "active", answers: [{ question_id: "q1", question_prompt: BEEHIIV_SURVEY_PROMPTS[0], answer: "x" }] }];
    const doc1 = runMain(dir, beehiivOnly);
    assert.ok(doc1.includes(`## 2. Preferências declaradas (survey)${PREVIOUS_DECLARED_SUFFIX}`));
    assert.ok(doc1.includes(`## 3. Quem são (demographics)${PREVIOUS_DECLARED_SUFFIX}`));
    assert.ok(doc1.includes("- **Tecnologia** — weight 0.4 (20 respostas)"));
    assert.ok(!doc1.includes("_rodapé_"), "o rodapé antigo não é copiado");
    const doc2 = runMain(dir, beehiivOnly);
    assert.equal(doc2.split(PREVIOUS_DECLARED_SUFFIX).length - 1, 2, "sufixo não acumula");
    assert.equal(buildAudienceSummary(join(dir, "audience-profile.md"))?.content_preferences.length, 1, "o painel lê as seções herdadas");
    const doc3 = runMain(dir, onboardingFormToSurveyResponses(sample).responses);
    assert.ok(!doc3.includes(PREVIOUS_DECLARED_SUFFIX) && !doc3.includes("Tecnologia"), "com resposta do formulário, as anteriores saem");
    assert.match(doc3, /## 2\. Preferências declaradas \(formulário\)/);
    assert.deepEqual(carryOverDeclaredSections(null), []);
    assert.deepEqual(carryOverDeclaredSections("# sem seção 2"), []);
  });

  it("painel: buildAudienceSummary lê '### Seções preferidas' do perfil gerado pelo formulário", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-audience-panel-10605-"));
    runMain(dir, onboardingFormToSurveyResponses(sample).responses);
    const summary = buildAudienceSummary(join(dir, "audience-profile.md"));
    assert.ok(summary, "perfil parseado");
    assert.deepEqual(summary!.content_preferences.map((c) => c.label).sort(), ["Pesquisas sobre IA", "Tutoriais práticos"]);
    assert.equal(summary!.knowledge_levels.length, 2);
  });
});

describe("#10605 leitura do formulário do onboarding", () => {
  const cfgUrl: PlatformConfig = { onboarding: { followup: { form_responses_url: "https://f.example/api/respostas" } } };
  const okPayload = { responses: [{ email: "a@x.com", submitted_at: "2026-10-20T12:00:00Z", answers: { area: "RH" } }] };

  it("loadOnboardingFormSurveyResponses: não configurado, falha e 0 respostas ABORTAM (única fonte)", async () => {
    await assert.rejects(loadOnboardingFormSurveyResponses({}, async () => null), AudienceAbort);
    await assert.rejects(loadOnboardingFormSurveyResponses({}, async () => { throw new Error("HTTP 500"); }), AudienceAbort);
    await assert.rejects(loadOnboardingFormSurveyResponses({}, async () => []), AudienceAbort);
    assert.equal((await loadOnboardingFormSurveyResponses({}, async () => [R({ area: "RH" })])).length, 1);
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
