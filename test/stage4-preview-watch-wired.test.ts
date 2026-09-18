/**
 * test/stage4-preview-watch-wired.test.ts (#8123 residual, generalizado pelo #8314)
 *
 * Guard mecânico contra a falha que fez a issue #8123 parecer pronta sem
 * estar: **a Fatia 1 entregou `--watch` e o playbook do Stage 4 diário nunca
 * ligou a flag.** As 4 invocações de `serve-preview.ts` em
 * `orchestrator-stage-4.md` (2 de pré-render em §4b, 2 de re-serve pós-autofix)
 * subiam o servidor SEM `--watch`, ou seja, sem live-reload. O preview só
 * mudava com refresh manual — e a meta da issue ("~10 s entre pedir o
 * ajuste e ver o resultado") nunca teve como ser observada em produção,
 * mesmo com as 5 fatias mergeadas.
 *
 * Nenhum teste pegava isso porque todos exercitavam o CÓDIGO da flag
 * (`startPreviewServer({ watch: true })`), nunca a CHAMADA no playbook.
 * Este teste fecha exatamente essa fresta: lê o playbook como texto e
 * exige a flag em toda invocação que sobe um servidor de preview.
 *
 * **#8314 — o mesmo problema existia na mensal e na anual, e este guard só
 * lia `orchestrator-stage-4.md`.** A lição do #8123 era "guard que precisa
 * ser estendido à mão é guard que vai ficar atrás" — então em vez de
 * duplicar o teste (`stage4-preview-watch-wired-mensal.test.ts`, etc.), a
 * lista de playbooks abaixo é o único lugar a tocar quando a próxima
 * superfície (semanal? apoiadores?) ganhar seu próprio preview local. Cada
 * arquivo listado tem sua CONTAGEM MÍNIMA de invocações própria — a mensal
 * tem 2 (Etapa 3c pré-render + Etapa 4b re-serve pós-embed), a anual tem 1
 * (Etapa 4a), o diário tem 4 — porque um guard que aceitasse "≥1 no total"
 * deixaria passar em silêncio a mensal perdendo 1 das suas 2 se a anual
 * ainda tivesse a dela.
 *
 * Vale o mesmo raciocínio do guard de `--stop-pid` no teardown: instrução
 * de playbook é código executável por um modelo, e merece o mesmo tipo de
 * trava que um `if` mereceria.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Todo playbook/skill que hoje invoca `serve-preview.ts` pra servir um
 *  preview local com live-reload, e a contagem mínima de invocações
 *  esperada em cada um (achado por grep, não por memória — #8314). Estender
 *  esta lista, não criar um teste irmão, quando uma nova superfície ganhar
 *  preview local próprio. */
const PLAYBOOKS: { label: string; path: string; minInvocations: number }[] = [
  { label: "diário (Stage 4)", path: ".claude/agents/orchestrator-stage-4.md", minInvocations: 4 },
  { label: "mensal", path: ".claude/skills/diaria-mensal/SKILL.md", minInvocations: 2 },
  { label: "anual", path: ".claude/skills/diaria-anual/SKILL.md", minInvocations: 1 },
];

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

describe("#8123/#8314 — todo playbook que sobe preview local LIGA o live-reload", () => {
  for (const { label, path, minInvocations } of PLAYBOOKS) {
    const fullPath = resolve(ROOT, path);
    const text = readFileSync(fullPath, "utf8");

    describe(`${label} (${path})`, () => {
      it(`tem ao menos ${minInvocations} invocação(ões) de preview`, () => {
        const invocations = serveInvocationLines(text);
        assert.ok(
          invocations.length >= minInvocations,
          `esperava ao menos ${minInvocations} invocações de preview em ${path}, achei ${invocations.length}`,
        );
      });

      it("toda invocação que sobe preview passa --watch", () => {
        const invocations = serveInvocationLines(text);
        const semWatch = invocations.filter(({ line }) => !line.includes("--watch"));
        assert.deepEqual(
          semWatch.map((i) => `L${i.lineNo}`),
          [],
          `sem --watch o preview não auto-recarrega e a meta de ~10s do #8123 deixa de existir em ${path}. ` +
            `Linhas: ${semWatch.map((i) => `L${i.lineNo}: ${i.line.trim()}`).join(" | ")}`,
        );
      });

      it("toda invocação que sobe preview etiqueta a edição/ciclo, pro relatório saber agrupar", () => {
        const semEdition = serveInvocationLines(text).filter(({ line }) => !line.includes("--edition"));
        assert.deepEqual(
          semEdition.map((i) => `L${i.lineNo}`),
          [],
          `sem --edition a medição ainda é gravada, mas cai em \`edition: null\` e some do relatório por edição em ${path}`,
        );
      });
    });
  }

  it("o playbook diário aponta o relatório que fecha o critério de aceite da issue", () => {
    const text = readFileSync(resolve(ROOT, ".claude/agents/orchestrator-stage-4.md"), "utf8");
    assert.match(
      text,
      /report-stage4-timing\.ts/,
      "o critério 'antes/depois medido numa edição real' precisa de um comando citado no playbook, não de um ritual lembrado",
    );
  });

  it("a instrução da Fatia 5 (diário) não promete mais que a medição depende dela", () => {
    // Antes: "'Antes/depois numa edição real' fica fora do alcance desta
    // unidade". Depois do residual, a perna automática existe — a prosa não
    // pode seguir dizendo que não há medição possível.
    const text = readFileSync(resolve(ROOT, ".claude/agents/orchestrator-stage-4.md"), "utf8");
    assert.doesNotMatch(
      text,
      /Antes\/depois numa edição real" fica fora do alcance/,
      "prosa vencida: a perna edição→preview passou a ser medida sozinha pelo watcher",
    );
  });
});
