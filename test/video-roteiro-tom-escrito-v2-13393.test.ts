// #13393: a v2 REAL do roteiro da 261118 (que o editor achou formal) tem "tá"
// e "pra" em várias falas, então o aviso por vídeo sem marca de fala não
// disparava. O registro escrito estava nos verbos de relatório e em "norma".
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { avisosTomConversacional, parseRoteiroFalas } from "../scripts/lib/diaria/roteiro-videos.ts";
import type { RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";

const V2 = JSON.parse(readFileSync(new URL("./fixtures/roteiro-video/roteiro-falas-261118-v2.json", import.meta.url), "utf8"));
const fala = (texto: string): RoteiroFalas => ({ falas: [{ id: "H1", bloco: "comentario", texto, videos: ["horizontal"] }] }) as RoteiroFalas;

it("fixture v2 da 261118 é válida e avisa a fala e a palavra do registro escrito", () => {
  assert.equal(parseRoteiroFalas(V2).ok, true);
  const avisos = avisosTomConversacional(V2);
  assert.ok(avisos.includes("H4: verbo de relatório (renunciou); considerar verbo de fala, sem mudar o sentido da fonte (#13165, #13393)."));
  assert.ok(avisos.some((a) => /^H6: verbo de relatório \(publicou\)/.test(a)));
  assert.ok(avisos.includes('H6: palavra de texto escrito (norma: em conversa, "regra") (#13393).'));
  assert.ok(avisos.some((a) => /^H7: palavra de texto escrito \(norma/.test(a)));
});

it("as reescritas da v3 não avisam", () => {
  for (const v3 of [
    "o Jensen Huang largou o cargo de CEO da Nvidia. Saiu do conselho também.",
    "o governo Trump soltou uma regra nova pra venda de chips de IA",
    "A ideia é fechar uma brecha: tem empresa chinesa contratando data center fora dos Estados Unidos.",
    "Calma, não é proibição.",
  ]) assert.deepEqual(avisosTomConversacional(fala(v3)), [], v3);
});

it("anunciou, plural de norma e limite de palavra", () => {
  assert.match(avisosTomConversacional(fala("A OpenAI anunciou o modelo."))[0], /verbo de relatório \(anunciou\)/);
  assert.deepEqual(avisosTomConversacional(fala("As NORMAS mudaram.")), ['H1: palavra de texto escrito (normas: em conversa, "regras") (#13393).']);
  assert.deepEqual(avisosTomConversacional(fala("Isso é normal, a gente sabe. Foi anunciada ontem.")), []);
});
