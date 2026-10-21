/**
 * test/onboarding-form-questions-10605.test.ts (#10605)
 *
 * Perguntas do formulário do onboarding (rascunho aguardando o editor), o
 * HTML do Worker, os rascunhos dos 2 e-mails como semente do
 * `--init-snippets` (com o marcador pendente que trava o envio) e a soma das
 * respostas ao perfil de audiência (`audience-run.ts` → `update-audience.ts`).
 * Nada toca rede nem `data/` do repo: tudo em `mkdtempSync`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FORM_QUESTIONS,
  FORM_MULTI_SEPARATOR,
  parseFormSubmission,
  splitMultiAnswer,
  type FormResponse,
} from "../scripts/lib/onboarding-form-contract.ts";
import {
  SURVEY_MATCHERS,
  onboardingFormToSurveyResponses,
  isOnboardingFormResponse,
  type SurveyMatcherKey,
} from "../scripts/lib/audience-survey-questions.ts";
import { collectFormFields, renderFormHtml, RADIO_MAX_OPTIONS } from "../workers/onboarding-form/src/render.ts";
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
import { renderProductInterestSection, formRespondentsNote } from "../scripts/update-audience.ts";
import {
  runAudience,
  loadOnboardingFormSurveyResponses,
  serializePlatformConfig,
  type AudienceRunDeps,
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

const NUMBER_WORDS: Record<number, string> = { 5: "cinco", 6: "seis", 7: "sete", 8: "oito" };
const ARROWS = /[←→]/;
const LEGACY_BRAND = /Diar\.ia(?!\.br)/;

function matchersOf(label: string): SurveyMatcherKey[] {
  return (Object.keys(SURVEY_MATCHERS) as SurveyMatcherKey[]).filter((k) => SURVEY_MATCHERS[k].test(label));
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

  it("toda opção de múltipla escolha é não vazia, única e não contém o separador", () => {
    for (const q of FORM_QUESTIONS) {
      if (q.kind !== "select" && q.kind !== "checkbox") continue;
      const opts = q.options ?? [];
      assert.ok(opts.length >= 2, q.id);
      assert.equal(new Set(opts).size, opts.length, q.id);
      for (const o of opts) assert.ok(o.trim() !== "" && !o.includes(FORM_MULTI_SEPARATOR.trim()), `${q.id}: ${o}`);
    }
  });

  it("cada pergunta cai em exatamente um matcher do perfil (o esperado)", () => {
    for (const q of FORM_QUESTIONS) {
      assert.deepEqual(matchersOf(q.label), [EXPECTED_MATCHER[q.id]], `${q.id}: "${q.label}"`);
    }
  });

  it("copy do leitor sem seta, sem marca antiga", () => {
    for (const q of FORM_QUESTIONS) {
      for (const t of [q.label, q.help ?? "", ...(q.options ?? [])]) {
        assert.ok(!ARROWS.test(t) && !LEGACY_BRAND.test(t), t);
      }
    }
  });
});

describe("#10605 parseFormSubmission com caixas de seleção", () => {
  const base = { email: "a@x.com", nivel_ia: FORM_QUESTIONS[0].options![0], area: "RH" };

  it("várias opções viram uma string na ordem da pergunta, sem repetição", () => {
    const opts = FORM_QUESTIONS.find((q) => q.id === "conteudo")!.options!;
    const r = parseFormSubmission({ ...base, conteudo: [opts[3], opts[0], opts[3]] });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.submission.answers.conteudo, `${opts[0]}${FORM_MULTI_SEPARATOR}${opts[3]}`);
    assert.deepEqual(splitMultiAnswer(r.submission.answers.conteudo), [opts[0], opts[3]]);
  });

  it("uma opção só (string) também vale; opção desconhecida é recusada", () => {
    const ok = parseFormSubmission({ ...base, produto_tema: "Como escrever bons prompts" });
    assert.ok(ok.ok);
    const bad = parseFormSubmission({ ...base, produto_tema: ["Como escrever bons prompts", "inventada"] });
    assert.equal(bad.ok, false);
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

  it("escolha única curta vira rádio, lista longa vira menu, múltipla vira caixa", () => {
    for (const q of FORM_QUESTIONS) {
      if (q.kind === "checkbox") assert.ok(html.includes(`type="checkbox" id="${q.id}-0" name="${q.id}"`), q.id);
      if (q.kind === "select" && q.options!.length <= RADIO_MAX_OPTIONS) assert.ok(html.includes(`type="radio" id="${q.id}-0" name="${q.id}"`), q.id);
      if (q.kind === "select" && q.options!.length > RADIO_MAX_OPTIONS) assert.ok(html.includes(`<select id="${q.id}" name="${q.id}"`), q.id);
      if (q.kind === "textarea") assert.ok(html.includes(`<textarea id="${q.id}" name="${q.id}"`), q.id);
    }
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
      assert.ok(snip.body.includes(NUMBER_WORDS[FORM_QUESTIONS.length]), "número de perguntas no texto bate com FORM_QUESTIONS");

      const approved = parseFollowupSnippet(raw.split("\n").filter((l) => !l.includes(PENDING_BODY_MARKER)).join("\n"));
      const both: FollowupSnippets = { form: approved, form_lembrete: approved };
      assert.deepEqual(formContentGate(both, cfgOk), { blocked: false });
      assert.equal((formContentGate({ form: snip, form_lembrete: snip }, cfgOk) as { motivo: string }).motivo, "texto_pendente");
    });
  }

  it("--init-snippets semeia do rascunho, troca o modelo vazio antigo e nunca sobrescreve texto editado", () => {
    const dir = mkdtempSync(join(tmpdir(), "followup-drafts-"));
    writeFileSync(join(dir, "formulario-lembrete.md"), snippetTemplate("form_lembrete"));
    writeFileSync(join(dir, "apoio-30.md"), "editado");
    const written = initFollowupSnippets(dir);
    assert.ok(written.some((p) => p.endsWith("onboarding-formulario.md")));
    assert.ok(written.some((p) => p.endsWith("formulario-lembrete.md")), "modelo vazio intacto vira o rascunho");
    assert.equal(readFileSync(join(dir, "apoio-30.md"), "utf8"), "editado");
    const snips = loadFollowupSnippets(dir);
    assert.ok(snips.form?.body.includes(FORM_URL_PLACEHOLDER) && snips.form.hasPendingMarker);
    assert.ok(snips.form_lembrete?.body.includes(FORM_URL_PLACEHOLDER) && snips.form_lembrete.hasPendingMarker);

    writeFileSync(join(dir, "onboarding-formulario.md"), "texto do editor");
    initFollowupSnippets(dir);
    assert.equal(readFileSync(join(dir, "onboarding-formulario.md"), "utf8"), "texto do editor");
  });

  it("rascunho sem o marcador pendente é recusado (a semente nunca sai aprovada)", () => {
    const drafts = mkdtempSync(join(tmpdir(), "followup-bad-draft-"));
    writeFileSync(join(drafts, "onboarding-formulario.md"), `<!--\nassunto: "x"\n-->\n<p>${FORM_URL_PLACEHOLDER}</p>`);
    const dir = mkdtempSync(join(tmpdir(), "followup-snip-"));
    assert.throws(() => initFollowupSnippets(dir, drafts), /ONBOARDING-CORPO-PENDENTE/);
  });
});

const R = (answers: Record<string, string>, email = "a@x.com"): FormResponse => ({ email, submitted_at: "2026-10-20T12:00:00Z", answers });

describe("#10605 respostas do formulário no perfil de audiência", () => {
  const sample = [
    R({
      nivel_ia: FORM_QUESTIONS[0].options![0],
      area: "RH",
      conteudo: ["Tutoriais práticos", "Pesquisas sobre IA"].join(FORM_MULTI_SEPARATOR),
      produto_formato: "Aula ou workshop ao vivo",
      produto_preco: "Até R$ 100",
      sugestao: "mais saúde",
      campo_antigo: "ignorado",
    }),
    R({ nivel_ia: FORM_QUESTIONS[0].options![1], area: "Vendas", produto_formato: "Aula ou workshop ao vivo" }, "b@x.com"),
  ];

  it("conversão: uma entrada por opção marcada, sem e-mail no id, pergunta removida ignorada", () => {
    const out = onboardingFormToSurveyResponses(sample);
    assert.equal(out.length, 2);
    assert.ok(out.every(isOnboardingFormResponse));
    assert.ok(!JSON.stringify(out).includes("@x.com"));
    const conteudo = out[0].answers.filter((a) => a.question_id === "form:conteudo").map((a) => a.answer);
    assert.deepEqual(conteudo, ["Tutoriais práticos", "Pesquisas sobre IA"]);
    assert.ok(!out[0].answers.some((a) => a.answer === "ignorado"));
  });

  it("seção 4 do perfil: formatos/preço contados, texto livre só como contagem", () => {
    const lines = renderProductInterestSection(onboardingFormToSurveyResponses(sample)).join("\n");
    assert.ok(lines.includes("## 4. Interesse em produtos"));
    assert.ok(lines.includes("- **Aula ou workshop ao vivo** — weight 1 (2 respostas)"));
    assert.ok(lines.includes("- **Até R$ 100**"));
    assert.ok(lines.includes("Respostas abertas: 1"));
    assert.ok(!lines.includes("mais saúde"), "texto livre não vai para o perfil");
    assert.deepEqual(renderProductInterestSection([{ id: "1", answers: [{ question_id: "q", question_prompt: "Qual seu nível de conhecimento em IA?", answer: "x" }] }]), []);
    assert.equal(formRespondentsNote(onboardingFormToSurveyResponses(sample)), " (2 do formulário do onboarding)");
    assert.equal(formRespondentsNote([{ id: "beehiiv-1", answers: [] }]), "");
  });

  it("fail-soft: sem fetch, não configurado ou leitura falhando devolve []", async () => {
    assert.deepEqual(await loadOnboardingFormSurveyResponses({}, undefined), []);
    assert.deepEqual(await loadOnboardingFormSurveyResponses({}, async () => null), []);
    assert.deepEqual(await loadOnboardingFormSurveyResponses({}, async () => { throw new Error("HTTP 500"); }), []);
    assert.equal((await loadOnboardingFormSurveyResponses({}, async () => sample)).length, 2);
  });
});

describe("#10605 audience-run soma o formulário à survey", () => {
  const survey = [{ id: "s1", answers: [{ question_id: "q1", question_prompt: "Qual seu nível de conhecimento em IA?", answer: "Uso casual (uso ferramentas eventualmente)" }] }];

  function setup(): { root: string; deps: (over: Partial<AudienceRunDeps>) => AudienceRunDeps; rawPath: string; calls: string[] } {
    const root = mkdtempSync(join(tmpdir(), "audience-run-form-"));
    writeFileSync(resolve(root, "platform.config.json"), serializePlatformConfig({}), "utf8");
    mkdirSync(resolve(root, "data"), { recursive: true });
    writeFileSync(resolve(root, "data/resp.json"), JSON.stringify(survey), "utf8");
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
    return { root, deps, rawPath: resolve(root, "data/audience-raw.json"), calls };
  }

  it("grava survey + formulário juntos e roda update-audience", async () => {
    const { deps, rawPath, calls } = setup();
    const r = await runAudience(["--skip-beehiiv-resolve", "--responses", "data/resp.json"], deps({ fetchFormResponses: async () => [R({ nivel_ia: FORM_QUESTIONS[0].options![1], area: "RH" })] }));
    assert.equal(r.code, 0);
    const raw = JSON.parse(readFileSync(rawPath, "utf8")) as { id: string }[];
    assert.deepEqual(raw.map((x) => x.id), ["s1", "onboarding-form:1"]);
    assert.deepEqual(calls, ["scripts/update-audience.ts"]);
  });

  it("leitura do formulário falhando não derruba o perfil (só a survey)", async () => {
    const { deps, rawPath } = setup();
    const r = await runAudience(["--skip-beehiiv-resolve", "--responses", "data/resp.json"], deps({ fetchFormResponses: async () => { throw new Error("HTTP 503"); } }));
    assert.equal(r.code, 0);
    assert.deepEqual((JSON.parse(readFileSync(rawPath, "utf8")) as { id: string }[]).map((x) => x.id), ["s1"]);
  });

  it("survey vazia + formulário com respostas ainda gera o perfil; tudo vazio continua abortando", async () => {
    const a = setup();
    writeFileSync(resolve(a.root, "data/resp.json"), "[]", "utf8");
    assert.equal((await runAudience(["--skip-beehiiv-resolve", "--responses", "data/resp.json"], a.deps({ fetchFormResponses: async () => [R({ area: "RH" })] }))).code, 0);
    const b = setup();
    writeFileSync(resolve(b.root, "data/resp.json"), "[]", "utf8");
    assert.equal((await runAudience(["--skip-beehiiv-resolve", "--responses", "data/resp.json"], b.deps({ fetchFormResponses: async () => null }))).code, 1);
    assert.equal(existsSync(b.rawPath), false);
  });
});
