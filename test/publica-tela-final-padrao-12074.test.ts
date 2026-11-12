/**
 * #12074: a tela final padrão do horizontal (decisão do editor, 10/11/2026) é
 * vídeo "Envio mais recente" + playlist "diar.ia.br comentada" + botão de
 * inscrição, nos últimos 20 s, e é passo do checklist do /diaria-publica.
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
  assert.match(par, /diar\.ia\.br comentada/);
  assert.match(par, /inscri/i);
  assert.match(par, /Importar do vídeo/);
});

test("relato do horizontal inclui a tela final", () => {
  const rel = skill.split("\n").find((l) => l.startsWith("- **Horizontal:**"));
  assert.ok(rel, "linha do relato do horizontal ausente");
  assert.match(rel, /tela final \(#12074/);
});
