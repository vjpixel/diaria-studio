import { test } from "node:test";
import assert from "node:assert/strict";
import { firstName, hasCorruptedName } from "../scripts/lib/clarice-name.ts";

test("firstName: extrai o primeiro token de um nome simples", () => {
  assert.equal(firstName("Ana Costa"), "Ana");
});

test("firstName: 'Sobrenome, Nome' particiona por vírgula também", () => {
  assert.equal(firstName("Azevedo, Ana"), "Azevedo");
});

test("firstName: null/undefined/vazio → string vazia", () => {
  assert.equal(firstName(null), "");
  assert.equal(firstName(undefined), "");
  assert.equal(firstName(""), "");
  assert.equal(firstName("   "), "");
});

test("firstName: remove U+FFFD (replacement character) antes de particionar (#5199/#5200)", () => {
  // Achado ao vivo (#5184 item 3): 22 contatos no store têm `name` com
  // U+FFFD — encoding upstream corrompido (ex: CSV do Stripe lido como
  // UTF-8 quando a fonte real era Latin-1/Windows-1252). A Brevo aceita o
  // import mas descarta a linha em silêncio se o byte inválido chegar ao
  // CSV — perder o acento é preferível a perder o contato inteiro.
  assert.equal(firstName("Gon�alo Soares"), "Gonalo");
  assert.equal(firstName("N�colas Canuto"), "Ncolas");
  assert.equal(firstName("EMILY VICT�RIA LIMA DO ROS�RIO"), "EMILY");
});

test("firstName: nome só com U+FFFD vira string vazia, não lança", () => {
  assert.equal(firstName("�"), "");
});

test("firstName: espaços múltiplos/tabs não geram token vazio no meio", () => {
  assert.equal(firstName("  Bia   Lima  "), "Bia");
});

// hasCorruptedName (#5214 item 1) — detecção CRUA, distinta da sanitização
// de firstName acima: precisa enxergar o U+FFFD ANTES dele ser removido,
// pra sinalizar o contato mesmo que o CSV já saia limpo.
test("hasCorruptedName: nome com U+FFFD → true", () => {
  assert.equal(hasCorruptedName("Gon�alo Soares"), true);
  assert.equal(hasCorruptedName("�"), true);
});

test("hasCorruptedName: nome limpo → false", () => {
  assert.equal(hasCorruptedName("Gonçalo Soares"), false);
  assert.equal(hasCorruptedName("Ana Costa"), false);
});

test("hasCorruptedName: null/undefined/vazio → false, não lança", () => {
  assert.equal(hasCorruptedName(null), false);
  assert.equal(hasCorruptedName(undefined), false);
  assert.equal(hasCorruptedName(""), false);
});

test("hasCorruptedName: o resultado de firstName() nunca teria U+FFFD — a sanitização já removeu", () => {
  // Prova de que os dois helpers têm papéis distintos: rodar hasCorruptedName
  // DEPOIS de firstName sempre dá false, mesmo pra um nome que era corrompido —
  // é exatamente por isso que o call site em clarice-build-segment.ts precisa
  // checar `r.name` cru, não `firstName(r.name)`.
  const raw = "Gon�alo Soares";
  assert.equal(hasCorruptedName(raw), true);
  assert.equal(hasCorruptedName(firstName(raw)), false);
});
