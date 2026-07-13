/**
 * test/git-sync.test.ts (#2686)
 *
 * Testa `scripts/lib/git-sync.ts` com spawner mockado (sem git real destrutivo).
 *
 * Cenários cobertos:
 *   - pull --ff-only sucede em tree limpa → outcome "synced"
 *   - tree limpa, já atualizado → "already_up_to_date"
 *   - tree suja → stash → pull → pop → "synced_stashed"
 *   - tree suja, já atualizado → stash → pull → pop → "already_up_to_date"
 *   - dirty tree, stash pop falhou → "stash_pop_failed" (stash preservado)
 *   - dirty tree, stash falhou → "stash_failed" (tree não tocada)
 *   - fetch falhou (offline) → "fetch_failed", proceed=true (fail-soft)
 *   - pull --ff-only falhou (divergência) → "ff_failed", proceed=true
 *   - branch != master → checkout master primeiro
 *   - branch != master, checkout falhou → "checkout_failed", proceed=true
 *   - #2699 item 1: defaultSpawn roda git com cwd=REPO_ROOT, não process.cwd()
 *   - #2699 item 3: rev-parse falha → mensagem de diagnóstico aponta pra causa raiz
 *     (não-repo / git indisponível), não "branch desconhecida"
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  syncCode,
  defaultSpawn,
  createFileLock,
  REPO_ROOT,
  type SpawnFn,
  type SpawnResult,
  type SyncLock,
} from "../scripts/lib/git-sync.ts";

// ── Helpers de mock ────────────────────────────────────────────────────────

function ok(stdout = ""): SpawnResult {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = "", status = 1): SpawnResult {
  return { status, stdout: "", stderr };
}

/**
 * Lock fake que sempre adquire com sucesso — usado pela maioria dos testes,
 * que não exercitam a lógica de lock em si (#3423) e não devem depender do
 * disco real nem interferir entre casos de teste sequenciais.
 */
const NOOP_LOCK: SyncLock = {
  path: "(noop-lock, teste)",
  acquire: () => true,
  release: () => {},
};

/**
 * Constrói um SpawnFn a partir de um mapa de "git <args[0]> <args[1]>" → resultado.
 * Fallback: ok("") para comandos não mapeados.
 */
function makeSpawn(responses: Record<string, SpawnResult>): SpawnFn {
  return (cmd: string, args: string[]) => {
    const key = [cmd, ...args].join(" ");
    return responses[key] ?? ok("");
  };
}

// ── Suíte principal ────────────────────────────────────────────────────────

describe("git-sync — cenários de sucesso", () => {
  it("tree limpa, pull bem-sucedido → 'synced'", () => {
    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": ok("master"),
      "git fetch origin": ok(""),
      "git status --porcelain": ok(""), // tree limpa
      "git merge --ff-only origin/master": ok("2 files changed, 10 insertions(+)"),
    });

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "synced");
    assert.equal(r.branch_before, "master");
    assert.equal(r.proceed, true);
    assert.equal(r.warnings.length, 0);
  });

  it("tree limpa, já atualizado → 'already_up_to_date'", () => {
    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": ok("master"),
      "git fetch origin": ok(""),
      "git status --porcelain": ok(""),
      "git merge --ff-only origin/master": ok("Already up to date."),
    });

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "already_up_to_date");
    assert.equal(r.proceed, true);
  });

  it("tree suja, stash → pull → pop sucedido → 'synced_stashed'", () => {
    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": ok("master"),
      "git fetch origin": ok(""),
      "git status --porcelain": ok(" M .claude/settings.json\n M seed/lancamentos-tool-allowlist.txt"),
      "git stash --include-untracked": ok("Saved working directory..."),
      "git merge --ff-only origin/master": ok("Fast-forward\n 3 files changed"),
      "git stash pop": ok("On branch master..."),
    });

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "synced_stashed");
    assert.equal(r.proceed, true);
    assert.match(r.message, /stash/);
  });

  it("tree suja, já atualizado após stash → 'already_up_to_date'", () => {
    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": ok("master"),
      "git fetch origin": ok(""),
      "git status --porcelain": ok(" M .claude/settings.local.json"),
      "git stash --include-untracked": ok("Saved working directory..."),
      "git merge --ff-only origin/master": ok("Already up to date."),
      "git stash pop": ok(""),
    });

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "already_up_to_date");
    assert.equal(r.proceed, true);
  });
});

