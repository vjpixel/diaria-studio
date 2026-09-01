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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync, closeSync, openSync, unlinkSync, renameSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BEACON_KIND,
  COORDINATOR_KIND_PREFIXES,
  TOUCHED_PATHS_CAP,
  MIN_WRITE_INTERVAL_MS,
  buildBeaconRecord,
  collapsePaths,
  extractTouchedPaths,
  findExistingSessionFile,
  resolveWritePathAtWriteTime,
  normalizePath,
  readCurrentBranch,
  resolveMainRepoRootNoSpawn,
  sniffVerb,
  isLinkedWorktree,
} from "../.claude/hooks/session-beacon.mjs";

describe("statIsDirectory não usa require() morto em .mjs puro ESM (#6322 achado 1)", () => {
  it("o hook não chama require() no caminho quente de statIsDirectory", () => {
    // `.claude/hooks/session-beacon.mjs` é ESM puro (import/export, sem
    // "type": "commonjs" nem transpile) — `require` não existe nesse escopo,
    // então toda chamada a `require("node:fs")` lançava `ReferenceError`,
    // caindo sempre no catch/fallback silenciosamente (#6322). A correção
    // troca isso por `import { statSync } from "node:fs"` real. Este teste
    // guarda contra reintrodução: nenhum `require(` sobrevive no arquivo, e
    // `statSync` chega via import ESM no topo.
    const hookPath = fileURLToPath(new URL("../.claude/hooks/session-beacon.mjs", import.meta.url));
    const source = readFileSync(hookPath, "utf8");
    assert.doesNotMatch(source, /\brequire\s*\(/, "require() não deve mais aparecer no hook ESM");
    assert.match(
      source,
      /import\s*\{[^}]*\bstatSync\b[^}]*\}\s*from\s*"node:fs"/,
      "statSync precisa ser importado via ESM real de node:fs",
    );
  });
});

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

  // ─── #6326 fleet review item 3 — desempate por KIND, não por alfabeto ──

  it("COORDINATOR_KIND_PREFIXES lista os 3 kinds coordenadores, nunca interactive", () => {
    assert.deepEqual([...COORDINATOR_KIND_PREFIXES].sort(), ["continuo", "develop", "overnight"]);
  });

  it("interactive- + overnight- presentes → escolhe overnight- (achado ao vivo #6326: 'interactive' < 'overnight' alfabeticamente, mas overnight é quem deve vencer)", () => {
    const root = mkdtempSync(join(tmpdir(), "beacon-find3-"));
    const dir = join(root, "sessions");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "interactive-helios-sess-1.json"), "{}", "utf8");
      writeFileSync(join(dir, "overnight-helios-sess-1.json"), "{}", "utf8");
      assert.equal(findExistingSessionFile(dir, "sess-1"), "overnight-helios-sess-1.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("interactive- + develop- presentes → escolhe develop- (esta ordem já vinha certa por acidente alfabético — segue certa, agora por regra explícita)", () => {
    const root = mkdtempSync(join(tmpdir(), "beacon-find4-"));
    const dir = join(root, "sessions");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "interactive-helios-sess-1.json"), "{}", "utf8");
      writeFileSync(join(dir, "develop-helios-sess-1.json"), "{}", "utf8");
      assert.equal(findExistingSessionFile(dir, "sess-1"), "develop-helios-sess-1.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("só interactive- presente → continua achando ele normalmente (sem coordenador pra preferir)", () => {
    const root = mkdtempSync(join(tmpdir(), "beacon-find5-"));
    const dir = join(root, "sessions");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "interactive-helios-sess-1.json"), "{}", "utf8");
      assert.equal(findExistingSessionFile(dir, "sess-1"), "interactive-helios-sess-1.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ─── #6326 fleet review item 3 — re-resolução no instante do write ──────

  it("resolveWritePathAtWriteTime: path resolvido AINDA existe → usa ele sem re-resolver", () => {
    const root = mkdtempSync(join(tmpdir(), "beacon-rewrite1-"));
    const dir = join(root, "sessions");
    try {
      mkdirSync(dir, { recursive: true });
      const resolvedPath = join(dir, "interactive-helios-sess-1.json");
      writeFileSync(resolvedPath, "{}", "utf8");
      assert.equal(resolveWritePathAtWriteTime(dir, "sess-1", resolvedPath), resolvedPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveWritePathAtWriteTime: path resolvido SUMIU (promovido por registerSession no meio) → re-resolve pro registro coordenador que apareceu", () => {
    const root = mkdtempSync(join(tmpdir(), "beacon-rewrite2-"));
    const dir = join(root, "sessions");
    try {
      mkdirSync(dir, { recursive: true });
      // O `interactive-*` que o beacon resolveu originalmente NÃO existe mais
      // em disco (foi promovido/removido por `registerSession` entre a
      // resolução e este ponto) — só o `overnight-*` promovido existe agora.
      const resolvedPath = join(dir, "interactive-helios-sess-1.json");
      const promotedPath = join(dir, "overnight-helios-sess-1.json");
      writeFileSync(promotedPath, "{}", "utf8");
      assert.equal(resolveWritePathAtWriteTime(dir, "sess-1", resolvedPath), promotedPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveWritePathAtWriteTime: path resolvido sumiu e NADA reapareceu → cai de volta no resolvedPath original (cria do zero, comportamento de sempre)", () => {
    const root = mkdtempSync(join(tmpdir(), "beacon-rewrite3-"));
    const dir = join(root, "sessions");
    try {
      mkdirSync(dir, { recursive: true });
      const resolvedPath = join(dir, "interactive-helios-sess-1.json");
      assert.equal(resolveWritePathAtWriteTime(dir, "sess-1", resolvedPath), resolvedPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveWritePathAtWriteTime nunca lança mesmo com sessionsDir ausente", () => {
    const missingDir = join(tmpdir(), "beacon-rewrite-missing");
    assert.doesNotThrow(() => resolveWritePathAtWriteTime(missingDir, "sess-1", join(missingDir, "x.json")));
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
    // Tipado como `any` de proposito: `record` so e atribuido DENTRO do
    // closure `step`, e a analise de fluxo do TS nao enxerga isso — ela
    // estreita pra `null` no ponto das assercoes e todo acesso vira
    // `never`. O valor real e sempre um record do beacon.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let record: any = null;
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
    // Tipado como `any` de proposito: `record` so e atribuido DENTRO do
    // closure `step`, e a analise de fluxo do TS nao enxerga isso — ela
    // estreita pra `null` no ponto das assercoes e todo acesso vira
    // `never`. O valor real e sempre um record do beacon.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let record: any = null;
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

  // #6327 — travando a garantia que a docstring de `heartbeat` (session-registry.ts)
  // agora documenta explicitamente: `overnight`/`develop` nunca chamam
  // `heartbeat` neste módulo, e MESMO ASSIM `lastHeartbeat` fica fresco,
  // porque o beacon ENRIQUECE o registro coordenador EXISTENTE em vez de
  // criar um `interactive-*` paralelo. Sem este teste, reduzir/desligar o
  // beacon (ou quebrar `findExistingSessionFile`) pareceria uma mudança
  // inócua de um hook de observabilidade — na prática destrava a garantia de
  // exclusão mútua entre sessões que este achado documenta.
  it(
    "beacon atualiza lastHeartbeat de um registro de kind COORDENADOR já existente, " +
      "sem criar um interactive-* paralelo (#6327)",
    () => {
      const { hookPath, sessionsDir } = makeIsolatedHookCopy();
      const sessionId = "sess-e2e-coord";
      const coordFile = join(sessionsDir, `overnight-Neo-${sessionId}.json`);
      const originalHeartbeat = iso(-60 * 60 * 1000); // 1h atrás — nunca chamou heartbeat() diretamente
      writeFileSync(
        coordFile,
        JSON.stringify({
          kind: "overnight",
          machineTag: "Neo",
          sessionId,
          startedAt: originalHeartbeat,
          lastHeartbeat: originalHeartbeat,
          claimed_issues: [1, 2],
        }),
      );

      const result = runHook(hookPath, {
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: { command: "gh pr list" },
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");

      const files = readdirSync(sessionsDir);
      assert.deepEqual(files, [`overnight-Neo-${sessionId}.json`], "nenhum interactive-* paralelo foi criado");

      const record = JSON.parse(readFileSync(coordFile, "utf8"));
      assert.equal(record.kind, "overnight", "o kind coordenador é preservado — o beacon nunca reclassifica");
      assert.deepEqual(record.claimed_issues, [1, 2], "claims existentes sobrevivem intactas");
      assert.notEqual(
        record.lastHeartbeat,
        originalHeartbeat,
        "lastHeartbeat avançou — é isto que mantém a claim fora de SOFT_STALE_MS sem a skill chamar heartbeat()",
      );
    },
  );
});

describe("#6303 P1/P2 — o beacon NÃO registra subagente", () => {
  it("worktree vinculado (.git é ARQUIVO) é detectado", () => {
    // Todo subagente implementador roda com `isolation: "worktree"`, então o
    // próprio arquivo do hook mora num worktree vinculado. Sem este
    // discriminador, o beacon criaria um registro por subagente: o Stage 1 de
    // UMA edição despacha ~53 `source-researcher` (uma por fonte ativa de
    // `seed/sources.csv`), mais discovery, writers e sociais — centenas de
    // arquivos/dia numa junction OneDrive cujo GC (`Diaria-Session-Registry-Gc`,
    // #6130) está "DECLARADA — ainda NÃO armada".
    const base = mkdtempSync(join(tmpdir(), "beacon-wt-guard-"));
    try {
      const main = join(base, "principal");
      const wt = join(base, "wt");
      mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`, "utf8");

      assert.equal(isLinkedWorktree(wt), true, "worktree vinculado → não registra");
      assert.equal(isLinkedWorktree(main), false, "checkout principal → registra normalmente");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("sem .git → false (fail-open pro lado de REGISTRAR)", () => {
    // Errar aqui custa um registro a mais, não um a menos — e um a menos
    // cegaria o `conflicts` de uma sessão real.
    const root = mkdtempSync(join(tmpdir(), "beacon-nogit-guard-"));
    try {
      assert.equal(isLinkedWorktree(root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── #6952 — lost update: o beacon apaga o que outro escritor gravou ────────
//
// O defeito medido ao vivo (01/09): uma coordenadora concedeu `merge_grant`,
// a beneficiária confirmou `granted: true`, e antes do `gh pr merge` o grant
// tinha sumido — sem ninguém consumi-lo.
//
// A causa é a ESTRUTURA do beacon, não o `merge_grant`. O hook:
//   1. lê o registro (`previous`) no início;
//   2. faz trabalho no meio (resolver branch, colapsar paths, re-resolver o
//      path de escrita com um `readdirSync`);
//   3. escreve mesclando num `...previous` congelado no passo 1.
// Qualquer escrita de outro processo entre 1 e 3 é apagada em silêncio.
//
// A janela é ESTREITA (o passo 2 é só I/O de disco, sem spawn), e é por isso
// que um teste que tenta acertá-la por `setTimeout` não presta: ele passa
// tanto com quanto sem a correção, porque a escrita concorrente quase nunca
// cai no meio. Foi medido: uma primeira versão destes testes, cronometrada,
// passava contra o beacon SEM correção — teste vacuoso.
//
// O que fecha a corrida não é a janela ser curta, é o beacon passar a
// respeitar a MESMA lock file que `session-registry.ts` usa. Então é isso que
// se testa, deterministicamente: com o lock retido por outro escritor, o
// beacon TEM que esperar. Um beacon que escreve enquanto o lock está retido é
// exatamente o beacon que apaga o grant, e o 1º teste falha nele.
describe("#6952 — escrita concorrente durante a janela read→write do beacon", () => {
  const REAL_HOOK = fileURLToPath(new URL("../.claude/hooks/session-beacon.mjs", import.meta.url));
  const raceRoots: string[] = [];

  after(() => {
    for (const r of raceRoots) rmSync(r, { recursive: true, force: true });
  });

  function makeRoot(): { root: string; hookPath: string; sessionsDir: string } {
    const root = mkdtempSync(join(tmpdir(), "beacon-6952-"));
    raceRoots.push(root);
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    const hookPath = join(root, ".claude", "hooks", "session-beacon.mjs");
    copyFileSync(REAL_HOOK, hookPath);
    return { root, hookPath, sessionsDir: join(root, "data", "sessions") };
  }

  function runHookSync(hookPath: string, payload: Record<string, unknown>) {
    return spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  /**
   * Escreve `mutate(record)` no registro do jeito que um OUTRO processo
   * escreve: sob a MESMA lock file que o beacon usa, com write atômico.
   * É o que `session-registry.ts` faz em `grant-merge`/`claim-issue`.
   *
   * Sob o lock de propósito: sem isso o teste mediria "duas escritas cruas
   * colidem", que é verdade em qualquer implementação e não prova nada sobre
   * a correção. O que ele precisa medir é se o beacon RESPEITA um escritor
   * que se anunciou corretamente.
   */
  function writeAsOtherProcess(recordPath: string, mutate: (r: any) => any): void {
    const lockPath = `${recordPath}.lock`;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        closeSync(openSync(lockPath, "wx"));
        break;
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockPath}`);
        const end = Date.now() + 10;
        while (Date.now() < end) { /* busy wait */ }
      }
    }
    try {
      const current = JSON.parse(readFileSync(recordPath, "utf8"));
      const next = mutate(current);
      const tmp = `${recordPath}.tmp-other`;
      writeFileSync(tmp, JSON.stringify(next), "utf8");
      renameSync(tmp, recordPath);
    } finally {
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }

  const GRANT = {
    grantedTo: "benef-6952",
    grantedBy: "coord-6952",
    grantedAt: "2026-09-01T12:00:00.000Z",
    pr: 6952,
  };

  function acquire(lockPath: string): void {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { closeSync(openSync(lockPath, "wx")); return; } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockPath}`);
        const end = Date.now() + 10;
        while (Date.now() < end) { /* busy wait */ }
      }
    }
  }

  it("com o lock retido por outro escritor, o beacon ESPERA — e o merge_grant sobrevive (#6952)", async () => {
    const { root, hookPath, sessionsDir } = makeRoot();
    const sessionId = "sess-6952-grant";

    // Passo 1 — o registro já existe, sem grant. A coordenadora está viva e
    // fazendo tool calls; foi o beacon dela que criou isto.
    runHookSync(hookPath, {
      session_id: sessionId,
      tool_name: "Edit",
      tool_input: { file_path: join(root, "a.ts") },
    });
    const files = readdirSync(sessionsDir);
    assert.equal(files.length, 1, `esperava 1 registro, achou ${JSON.stringify(files)}`);
    const recordPath = join(sessionsDir, files[0]!);
    assert.equal(
      JSON.parse(readFileSync(recordPath, "utf8")).merge_grant,
      undefined,
      "sanity: ainda não há grant",
    );

    // Passo 2 — outro processo (o `grant-merge` de session-registry.ts) entra
    // na seção crítica e SEGURA o lock. Ele ainda não gravou nada.
    const lockPath = `${recordPath}.lock`;
    acquire(lockPath);

    // Passo 3 — no meio disso a sessão faz outra tool call e o beacon dispara,
    // com caminho novo pra não cair no throttle.
    const child = spawn(process.execPath, [hookPath], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(
      JSON.stringify({
        session_id: sessionId,
        tool_name: "Edit",
        tool_input: { file_path: join(root, "b.ts") },
      }),
    );

    // Passo 4 — ESTA é a asserção que separa o beacon corrigido do defeituoso.
    // Com o lock retido, o beacon corrigido está bloqueado e NÃO escreveu. O
    // beacon sem correção ignora o lock, já leu um `previous` sem grant e já
    // gravou — e é essa gravação que, daqui a um instante, vai apagar o grant.
    await new Promise((r) => setTimeout(r, 300));
    const midFlight = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.ok(
      !(midFlight.touched_paths ?? []).includes("b.ts"),
      "o beacon escreveu com o lock retido por outro escritor — é exatamente assim que o merge_grant do #6952 é apagado",
    );

    // Passo 5 — o outro escritor grava o grant e solta o lock.
    const withGrant = { ...midFlight, merge_grant: GRANT };
    const tmp = `${recordPath}.tmp-other`;
    writeFileSync(tmp, JSON.stringify(withGrant), "utf8");
    renameSync(tmp, recordPath);
    unlinkSync(lockPath);

    // Passo 6 — o beacon acorda, relê o estado FRESCO (com grant) e escreve.
    const status: number = await new Promise((r) => child.on("close", (c) => r(c ?? 0)));
    assert.equal(status, 0, "o beacon nunca deve falhar a chamada de ferramenta");

    const after = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.deepEqual(
      after.merge_grant,
      GRANT,
      "o merge_grant foi apagado pelo beacon — lost update do #6952",
    );
    // Sem isto o teste passaria trivialmente por o beacon não ter escrito nada.
    assert.ok(
      (after.touched_paths ?? []).includes("b.ts"),
      "o beacon precisa ter feito o trabalho dele depois de esperar, não desistido",
    );
  });

  it("com o lock retido, uma claim gravada por outro escritor sobrevive (#6952)", async () => {
    const { root, hookPath, sessionsDir } = makeRoot();
    const sessionId = "sess-6952-claim";

    runHookSync(hookPath, {
      session_id: sessionId,
      tool_name: "Edit",
      tool_input: { file_path: join(root, "a.ts") },
    });
    const recordPath = join(sessionsDir, readdirSync(sessionsDir)[0]!);
    const lockPath = `${recordPath}.lock`;
    acquire(lockPath);

    const child = spawn(process.execPath, [hookPath], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(
      JSON.stringify({
        session_id: sessionId,
        tool_name: "Edit",
        tool_input: { file_path: join(root, "b.ts") },
      }),
    );

    await new Promise((r) => setTimeout(r, 300));
    const midFlight = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.ok(
      !(midFlight.touched_paths ?? []).includes("b.ts"),
      "o beacon escreveu com o lock retido — mesma classe do #6952",
    );

    const claimed = {
      ...midFlight,
      claimed_issues: [6952],
      claimed_issues_at: { "6952": "2026-09-01T12:00:00.000Z" },
    };
    const tmp = `${recordPath}.tmp-other`;
    writeFileSync(tmp, JSON.stringify(claimed), "utf8");
    renameSync(tmp, recordPath);
    unlinkSync(lockPath);

    await new Promise((r) => child.on("close", r));

    const after = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.deepEqual(after.claimed_issues, [6952], "a claim foi apagada pelo beacon");
    assert.deepEqual(after.claimed_issues_at, { "6952": "2026-09-01T12:00:00.000Z" });
    assert.ok((after.touched_paths ?? []).includes("b.ts"), "o beacon precisa ter escrito");
  });

  it("o beacon não deixa a lock file pra trás (senão trava todo escritor seguinte)", () => {
    const { root, hookPath, sessionsDir } = makeRoot();
    runHookSync(hookPath, {
      session_id: "sess-6952-lock",
      tool_name: "Edit",
      tool_input: { file_path: join(root, "a.ts") },
    });
    const leftovers = readdirSync(sessionsDir).filter((f) => f.endsWith(".lock"));
    assert.deepEqual(
      leftovers,
      [],
      "lock vazada: o próximo escritor (beacon OU session-registry) ficaria bloqueado até o timeout",
    );
  });
});
