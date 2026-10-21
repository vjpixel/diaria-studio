/**
 * test/onboarding-form-questions-10605.test.ts (#10605)
 *
 * Perguntas do formulário do onboarding (rascunho aguardando o editor), o
 * HTML do Worker, os rascunhos dos 2 e-mails como semente do
 * `--init-snippets` (com o marcador pendente que trava o envio) e a soma das
 * respostas ao perfil de audiência (`audience-run.ts` → `update-audience.ts`).
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
import { collectFormFields, renderFormHtml, renderThanksHtml, RADIO_MAX_OPTIONS } from "../workers/onboarding-form/src/render.ts";
import {
  FORM_URL_PLACEHOLDER,
  formContentGate,
  parseFollowupSnippet,
  resolveFollowupConfig,
  snippetTemplate,
  type FollowupSnippets,
} from "../scripts/lib/onboarding-followup.ts";
import { PENDING_BODY_MARKER } from "../scripts/lib/onboarding-state.ts";
import { FOLLOWUP_DRAFTS_DIR, initFollowupSnippets, loadFollowupSnippets } from "../scripts/onboarding-followup-run.ts";
import { main as updateAudienceMain, renderProductInterestSection, formRespondentsNote } from "../scripts/update-audience.ts";
import {
  runAudience,
  loadOnboardingFormSurveyResponses,
  fetchOnboardingFormResponsesReal,
  serializePlatformConfig,
  AudienceAbort,
  type AudienceRunDeps,
  type PlatformConfig,
} from "../scripts/audience-run.ts";

const EXPECTED_MATCHER: Record<string, SurveyMatcherKey> = {
  nivel_ia: "aiLevel",
  area: "areas",
  conteudo: "contentTypes",
  produto_formato: "productFormats",
  produto_tema: "courseTopics",
  produto_preco: "coursePrice",
  sugestao: "openSuggestion",
};

const PRODUCT_MATCHERS: SurveyMatcherKey[] = ["productFormats", "courseTopics", "coursePrice", "openSuggestion"];

/** Prompts REAIS da survey de perfil antiga da Beehiiv (os 6 distintos de
 *  `data/audience-raw.json`, conferidos em 21/10/2026) — fixture, não dado vivo. */
