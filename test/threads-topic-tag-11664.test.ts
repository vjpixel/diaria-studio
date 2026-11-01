/**
 * #11664: a 1ª hashtag do texto do Threads vira o topic tag (sem `#`, no
 * cabeçalho). Decisão do editor: a 1ª posição é escolhida de propósito — a
 * tag que lê natural como palavra solta (sujeito do texto), sem tag
 * sacrificial. Regressão: o post do Genie 4 saiu "Genie4 #DeepMind".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chooseThreadsTopicTag, topicTagRank } from "../scripts/lib/threads-topic-tag.ts";

const EDITION_URL = "https://diar.ia.br/p/genie-4?utm_source=threads";

test("caso da issue: #Genie4 #DeepMind com DeepMind no corpo → DeepMind vai para a frente", () => {
  const text = `O Google DeepMind lançou o Genie 4, que gera mundos jogáveis a partir de uma frase.\n\nMais em ${EDITION_URL}\n\n#Genie4 #DeepMind`;
  const r = chooseThreadsTopicTag(text);
  assert.equal(r.topicTag, "DeepMind");
  assert.equal(r.reordered, true);
  assert.ok(r.text.endsWith("\n\n#DeepMind #Genie4"), r.text);
  // Corpo intacto, nenhuma tag acrescentada nem removida.
  assert.equal(r.text.replace("#DeepMind #Genie4", ""), text.replace("#Genie4 #DeepMind", ""));
});

test("ordem já boa fica igual (ChatGPT no corpo em 1º)", () => {
  const text = `Os pais processam a OpenAI. Segundo a ação, o ChatGPT montou um plano de 25 dias.\n\nMais em ${EDITION_URL}\n\n#ChatGPT #OpenAI`;
  const r = chooseThreadsTopicTag(text);
  assert.equal(r.reordered, false);
  assert.equal(r.text, text);
  assert.equal(r.topicTag, "ChatGPT");
});

test("empate mantém a ordem do agente (estável)", () => {
  const text = `A OpenAI e a Anthropic anunciaram acordos.\n\nMais em ${EDITION_URL}\n\n#Anthropic #OpenAI`;
  const r = chooseThreadsTopicTag(text);
  assert.equal(r.reordered, false);
  assert.equal(r.topicTag, "Anthropic");
});

test("composto fora do corpo não fica em 1º se houver palavra simples", () => {
  const text = `Estudo mostra que modelos repetem preconceitos em contratações.\n\nMais em ${EDITION_URL}\n\n#ViésAlgorítmico #Contratação`;
  const r = chooseThreadsTopicTag(text);
  assert.equal(r.topicTag, "Contratação");
  assert.ok(r.text.endsWith("#Contratação #ViésAlgorítmico"));
});

test("URL do corpo não conta como menção (claude.ai)", () => {
  const words = ["golpistas", "hospedam", "paginas"];
  assert.equal(topicTagRank("Golpe", words), 1);
  const text = `Golpistas hospedam páginas falsas em https://claude.ai/x e anunciam no Google.\n\nMais em ${EDITION_URL}\n\n#ClaudeAI #Golpe`;
  // ClaudeAI só aparece dentro da URL: não é sujeito do corpo; Golpe lê natural.
  assert.equal(chooseThreadsTopicTag(text).topicTag, "Golpe");
});

test("níveis: corpo < simples < composto-sujeito < composto < com hífen", () => {
  const words = ["o", "gemini", "notebook", "do", "google", "deepmind"];
  assert.equal(topicTagRank("DeepMind", words), 0);
  assert.equal(topicTagRank("Produtividade", words), 1);
  assert.equal(topicTagRank("GeminiNotebook", words), 2);
  assert.equal(topicTagRank("ViésAlgorítmico", words), 3);
  assert.equal(topicTagRank("multi-agent", words), 4);
});

test("acento e caixa não atrapalham a menção no corpo", () => {
  const text = `A segurança dos agentes preocupa.\n\nMais em ${EDITION_URL}\n\n#AgentesIA #Segurança`;
  assert.equal(chooseThreadsTopicTag(text).topicTag, "Segurança");
});

test("bloco em várias linhas: escolhida abre a 1ª linha e sai da sua", () => {
  const text = `O Claude ganhou memória.\n\nMais em ${EDITION_URL}\n\n#Anthropic\n#Claude #Memória`;
  const r = chooseThreadsTopicTag(text);
  assert.equal(r.topicTag, "Claude");
  assert.ok(r.text.endsWith("\n\n#Claude #Anthropic\n#Memória"), r.text);
});

test("idempotente", () => {
  const text = `O Google DeepMind lançou o Genie 4.\n\nMais em ${EDITION_URL}\n\n#Genie4 #DeepMind\n`;
  const once = chooseThreadsTopicTag(text).text;
  assert.equal(chooseThreadsTopicTag(once).text, once);
  assert.ok(once.endsWith("#DeepMind #Genie4\n"), JSON.stringify(once));
});

test("sem bloco final: texto igual, topicTag null", () => {
  const text = `Sem hashtag nenhuma.\n\nMais em ${EDITION_URL}`;
  const r = chooseThreadsTopicTag(text);
  assert.deepEqual(r, { text, topicTag: null, reordered: false, inlineHashtag: false });
});

test("hashtag no meio do corpo é sinalizada (ela vira o topic tag antes do bloco)", () => {
  const text = `O #Claude ganhou memória.\n\nMais em ${EDITION_URL}\n\n#Anthropic`;
  assert.equal(chooseThreadsTopicTag(text).inlineHashtag, true);
  // `C#` e fragmento de URL não contam.
  const ok = `Código em C# no https://x.com/a#b.\n\n#Microsoft`;
  assert.equal(chooseThreadsTopicTag(ok).inlineHashtag, false);
});

test("publish-threads aplica a escolha antes de dividir em chunks", () => {
  const src = readFileSync(new URL("../scripts/publish-threads.ts", import.meta.url), "utf8");
  const apply = src.indexOf("chooseThreadsTopicTag(text)");
  const split = src.indexOf("splitIntoThreadChunks(text, THREADS_CHAR_LIMIT)");
  const video = src.indexOf("injectVideoLinkWithinLimit(text,");
  assert.ok(apply > 0 && split > apply && apply > video, "ordem esperada: vídeo → topic tag → chunks");
});

test("prompt do social-curto documenta a regra do topic tag", () => {
  const prompt = readFileSync(new URL("../.claude/agents/social-curto.md", import.meta.url), "utf8");
  assert.match(prompt, /topic tag do Threads \(#11664/);
});
