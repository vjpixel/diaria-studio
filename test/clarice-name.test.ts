import { test } from "node:test";
import assert from "node:assert/strict";
import { firstName } from "../scripts/lib/clarice-name.ts";

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
