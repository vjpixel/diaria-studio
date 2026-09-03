/**
 * test/which-set-guards.test.ts (#7056)
 *
 * Regressão do incidente: PR #7038 (#7030) converteu `workers/artigos` de
 * assets estáticos para scripted worker, tocando `workers/artigos/
 * wrangler.toml` (ganhou `main=`) + `workers/artigos/src/index.ts` (novo
 * entrypoint) — sem que nenhum arquivo de teste correspondente fosse tocado.
 * Isso fez `master` ficar vermelho em `c8fcdc9b` com os 8 checks do PR
 * verdes: `test/workers-observability-guard.test.ts` e
 * `test/worker-bundle-node-only-imports.test.ts` varrem TODO `workers/*`,
 * mas a disciplina local "só rode os testes de arquivo afetados" (#2959)
 * não tinha como saber que esses dois precisavam rodar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SET_GUARDS, matchingSetGuards, formatReport } from "../scripts/which-set-guards.ts";
import { matchesGlob } from "../scripts/lib/sensitive-path-guard.ts";
import { ORCHESTRATOR_FILES } from "../scripts/lib/orchestrator-files.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("regressão do #7030/#7038 — converter workers/artigos dispara os 2 guards certos", () => {
  it("wrangler.toml + src/index.ts de um worker disparam workers-observability-guard e worker-bundle-node-only-imports", () => {
    const report = matchingSetGuards(["workers/artigos/wrangler.toml", "workers/artigos/src/index.ts"]);
    assert.equal(report.triggered, true);
    const ids = report.hits.map((h) => h.ruleId).sort();
    assert.deepEqual(ids, ["worker-bundle-node-only-imports", "workers-observability-guard"]);
    assert.ok(
      report.testFilesToRun.includes("test/workers-observability-guard.test.ts"),
      "precisa apontar o teste de observabilidade a rodar",
    );
    assert.ok(
      report.testFilesToRun.includes("test/worker-bundle-node-only-imports.test.ts"),
      "precisa apontar o teste de imports Node-only a rodar",
    );
  });

  it("só o wrangler.toml (sem tocar src/) já dispara os 2 — main= sozinho já converte o worker", () => {
    const report = matchingSetGuards(["workers/artigos/wrangler.toml"]);
    const ids = report.hits.map((h) => h.ruleId).sort();
    assert.deepEqual(ids, ["worker-bundle-node-only-imports", "workers-observability-guard"]);
  });
});

describe("matchingSetGuards — um path por regra", () => {
  it("workers-observability-guard: workers/*/wrangler.toml", () => {
    const report = matchingSetGuards(["workers/cursos/wrangler.toml"]);
    assert.ok(report.hits.some((h) => h.ruleId === "workers-observability-guard"));
  });

  it("worker-bundle-node-only-imports: workers/*/src/**", () => {
    const report = matchingSetGuards(["workers/arquivo/src/render-archive.ts"]);
    assert.ok(report.hits.some((h) => h.ruleId === "worker-bundle-node-only-imports"));
  });

  it("hub-page-drift: scripts/lib/hubs/**", () => {
    const report = matchingSetGuards(["scripts/lib/hubs/anthropic-claude.ts"]);
    assert.ok(report.hits.some((h) => h.ruleId === "hub-page-drift"));
  });

  it("hub-page-drift: workers/arquivo/src/hubs/** (meta.ts e os *.generated.ts committed)", () => {
    const meta = matchingSetGuards(["workers/arquivo/src/hubs/meta.ts"]);
    assert.ok(meta.hits.some((h) => h.ruleId === "hub-page-drift"));
    const generated = matchingSetGuards(["workers/arquivo/src/hubs/anthropic-claude.generated.ts"]);
    assert.ok(generated.hits.some((h) => h.ruleId === "hub-page-drift"));
  });

  it("hub-page-drift: scripts/build-hub-page.ts", () => {
    const report = matchingSetGuards(["scripts/build-hub-page.ts"]);
    assert.ok(report.hits.some((h) => h.ruleId === "hub-page-drift"));
  });

  it("seed-html-sync: seed/courses/** e seed/books/**", () => {
    const cursos = matchingSetGuards(["seed/courses/cursos-ia.json"]);
    assert.ok(cursos.hits.some((h) => h.ruleId === "seed-html-sync"));
    const livros = matchingSetGuards(["seed/books/livros-ia.json"]);
    assert.ok(livros.hits.some((h) => h.ruleId === "seed-html-sync"));
  });

  it("scheduled-tasks: scripts/lib/scheduled-tasks.ts e docs/scheduled-tasks-registry.md", () => {
    const registro = matchingSetGuards(["scripts/lib/scheduled-tasks.ts"]);
    assert.ok(registro.hits.some((h) => h.ruleId === "scheduled-tasks"));
    const doc = matchingSetGuards(["docs/scheduled-tasks-registry.md"]);
    assert.ok(doc.hits.some((h) => h.ruleId === "scheduled-tasks"));
  });

  it("lib-boundary: scripts/lib/** e scripts/studio-ui/**", () => {
    const lib = matchingSetGuards(["scripts/lib/session-registry.ts"]);
    assert.ok(lib.hits.some((h) => h.ruleId === "lib-boundary"));
    const studioUi = matchingSetGuards(["scripts/studio-ui/dashboard-diaria.ts"]);
    assert.ok(studioUi.hits.some((h) => h.ruleId === "lib-boundary"));
  });

  it("orchestrator-prompt-snapshot: .claude/agents/orchestrator-stage-*.md (#7277)", () => {
    const report = matchingSetGuards(["scripts/lib/orchestrator-files.ts"]);
    // scripts/lib/orchestrator-files.ts em si não é um orchestrator-stage-*.md
    // (é o módulo que LISTA eles) — não deve casar com este guard.
    assert.equal(report.hits.some((h) => h.ruleId === "orchestrator-prompt-snapshot"), false);
  });
});