describe("git-sync — dirty tree edge cases", () => {
  it("stash pop falhou (conflito) → 'stash_pop_failed', proceed=true", () => {
    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": ok("master"),
      "git fetch origin": ok(""),
      "git status --porcelain": ok(" M .claude/settings.json"),
      "git stash --include-untracked": ok("Saved working directory..."),
      "git merge --ff-only origin/master": ok("Fast-forward\n 1 file changed"),
      "git stash pop": fail("CONFLICT (content): Merge conflict in .claude/settings.json"),
    });

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "stash_pop_failed");
    assert.equal(r.proceed, true);
    assert.ok(r.warnings.some((w) => /stash pop/i.test(w)));
  });

  it("stash falhou → 'stash_failed', tree não tocada, proceed=true", () => {
    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": ok("master"),
      "git fetch origin": ok(""),
      "git status --porcelain": ok(" M .claude/settings.json"),
      "git stash --include-untracked": fail("error: cannot stash"),
    });

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "stash_failed");
    assert.equal(r.proceed, true);
    assert.ok(r.warnings.some((w) => /stash/i.test(w)));
  });

  it("'No local changes to save' → não tenta stash pop", () => {
    // git stash pode retornar exit 0 com essa mensagem se não há nada pra stash
    const popCalled: boolean[] = [];
    const spawn: SpawnFn = (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      if (key === "git stash pop") popCalled.push(true);
      return makeSpawn({
        "git rev-parse --abbrev-ref HEAD": ok("master"),
        "git fetch origin": ok(""),
        "git status --porcelain": ok(" M .claude/settings.json"),
        "git stash --include-untracked": ok("No local changes to save"),
        "git merge --ff-only origin/master": ok("Already up to date."),
      })(cmd, args);
    };

    const r = syncCode(spawn, NOOP_LOCK);
    // nada foi stashado → pop não deve ter sido chamado
    assert.equal(popCalled.length, 0, "stash pop não deve ser chamado quando nada foi stashado");
    assert.equal(r.outcome, "already_up_to_date");
  });

  it("#2716 item 5c: 'No local changes to save' + merge traz mudanças → 'synced' (NÃO 'synced_stashed')", () => {
    // Regressão: antes do fix, o outcome era hardcoded para "synced_stashed" sempre
    // que a tree era tratada como dirty, mesmo quando `git stash` não guardou nada
    // (stashedSomething=false). O outcome enganava o diagnóstico — parecia que houve
    // stash/pop quando nunca houve. Cenário: status --porcelain falhou (força dirty
    // por segurança), stash não tinha nada pra guardar, merge trouxe mudanças reais.
    const popCalled: boolean[] = [];
    const spawn: SpawnFn = (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      if (key === "git stash pop") popCalled.push(true);
      return makeSpawn({
        "git rev-parse --abbrev-ref HEAD": ok("master"),
        "git fetch origin": ok(""),
        "git status --porcelain": fail("fatal: unable to read index"), // força dirty
        "git stash --include-untracked": ok("No local changes to save"),
        "git merge --ff-only origin/master": ok("Fast-forward\n 2 files changed"),
      })(cmd, args);
    };

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(popCalled.length, 0, "stash pop não deve ser chamado quando nada foi stashado");
    assert.equal(r.outcome, "synced", "outcome deve ser 'synced' (não 'synced_stashed') quando nada foi de fato stashado");
    assert.equal(r.proceed, true);
  });
});

