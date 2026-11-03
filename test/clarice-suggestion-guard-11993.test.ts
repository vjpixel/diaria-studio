/**
 * Regressão #11993 — o #11974 restringiu o domínio "solto" a uma lista de TLDs
 * pra não proteger `ok.então`/`funciona.depois`, e com isso `Bolt.new`,
 * `Pika.art`, `Manus.im`, `Notion.so` e `deepmind.google` deixaram de ser
 * reconhecidos: a sugestão `Bolt. new` da Clarice passava a ser aplicada.
 * Os casos do #11974 continuam valendo nos dois sentidos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyClariceNoise } from "../scripts/lib/clarice-suggestion-guard.ts";
import { applyClariceSuggestions } from "../scripts/clarice-apply.ts";

const BARE_DOMAINS: Array<[string, string]> = [
  ["teste o Bolt.new hoje", "teste o Bolt. new hoje"],
  ["o Pika.art lançou", "o Pika. art lançou"],
  ["o Manus.im respondeu", "o Manus. im respondeu"],
  ["no Notion.so agora", "no Notion. so agora"],
  ["veja deepmind.google hoje", "veja deepmind. google hoje"],
  ["usei o Bolt.new, depois", "usei o Bolt. new, depois"],
];

test("#11993: domínio com sufixo fora da lista de TLDs é protegido", () => {
  for (const [from, to] of BARE_DOMAINS) {
    assert.equal(classifyClariceNoise(from, to), "whitespace_only", `${from} → ${to}`);
  }
});

test("#11993: casos do #11974 seguem iguais", () => {
  // falta de espaço real depois do ponto: correção passa
  assert.equal(classifyClariceNoise("ok.então vamos", "ok. então vamos"), null);
  assert.equal(classifyClariceNoise("funciona.depois disso", "funciona. depois disso"), null);
  assert.equal(classifyClariceNoise("isso.de novo", "isso. de novo"), null);
  assert.equal(classifyClariceNoise("fim.Começo", "fim. Começo"), null);
  // domínios da lista e host com 2 pontos continuam protegidos
  assert.equal(classifyClariceNoise("openai.com hoje", "openai. com hoje"), "whitespace_only");
  assert.equal(classifyClariceNoise("veja diar.ia.br agora", "veja diar. ia.br agora"), "whitespace_only");
  assert.equal(classifyClariceNoise("em microsoft.ai hoje", "em microsoft. ai hoje"), "whitespace_only");
  assert.equal(classifyClariceNoise("em blog.google.com hoje", "em blog. google.com hoje"), "whitespace_only");
});

test("#11993: apply recusa `Bolt. new` e mantém o texto", () => {
  const text = "Teste o Bolt.new hoje.";
  const r = applyClariceSuggestions(text, [{ from: "Bolt.new", to: "Bolt. new" }]);
  assert.equal(r.patched, text);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["whitespace_only"]);
});