describe("regressão do #7277 — orchestrator-stage-*.md dispara o guard de snapshot (#634)", () => {
  it("orchestrator-stage-4.md sozinho aponta test/orchestrator-prompt.test.ts (repro literal da issue)", () => {
    const report = matchingSetGuards([".claude/agents/orchestrator-stage-4.md"]);
    assert.equal(report.triggered, true, "which-set-guards não pode dizer 'nenhum guard afetado' aqui");
    assert.ok(report.hits.some((h) => h.ruleId === "orchestrator-prompt-snapshot"));
    assert.ok(
      report.testFilesToRun.includes("test/orchestrator-prompt.test.ts"),
      "precisa apontar o teste de snapshot do orchestrator a rodar",
    );
  });

  it("cobre orchestrator.md (raiz, sem hífen) e todos os orchestrator-stage-{0..6}", () => {
    for (const file of ORCHESTRATOR_FILES) {
      const report = matchingSetGuards([`.claude/agents/${file}`]);
      assert.ok(
        report.hits.some((h) => h.ruleId === "orchestrator-prompt-snapshot"),
        `.claude/agents/${file} devia disparar orchestrator-prompt-snapshot`,
      );
    }
  });

  it("arquivo de agent que NÃO é orchestrator não dispara o guard (pattern não vira catch-all)", () => {
    const report = matchingSetGuards([".claude/agents/writer-destaque.md"]);
    assert.equal(report.hits.some((h) => h.ruleId === "orchestrator-prompt-snapshot"), false);
  });
});

describe("matchingSetGuards — casos negativos e degenerados", () => {
  it("diff sem nenhum path de conjunto → triggered:false, testFilesToRun vazio", () => {
    const report = matchingSetGuards(["CLAUDE.md", "test/algum-teste.test.ts", "docs/random.md"]);
    assert.equal(report.triggered, false);
    assert.deepEqual(report.hits, []);
    assert.deepEqual(report.testFilesToRun, []);
  });

  it("ignora linhas vazias/whitespace (saída típica de `git diff --name-only`)", () => {
    const report = matchingSetGuards(["", "  ", "workers/cursos/wrangler.toml", ""]);
    assert.equal(report.triggered, true);
    assert.equal(report.hits[0].matchedPaths.length, 1);
  });

  it("conjunto vazio → triggered:false, nunca lança", () => {
    const report = matchingSetGuards([]);
    assert.equal(report.triggered, false);
  });

  it("normaliza separador do Windows e prefixo ./", () => {
    const withBackslash = matchingSetGuards(["workers\\cursos\\wrangler.toml"]);
    assert.ok(withBackslash.hits.some((h) => h.ruleId === "workers-observability-guard"));
    const withDotSlash = matchingSetGuards(["./workers/cursos/wrangler.toml"]);
    assert.ok(withDotSlash.hits.some((h) => h.ruleId === "workers-observability-guard"));
  });

  it("um diff com arquivos de guards diferentes dispara os dois, sem interferência", () => {
    // `scripts/build-hub-page.ts` casa só com hub-page-drift — não mora sob
    // `workers/` nem `scripts/lib/`, então não cruza com nenhuma outra regra.
    // Path escolhido de propósito pra este par ficar genuinamente disjunto.
    const report = matchingSetGuards(["seed/courses/cursos-ia.json", "scripts/build-hub-page.ts"]);
    const ids = report.hits.map((h) => h.ruleId).sort();
    assert.deepEqual(ids, ["hub-page-drift", "seed-html-sync"]);
  });

  it("um path pode disparar MAIS de 1 guard quando os conjuntos se sobrepõem de verdade (scripts/lib/hubs/** ⊂ scripts/lib/**)", () => {
    const report = matchingSetGuards(["scripts/lib/hubs/google-gemini.ts"]);
    const ids = report.hits.map((h) => h.ruleId).sort();
    assert.deepEqual(ids, ["hub-page-drift", "lib-boundary"]);
  });
});

