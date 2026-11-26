/**
 * test/stage5-6-chained-registry-14039.test.ts (#14039)
 *
 * Etapas 5 e 6: `log-event.ts` e `update-stage-status.ts` vão no MESMO Bash do
 * comando que reportam, nunca num turno próprio (cada turno a mais relê ~262k
 * tokens de cache, edição 261123). O encadeamento guarda o exit do comando
 * principal (`; rc=$?`) e o devolve no fim (`(exit $rc)`), e nunca encadeia
 * `edition-lock.ts` (o hook inject-session-id só injeta `--session-id` em
 * comando standalone). Guard de prosa dos playbooks + execução real da forma
 * de encadeamento num shell, para provar que o exit do principal sobrevive ao
 * log.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const stage5 = read(".claude/agents/orchestrator-stage-5.md");
const stage6 = read(".claude/agents/orchestrator-stage-6.md");

/** Blocos ```bash ... ``` do playbook. */
function bashBlocks(md: string): string[] {
  return [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/** O bloco bash que contém `needle`. */
function blockWith(md: string, needle: string): string {
  const b = bashBlocks(md).find((x) => x.includes(needle));
  assert.ok(b, `bloco bash com ${needle} não encontrado`);
  return b;
}

describe("#14039 — registro encadeado nas Etapas 5 e 6", () => {
  it("stage 5 documenta a regra e a exceção do edition-lock", () => {
    assert.match(stage5, /### Comandos de registro encadeados \(#14039\)/);
    assert.match(stage5, /Sempre standalone, nunca encadeado:\*\* `edition-lock\.ts`/);
    assert.match(stage6, /\*\*Comandos de registro encadeados \(#14039\):\*\*/);
  });

  for (const [label, md, stage, msg] of [
    ["stage 5", stage5, 5, "etapa 5 publicacao started"],
    ["stage 6", stage6, 6, "etapa 6 agendamento started"],
  ] as const) {
    it(`${label}: running + log de início num Bash só, exit do update-stage-status devolvido`, () => {
      const b = blockWith(md, `--stage ${stage} --status running; rc=$?`);
      assert.ok(b.includes(msg), `log '${msg}' fora do bloco do running`);
      assert.match(b.trimEnd(), /\(exit \$rc\)$/);
      // o log de início não sobra num bloco isolado
      const isolated = bashBlocks(md).filter((x) => x.includes(msg) && !x.includes("update-stage-status"));
      assert.deepEqual(isolated, [], `log '${msg}' ainda tem bloco próprio`);
    });

    it(`${label}: status done + capture-stage-usage num Bash só`, () => {
      const b = blockWith(md, `--stage ${stage} --status done; rc=$?`);
      assert.ok(b.includes(`capture-stage-usage.ts --edition-dir {EDITION_DIR}/ --stage ${stage}`));
      assert.match(b.trimEnd(), /\(exit \$rc\)$/);
    });
  }

  it("site-page (stage 5 e fallback do stage 6) loga com o exit real do publicador", () => {
    for (const md of [stage5, stage6]) {
      const b = blockWith(md, "publish-edition-site-page.ts");
      assert.match(b, /--no-wait-merge; rc=\$\?/);
      assert.match(b, /--message "site-page stage[56][^"]*: exit \$rc"/);
      assert.match(b.trimEnd(), /\(exit \$rc\)$/);
    }
  });

  it("nenhum bloco encadeia edition-lock.ts nem session-registry.ts", () => {
    let seen = 0;
    for (const md of [stage5, stage6]) {
      // comando inline em crase e linha de bloco bash que roda o script
      const inline = [...md.matchAll(/`(npx tsx scripts\/(?:edition-lock|session-registry)\.ts[^`]*)`/g)].map((m) => m[1]);
      const inBlocks = bashBlocks(md).flatMap((b) => b.split("\n")).filter((l) => /scripts\/(edition-lock|session-registry)\.ts/.test(l));
      for (const cmd of [...inline, ...inBlocks]) {
        seen++;
        assert.doesNotMatch(cmd, /;|&&|\|/, `trava encadeada: ${cmd.slice(0, 160)}`);
      }
    }
    assert.ok(seen >= 5, `sanidade: esperava as chamadas do edition-lock no stage 5 (achadas: ${seen})`);
  });

  it("a forma encadeada devolve o exit do comando principal mesmo com o log saindo 0", () => {
    // Mesma forma dos playbooks: principal; rc=$?; registro; (exit $rc)
    const script = [
      "sh -c 'exit 3'; rc=$?",
      "case $rc in 0|2) lvl=info ;; *) lvl=warn ;; esac",
      'echo "log $lvl exit $rc"',
      "(exit $rc)",
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    assert.equal(r.status, 3, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /log warn exit 3/);
    const ok = spawnSync("bash", ["-c", script.replace("exit 3", "exit 0")], { encoding: "utf8" });
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /log info exit 0/);
  });
});
