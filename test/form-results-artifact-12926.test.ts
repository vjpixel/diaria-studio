import { it, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  formatBrtDateTime,
  formatBrtDay,
  formatDuration,
  isTrivialOpenAnswer,
  questionNumbers,
  questionNotes,
  renderFormResultsArtifact,
  writeFormResultsArtifact,
} from "../scripts/form-results-artifact.ts";
import { buildFormPartialResults } from "../scripts/lib/onboarding-form-partial-results.ts";
import { FORM_VERSION, FORM_CONVERSA_SIM, FORM_QUESTIONS, type FormResponse } from "../scripts/lib/onboarding-form-contract.ts";
import { EDITOR_SEED_EMAILS } from "../scripts/lib/editor-copy.ts";
import type { FollowupPerson } from "../scripts/lib/onboarding-followup.ts";

const full = (over: Record<string, string>) => ({
  uso_ia: "Uso pouco: só testei ou uso de vez em quando",
  situacao: "Servidor(a) público(a)",
  area: "Contabilidade",
  uso_recente: "Comentei ou compartilhei com alguém",
  ferramentas: "ChatGPT | Gemini",
  motivacao: "Ganhar tempo nas tarefas do meu trabalho",
  dificuldades: "Falta tempo para aprender",
  produto_formato: "Curso online gravado, no meu ritmo",
  produto_tema: "Como escrever bons prompts",
  quem_paga: "Ninguém: só uso versões gratuitas",
  maior_gasto: "Não paguei por nenhum",
  ...over,
});

const snapshot = {
  available: true as const, storeLido: false, geradoEm: "2026-11-13T01:02:03.000Z",
  ...buildFormPartialResults([
    { email: "private@example.com", submitted_at: "2026-11-12T12:00:00Z", form_version: FORM_VERSION, answers: { relato_falha: "<script>alert(1)</script> contato outra@example.com", conversa: FORM_CONVERSA_SIM } },
    { email: "second@example.com", submitted_at: "2026-11-12T13:00:00Z", form_version: FORM_VERSION, answers: { relato_falha: "Um relato sobre Nome Terceiro" } },
  ]),
};

it("HTML completo com foto em BRT, resumo, barras e textos seguros, sem contatos", () => {
  const html = renderFormResultsArtifact(snapshot, ["nome terceiro"]);
  assert.match(html, /^<!doctype html>/);
  // 01:02 UTC de 13/11 = 22:02 de 12/11 em Brasília: nunca o ISO em UTC.
  assert.match(html, /Foto tirada em 12\/11, 22:02 \(horário de Brasília\)/);
  assert.doesNotMatch(html, /2026-11-13T01:02:03/);
  assert.match(html, /<b>2<\/b><span>respostas<\/span>/);
  assert.match(html, /<b>1<\/b><span>toparam a conversa de 20 minutos<\/span>/);
  assert.match(html, /<b>2<\/b><span>contaram uma falha da IA<\/span>/);
  assert.match(html, /tempo de resposta não registrado/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|[\w.+-]+@[\w-]+\.[\w.]+|Nome Terceiro/);
  assert.match(html, /\[e-mail omitido\]/);
  assert.match(html, /1 texto omitido na revisão/);
  assert.match(html, /store do onboarding indisponível/);
});

it("omite vários filtros e recusa filtros vazios ou leitura indisponível", () => {
  const html = renderFormResultsArtifact(snapshot, ["nome terceiro", "CONTATO"]);
  assert.match(html, /2 textos omitidos na revisão/);
  assert.match(html, /Nenhum relato para exibir/);
  assert.throws(() => renderFormResultsArtifact(snapshot, [" "]), /Filtro de relato vazio/);
  assert.throws(() => renderFormResultsArtifact({ available: false, motivo: "Worker fora", geradoEm: snapshot.geradoEm }), /Worker fora/);
});

it("sem respostas não produz NaN nem Infinity", () => {
  const html = renderFormResultsArtifact({ available: true, geradoEm: snapshot.geradoEm, storeLido: false, ...buildFormPartialResults([]) });
  assert.match(html, /<b>0<\/b><span>respostas<\/span>/);
  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.doesNotMatch(html, /Respostas em "Outro"/);
});

