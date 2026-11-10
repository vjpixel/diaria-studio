/**
 * test/onboarding-form-ux-12522.test.ts (#12522)
 *
 * Dois achados de UX do formulário v3:
 *  1. "Marque até 3": a 4ª caixa era desmarcada sem nenhum aviso (parecia que
 *     o clique tinha falhado). Agora a pergunta tem o aviso "Marque até 3."
 *     escondido, e o script o mostra logo abaixo da opção tocada.
 *  2. Sem JavaScript, a escolha única mostra todos os formatos; escolher um
 *     não marcado dava a página de erro genérica e a pessoa perdia o que tinha
 *     marcado. Agora o Worker devolve o formulário PREENCHIDO, com a mensagem
 *     na pergunta.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FORM_QUESTIONS, parseFormSubmission } from "../scripts/lib/onboarding-form-contract.ts";
import { signFormEmail } from "../scripts/lib/onboarding-form-link-sig.ts";
import { FORM_SCRIPT, renderFormHtml } from "../workers/onboarding-form/src/render.ts";
import worker, { type Env } from "../workers/onboarding-form/src/index.ts";

const SECRET = "segredo-de-teste-com-32-caracteres-ou-mais";

function kvEnv() {
  const kv = new Map<string, string>();
  const ns = {
    async get(k: string) {
      return kv.get(k) ?? null;
    },
    async put(k: string, v: string) {
      kv.set(k, v);
    },
    async delete(k: string) {
      kv.delete(k);
    },
    async list({ prefix }: { prefix: string }) {
      return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
  return { kv, env: { ONBOARDING_FORM: ns as unknown as KVNamespace, RESPONSES_TOKEN: "tok", ONBOARDING_FORM_LINK_SECRET: SECRET } as Env };
}

/** Todas as obrigatórias com a 1ª opção, como um envio válido. */
function validFields(): [string, string][] {
  return FORM_QUESTIONS.filter((q) => q.required && !q.shownWhen && "options" in q && q.options).map((q) => [q.id, q.options![0]!]);
}

describe("#12522 aviso do limite de caixas", () => {
  const html = renderFormHtml("a@x.com", "S");

  it("cada pergunta 'Marque até N' tem o aviso escondido, e só elas", () => {
    const limited = FORM_QUESTIONS.filter((q) => q.kind === "checkbox" && q.maxChoices != null);
    assert.ok(limited.length >= 2, "dificuldades e produto_tema");
    const avisos = html.match(/<p class="limite" role="status" hidden>Marque até 3\.<\/p>/g) ?? [];
    assert.equal(avisos.length, limited.length);
  });

  it("o script mostra o aviso ao recusar a caixa a mais (não só desmarca)", () => {
    assert.match(FORM_SCRIPT, /if\(n>Number\(mx\)\)\{t\.checked=false;/);
    assert.match(FORM_SCRIPT, /lm\.hidden=false/);
    assert.match(FORM_SCRIPT, /querySelector\('\.limite'\)/);
  });
});

describe("#12522 erro do envio volta ao formulário preenchido", () => {
  it("parseFormSubmission diz qual pergunta recusou, e explica a escolha única", () => {
    const fields: Record<string, string | string[]> = Object.fromEntries(validFields());
    fields.email = "a@x.com";
    fields.produto_formato = ["Curso online gravado, no meu ritmo", "Aula ou workshop ao vivo"];
    fields.produto_escolha = "Mentoria individual ou em grupo pequeno"; // não marcado acima
    fields.produto_tema = ["Como escrever bons prompts"];
    const r = parseFormSubmission(fields);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.questionId, "produto_escolha");
      assert.match(r.error, /escolha um dos formatos que você marcou/);
    }
  });

  it("Worker: escolha única fora das marcadas = 400 com o formulário preenchido e o erro na pergunta", async () => {
    const { kv, env } = kvEnv();
    const sig = await signFormEmail("a@x.com", SECRET);
    const body = new URLSearchParams([["email", "a@x.com"], ["sig", sig], ...validFields()]);
    body.delete("produto_formato");
    body.append("produto_formato", "Curso online gravado, no meu ritmo");
    body.append("produto_formato", "Aula ou workshop ao vivo");
    body.set("produto_escolha", "Mentoria individual ou em grupo pequeno");
    body.append("produto_tema", "Como escrever bons prompts");
    body.set("relato_falha", "inventou números");
    const res = await worker.fetch(new Request("https://f.example/enviar", { method: "POST", body }), env);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.ok(html.includes('<form method="post" action="/enviar"'), "é o formulário, não a página genérica");
    assert.ok(html.includes(`name="sig" value="${sig}"`), "a assinatura segue no formulário (o reenvio funciona)");
    assert.match(html, /<fieldset id="q-produto_escolha"[^>]*><legend>[^]*?<p class="erro" role="alert">escolha um dos formatos/);
    assert.ok(html.includes('<a href="#q-produto_escolha">Ir para a pergunta</a>'));
    // O que a pessoa marcou volta marcado (e o texto livre volta escrito).
    assert.match(html, /value="Curso online gravado, no meu ritmo" checked/);
    assert.match(html, /value="Como escrever bons prompts" checked/);
    assert.ok(html.includes(">inventou números</textarea>"));
    // A escolha inválida NÃO volta marcada.
    assert.doesNotMatch(html, /name="produto_escolha" value="Mentoria individual ou em grupo pequeno" checked/);
    assert.equal([...kv.keys()].length, 0, "nada gravado");
  });

  it("obrigatória faltando também volta preenchida, com o erro na pergunta", async () => {
    const { env } = kvEnv();
    const sig = await signFormEmail("a@x.com", SECRET);
    const body = new URLSearchParams([["email", "a@x.com"], ["sig", sig], ...validFields()]);
    body.delete("maior_gasto");
    const res = await worker.fetch(new Request("https://f.example/enviar", { method: "POST", body }), env);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /<fieldset id="q-maior_gasto">/);
    assert.match(html, /name="uso_ia" value="[^"]+" required checked/);
  });
});
