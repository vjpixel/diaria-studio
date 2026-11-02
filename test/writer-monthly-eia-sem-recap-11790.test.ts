/**
 * #11790 (decisão do editor 02/11/2026): o render mensal mostra só a legenda
 * do 01-eia.md, então o writer-monthly não escreve mais o recap do bloco
 * "É IA? — DESTAQUE". O label continua obrigatório (lint + splitByLabels).
 * Grep test no prompt/template (writer é prompt, não código).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSectionIntegrity } from "../scripts/lint-monthly-draft.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const writer = readFileSync(resolve(ROOT, ".claude/agents/writer-monthly.md"), "utf8");
const template = readFileSync(resolve(ROOT, "context/templates/newsletter-monthly.md"), "utf8");
const PLACEHOLDER = "[Card do É IA? montado pelo render a partir do 01-eia.md.]";

describe("writer-monthly não escreve recap do É IA? (#11790)", () => {
  it("prompt proíbe recap e mantém o label obrigatório", () => {
    assert.match(writer, /Sem texto de recap \(#11790/);
    assert.ok(writer.includes("`**É IA? — DESTAQUE**`"));
    assert.ok(writer.includes(PLACEHOLDER));
  });
  it("prompt não manda mais escrever recap/%/análise por seleção", () => {
    assert.doesNotMatch(writer, /escrever 1-2 parágrafos citando a edição/);
    assert.doesNotMatch(writer, /Selecionar manualmente a edição do mês/);
  });
  it("template traz label + placeholder, sem instrução de recap", () => {
    assert.ok(template.includes("**É IA? — DESTAQUE**"));
    assert.ok(template.includes(PLACEHOLDER));
    assert.doesNotMatch(template, /Recap de UM É IA\?/);
  });
  it("lint continua exigindo a seção É IA? (label + placeholder basta)", () => {
    const base = ["ASSUNTO","APRESENTAÇÃO","INTRO","DESTAQUE 1 | A","DESTAQUE 2 | B","DESTAQUE 3 | C","USE MELHOR","RADAR","PARA ENCERRAR"];
    const mk = (withEia: boolean) =>
      [...base.slice(0, 8), ...(withEia ? ["É IA? — DESTAQUE"] : []), base[8]]
        .map((l) => `**${l}**\n\n${l === "É IA? — DESTAQUE" ? PLACEHOLDER : "texto"}`)
        .join("\n\n---\n\n");
    assert.equal(checkSectionIntegrity(mk(true)).ok, true);
    assert.deepEqual(checkSectionIntegrity(mk(false)).missing, ["É IA?"]);
  });
});
