/**
 * format-weekly-social.test.ts (#4101, restrito ao Instagram pelo #4483)
 *
 * Teste de regressão: caption do Instagram nunca excede o limite de caption
 * (2200 chars), inclusive no PIOR CASO (5 títulos longos, próximos do
 * máximo de 52 chars permitido por destaque, ver `context/editorial-rules.md`),
 * e nunca inclui URL crua (Instagram não linka no corpo).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatInstagramWeekly,
  formatFacebookWeekly,
  INSTAGRAM_WEEKLY_CHAR_LIMIT,
  buildInstagramWeeklyArchiveUrl,
  type InstagramWeeklyItem,
} from "../scripts/lib/format-weekly-social.ts";

function makeItems(n: number, titleLen = 20): InstagramWeeklyItem[] {
  const items: InstagramWeeklyItem[] = [];
  for (let i = 0; i < n; i++) {
    const title = `Título ${i + 1} `.padEnd(titleLen, "x").slice(0, titleLen);
    items.push({ title });
  }
  return items;
}

// 52 chars = máximo permitido por destaque (context/editorial-rules.md).
const LONG_TITLE = "Título de destaque bem longo perto do limite máximo!"; // 53 chars
// Contexto propositalmente longo (~300 chars) — pior caso real (#5330), já
// que `why`/`body` de origem não têm limite de tamanho como o título tem.
// Desde o achado ao vivo de 260815 (frase cortada no meio, "...expõe a
// falta de"), `contextLine` NUNCA trunca por conta própria — só a frase
// inteira, sempre. A rede de segurança contra estourar 2200 chars é só
// `truncateAtLimit` no corpo INTEIRO da caption.
const LONG_WHY =
  "Esse é um parágrafo de contexto propositalmente longo, escrito pra simular o pior caso " +
  "real de 'por que isso importa' de um destaque, que não passa por nenhum limite de " +
  "caracteres na escrita original e pode facilmente ultrapassar cento e quarenta caracteres " +
  "numa única frase antes de qualquer truncamento.";
function makeLongItems(n: number): InstagramWeeklyItem[] {
  return Array.from({ length: n }, () => ({ title: LONG_TITLE, why: LONG_WHY }));
}

describe("formatInstagramWeekly", () => {
  it("retorna vazio para 0 itens e nunca excede o limite de caption", () => {
    assert.equal(formatInstagramWeekly([]), "");
    const long = formatInstagramWeekly(makeLongItems(5));
    assert.ok(long.length <= INSTAGRAM_WEEKLY_CHAR_LIMIT);
  });

  it('menciona "link da bio" e a única URL no corpo é o link de arquivo, agora com UTM (#4537, nunca URL de item)', () => {
    const items = makeItems(5);
    const caption = formatInstagramWeekly(items);
    assert.ok(caption.toLowerCase().includes("bio"));
    const urls = caption.match(/https?:\/\/\S+/g) ?? [];
    assert.deepEqual(
      urls,
      [`${buildInstagramWeeklyArchiveUrl()}.`],
      "só o link de arquivo (com UTM) deveria aparecer, sem URL crua de item",
    );
  });

  it("#4537: buildInstagramWeeklyArchiveUrl carrega os 3 params via new URL()/searchParams (nunca concatenação)", () => {
    const url = new URL(buildInstagramWeeklyArchiveUrl());
    assert.equal(url.hostname, "diar.ia.br");
    assert.equal(url.searchParams.get("utm_source"), "instagram");
    assert.equal(url.searchParams.get("utm_medium"), "organic_social");
    assert.equal(url.searchParams.get("utm_campaign"), "weekly-archive");
  });

  it("inclui todos os títulos, numerados", () => {
    const items = makeItems(5);
    const caption = formatInstagramWeekly(items);
    items.forEach((it, i) => {
      assert.ok(caption.includes(`${i + 1}. ${it.title}`), `deveria incluir "${i + 1}. ${it.title}"`);
    });
  });

  it("4 itens (seleção incompleta) formata só os 4, sem placeholder de 5º item", () => {
    const items = makeItems(4);
    const caption = formatInstagramWeekly(items);
    assert.equal((caption.match(/^\d+\./gm) ?? []).length, 4);
  });

  it("#5330: inclui 1 linha de contexto por item, usando `why` quando presente", () => {
    const items: InstagramWeeklyItem[] = [
      { title: "Item com why", why: "Isso importa porque muda o mercado." },
    ];
    const caption = formatInstagramWeekly(items);
    assert.ok(caption.includes("Isso importa porque muda o mercado."));
  });

  it("#5330: usa a 1ª frase de `body` como contexto quando `why` está vazio (item de RADAR)", () => {
    const items: InstagramWeeklyItem[] = [
      { title: "Item de RADAR", why: "", body: "Primeira frase do RADAR. Segunda frase não deveria aparecer." },
    ];
    const caption = formatInstagramWeekly(items);
    assert.ok(caption.includes("Primeira frase do RADAR."));
    assert.ok(!caption.includes("Segunda frase não deveria aparecer."));
  });

  it("#5330: sem `why` nem `body`, não insere linha de contexto vazia", () => {
    const items: InstagramWeeklyItem[] = [{ title: "Item sem contexto" }];
    const caption = formatInstagramWeekly(items);
    assert.ok(caption.includes("1. Item sem contexto\n\nEdição completa"));
  });

  it("#5330 (achado ao vivo 260815): contexto longo NUNCA corta no meio da frase — sempre a frase inteira", () => {
    const items = makeLongItems(1);
    const caption = formatInstagramWeekly(items);
    assert.ok(caption.includes(LONG_WHY), "a frase de contexto deveria aparecer INTEIRA na caption, sem truncar");
    assert.doesNotMatch(caption, /\.\.\.\n/, "não deveria haver reticências cortando uma linha de contexto no meio");
  });

  it("#5330: contexto de vários itens longos ainda cabe dentro do limite de caption (2200) sem precisar de cap por linha", () => {
    const items = makeLongItems(5);
    const caption = formatInstagramWeekly(items);
    assert.ok(caption.length <= INSTAGRAM_WEEKLY_CHAR_LIMIT);
    // Confirma que NENHUM dos 5 contextos foi cortado — se o corpo total
    // coubesse sem truncar no limite geral, todos aparecem inteiros.
    if (caption.length < INSTAGRAM_WEEKLY_CHAR_LIMIT) {
      assert.equal((caption.match(new RegExp(LONG_WHY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 5);
    }
  });

  it("#5330: modo 'highlights' usa a intro 'principais destaques', não 'mais clicados'", () => {
    const caption = formatInstagramWeekly(makeItems(2), "highlights");
    assert.match(caption, /^Os principais destaques da semana na diar\.ia\.br:/);
    assert.doesNotMatch(caption, /mais clicados/);
  });

  it("#5330: modo default (omitido) continua 'clicked' — back-compat com chamadores existentes", () => {
    const caption = formatInstagramWeekly(makeItems(2));
    assert.match(caption, /^Os mais clicados da semana na diar\.ia\.br:/);
  });
});

describe("formatFacebookWeekly (#5348)", () => {
  it("retorna vazio para 0 itens", () => {
    assert.equal(formatFacebookWeekly([]), "");
  });

  it("MESMOS títulos/ordem/contexto do Instagram, mas a CTA final é um link clicável direto — nunca 'link na bio'", () => {
    const items = makeItems(5);
    const igCaption = formatInstagramWeekly(items);
    const fbCaption = formatFacebookWeekly(items);
    // As linhas numeradas (título + contexto, se houver) são idênticas —
    // só a linha final de CTA diverge entre os 2 formatadores.
    items.forEach((it, i) => {
      assert.ok(fbCaption.includes(`${i + 1}. ${it.title}`));
    });
    assert.doesNotMatch(fbCaption, /link da bio/i, "Facebook não usa a indireção 'link na bio' — link direto no corpo");
    assert.match(igCaption, /link da bio/i, "confirma que o Instagram (comparação) ainda usa 'link na bio', não regrediu");
  });

  it("o link de arquivo aparece cru, clicável, com o MESMO UTM do Instagram (#4537 — reusa buildInstagramWeeklyArchiveUrl)", () => {
    const caption = formatFacebookWeekly(makeItems(3));
    const urls = caption.match(/https?:\/\/\S+/g) ?? [];
    assert.deepEqual(urls, [buildInstagramWeeklyArchiveUrl()], "sem ponto final colado na URL — Facebook não precisa do tratamento visual do Instagram");
  });

  it("sem limite de truncamento — 5 itens com contexto longo saem inteiros, nunca cortados por um cap de tamanho (diferente do Instagram)", () => {
    const items = makeLongItems(5);
    const caption = formatFacebookWeekly(items);
    assert.doesNotMatch(caption, /\.\.\.$/, "nenhum truncamento — Facebook não tem o cap de 2200 chars do Instagram");
    assert.equal(
      (caption.match(new RegExp(LONG_WHY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length,
      5,
      "os 5 contextos aparecem inteiros, nenhum cortado",
    );
  });

  it("modo 'highlights' usa a mesma intro 'principais destaques' do Instagram", () => {
    const caption = formatFacebookWeekly(makeItems(2), "highlights");
    assert.match(caption, /^Os principais destaques da semana na diar\.ia\.br:/);
  });

  it("modo default (omitido) continua 'clicked'", () => {
    const caption = formatFacebookWeekly(makeItems(2));
    assert.match(caption, /^Os mais clicados da semana na diar\.ia\.br:/);
  });
});
