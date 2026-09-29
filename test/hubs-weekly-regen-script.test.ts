/**
 * test/hubs-weekly-regen-script.test.ts (#8948, #8949, #9019)
 *
 * Cobre as partes de I/O de `scripts/hubs-weekly-regen.ts` que não exigem
 * `data/beehiiv-cache/` real nem `gh`/rede reais (guard de #573/CLAUDE.md —
 * mesmo padrão de `test/hub-staleness-check-script.test.ts`):
 *
 *   - #8948: `HUBS_GIT_ADD_PATHS` inclui os dois diretórios que o passo de
 *     build reescreve (`scripts/lib/hubs/` + `workers/arquivo/src/hubs/`) —
 *     sem o segundo, o job "Hub page drift" nunca vê os `.generated.ts`
 *     commitados batendo com o dataset novo.
 *   - #8949 item 2: (comportamento coberto indiretamente — ver nota no
 *     próprio `hubs-weekly-regen.ts`; a ordem de `saveProseReviewState`
 *     agora vem depois do early-return de `--dry-run`).
 *   - #8949 item 3: `loadProseReviewState` com JSON corrompido emite aviso
 *     (via callback injetável) antes de resetar pra vazio, e nunca lança.
 *   - #8949 item 4: `createWorktree` faz `git fetch origin master` antes do
 *     `git worktree add`, e o worktree nasce de `origin/master` (nunca do
 *     `master` local sem fetch).
 *   - #9019: `planAllHubs` planeja contra o `hubsDir` passado explicitamente
 *     (o `workRoot` criado a partir de `origin/master`), não contra o
 *     `HUBS_DIR` da checkout compartilhada — que pode estar defasado.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  HUBS_GIT_ADD_PATHS,
  loadProseReviewState,
  saveProseReviewState,
  createWorktree,
  planAllHubs,
} from "../scripts/hubs-weekly-regen.ts";
import type { ProseReviewState } from "../scripts/lib/hubs-weekly-regen.ts";
import type { HubSourceEntry } from "../scripts/generate-hub-sources.ts";
import type { RawCachedPost } from "../scripts/generate-arquivo-titles.ts";

describe("HUBS_GIT_ADD_PATHS (#8948)", () => {
  it("inclui scripts/lib/hubs/ e workers/arquivo/src/hubs/ — os dois diretórios que build-hub-page.ts --all reescreve", () => {
    assert.deepEqual([...HUBS_GIT_ADD_PATHS], ["scripts/lib/hubs/", "workers/arquivo/src/hubs/"]);
  });
});

describe("loadProseReviewState / saveProseReviewState (#8949 item 3, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hubs-weekly-regen-prose-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio, sem avisar (fail-soft normal, não é corrupção)", () => {
    const warnings: string[] = [];
    const state = loadProseReviewState(resolve(tmpDir, "nao-existe.json"), (m) => warnings.push(m));
    assert.deepEqual(state, {});
    assert.deepEqual(warnings, []);
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state: ProseReviewState = { "anthropic-claude": { proseReviewedDate: "2026-09-01" } };
    saveProseReviewState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadProseReviewState(path), state);
  });

  it("JSON corrompido -> avisa via callback e reseta para vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    const warnings: string[] = [];
    const state = loadProseReviewState(path, (m) => warnings.push(m));
    assert.deepEqual(state, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /corrompido/);
    assert.match(warnings[0], new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("createWorktree (#8949 item 4)", () => {
  const branches: string[] = [];
  afterEach(() => {
    for (const b of branches.splice(0)) {
      const workRoot = join(tmpdir(), `diaria-hubs-weekly-regen-${b.replace(/\//g, "-")}`);
      if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("faz fetch de origin/master ANTES do worktree add, e o worktree nasce de origin/master (não master local)", () => {
    const branch = `hubs/weekly-regen-test-${Date.now()}`;
    branches.push(branch);
    const calls: { cmd: string; args: string[] }[] = [];
    const fakeGitRun = (cmd: string, args: string[]): string => {
      calls.push({ cmd, args });
      if (args[0] === "worktree" && args[1] === "add") {
        // args: ["worktree", "add", "-b", branch, workRoot, "origin/master"]
        const workRoot = args[4];
        mkdirSync(workRoot, { recursive: true });
      }
      return "";
    };
    createWorktree(branch, fakeGitRun);

    const fetchCallIdx = calls.findIndex((c) => c.args[0] === "fetch");
    const worktreeAddIdx = calls.findIndex((c) => c.args[0] === "worktree" && c.args[1] === "add");
    assert.notEqual(fetchCallIdx, -1, "esperava uma chamada git fetch");
    assert.notEqual(worktreeAddIdx, -1, "esperava uma chamada git worktree add");
    assert.ok(fetchCallIdx < worktreeAddIdx, "fetch precisa vir ANTES do worktree add");
    assert.deepEqual(calls[fetchCallIdx].args, ["fetch", "origin", "master"]);
    // Último arg do worktree add é o start-point — precisa ser origin/master, nunca "master".
    const worktreeAddArgs = calls[worktreeAddIdx].args;
    assert.equal(worktreeAddArgs[worktreeAddArgs.length - 1], "origin/master");
  });
});

describe("planAllHubs lê existing/currentUpdatedDate do hubsDir passado (#9019)", () => {
  const SLUG = "test-hub-9019-regression";
  let staleDir: string; // simula ROOT (checkout compartilhado) defasado vs origin/master
  let freshDir: string; // simula workRoot, criado a partir de origin/master

  // `SLUG` não existe em `HUB_KEYWORD_PATTERNS` (é um slug de teste) — por
  // isso o pattern precisa ser injetado explicitamente via o 5º parâmetro
  // de `planAllHubs` (#9019, review PR #9047 finding 4: nenhum fallback
  // silencioso "casa tudo" pra slug sem pattern registrado). Regex vazia
  // casa qualquer título.
  const TEST_PATTERNS: Record<string, RegExp> = { [SLUG]: /(?:)/ };

  // Post datado bem antes de "today" pra forçar `candidate = coverageDate`
  // em `planHubRegen` (gapDays estoura o teto) — só assim o `max()` contra
  // um `currentUpdatedDate` desatualizado regride de verdade, em vez de o
  // `candidate` (hoje) mascarar a diferença.
  const POST: RawCachedPost = {
    slug: "260115",
    title: "Edição de teste #9019",
    status: "confirmed",
    publish_date: Math.floor(Date.parse("2026-01-15T12:00:00-03:00") / 1000),
  };
  const TODAY = "2026-09-29";

  const MANUAL_ENTRY: HubSourceEntry = {
    date: "2026-06-01",
    editionSlug: "260601",
    url: "https://diar.ia.br/p/260601",
    matchedHeadlines: ["entrada curada manualmente"],
    manual: true,
  };

  function writeHub(dir: string, updatedDate: string, existing: HubSourceEntry[]): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${SLUG}.ts`), `const UPDATED_DATE = "${updatedDate}";\n`, "utf8");
    writeFileSync(resolve(dir, `${SLUG}-sources.generated.json`), JSON.stringify(existing), "utf8");
  }

  beforeEach(() => {
    staleDir = mkdtempSync(join(tmpdir(), "hubs-weekly-regen-stale-"));
    freshDir = mkdtempSync(join(tmpdir(), "hubs-weekly-regen-fresh-"));
    // ROOT defasado: nunca viu a entrada manual nem o UPDATED_DATE que uma
    // revisão de prosa já mergeou em master.
    writeHub(staleDir, "2026-01-01", []);
    // origin/master (o que o worktree real veria): já tem os dois.
    writeHub(freshDir, "2026-09-20", [MANUAL_ENTRY]);
  });

  afterEach(() => {
    rmSync(staleDir, { recursive: true, force: true });
    rmSync(freshDir, { recursive: true, force: true });
  });

  it("planejar contra o workRoot (fresh) preserva a entrada manual e não regride UPDATED_DATE", () => {
    const { hubPlans } = planAllHubs(TODAY, freshDir, [POST], [SLUG], TEST_PATTERNS);
    const { rows, plan } = hubPlans[0];

    assert.ok(
      rows.some((r) => r.editionSlug === MANUAL_ENTRY.editionSlug && r.manual === true),
      "entrada manual só presente no dataset FRESCO precisa sobreviver ao merge",
    );
    assert.equal(plan.hasDataChange, true);
    // max(candidate="2026-01-15", currentUpdatedDate="2026-09-20") — a data
    // mais nova (da revisão de prosa em master) NUNCA regride.
    assert.equal(plan.newUpdatedDate, "2026-09-20");
  });

  it("[documentação do bug] planejar contra o checkout defasado perderia a entrada manual e regrediria UPDATED_DATE", () => {
    const { hubPlans } = planAllHubs(TODAY, staleDir, [POST], [SLUG], TEST_PATTERNS);
    const { rows, plan } = hubPlans[0];

    assert.equal(
      rows.some((r) => r.editionSlug === MANUAL_ENTRY.editionSlug),
      false,
      "sem a entrada no `existing` do checkout defasado, mergeManualHubSources não tem o que reinjetar",
    );
    // max(candidate="2026-01-15", currentUpdatedDate="2026-01-01") = "2026-01-15"
    // — menor que os "2026-09-20" que já estavam escritos em origin/master,
    // uma regressão real se isto fosse escrito por cima do workRoot (#9019).
    assert.equal(plan.newUpdatedDate, "2026-01-15");
  });

  it("slug sem pattern registrado lança (nunca casa tudo em silêncio, review PR #9047 finding 4)", () => {
    assert.throws(
      () => planAllHubs(TODAY, freshDir, [POST], [SLUG], {}),
      /nenhum pattern registrado para o slug/,
    );
  });

  it("hubsDir é obrigatório — sem 2º argumento não compila (review PR #9047 finding 3)", () => {
    // @ts-expect-error hubsDir não tem default — um default de volta pra
    // HUBS_DIR reintroduziria o bug #9019 em silêncio num call site futuro.
    assert.throws(() => planAllHubs(TODAY));
  });
});