describe("git-sync — #3411: stash exit não-zero mas CRIOU um stash (falso negativo de 'working tree não tocada')", () => {
  /**
   * Reprodução real (260713): `git stash --include-untracked` não é atômico —
   * cria o(s) commit(s) de stash e SÓ DEPOIS remove os arquivos não-rastreados
   * (clean-equivalente). Se essa remoção falhar parcialmente (ex: "Permission
   * denied" num diretório com handle aberto por outro processo), o comando sai
   * com exit não-zero MESMO com o stash já criado. O código antigo tratava
   * qualquer exit não-zero como "stash falhou, tree não tocada" — falso.
   *
   * Helper para simular `git rev-parse --verify refs/stash` retornando valores
   * DIFERENTES nas chamadas antes/depois do stash (a essência da detecção).
   */
  function makeStashRefSequence(sequence: SpawnResult[]): SpawnFn {
    let call = 0;
    return (cmd: string, args: string[]): SpawnResult => {
      const key = [cmd, ...args].join(" ");
      if (key === "git rev-parse --verify refs/stash") {
        const r = sequence[Math.min(call, sequence.length - 1)];
        call += 1;
        return r;
      }
      return ok("");
    };
  }

  it("stash saiu não-zero mas CRIOU stash (refs/stash mudou) + pop recupera → 'stash_partial_failure'", () => {
    const popCalled: boolean[] = [];
    const stashRefSpawn = makeStashRefSequence([
      fail("fatal: ambiguous argument 'refs/stash': unknown revision", 128), // antes: nenhum stash existia
      ok("a1b2c3d4"), // depois: um stash FOI criado apesar do exit não-zero
    ]);
    const spawn: SpawnFn = (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      if (key === "git stash pop") popCalled.push(true);
      if (key === "git rev-parse --verify refs/stash") return stashRefSpawn(cmd, args);
      return makeSpawn({
        "git rev-parse --abbrev-ref HEAD": ok("master"),
        "git fetch origin": ok(""),
        "git status --porcelain": ok(" M arquivo.txt"),
        "git stash --include-untracked": fail(
          "warning: failed to remove some/untracked/dir: Permission denied",
          1,
        ),
        "git stash pop": ok("On branch master...\nDropped refs/stash@{0}"),
      })(cmd, args);
    };

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "stash_partial_failure");
    assert.equal(r.proceed, true);
    assert.equal(popCalled.length, 1, "pop deve ser tentado automaticamente quando um stash foi detectado");
    assert.match(r.message, /a1b2c3d4/, "mensagem deve citar o hash do stash pra investigação");
    assert.match(r.message, /pop/i);
    assert.doesNotMatch(
      r.message,
      /working tree não tocada/i,
      "NÃO deve afirmar 'working tree não tocada' quando um stash foi de fato criado",
    );
  });

  it("stash saiu não-zero mas CRIOU stash + pop TAMBÉM falha → 'stash_partial_failure_unrecovered', stash preservado (sem drop)", () => {
    const dropCalled: boolean[] = [];
    const stashRefSpawn = makeStashRefSequence([
      fail("fatal: ambiguous argument 'refs/stash': unknown revision", 128),
      ok("deadbeef01"),
    ]);
    const spawn: SpawnFn = (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      if (key.startsWith("git stash drop")) dropCalled.push(true);
      if (key === "git rev-parse --verify refs/stash") return stashRefSpawn(cmd, args);
      return makeSpawn({
        "git rev-parse --abbrev-ref HEAD": ok("master"),
        "git fetch origin": ok(""),
        "git status --porcelain": ok(" M arquivo.txt"),
        "git stash --include-untracked": fail(
          "warning: failed to remove some/untracked/dir: Permission denied",
          1,
        ),
        "git stash pop": fail("CONFLICT (content): Merge conflict in arquivo.txt"),
      })(cmd, args);
    };

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "stash_partial_failure_unrecovered");
    assert.equal(r.proceed, true);
    assert.equal(dropCalled.length, 0, "stash NUNCA deve ser descartado (git stash drop) quando o pop falha");
    assert.match(r.message, /deadbeef01/, "mensagem deve citar o hash do stash preservado");
    assert.match(r.message, /investiga(ç|c)[aã]o manual|preservado/i);
  });

  it("stash falhou 100% — NADA foi criado (refs/stash não mudou, nunca existiu) → 'stash_failed' original preservado", () => {
    // Regressão: garantir que a nova detecção não gera falso-positivo quando o
    // stash de fato falhou por completo, sem criar nada.
    const popCalled: boolean[] = [];
    const spawn: SpawnFn = (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      if (key === "git stash pop") popCalled.push(true);
      return makeSpawn({
        "git rev-parse --abbrev-ref HEAD": ok("master"),
        "git fetch origin": ok(""),
        "git status --porcelain": ok(" M arquivo.txt"),
        // refs/stash falha (nunca existiu) tanto antes quanto depois — mesmo resultado
        "git rev-parse --verify refs/stash": fail(
          "fatal: ambiguous argument 'refs/stash': unknown revision",
          128,
        ),
        "git stash --include-untracked": fail("error: cannot stash"),
      })(cmd, args);
    };

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "stash_failed");
    assert.equal(r.proceed, true);
    assert.equal(popCalled.length, 0, "pop não deve ser chamado quando nenhum stash foi criado");
    assert.match(r.message, /working tree não tocada/i);
  });

  it("stash falhou mas JÁ existia um stash de rodada anterior (refs/stash igual antes/depois) → 'stash_failed', não confunde com stash novo", () => {
    // Edge case: se já havia um stash de uma rodada anterior (não relacionado a
    // esta chamada), e o `git stash` desta chamada falha sem criar um NOVO
    // stash, refs/stash não muda — não deve ser confundido com "stash criado
    // apesar do exit não-zero".
    const popCalled: boolean[] = [];
    const spawn: SpawnFn = (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      if (key === "git stash pop") popCalled.push(true);
      return makeSpawn({
        "git rev-parse --abbrev-ref HEAD": ok("master"),
        "git fetch origin": ok(""),
        "git status --porcelain": ok(" M arquivo.txt"),
        // mesmo hash antes E depois — nenhum stash NOVO foi criado
        "git rev-parse --verify refs/stash": ok("existing-stash-hash-999"),
        "git stash --include-untracked": fail("error: cannot stash"),
      })(cmd, args);
    };

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "stash_failed");
    assert.equal(r.proceed, true);
    assert.equal(popCalled.length, 0, "pop não deve ser chamado — nenhum stash NOVO foi criado");
  });
});

