/**
 * test/worker-drift-unresolved-14097.test.ts (#14097)
 *
 * Regressão: `getWorkerTrackedPaths` usava só `computeClosure(...).external` e
 * descartava `.unresolved` sem log. Um import de um Worker para um arquivo de
 * `scripts/lib/` renomeado/movido (ou um alias que o parser não entende) saía
 * do fecho em silêncio, e uma mudança não deployada nesse módulo voltava a
 * passar sem alarme. Agora o import não resolvido vira aviso em stderr,
 * `closureIncomplete` no resultado (sufixo no relatório + seção no e-mail) e
 * um achado de issue próprio, sem derrubar os demais workers.
 *
 * Árvore de fixture num tmpdir, `git log` fake injetado; sem rede nem Cloudflare.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getLastCommitAt,
  getWorkerClosureReport,
  getWorkerTrackedPaths,
  toClosureIncompleteAlarmFinding,
  toAlarmFinding,
  type GitRunner,
} from "../scripts/worker-drift-check.ts";
import {
  evaluateAllWorkerDrift,
  evaluateWorkerDrift,
  buildWorkerDriftAlarmEmail,
  closureIncompleteReportSuffix,
  hasIncompleteClosure,
  hasPendingDrift,
  computeDriftFingerprint,
} from "../scripts/lib/worker-drift-check.ts";
import { computeWorkerExternalImports, extractAliasSpecifiers } from "../scripts/lib/worker-import-closure.ts";

/** Captura `console.error` durante `fn`. */
function captureStderr<T>(fn: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: fn(), lines };
  } finally {
    console.error = orig;
  }
}

