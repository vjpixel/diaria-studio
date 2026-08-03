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
  INSTAGRAM_WEEKLY_CHAR_LIMIT,
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
function makeLongItems(n: number): InstagramWeeklyItem[] {
  return Array.from({ length: n }, () => ({ title: LONG_TITLE }));
}

describe("formatInstagramWeekly", () => {
  it("retorna vazio para 0 itens e nunca excede o limite de caption", () => {
    assert.equal(formatInstagramWeekly([]), "");
    const long = formatInstagramWeekly(makeLongItems(5));
    assert.ok(long.length <= INSTAGRAM_WEEKLY_CHAR_LIMIT);
  });

  it('menciona "link da bio" e a única URL no corpo é o link de arquivo (nunca URL de item)', () => {
    const items = makeItems(5);
    const caption = formatInstagramWeekly(items);
    assert.ok(caption.toLowerCase().includes("bio"));
    const urls = caption.match(/https?:\/\/\S+/g) ?? [];
    assert.deepEqual(urls, ["https://diar.ia.br."], "só o link de arquivo deveria aparecer, sem URL crua de item");
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
});