describe("git-sync — cenários de falha fail-soft", () => {
  it("fetch falhou (offline) → 'fetch_failed', proceed=true, sem bloquear", () => {
    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": ok("master"),
      "git fetch origin": fail("fatal: unable to connect to origin"),
    });

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "fetch_failed");
    assert.equal(r.proceed, true);
    assert.ok(r.warnings.some((w) => /fetch/i.test(w)));
  });

  it("pull --ff-only falhou (divergência) → 'ff_failed', proceed=true", () => {
    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": ok("master"),
      "git fetch origin": ok(""),
      "git status --porcelain": ok(""),
      "git merge --ff-only origin/master": fail("fatal: Not possible to fast-forward, aborting."),
    });

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "ff_failed");
    assert.equal(r.proceed, true);
    assert.ok(r.warnings.length > 0);
  });

  it("pull --ff-only falhou com dirty tree → 'ff_failed', tree restaurada, proceed=true", () => {
    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": ok("master"),
      "git fetch origin": ok(""),
      "git status --porcelain": ok(" M .claude/settings.json"),
      "git stash --include-untracked": ok("Saved working directory..."),
      "git merge --ff-only origin/master": fail("fatal: Not possible to fast-forward"),
      "git stash pop": ok(""), // pop deve ser chamado mesmo com ff falho
    });

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "ff_failed");
    assert.equal(r.proceed, true);
  });

  it("ff falhou E stash pop falhou (double-failure) → 'ff_failed' com stderr do ff na mensagem", () => {
    // #2686 review (angles A/B/G/J/C): outcome=ff_failed mas a mensagem antes só
    // citava o conflito de stash, escondendo a divergência. Agora inclui ambos.
    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": ok("master"),
      "git fetch origin": ok(""),
      "git status --porcelain": ok(" M .claude/settings.json"),
      "git stash --include-untracked": ok("Saved working directory..."),
      "git merge --ff-only origin/master": fail("fatal: Not possible to fast-forward, aborting."),
      "git stash pop": fail("CONFLICT (content): Merge conflict in .claude/settings.json"),
    });

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "ff_failed");
    assert.equal(r.proceed, true);
    // a mensagem deve mencionar AMBOS: a divergência do ff e o conflito do pop
    assert.match(r.message, /fast-forward/i, "mensagem deve citar o stderr do ff");
    assert.match(r.message, /conflict|conflito|stash/i, "mensagem deve citar o conflito do pop");
  });
});

