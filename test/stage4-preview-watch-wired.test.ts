/**
 * test/stage4-preview-watch-wired.test.ts (#8123 residual)
 *
 * Guard mecânico contra a falha que fez a issue #8123 parecer pronta sem
 * estar: **a Fatia 1 entregou `--watch` e o playbook nunca ligou a flag.**
 *
 * As 4 invocações de `serve-preview.ts` em `orchestrator-stage-4.md` (2 de
 * pré-render em §4b, 2 de re-serve pós-autofix) subiam o servidor SEM
 * `--watch`, ou seja, sem live-reload. O preview só mudava com refresh
 * manual — e a meta da issue ("~10 s entre pedir o ajuste e ver o
 * resultado") nunca teve como ser observada em produção, mesmo com as 5
 * fatias mergeadas.
 *
 * Nenhum teste pegava isso porque todos exercitavam o CÓDIGO da flag
 * (`startPreviewServer({ watch: true })`), nunca a CHAMADA no playbook.
 * Este teste fecha exatamente essa fresta: lê o playbook como texto e
 * exige a flag em toda invocação que sobe um servidor de preview.
 *
 * Vale o mesmo raciocínio do guard de `--stop-pid` no teardown: instrução
 * de playbook é código executável por um modelo, e merece o mesmo tipo de
 * trava que um `if` mereceria.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PLAYBOOK = resolve(import.meta.dirname, "..", ".claude", "agents", "orchestrator-stage-4.md");

/** Linhas que sobem um servidor de preview — `--file ... --port N`. O
 *  teardown (`--stop-pid`) não sobe nada e fica de fora. */
function serveInvocationLines(text: string): { lineNo: number; line: string }[] {
  // Junta as continuações de linha (barra invertida no fim) ANTES de filtrar
  // (#8313 review): sem isso, um reflow que separasse `--file` e `--port` em
  // linhas diferentes — bash igualmente válido — faria a invocação sair do
  // radar do guard em silêncio. Falso negativo num guard é pior que guard
  // nenhum, porque desaparece sem ninguém notar.
  const lines = text.split("\n");
  const out: { lineNo: number; line: string }[] = [];
  let buffer = "";
  let bufferStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (buffer === "") bufferStart = i + 1;
    buffer += (buffer ? " " : "") + raw.replace(/\\$/, "").trim();
    if (raw.trimEnd().endsWith("\\")) continue;
    if (buffer.includes("--file ") && buffer.includes("--port ")) {
      out.push({ lineNo: bufferStart, line: buffer });
    }
    buffer = "";
  }
  return out;
}

describe("#8123 residual — o playbook do Stage 4 LIGA o live-reload que a Fatia 1 entregou", () => {
  const text = readFileSync(PLAYBOOK, "utf8");

  it("toda invocação que sobe preview passa --watch", () => {
    const invocations = serveInvocationLines(text);
    assert.ok(invocations.length >= 4, `esperava ao menos 4 invocações de preview, achei ${invocations.length}`);
    const semWatch = invocations.filter(({ line }) => !line.includes("--watch"));
    assert.deepEqual(
      semWatch.map((i) => `L${i.lineNo}`),
      [],
      `sem --watch o preview não auto-recarrega e a meta de ~10s do #8123 deixa de existir. ` +
        `Linhas: ${semWatch.map((i) => `L${i.lineNo}: ${i.line.trim()}`).join(" | ")}`,
    );
  });

  it("toda invocação que sobe preview etiqueta a edição, pro relatório saber agrupar", () => {
    const semEdition = serveInvocationLines(text).filter(({ line }) => !line.includes("--edition"));
    assert.deepEqual(
      semEdition.map((i) => `L${i.lineNo}`),
      [],
      "sem --edition a medição ainda é gravada, mas cai em `edition: null` e some do relatório por edição",
    );
  });

  it("o playbook aponta o relatório que fecha o critério de aceite da issue", () => {
    assert.match(
      text,
      /report-stage4-timing\.ts/,
      "o critério 'antes/depois medido numa edição real' precisa de um comando citado no playbook, não de um ritual lembrado",
    );
  });

  it("a instrução da Fatia 5 não promete mais que a medição depende dela", () => {
    // Antes: "'Antes/depois numa edição real' fica fora do alcance desta
    // unidade". Depois do residual, a perna automática existe — a prosa não
    // pode seguir dizendo que não há medição possível.
    assert.doesNotMatch(
      text,
      /Antes\/depois numa edição real" fica fora do alcance/,
      "prosa vencida: a perna edição→preview passou a ser medida sozinha pelo watcher",
    );
  });
});
