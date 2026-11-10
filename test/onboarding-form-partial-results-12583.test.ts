/**
 * test/onboarding-form-partial-results-12583.test.ts (#12583)
 *
 * Pergunta do editor (10/11/2026): "como acesso o resultado parcial do
 * formulário?". Antes só por uma sessão (o `GET /api/respostas` pede token).
 * Agora: Studio > Assinantes > "Formulário: resultado parcial". Trava:
 *
 *  1. `buildFormPartialResults` (lógica pura): resposta mais recente por
 *     e-mail; testes do editor fora (com `+sufixo` também); origem pelo
 *     convite do store (base, onboarding, sem convite; casa por
 *     `previous_emails`); contagem por opção só da versão atual; textos de
 *     "Outro" e `relato_falha` sem e-mail; conversa num bloco à parte;
 *     nenhum e-mail fora do bloco da conversa.
 *  2. `buildFormResultsView`: endpoint ausente, Worker falhando e store
 *     corrompido viram `available: false`/origem sem convite, nunca exceção.
 *  3. O HTML do painel (`formulario-parcial.js`): escapa texto do leitor, não
 *     põe e-mail no resumo/contagens/abertas, e põe na lista da conversa.
 *  4. A página: painel entre a busca e "Detalhes", rota no servidor.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildFormPartialResults, formResponseOrigin, isFormTestEmail } from "../scripts/lib/onboarding-form-partial-results.ts";
import { FORM_CONVERSA_SIM, FORM_MULTI_SEPARATOR, FORM_QUESTIONS, FORM_VERSION, type FormResponse } from "../scripts/lib/onboarding-form-contract.ts";
import type { FollowupPerson } from "../scripts/lib/onboarding-followup.ts";
import { buildFormResultsView } from "../scripts/studio-ui/studio-onboarding-form.ts";
import { conversaHtml, formOpenAnswersHtml, formQuestionsHtml, formSummaryHtml, formUnavailableText } from "../scripts/studio-ui/public/formulario-parcial.js";

const ROOT = resolve(import.meta.dirname, "..");

function resp(email: string, at: string, answers: Record<string, string>, form_version: number | null = FORM_VERSION): FormResponse {
  return { email, submitted_at: at, answers, ...(form_version != null ? { form_version } : {}) };
}

function person(id: number, email: string, step: "form" | "form_base" | null, extra: Partial<FollowupPerson> = {}): FollowupPerson {
  return {
    kit_subscriber_id: id,
    email,
    cadastro_at: null,
    sends: step ? [{ step, at: "2026-11-09T12:00:00.000Z", lot_id: `lot-${step}` }] : [],
    ...extra,
  };
}

const PEOPLE: Record<string, FollowupPerson> = {
  "1": person(1, "base@x.com", "form_base"),
  "2": person(2, "novo@x.com", "form"),
  "3": person(3, "trocou@x.com", "form_base", { previous_emails: ["antigo@x.com"] }),
};

const RESPONSES: FormResponse[] = [
  // Mesma pessoa duas vezes: vale a mais recente.
  resp("base@x.com", "2026-11-09T13:00:00.000Z", { uso_ia: "Uso pouco: só testei ou uso de vez em quando" }),
  resp("Base@X.com", "2026-11-10T09:00:00.000Z", {
    uso_ia: "Uso com frequência em tarefas do dia a dia (textos, resumos, pesquisas)",
    area: "Outra",
    area_outro: "Arqueologia <script>",
    ferramentas: ["ChatGPT", "Claude"].join(FORM_MULTI_SEPARATOR),
    relato_falha: "Pediu um resumo e inventou números",
    conversa: FORM_CONVERSA_SIM,
  }),
  resp("novo@x.com", "2026-11-09T20:00:00.000Z", {
    uso_ia: "Uso com frequência em tarefas do dia a dia (textos, resumos, pesquisas)",
    ferramentas: ["ChatGPT", "Gemini"].join(FORM_MULTI_SEPARATOR),
  }),
  // Respondeu com o e-mail antigo: continua sendo do lote da base.
  resp("antigo@x.com", "2026-11-09T15:00:00.000Z", { ferramentas: "Nenhuma", conversa: FORM_CONVERSA_SIM }),
  // Ninguém no store.
  resp("sumido@x.com", "2026-11-09T16:00:00.000Z", { uso_ia: "Uso pouco: só testei ou uso de vez em quando" }),
  // Versão anterior das perguntas: conta no total, não nas opções.
  resp("velho@x.com", "2026-11-08T10:00:00.000Z", { nivel_ia: "iniciante", uso_ia: "Uso pouco: só testei ou uso de vez em quando" }, null),
  // Testes do editor.
  resp("vjpixel@gmail.com", "2026-11-09T11:00:00.000Z", { uso_ia: "Uso pouco: só testei ou uso de vez em quando", conversa: FORM_CONVERSA_SIM }),
  resp("vjpixel+teste3@gmail.com", "2026-11-09T11:30:00.000Z", { uso_ia: "Uso pouco: só testei ou uso de vez em quando" }),
  resp("pixel@memelab.com.br", "2026-11-09T11:40:00.000Z", { relato_falha: "teste do editor" }),
];

describe("#12583 buildFormPartialResults", () => {
  const r = buildFormPartialResults(RESPONSES, { people: PEOPLE });

  it("conta a resposta mais recente por pessoa e deixa os testes do editor fora", () => {
    assert.equal(r.total, 5);
    assert.equal(r.testes_excluidos, 3);
    assert.equal(r.versao_anterior, 1);
    assert.equal(r.versao_atual, FORM_VERSION);
    assert.equal(r.primeira, "2026-11-08");
    assert.equal(r.ultima, "2026-11-10");
  });

  it("separa por origem do convite, casando também pelo e-mail antigo", () => {
    assert.deepEqual(r.por_origem, { base: 2, onboarding: 1, sem_convite: 2 });
    assert.equal(formResponseOrigin(undefined), "sem_convite");
    assert.equal(formResponseOrigin(person(9, "a@x.com", "form")), "onboarding");
  });

  it("conta cada opção das perguntas de marcar, só na versão atual", () => {
    const uso = r.perguntas.find((q) => q.id === "uso_ia")!;
    assert.equal(uso.responderam, 3, "base (a mais recente), novo, sumido; o velho é v2");
    const n = Object.fromEntries(uso.opcoes.map((o) => [o.opcao, o.n]));
    assert.equal(n["Uso com frequência em tarefas do dia a dia (textos, resumos, pesquisas)"], 2);
    assert.equal(n["Uso pouco: só testei ou uso de vez em quando"], 1);
    assert.equal(uso.opcoes.length, (FORM_QUESTIONS.find((q) => q.id === "uso_ia") as { options: readonly string[] }).options.length, "opções com zero aparecem");
    const ferr = r.perguntas.find((q) => q.id === "ferramentas")!;
    assert.equal(ferr.tipo, "checkbox");
    assert.equal(ferr.responderam, 3);
    const nf = Object.fromEntries(ferr.opcoes.map((o) => [o.opcao, o.n]));
    assert.equal(nf.ChatGPT, 2);
    assert.equal(nf.Nenhuma, 1);
    assert.equal(ferr.fora_da_lista, 0);
  });

  it("a conversa não vira tabela de opções: tem bloco próprio, com e-mail, mais recente primeiro", () => {
    assert.ok(!r.perguntas.some((q) => q.id === "conversa"));
    assert.equal(r.conversa.toparam, 2);
    assert.deepEqual(r.conversa.pessoas, [
      { email: "base@x.com", data: "2026-11-10", origem: "base" },
      { email: "antigo@x.com", data: "2026-11-09", origem: "base" },
    ]);
  });

  it("respostas abertas saem sem e-mail (relato e o texto do 'Outra')", () => {
    const relato = r.abertas.find((b) => b.id === "relato_falha")!;
    assert.deepEqual(relato.respostas, [{ data: "2026-11-10", texto: "Pediu um resumo e inventou números" }]);
    const areaOutro = r.abertas.find((b) => b.id === "area_outro")!;
    assert.deepEqual(areaOutro.respostas.map((a) => a.texto), ["Arqueologia <script>"]);
  });

  it("nenhum e-mail fora do bloco da conversa", () => {
    const { conversa: _c, ...agregado } = r;
    assert.ok(!JSON.stringify(agregado).includes("@"), JSON.stringify(agregado));
  });

  it("teste do editor casa com +sufixo e maiúscula, e só o editor", () => {
    assert.ok(isFormTestEmail("VJPixel+x@Gmail.com"));
    assert.ok(isFormTestEmail("pixel@memelab.com.br"));
    assert.ok(!isFormTestEmail("vjpixel@outlook.com"));
    assert.ok(!isFormTestEmail("outra+vjpixel@gmail.com"));
  });

  it("destinatário do e-mail da base sem registro por pessoa ainda: lote da base", () => {
    const s = buildFormPartialResults(RESPONSES, { people: PEOPLE, baseRecipientEmails: ["Sumido@x.com"] });
    assert.deepEqual(s.por_origem, { base: 3, onboarding: 1, sem_convite: 1 });
    assert.equal(formResponseOrigin(person(9, "a@x.com", "form"), true), "onboarding", "convite registrado vence a lista");
  });

  it("sem store: todo mundo sem convite registrado", () => {
    const s = buildFormPartialResults(RESPONSES);
    assert.deepEqual(s.por_origem, { base: 0, onboarding: 0, sem_convite: 5 });
  });
});

describe("#12583 buildFormResultsView", () => {
  function cfgDir(followup: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "form-12583-"));
    writeFileSync(join(dir, "platform.config.json"), JSON.stringify({ onboarding: { followup } }));
    return dir;
  }
  const followup = { enabled: true, form_url: "https://f.example/", form_responses_url: "https://f.example/api/respostas" };
  const now = () => new Date("2026-11-10T12:00:00.000Z");

  it("sem endpoint configurado: indisponível com o motivo", async () => {
    const dir = cfgDir({ enabled: true });
    const v = await buildFormResultsView(dir, { now, fetchResponses: async () => [] });
    assert.equal(v.available, false);
    assert.match((v as { motivo: string }).motivo, /form_responses_url/);
  });

  it("Worker falhando: indisponível com o motivo, sem lançar", async () => {
    const dir = cfgDir(followup);
    const v = await buildFormResultsView(dir, { now, fetchResponses: async () => { throw new Error("HTTP 503"); } });
    assert.equal(v.available, false);
    assert.match((v as { motivo: string }).motivo, /HTTP 503/);
  });

  it("lê o store para a origem; store corrompido cai em sem convite", async () => {
    const dir = cfgDir(followup);
    const storePath = join(dir, "store.json");
    writeFileSync(storePath, JSON.stringify({ version: 1, entries: {}, followup: { people: PEOPLE, lots: {} } }));
    const ok = await buildFormResultsView(dir, { now, storePath, fetchResponses: async () => RESPONSES });
    assert.equal(ok.available, true);
    if (ok.available) {
      assert.equal(ok.storeLido, true);
      assert.equal(ok.por_origem.base, 2);
      assert.equal(ok.geradoEm, "2026-11-10T12:00:00.000Z");
    }
    writeFileSync(storePath, "{ quebrado");
    const bad = await buildFormResultsView(dir, { now, storePath, fetchResponses: async () => RESPONSES });
    assert.equal(bad.available, true);
    if (bad.available) {
      assert.equal(bad.storeLido, false);
      assert.equal(bad.por_origem.sem_convite, 5);
    }
  });
});

describe("#12583 HTML do painel", () => {
  const r = buildFormPartialResults(RESPONSES, { people: PEOPLE });
  const view = { available: true as const, geradoEm: "2026-11-10T12:00:00.000Z", storeLido: true, ...r };

  it("resumo, contagens e abertas sem e-mail, com texto do leitor escapado", () => {
    const html = formSummaryHtml(view) + formQuestionsHtml(r.perguntas) + formOpenAnswersHtml(r.abertas);
    assert.ok(!html.includes("@"), "e-mail na visão agregada");
    assert.ok(html.includes("Arqueologia &lt;script&gt;"));
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("lote da base"));
    assert.match(html, /3 resposta\(s\) de teste/);
  });

  it("lista da conversa tem o e-mail; vazia diz isso", () => {
    assert.ok(conversaHtml(r.conversa).includes("base@x.com"));
    assert.match(conversaHtml({ toparam: 0, pessoas: [] }), /Ninguém marcou/);
    assert.match(formUnavailableText({ motivo: "respostas indisponíveis: x" }), /respostas indisponíveis: x/);
    assert.match(formUnavailableText(null), /inesperada/);
  });
});

describe("#12583 página e rota", () => {
  const html = readFileSync(join(ROOT, "scripts/studio-ui/public/assinantes.html"), "utf8");
  const server = readFileSync(join(ROOT, "scripts/studio-ui/server.ts"), "utf8");

  it("painel entre a busca e 'Detalhes', com os ids que o JS usa", () => {
    const busca = html.indexOf('id="search-form"');
    const painel = html.indexOf('id="formulario-panel"');
    const detalhes = html.indexOf('id="detalhes"');
    assert.ok(busca > 0 && busca < painel && painel < detalhes);
    for (const id of ["formulario-load-btn", "formulario-status", "formulario-result", "formulario-summary", "formulario-perguntas", "formulario-abertas", "formulario-conversa"]) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
  });

  it("o servidor expõe GET /api/onboarding/form-results", () => {
    assert.ok(server.includes('urlPath === "/api/onboarding/form-results"'));
    assert.ok(server.includes("buildFormResultsView"));
  });
});
