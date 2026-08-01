/**
 * clarice-sector.ts — detecção do setor jurídico (260731).
 *
 * O ponto central coberto aqui: a detecção usa DOIS sinais unidos, e o sinal
 * de handle é o que carrega o segmento. Medido sobre a base real, o detector
 * por domínio sozinho via 331 de 1.248 contatos — a maioria dos advogados usa
 * provedor genérico e se identifica no local-part. Um teste que só exercitasse
 * `.adv.br` passaria com uma implementação que perde 3/4 do segmento.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isJuridicoEmail,
  juridicoSignal,
  juridicoKind,
  isGenericDomain,
  splitJuridicoSuffix,
} from "../scripts/lib/clarice-sector.ts";

test("sinal de domínio: sufixos regulados (.adv.br / .jus.br)", () => {
  assert.equal(juridicoSignal("advocacia@chcadvocacia.adv.br"), "ambos"); // domínio E handle
  assert.equal(juridicoSignal("contato@chcadvocacia.adv.br"), "dominio"); // só o domínio marca
  assert.equal(juridicoSignal("fulano@escritorio.adv.br"), "dominio");
  assert.equal(juridicoSignal("hrmelo@tjma.jus.br"), "dominio");
  assert.equal(juridicoKind("fulano@escritorio.adv.br"), "escritorio");
  assert.equal(juridicoKind("hrmelo@tjma.jus.br"), "tribunal");
});

test("sinal de domínio: domínio próprio com marca jurídica", () => {
  assert.equal(juridicoSignal("contato@silvaadvocacia.com.br"), "dominio");
  assert.equal(juridicoSignal("info@fcm.law"), "dominio");
  assert.equal(juridicoKind("contato@silvaadvocacia.com.br"), "dominio-proprio");
});

test("sinal de handle: provedor genérico com marcador — o grosso do segmento", () => {
  // Sem este sinal o detector perde ~3/4 dos contatos jurídicos reais.
  assert.equal(juridicoSignal("advogado.fulano@gmail.com"), "handle");
  assert.equal(juridicoSignal("maria.adv@hotmail.com"), "handle");
  assert.equal(juridicoSignal("adv.joao@outlook.com"), "handle");
  assert.equal(juridicoSignal("juridico@yahoo.com.br"), "handle");
  assert.equal(juridicoSignal("oab123@gmail.com"), "handle");
  assert.equal(juridicoKind("advogado.fulano@gmail.com"), "handle");
});

test("marcador delimitado: 'adv' dentro de palavra NÃO conta", () => {
  // Sem a delimitação, "advento"/"adverso"/"advindo" entrariam no segmento e
  // encheriam a lista de falso-positivo — o custo aqui é enviar para quem não
  // é do setor, num recorte cujo valor inteiro está na precisão.
  assert.equal(isJuridicoEmail("advento@gmail.com"), false);
  assert.equal(isJuridicoEmail("adverso.silva@gmail.com"), false);
  assert.equal(isJuridicoEmail("radvogado@gmail.com"), false); // não começa nem tem separador
  assert.equal(isJuridicoEmail("joao@advento.com.br"), false);
});

test("não-jurídicos comuns não entram", () => {
  for (const e of [
    "fulano@gmail.com",
    "contato@padaria.com.br",
    "aluno@usp.br",
    "medico@clinica.med.br",
  ]) {
    assert.equal(isJuridicoEmail(e), false, e);
  }
});

test("e-mail malformado nunca lança e nunca classifica", () => {
  for (const e of ["", "   ", "sem-arroba", "@sodominio.adv.br", "local@", "adv@"]) {
    assert.equal(juridicoSignal(e), null, JSON.stringify(e));
    assert.equal(juridicoKind(e), null, JSON.stringify(e));
  }
});

test("case e espaço em volta não mudam o resultado", () => {
  assert.equal(isJuridicoEmail("  ADVOGADO.Fulano@GMAIL.com "), true);
  assert.equal(juridicoKind("  Fulano@Escritorio.ADV.BR "), "escritorio");
});

test("isGenericDomain distingue provedor de domínio próprio", () => {
  assert.equal(isGenericDomain("gmail.com"), true);
  assert.equal(isGenericDomain("GMAIL.COM"), true);
  assert.equal(isGenericDomain("silvaadvocacia.com.br"), false);
});

test("splitJuridicoSuffix separa só os sufixos regulados", () => {
  assert.deepEqual(splitJuridicoSuffix("chcadvocacia.adv.br"), { name: "chcadvocacia", suffix: "adv.br" });
  assert.deepEqual(splitJuridicoSuffix("tjma.jus.br"), { name: "tjma", suffix: "jus.br" });
  // Domínio comum volta inteiro no `name` — o regex de marca roda sobre ele.
  assert.deepEqual(splitJuridicoSuffix("silvaadvocacia.com.br"), { name: "silvaadvocacia.com.br", suffix: "" });
});