describe("formatReport", () => {
  it("caso afetado imprime o comando pronto pra rodar", () => {
    const msg = formatReport(matchingSetGuards(["workers/cursos/wrangler.toml"]));
    assert.match(msg, /workers-observability-guard/);
    assert.match(msg, /npx tsx --test/);
    assert.match(msg, /test\/workers-observability-guard\.test\.ts/);
  });

  it("caso limpo diz explicitamente que nenhum guard foi afetado", () => {
    const msg = formatReport(matchingSetGuards(["CLAUDE.md"]));
    assert.match(msg, /nenhum guard de conjunto afetado/);
  });
});

describe("higiene de SET_GUARDS — nenhuma regra morta/órfã", () => {
  it("ids são únicos e não-vazios", () => {
    const ids = SET_GUARDS.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "ids duplicados tornam o output ambíguo");
    for (const rule of SET_GUARDS) {
      assert.ok(rule.id.length > 0);
      assert.ok(rule.triggerPatterns.length > 0, `regra "${rule.id}" sem nenhum triggerPattern`);
      assert.ok(rule.testFiles.length > 0, `regra "${rule.id}" sem nenhum testFile`);
      assert.ok(rule.reason.length > 20, `regra "${rule.id}" precisa de uma razão real, não um rótulo`);
    }
  });

  for (const rule of SET_GUARDS) {
    it(`regra "${rule.id}": todo testFile existe no disco`, () => {
      for (const f of rule.testFiles) {
        assert.ok(existsSync(resolve(ROOT, f)), `${f} não existe — regra "${rule.id}" aponta pra teste órfão`);
      }
    });
  }

  const trackedFiles = execFileSync("git", ["ls-files"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);

  it("o repo tem arquivos rastreados (sanity — senão os testes abaixo passariam vazios)", () => {
    assert.ok(trackedFiles.length > 100, `git ls-files devolveu ${trackedFiles.length} arquivo(s)`);
  });

  for (const rule of SET_GUARDS) {
    for (const pattern of rule.triggerPatterns) {
      it(`regra "${rule.id}", pattern "${pattern}" casa com ao menos 1 arquivo real (#6277, mesmo achado aplicado aqui)`, () => {
        const matched = trackedFiles.filter((f) => matchesGlob(f, pattern));
        assert.ok(
          matched.length > 0,
          `regra "${rule.id}" pattern "${pattern}" não casa com NENHUM arquivo do repo — pattern morto ` +
            "(arquivo movido/renomeado, ou typo). Pattern morto = guard silenciosamente furado.",
        );
      });
    }
  }
});

describe("CLI", () => {
  const script = resolve(ROOT, "scripts/which-set-guards.ts");

  /** Spawna `node --import tsx` diretamente — mesma ressalva de
   * `test/sensitive-path-guard.test.ts` (`npx` sem shell dá ENOENT no
   * Windows; `shell:true` com path absoluto quebra o quoting do cmd.exe). */
  function runCli(args: string[]) {
    const r = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(r.error, undefined, `falha ao spawnar o CLI: ${r.error?.message}`);
    return r;
  }

  it("--files com worker convertido → exit 0 e lista os 2 guards no stdout", () => {
    const r = runCli(["--files", "workers/artigos/wrangler.toml,workers/artigos/src/index.ts"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /workers-observability-guard/);
    assert.match(r.stdout, /worker-bundle-node-only-imports/);
  });

  it("--files limpo → exit 0 e diz que nenhum guard foi afetado", () => {
    const r = runCli(["--files", "CLAUDE.md"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nenhum guard de conjunto afetado/);
  });

  it("--json emite o envelope estruturado com testFilesToRun", () => {
    const r = runCli(["--files", "workers/cursos/wrangler.toml", "--json"]);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.triggered, true);
    assert.ok(parsed.testFilesToRun.includes("test/workers-observability-guard.test.ts"));
  });

  it("FAIL-CLOSED: --base inválido → exit 1 e nenhum veredito no stdout", () => {
    const r = runCli(["--base", "ref/que/nao/existe/jamais"]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /nenhum guard de conjunto afetado/);
    assert.match(r.stderr, /erro/);
  });

  it("FAIL-CLOSED: --files vazio é recusado, nunca lido como 'zero arquivos'", () => {
    const r = runCli(["--files", ""]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /nenhum guard de conjunto afetado/);
    assert.match(r.stderr, /vazio/);
  });

  it("--files e --base juntos são recusados", () => {
    const r = runCli(["--files", "CLAUDE.md", "--base", "origin/master"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mutuamente exclusivos/);
  });
});
