/**
 * #12074: a tela final padrão do horizontal (decisão do editor, 10/11/2026) é
 * vídeo "Envio mais recente" + playlist "diar.ia.br: notícias de IA" (o
 * podcast, renomeado de "diar.ia.br comentada" em 16/11/2026, #13317) + botão
 * de inscrição, nos últimos 20 s, e é passo do checklist do /diaria-publica.
 * Trava o texto da skill e do relato final contra regressão silenciosa.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(new URL("../.claude/skills/diaria-publica/SKILL.md", import.meta.url), "utf8");

test("SKILL.md documenta o padrão da tela final (#12074)", () => {
  const par = skill.split("\n").find((l) => l.startsWith("**Tela final (#12074"));
  assert.ok(par, "parágrafo 'Tela final (#12074' ausente");
  assert.match(par, /últimos 20 s/);
  assert.match(par, /Envio mais recente/);
  // #13317: a playlist escolhida na tela final é a do nome novo; o nome antigo
  // só pode aparecer como histórico ("até 16/11/2026").
  assert.match(par, /playlist = \*\*"diar\.ia\.br: notícias de IA"\*\*/);
  assert.match(par, /"Envio mais recente" \+ "diar\.ia\.br: notícias de IA" \+ inscrição/);
  assert.match(par, /inscri/i);
  assert.match(par, /Importar do vídeo/);
});

test("relato do horizontal inclui a tela final", () => {
  const rel = skill.split("\n").find((l) => l.startsWith("- **Horizontal:**"));
  assert.ok(rel, "linha do relato do horizontal ausente");
  assert.match(rel, /tela final \(#12074/);
});