describe("layout publicado (#13979)", () => {
  const people: Record<string, FollowupPerson> = {
    a: { email: "a@example.com", form_invite: "form_base" } as unknown as FollowupPerson,
  };
  const responses: FormResponse[] = [
    { email: "a@example.com", submitted_at: "2026-11-09T15:00:00Z", form_version: FORM_VERSION, duration_s: 200, answers: full({ relato_falha: "Inventou números num resumo.", area: "Outra", area_outro: "Arqueologia", conversa: FORM_CONVERSA_SIM }) },
    { email: "b@example.com", submitted_at: "2026-11-20T15:00:00Z", form_version: FORM_VERSION, duration_s: 260, answers: full({ relato_falha: "x", area: "Outra", area_outro: "x", produto_formato: "Curso online gravado, no meu ritmo | Aula ou workshop ao vivo", produto_escolha: "Aula ou workshop ao vivo" }) },
    // 02:30 UTC de 26/11 = 23:30 de 25/11 em Brasília.
    { email: "c@example.com", submitted_at: "2026-11-26T02:30:00Z", form_version: FORM_VERSION, duration_s: 230, answers: full({ relato_falha: "  ...  ", quem_paga: "Eu, do próprio bolso", gasto_mensal: "Até R$ 50" }) },
    { email: EDITOR_SEED_EMAILS[0], submitted_at: "2026-11-21T15:00:00Z", form_version: FORM_VERSION, answers: full({ relato_falha: "teste do editor" }) },
  ];
  const view = { available: true as const, storeLido: true, geradoEm: "2026-11-26T17:58:00.000Z", ...buildFormPartialResults(responses, { people }) };
  const html = renderFormResultsArtifact(view);

  it("lede com período e foto em BRT, derivados das respostas (sem datas fixas)", () => {
    assert.match(html, /3 respostas recebidas de 09\/11 a 25\/11, sem as de teste/);
    assert.match(html, /1 veio do convite da base e 2 sem convite registrado/);
    assert.match(html, /Foto tirada em 26\/11, 14:58 \(horário de Brasília\)/);
    assert.doesNotMatch(html, /teste do editor/);
  });

  it("resumo: respostas, conversa, relatos sem lixo e tempo mediano de duration_s", () => {
    assert.match(html, /<b>3<\/b><span>respostas<\/span>/);
    assert.match(html, /<b>1<\/b><span>toparam a conversa de 20 minutos<\/span>/);
    // "x" e "..." não contam como relato de falha.
    assert.match(html, /<b>1<\/b><span>contaram uma falha da IA<\/span>/);
    assert.match(html, /<b>4 min<\/b><span>tempo mediano para responder<\/span>/);
    assert.equal((html.match(/<blockquote>/g) ?? []).length, 1);
  });

  it("numera as perguntas, marca as subperguntas e escreve as notas de exibição", () => {
    assert.match(html, /<span class="qn">1<\/span><h3>Como você usa IA hoje\?/);
    assert.match(html, /<span class="qn">8 · sub<\/span><h3>Se só um deles existisse/);
    assert.match(html, /1 de 3 responderam · só aparece para quem marcou 2 ou mais opções na 8/);
    assert.match(html, /<span class="qn">10 · sub<\/span>/);
    assert.match(html, /só aparece para quem marcou &quot;Eu, do próprio bolso&quot; ou &quot;Eu e a empresa, uma parte cada&quot; na 10/);
    assert.match(html, /<span class="qn">9<\/span>[^]*?não aparece para quem marcou &quot;Nada disso, a newsletter já me basta&quot; na 8/);
    assert.match(html, /<span class="qn">11<\/span>/);
    assert.match(html, /3 de 3 responderam · várias opções por pessoa, a soma passa de 100%/);
  });

  it("barras relativas à maior opção, percentual sobre quem respondeu, zeros esmaecidos", () => {
    // ferramentas: ChatGPT e Gemini marcados pelos 3.
    assert.match(html, /<div class="opt">ChatGPT<\/div><div class="bar"><span style="width:100.0%"><\/span><\/div><div class="num">3<small>100%<\/small>/);
    assert.match(html, /<div class="row zero"><div class="opt">Claude<\/div>/);
  });

  it("seção Outro com o texto e a pergunta de origem, sem respostas lixo", () => {
    assert.match(html, /<h2>Respostas em "Outro"<\/h2>/);
    assert.match(html, /<li><span>Arqueologia<\/span><small>Em que área você trabalha ou estuda\?<\/small><\/li>/);
    assert.equal((html.match(/<li>/g) ?? []).length, 1);
  });

  it("design system: Georgia/Geist, teal na .rule, tema escuro", () => {
    assert.match(html, /--serif:Georgia/);
    assert.match(html, /family=Geist/);
    assert.match(html, /\.rule\{[^}]*background:var\(--teal\)/);
    assert.match(html, /<hr class="rule">/);
    assert.match(html, /prefers-color-scheme: dark/);
  });
});

