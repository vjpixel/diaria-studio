/**
 * test/stage4-gate-recipes-flags-14033.test.ts (#14033)
 *
 * O cartão de receitas do gate (`context/stage-4-gate-receitas.md`) copia
 * comandos e flags do playbook da Etapa 4. Quem consulta só o cartão não vê
 * quando um script muda de flag, então este teste trava os dois lados: para
 * cada `scripts/X.ts --flag` citado no cartão,
 *
 *   1. o script existe;
 *   2. a flag aparece no fonte do script (o parser de argv), e
 *   3. a flag aparece em alguma invocação do MESMO script no playbook
 *      (pré-gate ou gate), que é a fonte que vence o cartão.
 *
 * Flags com placeholder (`--d{N}-url`) são conferidas pelo que vem depois do
 * placeholder (`-url`), porque o parser as monta por template.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readStage4Playbook, STAGE4_GATE_RECIPES_FILE } from "../scripts/lib/stage4-playbook.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ScriptInvocation {
  script: string;
  flags: string[];
}

/** Trechos com cara de comando: linhas de bloco cercado e spans `inline`. */
function commandFragments(md: string): string[] {
  const out: string[] = [];
  let inFence = false;
  let pending = "";
  for (const line of md.split("\n")) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      // Continuação de linha (barra no fim) faz parte do mesmo comando.
      pending += " " + line.replace(/\\\s*$/, "");
      if (/\\\s*$/.test(line)) continue;
      // Comentário de shell no fim da linha não é flag do comando.
      out.push(pending.replace(/\s#\s.*$/, ""));
      pending = "";
      continue;
    }
    for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  }
  return out;
}

/** Cada `X.ts` seguido das flags até o próximo `X.ts` do mesmo trecho. */
export function extractInvocations(md: string): ScriptInvocation[] {
  const out: ScriptInvocation[] = [];
  for (const frag of commandFragments(md)) {
    const hits = [...frag.matchAll(/(?<![\w./-])(?:scripts\/)?((?:lib\/)?[\w-]+\.ts)\b/g)];
    hits.forEach((m, i) => {
      const rest = frag.slice(m.index! + m[0].length, hits[i + 1]?.index ?? frag.length);
      const flags = [...rest.matchAll(/(?<![\w-])--[a-z][\w{}-]*/g)].map((f) => f[0]);
      out.push({ script: m[1], flags });
    });
  }
  return out;
}

/** Forma conferível no fonte: `--d{N}-url` vira o sufixo `-url`. */
function sourceProbe(flag: string): string {
  const i = flag.lastIndexOf("}");
  return i >= 0 ? flag.slice(i + 1) : flag;
}

describe("#14033: flags do cartão de receitas batem com o script e com o playbook", () => {
  const recipes = readFileSync(resolve(ROOT, STAGE4_GATE_RECIPES_FILE), "utf8");
  const playbook = readStage4Playbook(ROOT);
  const playbookFlags = new Map<string, Set<string>>();
  const add = (script: string, flags: Iterable<string>) => {
    const set = playbookFlags.get(script) ?? new Set<string>();
    for (const f of flags) set.add(f);
    playbookFlags.set(script, set);
  };
  for (const inv of extractInvocations(playbook)) add(inv.script, inv.flags);
  // Flag documentada em prosa na MESMA linha que cita o script (ex.: "`--dry-run`
  // mostra o plano" logo depois do comando) também conta como do script.
  for (const line of playbook.split("\n")) {
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const loose = spans.filter((s) => /^--[a-z][\w{}-]*/.test(s)).map((s) => /^--[a-z][\w{}-]*/.exec(s)![0]);
    if (loose.length === 0) continue;
    for (const inv of extractInvocations(line)) add(inv.script, loose);
  }
  const cardInvocations = extractInvocations(recipes).filter((i) => i.flags.length > 0);

  it("o cartão tem comandos com flags (sanidade do extrator)", () => {
    assert.ok(cardInvocations.length >= 40, `só ${cardInvocations.length} invocações com flag no cartão`);
  });

  for (const inv of cardInvocations) {
    const label = `${inv.script} ${inv.flags.join(" ")}`;
    it(`cartão: ${label}`, () => {
      const candidates = [resolve(ROOT, "scripts", inv.script), resolve(ROOT, "scripts/lib", inv.script)];
      const path = candidates.find((p) => existsSync(p));
      assert.ok(path, `scripts/${inv.script} (nem scripts/lib/) não existe`);
      // #14001: CLI que virou casca reexporta a lib (`export * from "./lib/X.ts"`);
      // a flag pode estar citada só no texto movido para a lib, então lê os dois.
      const cli = readFileSync(path, "utf8");
      const reexported = [...cli.matchAll(/^export \* from "(\.\/lib\/[\w./-]+\.ts)";$/gm)]
        .map((m) => resolve(dirname(path), m[1]))
        .filter((p) => existsSync(p))
        .map((p) => readFileSync(p, "utf8"));
      const source = [cli, ...reexported].join("\n");
      const known = playbookFlags.get(inv.script);
      assert.ok(known, `scripts/${inv.script} citado no cartão, mas nenhuma invocação dele no playbook da Etapa 4`);
      for (const flag of inv.flags) {
        assert.ok(source.includes(sourceProbe(flag)), `scripts/${inv.script} não reconhece ${flag} (ausente do fonte)`);
        assert.ok(known.has(flag), `${flag} de scripts/${inv.script} está no cartão mas em nenhuma invocação do playbook`);
      }
    });
  }
});

describe("extractInvocations (#14033)", () => {
  it("separa scripts do mesmo trecho, ignora comentário de shell e aceita placeholder", () => {
    const md = [
      "```bash",
      "npx tsx scripts/a.ts --x 1 --y   # nota --z",
      "```",
      "Use `b.ts --d{N}-url {u}` e depois `scripts/lib/c.ts --k`.",
    ].join("\n");
    assert.deepEqual(extractInvocations(md), [
      { script: "a.ts", flags: ["--x", "--y"] },
      { script: "b.ts", flags: ["--d{N}-url"] },
      { script: "lib/c.ts", flags: ["--k"] },
    ]);
  });
});