describe("git-sync — robustez de detecção (locale + status)", () => {
  it("git status falhou → tratado como dirty (protege via stash), proceed=true", () => {
    // #2686 review (angles A/B): se status falha, NÃO assumir tree limpa —
    // isso pularia a proteção do stash.
    const stashCalled: boolean[] = [];
    const spawn: SpawnFn = (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      if (key === "git stash --include-untracked") stashCalled.push(true);
      return makeSpawn({
        "git rev-parse --abbrev-ref HEAD": ok("master"),
        "git fetch origin": ok(""),
        "git status --porcelain": fail("fatal: unable to read index"),
        "git stash --include-untracked": ok("Saved working directory..."),
        "git merge --ff-only origin/master": ok("Already up to date."),
        "git stash pop": ok(""),
      })(cmd, args);
    };

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(stashCalled.length, 1, "status-fail deve forçar o caminho com stash");
    assert.equal(r.proceed, true);
    assert.ok(r.warnings.some((w) => /status falhou/i.test(w)));
  });

  it("stash reporta 'nada guardado' em PT-BR → não chama stash pop (locale-robusto)", () => {
    // #2686 review (angle D/I/C): detecção EN-only causava pop espúrio em git PT-BR.
    const popCalled: boolean[] = [];
    const spawn: SpawnFn = (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      if (key === "git stash pop") popCalled.push(true);
      return makeSpawn({
        "git rev-parse --abbrev-ref HEAD": ok("master"),
        "git fetch origin": ok(""),
        "git status --porcelain": ok(" M .claude/settings.json"),
        "git stash --include-untracked": ok("Não há mudanças locais para salvar"),
        "git merge --ff-only origin/master": ok("Already up to date."),
      })(cmd, args);
    };

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(popCalled.length, 0, "stash pop não deve ser chamado em PT-BR 'nada guardado'");
    assert.equal(r.outcome, "already_up_to_date");
  });
});

describe("git-sync — branch != master", () => {
  it("branch != master → checkout master antes do sync", () => {
    const checkoutCalled: boolean[] = [];
    const spawn: SpawnFn = (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      if (key === "git checkout master") checkoutCalled.push(true);
      return makeSpawn({
        "git rev-parse --abbrev-ref HEAD": ok("overnight/fix-2686"),
        "git checkout master": ok("Switched to branch 'master'"),
        "git fetch origin": ok(""),
        "git status --porcelain": ok(""),
        "git merge --ff-only origin/master": ok("Already up to date."),
      })(cmd, args);
    };

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.branch_before, "overnight/fix-2686");
    assert.equal(checkoutCalled.length, 1, "checkout master deve ser chamado");
    assert.equal(r.outcome, "already_up_to_date");
    assert.equal(r.proceed, true);
    assert.ok(r.warnings.some((w) => /overnight\/fix-2686/.test(w)));
  });

  it("branch != master, checkout falhou → 'checkout_failed', proceed=true (não força)", () => {
    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": ok("feat/some-feature"),
      "git checkout master": fail("error: Your local changes would be overwritten by checkout"),
    });

    const r = syncCode(spawn, NOOP_LOCK);
    assert.equal(r.outcome, "checkout_failed");
    assert.equal(r.branch_before, "feat/some-feature");
    assert.equal(r.proceed, true);
    assert.ok(r.warnings.some((w) => /checkout/i.test(w)));
  });
});