describe("helpers puros (#13979)", () => {
  it("isTrivialOpenAnswer: até 2 caracteres ou sem letra nem número", () => {
    for (const t of ["x", " X ", "ok", "...", "---", "", "  "]) assert.equal(isTrivialOpenAnswer(t), true, t);
    for (const t of ["Não", "IA", "Inventou números", "123"]) assert.equal(isTrivialOpenAnswer(t), t === "IA", t);
  });
  it("datas em BRT", () => {
    assert.equal(formatBrtDay("2026-11-26T02:30:00Z"), "25/11");
    assert.equal(formatBrtDateTime("2026-11-25T17:58:00Z"), "25/11, 14:58");
  });
  it("formatDuration", () => {
    assert.equal(formatDuration(null), null);
    assert.equal(formatDuration(45), "45 s");
    assert.equal(formatDuration(230), "4 min");
  });
  it("questionNumbers segue a ordem do formulário", () => {
    const n = questionNumbers(FORM_QUESTIONS);
    assert.equal(n.get("uso_ia"), "1");
    assert.equal(n.get("dificuldades"), "7");
    assert.equal(n.has("relato_falha"), false);
    assert.equal(n.get("produto_formato"), "8");
    assert.equal(n.get("produto_escolha"), "8 · sub");
    assert.equal(n.get("produto_tema"), "9");
    assert.equal(n.get("quem_paga"), "10");
    assert.equal(n.get("gasto_mensal"), "10 · sub");
    assert.equal(n.get("maior_gasto"), "11");
  });
  it("questionNotes: escolha única sem condição não tem nota", () => {
    const n = questionNumbers(FORM_QUESTIONS);
    assert.deepEqual(questionNotes(FORM_QUESTIONS[0], n), []);
  });
});

it("gera arquivo da leitura fresca e preserva arquivo anterior quando o Worker falha", async () => {
  const root = mkdtempSync(join(tmpdir(), "artifact-12926-"));
  try {
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ onboarding: { followup: { form_responses_url: "https://example.com/api/respostas" } } }));
    const output = join(root, "out", "results.html");
    let calls = 0;
    await writeFormResultsArtifact(root, output, [], { fetchResponses: async () => { calls++; return []; }, now: () => new Date(snapshot.geradoEm) });
    const html = readFileSync(output, "utf8");
    assert.equal(calls, 1);
    assert.match(html, /<b>0<\/b><span>respostas<\/span>/);
    assert.match(html, /12\/11, 22:02/);
    await assert.rejects(writeFormResultsArtifact(root, output, [], { fetchResponses: async () => { throw new Error("HTTP 503"); } }), /HTTP 503/);
    assert.equal(readFileSync(output, "utf8"), html);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("CLI help e flags inválidas saem sem buscar respostas ou gravar", () => {
  const script = "scripts/form-results-artifact.ts";
  const help = execFileSync(process.execPath, ["--import", "tsx", script, "--help"], { encoding: "utf8" });
  assert.match(help, /--exclude-open-text/);
  for (const argv of [["--output"], ["--bogus"], ["--exclude-open-text="]]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", script, ...argv], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Artefato gravado/);
  }
});
