/**
 * #11897: o D1 da 261103 (pesos abertos do Mistral Large 4) continua a
 * história do D3 de 261007 (anúncio do Mistral Large 4) e nenhum check acusou.
 * Textos copiados dos `02-reviewed.md` reais das duas edições.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findStoryContinuations,
  leadSentence,
  slugContinuation,
  formatStoryContinuationWarning,
} from "../scripts/lib/story-continuation.ts";
import { checkStoryContinuation, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

const D3_URL = "https://mistral.ai/news/mistral-large-4/";
const D3_TITLE = "Mistral Large 4 faz o que Claude e GPT recusam";
const D3_BODY = "A Mistral lançou o Large 4 destacando que ele aceita a pesquisa de segurança que o Claude Opus 5.5 e o GPT-6 Astra recusam. Num teste que pede para reproduzir e corrigir uma falha real em software aberto, o modelo marca 82%, a maior nota entre todos.\n\nA prévia já está na API do Mistral Studio. Os pesos abertos saem até o fim do mês.";
const D1_URL = "https://mistral.ai/news/mistral-large-4-oss/";
const D1_TITLE = "Só o Claude Opus 5.5 supera a IA aberta da Mistral no teste às cegas";
const D1_BODY = "A Mistral abriu os pesos do Mistral Large 4 (Le Chonk), modelo de 1 trilhão de parâmetros treinado do zero na Europa: qualquer empresa pode baixá-lo e rodá-lo em servidores próprios.\n\nApós três semanas de aprendizado por reforço, ele lidera entre os abertos nos testes de programação FrontierCode e Terminal-Bench.";

const pastD3 = { label: "D3", title: D3_TITLE, summary: D3_BODY, url: D3_URL, aammdd: "261007", highlight: true };
const d1 = { label: "D1", title: D1_TITLE, summary: D1_BODY, url: D1_URL };

const block = (n: number, title: string, url: string, body: string) =>
  `**DESTAQUE ${n} | 🚀 LANÇAMENTO**\n\n**[${title}](${url})**  \n\n${body}\n\nPor que isso importa:\nContexto.\n\n---\n`;

test("#11897 regressão: D1 261103 (pesos do Mistral Large 4) continua o D3 de 261007", () => {
  const w = findStoryContinuations([d1], [pastD3]);
  assert.equal(w.length, 1);
  assert.equal(w[0].matched_edition, "261007");
  assert.equal(w[0].matched_label, "D3");
  assert.equal(w[0].signal, "produto: large 4");
  const msg = formatStoryContinuationWarning(w[0]);
  assert.match(msg, /^ℹ️ Destaque continua história publicada em 261007/);
  assert.doesNotMatch(msg, /Cortar/, "continuação com fato novo é legítima: o aviso não pede corte");
});

test("#11897: o assunto vem do lead, não do título (título cita o concorrente)", () => {
  // Item passado sobre o Claude Opus 5.5: o título do D1 cita "Claude Opus 5.5",
  // mas o assunto é o Mistral Large 4.
  const opus = { label: "D1", title: "Claude Opus 5.5 chega dias após alerta de Amodei", summary: "A Anthropic lançou o Claude Opus 5.5.", url: "https://www.anthropic.com/claude-opus-5-5", aammdd: "261020", highlight: true };
  assert.deepEqual(findStoryContinuations([d1], [opus]), []);
  // Lead sem produto: sem sinal de produto, mesmo com produto no título.
  const noLeadProduct = { label: "D1", title: "DeepSeek quase iguala GPT-6 Astra por 1,4% do custo", summary: "A OpenDesign Arena testou 13 modelos de IA em tarefas reais de design.", url: "https://decrypt.co/x" };
  const astra = { label: "D2", title: "GPT-6 Astra: modelo mais capaz vira arma crítica", summary: "A OpenAI lançou o GPT-6 Astra.", url: "https://openai.com/index/gpt-6-astra/", aammdd: "261020", highlight: true };
  assert.deepEqual(findStoryContinuations([noLeadProduct], [astra]), []);
});

test("#11897: concorrente citado depois do sujeito no lead não casa", () => {
  const past = { label: "D2", title: "GPT-6 Astra: modelo mais capaz", summary: "A OpenAI lançou o GPT-6 Astra.", url: "https://openai.com/index/gpt-6-astra/", aammdd: "261020", highlight: true };
  // Lead do D3 de 261007: sujeito Large 4, concorrentes GPT-6 Astra e Opus 5.5 depois.
  assert.deepEqual(findStoryContinuations([{ label: "D3", title: D3_TITLE, summary: D3_BODY, url: D3_URL }], [past]), []);
});

test("#11897: variantes nomeadas diferentes e licença não casam; mesma URL fica de fora", () => {
  const sol = { label: "D1", title: "x", summary: "A OpenAI lançou o GPT-6.1 Sol para desenvolvedores.", url: "https://openai.com/a" };
  const astra = { label: "D1", title: "y", summary: "A OpenAI lançou o GPT-6.1 Astra.", url: "https://openai.com/b", aammdd: "261020", highlight: true };
  assert.deepEqual(findStoryContinuations([sol], [astra]), []);
  const lic = { label: "D3", title: "x", summary: "A Aleph Alpha abriu o Kolibri sob licença Apache 2.0 para uso comercial.", url: "https://aleph-alpha.com/k" };
  const bonsai = { label: "LANÇAMENTOS", title: "Bonsai 2 27B", summary: "Modelo aberto sob Apache 2.0.", url: "https://prismml.com/news/bonsai", aammdd: "261020", highlight: false };
  assert.deepEqual(findStoryContinuations([lic], [bonsai]), []);
  assert.deepEqual(findStoryContinuations([{ ...d1, url: D3_URL }], [pastD3]), []);
});

test("#11897: seções de formato deliberado (USE MELHOR) ficam de fora; LANÇAMENTOS conta", () => {
  const um = { ...pastD3, label: "USE MELHOR", highlight: false };
  assert.deepEqual(findStoryContinuations([d1], [um]), []);
  const lanc = { ...pastD3, label: "LANÇAMENTOS", highlight: false };
  assert.equal(findStoryContinuations([d1], [lanc]).length, 1);
});

test("#11897: sinal de URL — slug que continua o anterior no mesmo host", () => {
  assert.equal(slugContinuation(D1_URL, D3_URL), "mistral-large-4 → mistral-large-4-oss");
  assert.equal(slugContinuation("https://x.com/news/a", "https://x.com/news/a-b"), null, "slug curto demais");
  assert.equal(slugContinuation("https://a.com/p/mistral-large-4-oss", D3_URL), null, "host diferente");
  assert.equal(slugContinuation("https://mistral.ai/news/mistral-large-40", D3_URL), null, "sem fronteira de hífen");
  // Lead sem produto, só a URL continua.
  const w = findStoryContinuations([{ ...d1, summary: "A empresa francesa liberou os pesos do modelo." }], [pastD3]);
  assert.equal(w.length, 1);
  assert.equal(w[0].signal, "url: mistral-large-4 → mistral-large-4-oss");
});

test("#11897: leadSentence ignora a linha da manchete e pega a 1ª frase", () => {
  assert.equal(
    leadSentence(`**[${D1_TITLE}](${D1_URL})**  \n\n${D1_BODY}`),
    "A Mistral abriu os pesos do Mistral Large 4 (Le Chonk), modelo de 1 trilhão de parâmetros treinado do zero na Europa: qualquer empresa pode baixá-lo e rodá-lo em servidores próprios.",
  );
  assert.equal(leadSentence("O modelo 5.5 marca 82%. Depois vem outra."), "O modelo 5.5 marca 82%.");
  assert.equal(leadSentence(undefined), "");
});

test("#11897: invariante story-continuation lê o 02-reviewed.md final e a janela de 30 dias", () => {
  const root = mkdtempSync(join(tmpdir(), "story-cont-"));
  try {
    const cur = join(root, "2611", "261103");
    const old = join(root, "2610", "261007");
    mkdirSync(cur, { recursive: true });
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "02-reviewed.md"), block(3, D3_TITLE, D3_URL, D3_BODY));
    writeFileSync(join(cur, "02-reviewed.md"), block(1, D1_TITLE, D1_URL, D1_BODY));
    const v = checkStoryContinuation(cur, root);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "story-continuation");
    assert.equal(v[0].severity, "warning");
    assert.match(v[0].message, /261007/);
    // Fora da janela de 30 dias: sem aviso.
    const far = join(root, "2609", "260901");
    mkdirSync(far, { recursive: true });
    rmSync(join(old, "02-reviewed.md"));
    writeFileSync(join(far, "02-reviewed.md"), block(3, D3_TITLE, D3_URL, D3_BODY));
    assert.deepEqual(checkStoryContinuation(cur, root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#11897: destaque já acusado pelo story-twice-in-edition (últimas 3 edições) não ganha 2º aviso", () => {
  const root = mkdtempSync(join(tmpdir(), "story-cont-"));
  try {
    const cur = join(root, "2610", "261008");
    const prev = join(root, "2610", "261007");
    mkdirSync(cur, { recursive: true });
    mkdirSync(prev, { recursive: true });
    writeFileSync(join(prev, "02-reviewed.md"), block(3, D3_TITLE, D3_URL, D3_BODY));
    // Título com o mesmo produto+versão: story-twice já acusa.
    writeFileSync(join(cur, "02-reviewed.md"), block(1, "Mistral Large 4 abre os pesos", D1_URL, D1_BODY));
    assert.deepEqual(checkStoryContinuation(cur, root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#11897: registrada no Stage 4 como warn-only", () => {
  const rule = STAGE_4_RULES.find((r) => r.id === "story-continuation");
  assert.ok(rule);
  assert.equal(rule.source_issue, "#11897");
});