describe("git-sync — #2699 item 1: defaultSpawn usa cwd=REPO_ROOT explícito", () => {
  // REPO_ROOT é resolvido a partir de scripts/lib/git-sync.ts (2 níveis abaixo
  // da raiz do repo); este arquivo de teste está em test/ (1 nível abaixo) —
  // recomputa independentemente para não reusar a mesma lógica sob teste.
  const expectedRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  it("REPO_ROOT resolve pra raiz do repo (não process.cwd())", () => {
    assert.equal(REPO_ROOT, expectedRepoRoot);
  });

  describe("com process.cwd() apontando pra fora do repo", () => {
    let originalCwd: string;

    before(() => {
      originalCwd = process.cwd();
      // tmpdir() garantidamente fora do checkout do repo — se defaultSpawn
      // usasse process.cwd() (bug do item 1), o `git rev-parse` abaixo falharia
      // ("not a git repository") em vez de resolver a raiz do repo.
      process.chdir(tmpdir());
    });

    after(() => {
      process.chdir(originalCwd);
    });

    it("defaultSpawn roda git com cwd=REPO_ROOT — rev-parse resolve mesmo fora do repo", () => {
      assert.notEqual(
        process.cwd().toLowerCase(),
        REPO_ROOT.toLowerCase(),
        "pré-condição do teste: cwd do processo precisa estar fora do repo",
      );

      const r = defaultSpawn("git", ["rev-parse", "--show-toplevel"]);

      assert.equal(r.status, 0, `git rev-parse deveria suceder via cwd=REPO_ROOT; stderr: ${r.stderr}`);
      // Normaliza separadores (Windows usa \\, git imprime /), barra final e
      // caixa (drive letter pode divergir em maiúscula/minúscula) antes de comparar.
      const normalize = (p: string) => p.trim().replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
      assert.equal(
        normalize(r.stdout),
        normalize(REPO_ROOT),
        `git deveria ter rodado com cwd=REPO_ROOT (${REPO_ROOT}), resolveu toplevel: ${r.stdout.trim()}`,
      );
    });
  });
});

describe("git-sync — #2699 item 3: diagnóstico quando rev-parse falha", () => {
  it("rev-parse falha (não-repo/git indisponível) → warning aponta causa raiz, não 'branch desconhecida'", () => {
    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": fail("fatal: not a git repository (or any of the parent directories): .git", 128),
    });

    const r = syncCode(spawn, NOOP_LOCK);

    // rev-parse falhou → stdout vazio → branchBefore cai em "unknown" → tenta
    // checkout master (fail-soft) → mockSpawn não mapeado pra "git checkout
    // master" retorna ok("") por padrão do helper `makeSpawn`... então força
    // falha explícita do checkout também, pra simular o caminho real onde um
    // git quebrado falha em qualquer comando subsequente.
    assert.ok(
      r.warnings.some((w) => /rev-parse.*falhou/i.test(w)),
      `deveria haver um warning específico sobre rev-parse falho: ${JSON.stringify(r.warnings)}`,
    );
    assert.ok(
      r.warnings.some((w) => /não é um reposit(ó|o)rio git|git indispon[íi]vel/i.test(w)),
      `warning deveria apontar causa raiz (não-repo / git indisponível): ${JSON.stringify(r.warnings)}`,
    );
  });

  it("rev-parse E checkout falham → mensagem final também cita a causa raiz do rev-parse (não só 'branch=unknown')", () => {
    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": fail("fatal: not a git repository", 128),
      "git checkout master": fail("fatal: not a git repository", 128),
    });

    const r = syncCode(spawn, NOOP_LOCK);

    assert.equal(r.outcome, "checkout_failed");
    assert.equal(r.branch_before, "unknown");
    assert.match(
      r.message,
      /não é um reposit(ó|o)rio git|git indispon[íi]vel/i,
      `mensagem final deveria citar a causa raiz (rev-parse já falho), não só a branch: ${r.message}`,
    );
  });
});