const BEEHIIV_SURVEY_PROMPTS: { prompt: string; matcher: SurveyMatcherKey | null }[] = [
  { prompt: "Como você classificaria seu nível de conhecimento em IA?", matcher: "aiLevel" },
  { prompt: "Quais seções ou tipos de conteúdo mais te interessam?", matcher: "contentTypes" },
  { prompt: "Qual o setor de atuação da organização onde você trabalha?", matcher: "sectors" },
  { prompt: "Qual é a sua principal área de atuação?", matcher: "areas" },
  { prompt: 'Se respondeu "outro", qual?', matcher: null },
  { prompt: 'Se respondeu "outra", qual?', matcher: null },
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

  it("prompts reais da survey Beehiiv casam o matcher de sempre e nunca um de produto", () => {
    for (const { prompt, matcher } of BEEHIIV_SURVEY_PROMPTS) {
      const hit = matchersOf(prompt);
      assert.ok(!hit.some((k) => PRODUCT_MATCHERS.includes(k)), prompt);
      assert.deepEqual(hit, matcher ? [matcher] : [], prompt);
    }
  });

  it("opções das 3 perguntas de perfil congeladas (somam nas linhas da survey antiga)", () => {
    assert.deepEqual(choice("nivel_ia").options, [
      "Uso casual (uso ferramentas eventualmente)",
      "Uso consciente (uso GenAI para tarefas simples diariamente)",
      "Entusiasta (sei diferenciar IA, Machine Learning e Deep Learning)",
      "Praticante (consigo usar um modelo via API e/ou limpar e coletar dados)",
      "Especialista (sei otimizar modelos e/ou traduzir um problema de negócio em uma estratégia que use IA eficientemente)",
    ]);
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
    assert.deepEqual(choice("conteudo").options, [
      "Tutoriais práticos",
      "Curadoria de novas ferramentas",
      "Notícias do mundo de IA",
      "Estudos de caso (como uma empresa usa IA)",
      "Análises mais aprofundadas sobre um tema específico",
      "Pesquisas sobre IA",
      "Artigos de opinião e editoriais",
    ]);
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

  it("collectFormFields preserva campos repetidos do POST", () => {
    const f = collectFormFields([["email", "a@x.com"], ["conteudo", "A"], ["conteudo", "B"], ["arquivo", {}]]);
    assert.deepEqual(f, { email: "a@x.com", conteudo: ["A", "B"] });
  });
});

describe("#10605 HTML do formulário", () => {
  const html = renderFormHtml('a+b@x.com"><script>');

  it("e-mail pré-preenchido e escapado, página móvel em pt-BR", () => {
    assert.ok(html.includes('value="a+b@x.com&quot;&gt;&lt;script&gt;"'));
    assert.ok(html.includes('lang="pt-BR"') && html.includes("width=device-width"));
    assert.ok(html.includes(`São ${FORM_QUESTIONS.length} perguntas`));
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

  it("agradecimento não promete parar lembrete na hora (lote do Kit já agendado ainda pode sair)", () => {
    const t = renderThanksHtml();
    assert.ok(t.includes("Em breve você para de receber lembretes"));
    assert.ok(!/não vai receber mais/.test(t));
  });
});

describe("#10605 rascunhos dos e-mails (semente do --init-snippets)", () => {
  const cfgOk = resolveFollowupConfig({ form_url: "https://f.example/", form_responses_url: "https://f.example/api/respostas" });

  for (const file of ["onboarding-formulario.md", "formulario-lembrete.md"]) {
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
      assert.deepEqual(formContentGate({ form: approved, form_lembrete: approved }, cfgOk), { blocked: false });
      const pend: FollowupSnippets = { form: snip, form_lembrete: snip };
      assert.equal((formContentGate(pend, cfgOk) as { motivo: string }).motivo, "texto_pendente");
    });
  }

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
    const beehiivOnly = BEEHIIV_SURVEY_PROMPTS.map((p, i) => ({ id: `b${i}`, answers: [{ question_id: "q", question_prompt: p.prompt, answer: "x" }] }));
    assert.deepEqual(renderProductInterestSection(beehiivOnly), [], "survey antiga sozinha não gera seção 4");
    assert.equal(formRespondentsNote(conv), " (2 do formulário do onboarding)");
    assert.equal(formRespondentsNote([{ id: "beehiiv-1", answers: [] }]), "");
  });

  it("update-audience main(): seção 4, nota de respondentes do formulário e texto livre ausente", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-audience-10605-"));
    const survey = [
      { id: "r1", status: "active", answers: [{ question_id: "q1", question_prompt: BEEHIIV_SURVEY_PROMPTS[0].prompt, answer: LEVELS()[0] }] },
      ...onboardingFormToSurveyResponses(sample).responses,
    ];
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
      warnFn: () => {},
    });
    assert.equal(result.ok, true, result.reason);
    const doc = readFileSync(outPath, "utf8");
    assert.match(doc, /\*\*respondentes survey:\*\* 3 \(2 do formulário do onboarding\)/);
    assert.match(doc, /## 4\. Interesse em produtos \(formulário do onboarding\)/);
    assert.match(doc, new RegExp(`- \\*\\*${LEVELS()[0].replace(/[()]/g, "\\$&")}\\*\\* — weight 0\\.667 \\(2 respostas\\)`), "nível soma survey + formulário");
    assert.ok(!doc.includes("mais saúde"));
  });
});

