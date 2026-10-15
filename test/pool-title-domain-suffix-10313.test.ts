/**
 * #10313 — o caminho do Stage 1 (`categorizeArticles`, ponto único de
 * normalização de título do pool desde #9380) passa a URL do item pro
 * `normalizeItemTitle`, então " - {Veículo}" fora da allowlist é removido
 * quando o nome bate com o domínio. Caso real: edição 261016, RADAR.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { categorizeArticles } from "../scripts/categorize.ts";
import { toPoolItem } from "../scripts/swap-destaque.ts";

const RAW =
  "Quase 70% dos médicos já usam Inteligência Artificial, aponta estudo da MV - Saúde Digital News";
const CLEAN = "Quase 70% dos médicos já usam Inteligência Artificial, aponta estudo da MV";
const URL = "https://saudedigitalnews.com.br/2026/10/15/quase-70-dos-medicos-ia/";

test("#10313 categorizeArticles remove sufixo do veículo que bate com o domínio do item", () => {
  const out = categorizeArticles([
    { url: URL, title: RAW, summary: "Estudo da MV sobre uso de inteligência artificial por médicos." } as any,
  ]);
  const all = [...out.lancamento, ...out.radar, ...out.use_melhor, ...out.video];
  assert.equal(all.length, 1);
  assert.equal(all[0].title, CLEAN);
  assert.equal((all[0] as any).title_raw, RAW);
});

test("#10313 toPoolItem (swap-destaque) também usa a URL do item", () => {
  const out = toPoolItem({ url: URL, title: RAW, article: { url: URL, title: RAW } });
  assert.equal(out.title, CLEAN);
  assert.equal((out.article as any).title, CLEAN);
});