describe("git-sync — #3423: TOCTOU race no stash-recovery, serializada via lock", () => {
  /**
   * Reprodução do achado #3423: `scripts/lib/git-sync.ts` comparava `refs/stash`
   * antes/depois de um `git stash --include-untracked` que falhou parcialmente
   * (#3411) e, se a ref mudasse, rodava `git stash pop` SEM identificador — que
   * popa cegamente o topo da pilha (`stash@{0}`). Se 2 chamadas de `syncCode()`
   * corressem concorrentemente contra o MESMO checkout e ambas falhassem
   * parcialmente no stash, o processo A podia ler `stashRefAfter` como o stash
   * que o processo B tinha acabado de criar (não o seu próprio) e popar as
   * mudanças de B — corrompendo o estado de B e deixando as mudanças reais de A
   * ainda stashadas.
   *
   * O fix serializa toda a chamada de `syncCode()` com um lock — uma segunda
   * chamada concorrente detecta o lock já adquirido e retorna imediatamente
   * SEM rodar nenhum comando `git stash`/`git merge`, eliminando a janela onde
   * a comparação `refs/stash` antes/depois poderia observar o stash de OUTRO
   * processo.
   */

  it("lock já adquirido (simulando processo B em andamento) → 'sync_in_progress' SEM tocar em stash/merge", () => {
    // Lock double que simula "já existe um lock ativo de outro processo" —
    // é exatamente o que aconteceria se o processo B tivesse chamado
    // lock.acquire() primeiro e ainda não tivesse chamado release().
    const alreadyHeldLock: SyncLock = {
      path: "/fake/.diaria-sync.lock",
      acquire: () => false,
      release: () => {
        throw new Error("release() nunca deveria ser chamado por quem não adquiriu o lock");
      },
    };

    const gitCommandsRun: string[] = [];
    const spawn: SpawnFn = (cmd, args) => {
      gitCommandsRun.push([cmd, ...args].join(" "));
      // Mesmo cenário do achado original: tree dirty, refs/stash MUDOU
      // (simula o stash que o processo B concorrente acabou de criar) — se o
      // lock não tivesse barrado a chamada, o código antigo teria popado isso.
      return makeSpawn({
        "git rev-parse --abbrev-ref HEAD": ok("master"),
        "git fetch origin": ok(""),
        "git status --porcelain": ok(" M arquivo-do-processo-A.txt"),
        "git rev-parse --verify refs/stash": ok("stash-do-processo-B"),
        "git stash --include-untracked": fail("warning: failed to remove some/dir: Permission denied", 1),
      })(cmd, args);
    };

    const r = syncCode(spawn, alreadyHeldLock);

    assert.equal(r.outcome, "sync_in_progress");
    assert.equal(r.proceed, true);
    assert.match(r.message, /outro processo|lock/i);
    assert.equal(
      gitCommandsRun.length,
      0,
      `nenhum comando git deveria rodar quando o lock já está adquirido — rodou: ${JSON.stringify(gitCommandsRun)}`,
    );
  });

  it("lock livre → syncCode adquire, roda normalmente, e libera ao final (sucesso)", () => {
    const acquireCalls: boolean[] = [];
    const releaseCalls: boolean[] = [];
    const lock: SyncLock = {
      path: "/fake/.diaria-sync.lock",
      acquire: () => {
        acquireCalls.push(true);
        return true;
      },
      release: () => {
        releaseCalls.push(true);
      },
    };

    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": ok("master"),
      "git fetch origin": ok(""),
      "git status --porcelain": ok(""),
      "git merge --ff-only origin/master": ok("Already up to date."),
    });

    const r = syncCode(spawn, lock);

    assert.equal(r.outcome, "already_up_to_date");
    assert.equal(acquireCalls.length, 1, "lock deve ser adquirido exatamente 1x");
    assert.equal(releaseCalls.length, 1, "lock deve ser liberado exatamente 1x ao final");
  });

  it("lock livre, mas syncCode caminho com erro (checkout falha) → lock ainda é liberado (finally)", () => {
    const releaseCalls: boolean[] = [];
    const lock: SyncLock = {
      path: "/fake/.diaria-sync.lock",
      acquire: () => true,
      release: () => {
        releaseCalls.push(true);
      },
    };

    const spawn = makeSpawn({
      "git rev-parse --abbrev-ref HEAD": ok("overnight/fix-x"),
      "git checkout master": fail("error: Your local changes would be overwritten by checkout"),
    });

    const r = syncCode(spawn, lock);

    assert.equal(r.outcome, "checkout_failed");
    assert.equal(releaseCalls.length, 1, "lock deve ser liberado mesmo em caminho de erro (early return)");
  });
});