describe("#10605 leitura do formulário: só 'não configurado' é tolerado", () => {
  const cfgUrl: PlatformConfig = { onboarding: { followup: { form_responses_url: "https://f.example/api/respostas" } } };
  const okPayload = { responses: [{ email: "a@x.com", submitted_at: "2026-10-20T12:00:00Z", answers: { area: "RH" } }] };

  it("loadOnboardingFormSurveyResponses: null segue, falha de leitura ABORTA", async () => {
    assert.deepEqual(await loadOnboardingFormSurveyResponses({}, undefined), []);
    assert.deepEqual(await loadOnboardingFormSurveyResponses({}, async () => null), []);
    await assert.rejects(loadOnboardingFormSurveyResponses({}, async () => { throw new Error("HTTP 500"); }), AudienceAbort);
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

describe("#10605 audience-run soma o formulário à survey", () => {
  const survey = [{ id: "s1", answers: [{ question_id: "q1", question_prompt: "Qual seu nível de conhecimento em IA?", answer: "Uso casual (uso ferramentas eventualmente)" }] }];

  function setup(surveyData: unknown = survey): { deps: (over: Partial<AudienceRunDeps>) => AudienceRunDeps; rawPath: string; calls: string[] } {
    const root = mkdtempSync(join(tmpdir(), "audience-run-form-"));
    writeFileSync(resolve(root, "platform.config.json"), serializePlatformConfig({}), "utf8");
    mkdirSync(resolve(root, "data"), { recursive: true });
    writeFileSync(resolve(root, "data/resp.json"), JSON.stringify(surveyData), "utf8");
    const calls: string[] = [];
    const deps = (over: Partial<AudienceRunDeps>): AudienceRunDeps => ({
      rootDir: root,
      apiKey: undefined,
      fetchPublications: async () => { throw new Error("não chamado"); },
      exec: (script) => { calls.push(script); return { code: 0, stdout: "", stderr: "" }; },
      readFile: (p) => readFileSync(p, "utf8"),
      writeFile: (p, c) => writeFileSync(p, c, "utf8"),
      ...over,
    });
    return { deps, rawPath: resolve(root, "data/audience-raw.json"), calls };
  }
  const ARGS = ["--skip-beehiiv-resolve", "--responses", "data/resp.json"];

  it("grava survey + formulário juntos e roda update-audience", async () => {
    const { deps, rawPath, calls } = setup();
    const r = await runAudience(ARGS, deps({ fetchFormResponses: async () => [R({ nivel_ia: LEVELS()[1], area: "RH" })] }));
    assert.equal(r.code, 0);
    assert.deepEqual((JSON.parse(readFileSync(rawPath, "utf8")) as { id: string }[]).map((x) => x.id), ["s1", "onboarding-form:1"]);
    assert.deepEqual(calls, ["scripts/update-audience.ts"]);
  });

  it("formulário configurado mas leitura falhando ABORTA sem gravar nada", async () => {
    const { deps, rawPath, calls } = setup();
    const r = await runAudience(ARGS, deps({ fetchFormResponses: async () => { throw new Error("HTTP 503"); } }));
    assert.equal(r.code, 1);
    assert.equal(existsSync(rawPath), false);
    assert.deepEqual(calls, []);
  });

  it("formulário não configurado segue só com a survey", async () => {
    const { deps, rawPath } = setup();
    assert.equal((await runAudience(ARGS, deps({ fetchFormResponses: async () => null }))).code, 0);
    assert.deepEqual((JSON.parse(readFileSync(rawPath, "utf8")) as { id: string }[]).map((x) => x.id), ["s1"]);
  });

  it("survey vazia aborta mesmo com formulário, a menos que --allow-form-only", async () => {
    const form = async () => [R({ area: "RH" })];
    const a = setup([]);
    assert.equal((await runAudience(ARGS, a.deps({ fetchFormResponses: form }))).code, 1);
    assert.equal(existsSync(a.rawPath), false, "dump [] não troca o perfil por um só do formulário");
    const b = setup([]);
    assert.equal((await runAudience([...ARGS, "--allow-form-only"], b.deps({ fetchFormResponses: form }))).code, 0);
    assert.deepEqual((JSON.parse(readFileSync(b.rawPath, "utf8")) as { id: string }[]).map((x) => x.id), ["onboarding-form:1"]);
    const c = setup([]);
    assert.equal((await runAudience([...ARGS, "--allow-form-only"], c.deps({ fetchFormResponses: async () => null }))).code, 1);
    assert.equal(existsSync(c.rawPath), false);
  });
});
