/**
 * test/session-beacon-hook.test.ts (#6168 Parte B)
 *
 * O argumento central de desenho da issue é uma observação sobre este repo:
 * **o que depende de skill lembrar, não acontece.** Três mecanismos corretos,
 * testados e INERTES provaram isso — `heartbeat --active-worktrees` (#5156
 * item 6, nunca chamado por skill nenhuma, campo `undefined` há meses),
 * `register --pid` (#6160, fechado por HOOK e não por skill) e
 * `plan.session_id` (#5156 item 11, rollout pendente).
 *
 * Por isso o beacon é um hook `PreToolUse`. O teste que importa mais neste
 * arquivo é o último: um registro que nasce **só de chamadas de ferramenta**,
 * sem nenhuma skill chamar nada.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BEACON_KIND,
  TOUCHED_PATHS_CAP,
  MIN_WRITE_INTERVAL_MS,
  buildBeaconRecord,
  collapsePaths,
  extractTouchedPaths,
  findExistingSessionFile,
  normalizePath,
  readCurrentBranch,
  resolveMainRepoRootNoSpawn,
  sniffVerb,
} from "../.claude/hooks/session-beacon.mjs";

const T0 = Date.parse("2026-08-26T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function event(over: Record<string, unknown> = {}) {
  return {
    kind: BEACON_KIND,
    machineTag: "Neo",
    sessionId: "sess-1",
    branch: "master",
    newPaths: [] as string[],
    verb: null as string | null,
    nowIso: iso(0),
    pid: 4242,
    ...over,
  };
}

describe("#6168 Parte B — o kind do beacon nunca é coordenador", () => {
  it('BEACON_KIND é "interactive"', () => {
    assert.equal(BEACON_KIND, "interactive");
  });
});

describe("#6168 Parte B — extração de caminho tocado", () => {
  const root = "C:/repo";

  it("Edit/Write/NotebookEdit produzem caminho relativo à raiz", () => {
    assert.deepEqual(extractTouchedPaths("Edit", { file_path: "C:/repo/scripts/a.ts" }, root), ["scripts/a.ts"]);
    assert.deepEqual(extractTouchedPaths("Write", { file_path: "C:/repo/test/b.test.ts" }, root), ["test/b.test.ts"]);
  });

  it("Bash NÃO produz caminho — o sinal do Bash é o VERBO", () => {
    // Parsear caminho de linha de comando é frágil e não é o que interessa:
    // o que o Bash informa é o que MUDOU de estado (commit/checkout/push).
    assert.deepEqual(extractTouchedPaths("Bash", { command: "vim scripts/a.ts" }, root), []);
  });

  it("arquivo FORA do repo é ignorado (scratchpad, /tmp)", () => {
    // Não interessa a peer nenhum, e vazaria caminho de fora do projeto pro
    // registro compartilhado.
    assert.deepEqual(extractTouchedPaths("Write", { file_path: "C:/tmp/scratch.md" }, root), []);
  });

  it("arquivo em OUTRO DRIVE do Windows é ignorado (#6303 Finding U)", () => {
    // `path.relative()` entre drives distintos no Windows não devolve uma
    // string começando com ".." (devolve o path ABSOLUTO do destino, sem
    // transformação nenhuma) — o guard `rel.startsWith("..")` sozinho não
    // pega esse caso. Sem o guard adicional `isAbsolute(rel)`, o path
    // absoluto de outro drive entraria em touched_paths como se fosse
    // relativo à raiz.
    assert.deepEqual(extractTouchedPaths("Write", { file_path: "D:/outro/lugar.md" }, "C:/repo"), []);
  });

  it("sem file_path → vazio", () => {
    assert.deepEqual(extractTouchedPaths("Edit", {}, root), []);
    assert.deepEqual(extractTouchedPaths("Edit", undefined, root), []);
  });
});

describe("#6168 Parte B — sniffVerb", () => {
  it("reconhece os verbos que mudam estado compartilhado", () => {
    assert.equal(sniffVerb("git commit -m 'x'"), "commit");
    assert.equal(sniffVerb("git checkout master"), "checkout");
    assert.equal(sniffVerb("git switch -c nova"), "checkout");
    assert.equal(sniffVerb("git push -u origin nova"), "push");
    assert.equal(sniffVerb("gh pr create --fill"), "pr-create");
    assert.equal(sniffVerb("gh pr merge 42 --squash"), "pr-merge");
    assert.equal(sniffVerb("git worktree add x y"), "worktree-open");
  });

  it("comando comum não vira verbo", () => {
    assert.equal(sniffVerb("npx tsc --noEmit"), null);
    assert.equal(sniffVerb("ls -la"), null);
  });

  it("entrada não-string nunca lança", () => {
    assert.equal(sniffVerb(undefined), null);
    assert.equal(sniffVerb(null), null);
    assert.equal(sniffVerb(42), null);
  });
});

describe("#6168 Parte B — dirty_paths significa NÃO COMMITADO", () => {
  it("Edit/Write acumulam em touched_paths E dirty_paths", () => {
    const r1 = buildBeaconRecord(null, event({ newPaths: ["scripts/a.ts"] }));
    assert.deepEqual(r1!.touched_paths, ["scripts/a.ts"]);
    assert.deepEqual(r1!.dirty_paths, ["scripts/a.ts"]);

    const r2 = buildBeaconRecord(r1, event({ newPaths: ["scripts/b.ts"], nowIso: iso(60_000) }));
    assert.deepEqual(r2!.touched_paths, ["scripts/a.ts", "scripts/b.ts"]);
    assert.deepEqual(r2!.dirty_paths, ["scripts/a.ts", "scripts/b.ts"]);
  });

  it("`git commit` ZERA dirty_paths mas PRESERVA touched_paths", () => {
    // É o que faz o campo significar "trabalho não commitado" em vez de
    // "arquivos que a sessão já tocou alguma vez" — a distinção exata que a
    // evidência 2 da issue pedia.
    const r1 = buildBeaconRecord(null, event({ newPaths: ["scripts/a.ts", "scripts/b.ts"] }));
    const r2 = buildBeaconRecord(r1, event({ verb: "commit", nowIso: iso(60_000) }));
    assert.deepEqual(r2!.dirty_paths, [], "commit zera o não-commitado");
    assert.deepEqual(r2!.touched_paths, ["scripts/a.ts", "scripts/b.ts"], "mas o histórico da sessão fica");
    assert.equal(r2!.last_action.verb, "commit");
  });

  it("depois do commit, editar de novo volta a sujar", () => {
    const r1 = buildBeaconRecord(null, event({ newPaths: ["a.ts"] }));
    const r2 = buildBeaconRecord(r1, event({ verb: "commit", nowIso: iso(60_000) }));
    const r3 = buildBeaconRecord(r2, event({ newPaths: ["c.ts"], nowIso: iso(120_000) }));
    assert.deepEqual(r3!.dirty_paths, ["c.ts"]);
  });
});

describe("#6168 Parte B — throttle de escrita", () => {
  it("nada novo + write recente → NÃO reescreve", () => {
    // `data/sessions/` vive na junction OneDrive; escrita de alta frequência
    // ali é o que gera cópia de conflito `-safeBackup-NNNN` (#5427/#6130).
    const r1 = buildBeaconRecord(null, event({ newPaths: ["a.ts"] }));
    const r2 = buildBeaconRecord(r1, event({ nowIso: iso(MIN_WRITE_INTERVAL_MS - 1) }));
    assert.equal(r2, null);
  });

  it("nada novo mas passou o intervalo → reescreve (heartbeat segue vivo)", () => {
    const r1 = buildBeaconRecord(null, event({ newPaths: ["a.ts"] }));
    const r2 = buildBeaconRecord(r1, event({ nowIso: iso(MIN_WRITE_INTERVAL_MS + 1) }));
    assert.ok(r2, "sem isto o heartbeat congelaria e a sessão viva viraria stale");
  });

  it("caminho NOVO fura o throttle", () => {
    const r1 = buildBeaconRecord(null, event({ newPaths: ["a.ts"] }));
    const r2 = buildBeaconRecord(r1, event({ newPaths: ["b.ts"], nowIso: iso(10) }));
    assert.ok(r2);
    assert.deepEqual(r2!.dirty_paths, ["a.ts", "b.ts"]);
  });

  it("troca de BRANCH fura o throttle", () => {
    // É o dado que a checagem "a branch ainda é minha?" consome — atrasá-lo
    // por throttle derrotaria o propósito.
    const r1 = buildBeaconRecord(null, event({ branch: "master" }));
    const r2 = buildBeaconRecord(r1, event({ branch: "develop/fix-1", nowIso: iso(10) }));
    assert.ok(r2);
    assert.equal(r2!.branch, "develop/fix-1");
  });

  it("verbo NOVO fura o throttle", () => {
    const r1 = buildBeaconRecord(null, event({ newPaths: ["a.ts"] }));
    const r2 = buildBeaconRecord(r1, event({ verb: "commit", nowIso: iso(10) }));
    assert.ok(r2);
  });
});

describe("#6168 Parte B — o beacon nunca destrói estado alheio", () => {
  it("claimed_issues de um registro COORDENADOR sobrevive ao beacon", () => {
    // O beacon roda sobre o registro de QUALQUER sessão, inclusive uma
    // overnight com 12 issues reivindicadas. Zerar isso aqui seria o mesmo
    // dano do #6294, por outro caminho.
    const previous = {
      kind: "overnight",
      machineTag: "helios",
      sessionId: "sess-1",
      startedAt: iso(-3_600_000),
      lastHeartbeat: iso(-60_000),
      claimed_issues: [5653, 5942, 6035],
    };
    const r = buildBeaconRecord(previous, event({ newPaths: ["a.ts"] }));
    assert.deepEqual(r!.claimed_issues, [5653, 5942, 6035]);
    assert.equal(r!.kind, "overnight", "o beacon NÃO rebaixa uma coordenadora a interactive");
    assert.equal(r!.machineTag, "helios");
    assert.equal(r!.startedAt, previous.startedAt, "startedAt original preservado — o beacon não rejuvenesce a sessão");
  });

  it("findExistingSessionFile acha o registro coordenador do MESMO sessionId", () => {
    // Sem isto, o beacon criaria um `interactive-*` paralelo pro mesmo
    // sessionId, e a sessão apareceria DUAS vezes em `list-active`.
    const root = mkdtempSync(join(tmpdir(), "beacon-find-"));
    const dir = join(root, "sessions");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "overnight-helios-sess-1.json"), "{}", "utf8");
      assert.equal(findExistingSessionFile(dir, "sess-1"), "overnight-helios-sess-1.json");
      assert.equal(findExistingSessionFile(dir, "sess-outra"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("findExistingSessionFile ignora cópias de conflito do OneDrive", () => {
    const root = mkdtempSync(join(tmpdir(), "beacon-find2-"));
    const dir = join(root, "sessions");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "develop-Neo-sess-1-Neo-safeBackup-0001.json"), "{}", "utf8");
      assert.equal(findExistingSessionFile(dir, "sess-1"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("diretório ausente → null, nunca lança", () => {
    assert.equal(findExistingSessionFile(join(tmpdir(), "nao-existe-mesmo"), "s"), null);
  });
});

describe("#6168 Parte B — resolução de raiz e branch sem subprocesso", () => {
  it("checkout principal: .git é diretório → a própria raiz", () => {
    const root = mkdtempSync(join(tmpdir(), "beacon-root-"));
    try {
      mkdirSync(join(root, ".git"), { recursive: true });
      assert.equal(resolveMainRepoRootNoSpawn(root), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("worktree: .git é arquivo apontando pra .git/worktrees/<nome> → sobe pra raiz principal", () => {
    const base = mkdtempSync(join(tmpdir(), "beacon-wt-"));
    try {
      const main = join(base, "principal");
      const wt = join(base, "wt");
      mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`, "utf8");
      assert.equal(resolveMainRepoRootNoSpawn(wt), main);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("sem .git → null (fail-open: o caller não faz nada)", () => {
    const root = mkdtempSync(join(tmpdir(), "beacon-nogit-"));
    try {
      assert.equal(resolveMainRepoRootNoSpawn(root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readCurrentBranch lê ref de .git/HEAD; detached vira null", () => {
    const root = mkdtempSync(join(tmpdir(), "beacon-head-"));
    try {
      mkdirSync(join(root, ".git"), { recursive: true });
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/develop/fix-6168\n", "utf8");
      assert.equal(readCurrentBranch(root), "develop/fix-6168");

      writeFileSync(join(root, ".git", "HEAD"), "aaea3860f1e2d3c4b5a6\n", "utf8");
      assert.equal(readCurrentBranch(root), null, "detached HEAD não tem branch pra declarar");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readCurrentBranch nunca lança quando não há repo", () => {
    assert.equal(readCurrentBranch(join(tmpdir(), "nao-existe-mesmo")), null);
  });
});

describe("#6168 Parte B — comportamento das funções do PRÓPRIO hook (não é cross-check)", () => {
  // #6303 Findings L/M/J: os títulos anteriores ("TOUCHED_PATHS_CAP é 200 NOS
  // DOIS LADOS", "normalizePath do hook CONCORDA COM O DO MÓDULO") prometiam
  // uma paridade cruzada que estes 3 testes nunca verificaram — cada um só
  // compara a função DESTE arquivo contra um literal/comportamento esperado,
  // sem importar a versão irmã de `session-registry.ts`. Os testes em si
  // continuam úteis (documentam o comportamento do hook), só o título mentia.
  // O cross-check DE VERDADE (importa os dois módulos, compara valor a
  // valor) mora em `test/session-beacon-blast-radius.test.ts`, describe
  // "#6303 Findings L/M/J".
  it("TOUCHED_PATHS_CAP deste arquivo é 200", () => {
    assert.equal(TOUCHED_PATHS_CAP, 200);
  });

  it("collapsePaths colapsa em vez de truncar", () => {
    const many = Array.from({ length: 40 }, (_, i) => `scripts/lib/m${i}.ts`);
    const out = collapsePaths(many, 4);
    assert.ok(out.length <= 4);
  });

  it("normalizePath deste arquivo produz o separador esperado", () => {
    assert.equal(normalizePath("scripts\\lib\\a.ts"), "scripts/lib/a.ts");
    assert.equal(normalizePath("./a/"), "a");
  });
});

describe("#6168 Parte B — CRITÉRIO DE ACEITE: registro nasce só de chamadas de ferramenta", () => {
  it("uma sessão que NUNCA chama skill nenhuma acaba com branch, caminhos e verbo populados", () => {
    // Este é o teste que a issue pede literalmente: "Hook de beacon popula
    // esses campos SEM NENHUMA SKILL CHAMAR NADA, e o teste prova isso com um
    // registro nascido só de chamadas Bash."
    //
    // Simula a sequência real de uma sessão interativa: edita 2 arquivos,
    // roda um typecheck, commita, cria PR. Nenhum `register`, nenhum
    // `heartbeat`, nenhuma linha de SKILL.md envolvida.
    let record: Record<string, unknown> | null = null;
    let t = 0;
    const step = (over: Record<string, unknown>) => {
      t += MIN_WRITE_INTERVAL_MS + 1000;
      const next = buildBeaconRecord(record, event({ ...over, nowIso: iso(t) }));
      if (next) record = next;
    };

    step({ branch: "develop/fix-6168", newPaths: ["scripts/lib/session-registry.ts"] });
    step({ branch: "develop/fix-6168", newPaths: [".claude/hooks/session-beacon.mjs"] });
    step({ branch: "develop/fix-6168", verb: null }); // npx tsc --noEmit
    step({ branch: "develop/fix-6168", verb: "commit" });
    step({ branch: "develop/fix-6168", verb: "pr-create" });

    assert.ok(record, "o registro existe sem nenhuma skill ter chamado nada");
    assert.equal(record!.kind, "interactive");
    assert.equal(record!.branch, "develop/fix-6168");
    assert.deepEqual(record!.touched_paths, [
      ".claude/hooks/session-beacon.mjs",
      "scripts/lib/session-registry.ts",
    ]);
    assert.deepEqual(record!.dirty_paths, [], "commitou antes de abrir a PR — nada pendente");
    assert.equal((record!.last_action as { verb: string }).verb, "pr-create");
    assert.equal(record!.pid, 4242, "pid vem do hook (process.ppid), não de uma skill lembrar de --pid");
  });

  it("a MESMA sessão que edita e NÃO commita fica com dirty_paths — o sintoma da evidência 2", () => {
    // O tick do contínuo que deixou 4 arquivos sem commit em master e
    // reportou "concluído". Com o beacon, isso fica visível a qualquer peer.
    let record: Record<string, unknown> | null = null;
    let t = 0;
    const step = (over: Record<string, unknown>) => {
      t += MIN_WRITE_INTERVAL_MS + 1000;
      const next = buildBeaconRecord(record, event({ ...over, nowIso: iso(t) }));
      if (next) record = next;
    };

    step({ branch: "master", newPaths: [".claude/skills/diaria-develop/SKILL.md"] });
    step({ branch: "master", newPaths: [".claude/skills/diaria-overnight/SKILL.md"] });
    step({ branch: "master", newPaths: ["scripts/lib/session-registry.ts"] });
    step({ branch: "master", newPaths: ["test/session-registry.test.ts"] });

    assert.equal((record!.dirty_paths as string[]).length, 4);
    assert.equal(record!.branch, "master", "e em master, num checkout compartilhado");
  });
});

// ─── #6303 Finding H: o ENTRYPOINT do hook nunca é exercitado ──────────────

describe("CLI end-to-end — harness real via stdin (#6303 Finding H, mesmo padrão do #5161 item 10)", () => {
  // Achado do fleet review: os 24 testes acima chamam só as funções PURAS
  // (`buildBeaconRecord` e companhia) — ninguém spawna o ARQUIVO com um
  // payload real no stdin. Se o shape real do payload do harness divergir
  // (`tool_input.file_path` sob outra chave, `session_id` ausente nalguma
  // tool call), o beacon escreveria nada — ou errado — pra sempre, com a
  // suíte inteira verde.
  //
  // `resolveMainRepoRootNoSpawn` deriva a raiz a partir de ONDE O ARQUIVO DO
  // HOOK MORA (`import.meta.url`), não do cwd do processo spawnado — spawnar
  // o hook REAL deste worktree resolveria a raiz do checkout PRINCIPAL de
  // verdade (a junction OneDrive real). Por isso cada teste aqui copia o
  // hook pra um diretório temporário ISOLADO, com `.git/` e `data/sessions/`
  // PRÓPRIOS, e spawna essa CÓPIA — nunca o arquivo original do worktree.
  const REAL_HOOK_PATH = fileURLToPath(new URL("../.claude/hooks/session-beacon.mjs", import.meta.url));
  const roots: string[] = [];

  function makeIsolatedHookCopy(): { root: string; hookPath: string; sessionsDir: string } {
    const root = mkdtempSync(join(tmpdir(), "beacon-e2e-"));
    roots.push(root);
    // `.git` como DIRETÓRIO (sem HEAD nem mais nada dentro) já basta pra
    // `resolveMainRepoRootNoSpawn` devolver a própria `root` como raiz —
    // `readCurrentBranch` cai em `null` de forma fail-open (sem HEAD pra
    // ler), que é aceitável pros propósitos deste teste.
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    const hookPath = join(root, ".claude", "hooks", "session-beacon.mjs");
    copyFileSync(REAL_HOOK_PATH, hookPath);
    return { root, hookPath, sessionsDir: join(root, "data", "sessions") };
  }

  function runHook(hookPath: string, payload: Record<string, unknown>) {
    return spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("payload de Edit com file_path REAL → registro criado com touched_paths", () => {
    const { root, hookPath, sessionsDir } = makeIsolatedHookCopy();
    const payload = {
      session_id: "sess-e2e-edit",
      tool_name: "Edit",
      tool_input: { file_path: join(root, "scripts", "lib", "foo.ts") },
    };
    const result = runHook(hookPath, payload);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim(), "", "o beacon nunca emite saída — PreToolUse aqui é side-effect puro");

    const files = readdirSync(sessionsDir);
    assert.equal(files.length, 1, `esperava exatamente 1 registro, achou: ${JSON.stringify(files)}`);
    assert.match(files[0]!, /^interactive-.+-sess-e2e-edit\.json$/);
    const record = JSON.parse(readFileSync(join(sessionsDir, files[0]!), "utf8"));
    assert.equal(record.kind, "interactive");
    assert.deepEqual(record.touched_paths, ["scripts/lib/foo.ts"]);
    assert.deepEqual(record.dirty_paths, ["scripts/lib/foo.ts"]);
  });

  it("payload de Bash com 'git commit' → dirty_paths ZERADO (mesmo registro da sessão)", () => {
    const { root, hookPath, sessionsDir } = makeIsolatedHookCopy();
    // 1º: Edit suja um arquivo.
    runHook(hookPath, {
      session_id: "sess-e2e-commit",
      tool_name: "Edit",
      tool_input: { file_path: join(root, "a.ts") },
    });
    let files = readdirSync(sessionsDir);
    let record = JSON.parse(readFileSync(join(sessionsDir, files[0]!), "utf8"));
    assert.deepEqual(record.dirty_paths, ["a.ts"], "sanity check do passo 1");

    // 2º: Bash com `git commit` — deve zerar dirty_paths e preservar touched_paths.
    const result = runHook(hookPath, {
      session_id: "sess-e2e-commit",
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'x'" },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");

    files = readdirSync(sessionsDir);
    assert.equal(files.length, 1, "commit não cria um 2º registro — enriquece o mesmo");
    record = JSON.parse(readFileSync(join(sessionsDir, files[0]!), "utf8"));
    assert.deepEqual(record.dirty_paths, [], "commit zera o não-commitado");
    assert.deepEqual(record.touched_paths, ["a.ts"], "mas o histórico da sessão sobrevive");
    assert.equal(record.last_action.verb, "commit");
  });

  it("payload SEM session_id → nada é escrito, nunca lança", () => {
    const { hookPath, sessionsDir } = makeIsolatedHookCopy();
    const result = runHook(hookPath, {
      tool_name: "Edit",
      tool_input: { file_path: "/algum/lugar.ts" },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(readdirSync(sessionsDir), []);
  });
});