describe("git-sync — #3423: createFileLock (lock de arquivo real)", () => {
  let lockDir: string;
  let lockPath: string;

  before(() => {
    lockDir = fs.mkdtempSync(join(tmpdir(), "diaria-sync-lock-test-"));
    lockPath = join(lockDir, ".diaria-sync.lock");
  });

  after(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("2 locks apontando pro MESMO path → só o primeiro adquire (exclusão mútua real, sem mock)", () => {
    // Simula 2 processos concorrentes (processo A e processo B) chamando
    // createFileLock() com o mesmo path — o cenário real do #3423 (2 invocações
    // de /diaria-edicao contra o mesmo checkout).
    const lockA = createFileLock(lockPath);
    const lockB = createFileLock(lockPath);

    assert.equal(lockA.acquire(), true, "processo A adquire o lock livre");
    assert.equal(lockB.acquire(), false, "processo B NÃO deve conseguir adquirir — A já é dono");

    lockA.release();

    assert.equal(lockB.acquire(), true, "após A liberar, B consegue adquirir");
    lockB.release();
  });

  it("release() é idempotente — chamar sem ter adquirido não lança", () => {
    const lock = createFileLock(join(lockDir, "nunca-adquirido.lock"));
    assert.doesNotThrow(() => lock.release());
  });

  it("lock STALE (mtime antigo, processo dono crashou) é recuperado automaticamente", () => {
    const staleLockPath = join(lockDir, "stale.lock");
    fs.mkdirSync(staleLockPath);
    // Recua o mtime pra além do limiar de staleness (LOCK_STALE_MS = 10min).
    const veryOld = new Date(Date.now() - 15 * 60 * 1000);
    fs.utimesSync(staleLockPath, veryOld, veryOld);

    const lock = createFileLock(staleLockPath);
    assert.equal(lock.acquire(), true, "lock stale (>10min) deve ser recuperado, não bloquear pra sempre");
    lock.release();
  });

  it("lock recente (não-stale) NÃO é recuperado — permanece bloqueado", () => {
    const freshLockPath = join(lockDir, "fresh.lock");
    fs.mkdirSync(freshLockPath); // mtime = agora

    const lock = createFileLock(freshLockPath);
    assert.equal(lock.acquire(), false, "lock recente deve continuar bloqueando (processo genuinamente em andamento)");

    fs.rmdirSync(freshLockPath); // cleanup manual (não foi este `lock` que criou)
  });
});