const fakeGitLog =
  (commits: { at: string; files: string[] }[]): GitRunner =>
  (args) => {
    const paths = args.slice(args.indexOf("--") + 1).map((p) => p.split("\\").join("/"));
    const touches = (f: string) => paths.some((p) => f === p || f.startsWith(`${p}/`));
    const hit = commits.filter((c) => c.files.some(touches)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    return { status: 0, stdout: hit ? `${hit.at}\n` : "" };
  };

describe("worker-drift-check — import não resolvido no fecho (#14097)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "worker-drift-14097-"));
    mkdirSync(join(root, "workers", "site", "src"), { recursive: true });
    mkdirSync(join(root, "workers", "poll", "src"), { recursive: true });
    mkdirSync(join(root, "scripts", "lib", "shared"), { recursive: true });
    writeFileSync(join(root, "workers", "site", "wrangler.toml"), 'name = "diaria-site"\nmain = "src/index.ts"\n');
    // Um import resolve; o outro aponta para um módulo que foi renomeado (não existe mais).
    writeFileSync(
      join(root, "workers", "site", "src", "index.ts"),
      [
        'import { tokens } from "../../../scripts/lib/shared/design-tokens.ts";',
        'import { velho } from "../../../scripts/lib/shared/renomeado.ts";',
        'import { cfg } from "@/lib/config";',
        "export default { fetch() { return [tokens, velho, cfg]; } };",
      ].join("\n"),
    );
    writeFileSync(join(root, "scripts", "lib", "shared", "design-tokens.ts"), "export const tokens = 1;\n");
    // O arquivo novo (depois do rename) — o worker ainda importa o nome velho.
    writeFileSync(join(root, "scripts", "lib", "shared", "renomeado-novo.ts"), "export const velho = 2;\n");
    // Worker vizinho com fecho completo.
    writeFileSync(join(root, "workers", "poll", "wrangler.toml"), 'name = "diaria-poll"\nmain = "src/index.ts"\n');
    writeFileSync(
      join(root, "workers", "poll", "src", "index.ts"),
      'import { tokens } from "../../../scripts/lib/shared/design-tokens.ts";\nexport default { fetch() { return tokens; } };\n',
    );
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("extractAliasSpecifiers pega @/, ~/ e #, mas não pacote npm com escopo nem relativo", () => {
    const src = 'import a from "@/x";\nimport b from "~/y";\nimport c from "#z";\nimport d from "@scope/pkg";\nimport e from "./rel.ts";\nimport f from "zod";\n';
    assert.deepEqual(extractAliasSpecifiers(src).sort(), ["#z", "@/x", "~/y"]);
  });

  it("computeWorkerExternalImports lista o relativo inexistente e o alias em `unresolved`", () => {
    const c = computeWorkerExternalImports(root, "site");
    assert.deepEqual(c.external, ["scripts/lib/shared/design-tokens.ts"]);
    assert.deepEqual(c.unresolved, [
      "workers/site/src/index.ts: ../../../scripts/lib/shared/renomeado.ts",
      "workers/site/src/index.ts: @/lib/config (alias não suportado pelo parser)",
    ]);
  });

  it("getWorkerClosureReport devolve os paths E o incompleto, com aviso em stderr por import", () => {
    const { value, lines } = captureStderr(() => getWorkerClosureReport("site", root));
    assert.deepEqual(value.paths, ["scripts/lib/shared/design-tokens.ts"]);
    assert.equal(value.incomplete.length, 2);
    assert.equal(lines.length, 2, "um aviso por import não resolvido");
    assert.ok(lines.every((l) => l.includes("workers/site/") && l.includes("import não resolvido")));
    assert.ok(lines.some((l) => l.includes("renomeado.ts")));
  });

  it("fecho completo não avisa nada", () => {
    const { value, lines } = captureStderr(() => getWorkerClosureReport("poll", root));
    assert.deepEqual(value.incomplete, []);
    assert.deepEqual(lines, []);
  });

  it("falha ao calcular o fecho também conta como fecho incompleto (antes: só lista vazia)", () => {
    const { value, lines } = captureStderr(() =>
      getWorkerClosureReport("site", root, () => {
        throw new Error("boom");
      }),
    );
    assert.deepEqual(value.paths, []);
    assert.equal(value.incomplete.length, 1);
    assert.match(value.incomplete[0], /boom/);
    assert.equal(lines.length, 1);
    // O wrapper do #13993 segue devolvendo só os paths.
    assert.deepEqual(
      captureStderr(() => getWorkerTrackedPaths("site", root, () => { throw new Error("x"); })).value,
      [],
    );
  });

  it("cenário da issue: o worker sai marcado como fecho incompleto, sem derrubar o vizinho", () => {
    const git = fakeGitLog([
      { at: "2026-11-20T10:00:00-03:00", files: ["workers/site/src/index.ts", "workers/poll/src/index.ts"] },
      // Mudança no módulo que o fecho perdeu: invisível para o git log.
      { at: "2026-11-24T10:00:00-03:00", files: ["scripts/lib/shared/renomeado-novo.ts"] },
    ]);
    const lastDeployedAt = "2026-11-21T12:00:00.000Z";
    const now = new Date("2026-11-26T12:00:00.000Z");

    const inputs = ["site", "poll"].map((dir) => {
      const closure = captureStderr(() => getWorkerClosureReport(dir, root)).value;
      return {
        workerName: `diaria-${dir}`,
        workerDir: dir,
        lastDeployedAt,
        lastCommitAt: getLastCommitAt(dir, root, "origin/master", closure.paths, git),
        deployError: null,
        closureIncomplete: closure.incomplete,
      };
    });
    const [site, poll] = evaluateAllWorkerDrift(inputs, now);

    // O status não muda (o commit escondido segue escondido), mas o sinal existe.
    assert.equal(site.status, "ok");
    assert.equal(hasIncompleteClosure(site), true);
    assert.match(closureIncompleteReportSuffix(site), /fecho incompleto: 2 import\(s\)/);
    // Vizinho com fecho completo: shape inalterado, sem campo novo.
    assert.equal(poll.status, "ok");
    assert.equal(hasIncompleteClosure(poll), false);
    assert.equal("closureIncomplete" in poll, false);
    assert.equal(closureIncompleteReportSuffix(poll), "");

    // Fecho incompleto não é drift pendente: não mexe no cursor/fingerprint do e-mail de drift.
    assert.equal(hasPendingDrift([site, poll]), false);
    assert.equal(computeDriftFingerprint([site, poll]), "");

    // Vira achado de issue próprio, com check distinto do drift.
    const f = toClosureIncompleteAlarmFinding(site);
    assert.equal(f.check, "fecho-incompleto:diaria-site");
    assert.equal(f.priority, "P3");
    assert.match(f.body, /renomeado\.ts/);
    assert.match(f.fingerprint, /^diaria-site:fecho-incompleto:/);
  });

  it("o e-mail de drift carrega a seção de fecho incompleto quando algum worker o tem", () => {
    const now = new Date("2026-11-26T12:00:00.000Z");
    const drifted = evaluateWorkerDrift(
      {
        workerName: "diaria-poll",
        workerDir: "poll",
        lastDeployedAt: "2026-11-21T12:00:00.000Z",
        lastCommitAt: "2026-11-24T10:00:00-03:00",
        deployError: null,
      },
      now,
    );
    const incomplete = evaluateWorkerDrift(
      {
        workerName: "diaria-site",
        workerDir: "site",
        lastDeployedAt: "2026-11-21T12:00:00.000Z",
        lastCommitAt: "2026-11-20T10:00:00-03:00",
        deployError: null,
        closureIncomplete: ["workers/site/src/index.ts: ../x.ts"],
      },
      now,
    );
    const { body } = buildWorkerDriftAlarmEmail([drifted, incomplete], now);
    assert.match(body, /1 worker\(s\) com fecho de imports incompleto/);
    assert.match(body, /diaria-site \(workers\/site\/\): workers\/site\/src\/index\.ts: \.\.\/x\.ts/);
    // Sem fecho incompleto, a seção não aparece.
    assert.doesNotMatch(buildWorkerDriftAlarmEmail([drifted], now).body, /fecho de imports incompleto/);
    // O achado de drift não muda de fingerprint por causa do campo novo.
    assert.equal(toAlarmFinding(drifted).check, "diaria-poll");
  });
});
