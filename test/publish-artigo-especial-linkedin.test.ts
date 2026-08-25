import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { DispatchContext } from "../scripts/publish-linkedin.ts";
import {
  deriveChannelStatusFromPostEntry,
  parseCliArgs,
  parseAnoSlugFromDir,
  resolveImageUrl,
  runArtigoEspecialLinkedinDispatch,
  dispatchDestaqueFor,
  assertDispatchDestaquesValid,
  channelForStoredDestaque,
  WORKER_DESTAQUE_RE,
} from "../scripts/publish-artigo-especial-linkedin.ts";
import {
  artigoEspecialStatePath,
  readArtigoEspecialState,
  writeArtigoEspecialState,
  buildDoneChannelState,
  withChannelState,
  type ArtigoEspecialState,
} from "../scripts/lib/artigo-especial-state.ts";
import { readSocialPublished } from "../scripts/lib/social-published-store.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

describe("deriveChannelStatusFromPostEntry (#5979)", () => {
  it("status draft -> done", () => {
    assert.equal(deriveChannelStatusFromPostEntry({ platform: "linkedin", destaque: "pagina", url: null, status: "draft", scheduled_at: null }), "done");
  });
  it("status scheduled -> done", () => {
    assert.equal(deriveChannelStatusFromPostEntry({ platform: "linkedin", destaque: "pagina", url: null, status: "scheduled", scheduled_at: "x" }), "done");
  });
  it("status failed -> failed", () => {
    assert.equal(deriveChannelStatusFromPostEntry({ platform: "linkedin", destaque: "perfil", url: null, status: "failed", scheduled_at: null }), "failed");
  });
});

describe("parseAnoSlugFromDir (#5979)", () => {
  it("extrai ano e slug simples", () => {
    assert.deepEqual(parseAnoSlugFromDir("2026-o-agente"), { ano: "2026", slug: "o-agente" });
  });
  it("slug com multiplos hifens preservado inteiro", () => {
    assert.deepEqual(parseAnoSlugFromDir("2026-engenharia-de-ilusao"), { ano: "2026", slug: "engenharia-de-ilusao" });
  });
  it("sem padrao {ano}-{slug} -> null", () => {
    assert.equal(parseAnoSlugFromDir("qualquer-coisa"), null);
    assert.equal(parseAnoSlugFromDir("26-slug"), null); // ano precisa ter 4 digitos
  });
});

describe("parseCliArgs (#5979)", () => {
  it("--dir obrigatorio", () => {
    const r = parseCliArgs([]);
    assert.ok("error" in r);
  });
  it("only default = [pagina, perfil]", () => {
    const r = parseCliArgs(["--dir", "data/artigo-especial/2026-x"]);
    assert.ok(!("error" in r));
    if (!("error" in r)) assert.deepEqual(r.only, ["pagina", "perfil"]);
  });
  it("--only com token invalido misturado a um valido -> erro EXPLICITO (nao filtra em silencio, #5979 review PR #6000)", () => {
    // Corrige comportamento anterior: um typo tipo "perfiil" nao pode
    // silenciosamente virar so ["pagina"] — o operador precisa saber que
    // metade do --only foi ignorada (achado do silent-failure-hunter).
    const r = parseCliArgs(["--dir", "d", "--only", "pagina,bogus"]);
    assert.ok("error" in r);
    if ("error" in r) assert.match(r.error, /bogus/);
  });
  it("--only todo invalido -> erro", () => {
    const r = parseCliArgs(["--dir", "d", "--only", "bogus"]);
    assert.ok("error" in r);
  });
  it("--only valido (2 tokens) passa direto", () => {
    const r = parseCliArgs(["--dir", "d", "--only", "pagina,perfil"]);
    assert.ok(!("error" in r));
    if (!("error" in r)) assert.deepEqual(r.only, ["pagina", "perfil"]);
  });
  it("--force e --dry-run viram flags", () => {
    const r = parseCliArgs(["--dir", "d", "--force", "--dry-run"]);
    assert.ok(!("error" in r));
    if (!("error" in r)) {
      assert.equal(r.force, true);
      assert.equal(r.dryRun, true);
    }
  });
});

describe("resolveImageUrl (#5979)", () => {
  it("override explicito tem precedencia", () => {
    const url = resolveImageUrl("/nao-existe", "2026", "x", "https://override/img.jpg");
    assert.equal(url, "https://override/img.jpg");
  });
  it("artigo real do repo: le og:image do index.html publicado", () => {
    const rootDir = join(import.meta.dirname, "..");
    const url = resolveImageUrl(rootDir, "2026", "engenharia-de-ilusao");
    assert.equal(url, "https://especial.diar.ia.br/2026/engenharia-de-ilusao/capa.jpg");
  });
  it("artigo inexistente -> null (sem lancar)", () => {
    const rootDir = join(import.meta.dirname, "..");
    assert.equal(resolveImageUrl(rootDir, "2026", "nao-existe-mesmo"), null);
  });
});

describe("runArtigoEspecialLinkedinDispatch (#5979)", () => {
  let dir: string;
  let artigoDir: string;
  let dataDir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "artigo-especial-linkedin-"));
    artigoDir = join(dir, "artigo");
    dataDir = join(dir, "data");
    mkdirSync(artigoDir, { recursive: true });
    writeFileSync(join(artigoDir, "linkedin-pagina.md"), "Texto da pagina.");
    writeFileSync(join(artigoDir, "linkedin-perfil.md"), "Texto do perfil.");
    statePath = artigoEspecialStatePath(dataDir, "2026", "x");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function mkCtx(): DispatchContext {
    return {
      publishedPath: join(artigoDir, "linkedin-published.json"),
      webhookUrl: "https://hook.test/diaria",
      workerUrl: "https://worker.test",
      workerToken: "test-tok",
      useWorkerForScheduled: true,
      editionDate: "2026-x",
      rootDir: dir,
    };
  }

  it("#6014 item 1: scheduledAtPerfil — perfil usa horario proprio, pagina usa scheduledAt (regressao)", async () => {
    const savedFetch = globalThis.fetch;
    const bodies: Array<{ destaque?: string; scheduled_at?: string }> = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      // so captura os POSTs de dispatch (verify /list+/dlq vem depois, sem destaque)
      if (body.destaque) bodies.push(body);
      // futuro -> route=worker_queue; o mock responde no formato da fila
      return new Response(
        JSON.stringify({ queued: true, key: `k-${bodies.length}`, scheduled_at: body.scheduled_at, destaque: body.destaque }),
        {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const { results, failedCount } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2099-01-01T09:00:00-03:00",
        scheduledAtPerfil: "2099-01-02T09:30:00-03:00",
        only: ["pagina", "perfil"],
        force: false,
        dryRun: false,
        ctx: mkCtx(),
        statePath,
      });
      assert.equal(failedCount, 0);
      assert.equal(results.length, 2);
      assert.deepEqual(
        bodies.map((b) => [b.destaque, b.scheduled_at]),
        [
          ["especial-pagina", "2099-01-01T09:00:00-03:00"],
          ["especial-perfil", "2099-01-02T09:30:00-03:00"],
        ],
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("--dry-run: nao chama dispatchEntry (rede), nao grava state, retorna 2 entries null", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("fetch NAO deveria ser chamado em --dry-run");
    };
    try {
      const { results, failedCount } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2026-09-02T17:30:00-03:00",
        only: ["pagina", "perfil"],
        force: false,
        dryRun: true,
        ctx: mkCtx(),
        statePath,
      });
      assert.equal(failedCount, 0);
      assert.equal(results.length, 2);
      assert.ok(results.every((r) => r.entry === null && !r.skipped));
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("dispatch real (mockado): 2 sucessos via make_now, state e linkedin-published.json gravados", async () => {
    const savedFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ accepted: true, request_id: `req-${calls}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const ctx = { ...mkCtx(), useWorkerForScheduled: false }; // sem worker -> make_now (scheduledAt passado no futuro nao importa aqui pois useWorkerForScheduled=false força make_now)
      const { results, failedCount } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: "https://especial.diar.ia.br/2026/x/capa.jpg",
        scheduledAt: "2026-09-02T17:30:00-03:00",
        only: ["pagina"], // perfil (pixel) sem worker lançaria — testado à parte
        force: false,
        dryRun: false,
        ctx,
        statePath,
      });
      assert.equal(failedCount, 0);
      assert.equal(results.length, 1);
      assert.equal(results[0].entry?.status, "draft");
      assert.equal(calls, 1);

      // REGRESSÃO do incidente 23/08/2026 — fecha o loop até o CALL SITE.
      // Os testes de `dispatchDestaqueFor`/`assertDispatchDestaquesValid` mais
      // abaixo verificam essas funções ISOLADAMENTE: se alguém reverter a
      // linha `destaque:` do call site pra `target` cru (o bug original)
      // deixando aquelas funções intactas, nenhum deles falha — o guard
      // recalcula o valor por conta própria e nunca inspeciona o payload real.
      // Esta asserção olha o `destaque` que de fato saiu no `PostEntry`, que é
      // o mesmo que foi ao Worker, e por isso é a única aqui que pegaria a
      // reintrodução do bug que publicou um post fora de hora em produção.
      assert.equal(results[0].entry?.destaque, dispatchDestaqueFor("pagina"));

      const state = readArtigoEspecialState(statePath, "2026", "x");
      assert.equal(state.channels.linkedin_pagina?.status, "done");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("canal linkedin_pagina ja done sem --force: pula sem chamar dispatchEntry", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("fetch NAO deveria ser chamado — canal ja done");
    };
    try {
      let state: ArtigoEspecialState = { ano: "2026", slug: "x", channels: {} };
      state = withChannelState(state, "linkedin_pagina", buildDoneChannelState("2026-08-01T00:00:00Z", null));
      writeArtigoEspecialState(statePath, state);

      const { results } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2026-09-02T17:30:00-03:00",
        only: ["pagina"],
        force: false,
        dryRun: false,
        ctx: mkCtx(),
        statePath,
      });
      assert.equal(results[0].skipped, true);
      assert.equal(results[0].entry, null);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("--force reexecuta canal ja done", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ accepted: true, request_id: "r" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      let state: ArtigoEspecialState = { ano: "2026", slug: "x", channels: {} };
      state = withChannelState(state, "linkedin_pagina", buildDoneChannelState("2026-08-01T00:00:00Z", null));
      writeArtigoEspecialState(statePath, state);

      const ctx = { ...mkCtx(), useWorkerForScheduled: false };
      const { results } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2026-09-02T17:30:00-03:00",
        only: ["pagina"],
        force: true,
        dryRun: false,
        ctx,
        statePath,
      });
      assert.equal(results[0].skipped, false);
      assert.equal(results[0].entry?.status, "draft");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("dispatch pixel sem Worker configurado -> entry status=failed, state grava failed (falha por canal, nao lanca)", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("fetch nao deveria ser chamado — pixel sem worker falha antes de chamar rede");
    };
    try {
      const ctx = { ...mkCtx(), useWorkerForScheduled: false, workerUrl: "", workerToken: "" };
      const { results, failedCount } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2026-09-02T17:30:00-03:00",
        only: ["perfil"],
        force: false,
        dryRun: false,
        ctx,
        statePath,
      });
      assert.equal(failedCount, 1);
      assert.equal(results[0].entry?.status, "failed");

      const state = readArtigoEspecialState(statePath, "2026", "x");
      assert.equal(state.channels.linkedin_perfil?.status, "failed");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("verifyWorker injetavel e chamado quando ha entry 'scheduled'", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ queued: true, key: "k1", scheduled_at: "2026-09-02T17:30:00-03:00", destaque: "pagina" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      let verifyCalled = false;
      const { results } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2099-01-01T17:30:00-03:00", // bem no futuro -> route=worker_queue
        only: ["pagina"],
        force: false,
        dryRun: false,
        ctx: mkCtx(),
        statePath,
        verifyWorker: async (published) => {
          verifyCalled = true;
          return { updated: published, changes: 0 };
        },
      });
      assert.equal(results[0].entry?.status, "scheduled");
      assert.equal(verifyCalled, true);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("verifyWorker com changes>0: persiste linkedin-published.json reconciliado E propaga failed pro published.json + resultado (#5979 review, PR #6000)", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ queued: true, key: "k1", scheduled_at: "2026-09-02T17:30:00-03:00", destaque: "pagina" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      const ctx = mkCtx();
      const { results, failedCount } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2099-01-01T17:30:00-03:00", // futuro -> route=worker_queue -> status "scheduled"
        only: ["pagina"],
        force: false,
        dryRun: false,
        ctx,
        statePath,
        verifyWorker: async (published) => {
          // Simula o Worker rejeitando o item (DLQ) apos dispatchEntry ja ter
          // reportado "scheduled".
          const updated = {
            // Casa pelo destaque COMO PERSISTIDO (`especial-pagina` desde este fix (#6016); antes era `weekly-pagina`,
            // incidente de 23/08/2026 — `dispatchEntry` grava o valor que foi
            // ao Worker). Derivado de `dispatchDestaqueFor` de propósito, pra
            // este mock não voltar a congelar uma string literal que o
            // contrato do Worker pode mudar de novo.
            posts: published.posts.map((p) =>
              p.destaque === dispatchDestaqueFor("pagina")
                ? { ...p, status: "failed" as const, failure_reason: "worker_dlq: teste" }
                : p,
            ),
          };
          return { updated, changes: 1 };
        },
      });

      // 1. linkedin-published.json foi REESCRITO com o resultado reconciliado.
      const persisted = readSocialPublished(ctx.publishedPath);
      assert.equal(persisted.posts[0].status, "failed");
      assert.equal(persisted.posts[0].failure_reason, "worker_dlq: teste");

      // 2. O RunDispatchResult reflete a falha pos-reconciliacao, nao o
      //    "scheduled" original de dispatchEntry.
      assert.equal(results[0].entry?.status, "failed");
      assert.equal(failedCount, 1);

      // 3. published.json (guard agregado) tambem foi corrigido pra "failed"
      //    — sem isso um resume nao teria como saber que precisa retentar.
      const state = readArtigoEspecialState(statePath, "2026", "x");
      assert.equal(state.channels.linkedin_pagina?.status, "failed");
      assert.match(state.channels.linkedin_pagina?.reason ?? "", /worker_dlq: teste/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("#6000 fleet review (achado convergente silent-failure-hunter + code-reviewer): reconciliação corrige o guard agregado de um canal FORA do --only desta invocação", async () => {
    // Simula uma run ANTERIOR que já dispatchou os 2 targets: 'perfil' ficou
    // 'done' em published.json (guard agregado) e tem uma entry 'scheduled'
    // em linkedin-published.json. Uma run B, com --only pagina, reconcilia e
    // o Worker mock descobre que 'perfil' (não presente em 'results' desta
    // run) na verdade caiu no DLQ nesse ínterim.
    const ctx = mkCtx();
    const perfilEntryAntigo: PostEntry = {
      platform: "linkedin",
      destaque: "perfil",
      url: null,
      status: "scheduled",
      scheduled_at: "2026-09-02T17:30:00-03:00",
    };
    writeFileSync(ctx.publishedPath, JSON.stringify({ posts: [perfilEntryAntigo] }, null, 2), "utf8");
    let state: ArtigoEspecialState = { ano: "2026", slug: "x", channels: {} };
    state = withChannelState(state, "linkedin_perfil", buildDoneChannelState(new Date().toISOString(), null));
    writeArtigoEspecialState(statePath, state);

    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ queued: true, key: "k1", scheduled_at: "2026-09-02T17:30:00-03:00", destaque: "pagina" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      const { results } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2099-01-01T17:30:00-03:00",
        only: ["pagina"], // 'perfil' NÃO faz parte desta invocação
        force: false,
        dryRun: false,
        ctx,
        statePath,
        verifyWorker: async (published) => {
          // Descobre que o 'perfil' de uma run anterior caiu no DLQ, além
          // do 'pagina' desta run já sair "scheduled".
          const updated = {
            posts: published.posts.map((p) =>
              p.destaque === "perfil" ? { ...p, status: "failed" as const, failure_reason: "worker_dlq: perfil de run anterior" } : p,
            ),
          };
          return { updated, changes: 1 };
        },
      });

      // 'results' só tem 'pagina' (o único target desta invocação) — não
      // deve lançar nem tentar indexar um 'perfil' inexistente ali.
      assert.equal(results.length, 1);
      assert.equal(results[0].target, "pagina");

      // O guard agregado (published.json) É corrigido pra 'perfil' mesmo
      // sem 'perfil' estar em 'results' desta run — este é o achado do
      // fleet review: antes, esse ramo não escrevia nada porque
      // `results.find(...)` não achava o target.
      const stateAfter = readArtigoEspecialState(statePath, "2026", "x");
      assert.equal(stateAfter.channels.linkedin_perfil?.status, "failed");
      assert.match(stateAfter.channels.linkedin_perfil?.reason ?? "", /worker_dlq: perfil de run anterior/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("verifyWorker com changes=0: nao reescreve linkedin-published.json nem published.json", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ queued: true, key: "k1", scheduled_at: "2026-09-02T17:30:00-03:00", destaque: "pagina" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      const ctx = mkCtx();
      const { results } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2099-01-01T17:30:00-03:00",
        only: ["pagina"],
        force: false,
        dryRun: false,
        ctx,
        statePath,
        verifyWorker: async (published) => ({ updated: published, changes: 0 }),
      });
      assert.equal(results[0].entry?.status, "scheduled");
      const state = readArtigoEspecialState(statePath, "2026", "x");
      assert.equal(state.channels.linkedin_pagina?.status, "done");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// #5979 self-review (pr-test-analyzer, PR #6000): a garantia mais importante
// deste script — "abortar os 2 dispatches, nunca so 1, quando o Worker nao
// suporta webhook_target=pixel" — vive inteiramente em main() (linhas 288-299),
// NAO em runArtigoEspecialLinkedinDispatch (que so implementa fail-soft POR
// canal). Os testes acima nunca exercitam main(), entao um refactor que
// movesse/removesse esse guard de main() passaria em silencio. Este bloco
// spawna o CLI de verdade (mesmo padrao de update-artigo-especial-box.test.ts)
// pra fechar essa lacuna.
describe("publish-artigo-especial-linkedin.ts CLI — fail-fast sem Worker (main(), #5979)", () => {
  let dir: string;
  let artigoDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "artigo-especial-linkedin-cli-"));
    artigoDir = join(dir, "2026-x");
    mkdirSync(artigoDir, { recursive: true });
    writeFileSync(join(artigoDir, "linkedin-pagina.md"), "Texto da pagina.");
    writeFileSync(join(artigoDir, "linkedin-perfil.md"), "Texto do perfil.");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runCli(extraEnv: Record<string, string>): ReturnType<typeof spawnSync> {
    const scriptPath = join(import.meta.dirname, "..", "scripts", "publish-artigo-especial-linkedin.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "--dir", artigoDir, "--at", "2099-01-01T17:30:00-03:00"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          // Explicito ("" != undefined) para vencer tanto o config real
          // (workerUrl usa `??`, so cai no config se o env for undefined —
          // "" ja resolve pra "") quanto qualquer valor herdado do .env real
          // desta maquina (dotenv override:false preserva o que ja esta
          // definido no env do processo filho).
          DIARIA_LINKEDIN_CRON_URL: "",
          DIARIA_LINKEDIN_CRON_TOKEN: "",
        },
      },
    );
  }

  it("sem Worker configurado: exit 2, stderr menciona abortar os 2 dispatches, nenhum arquivo gravado", () => {
    const result = runCli({});
    assert.equal(result.status, 2, result.stderr as string);
    assert.match(result.stderr as string, /Abortando os 2 dispatches/);
    // Nem published.json nem linkedin-published.json devem existir — o guard
    // aborta ANTES de runArtigoEspecialLinkedinDispatch rodar.
    assert.ok(!existsSyncSafe(join(artigoDir, "linkedin-published.json")));
  });
});

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Regressão do incidente de 23/08/2026 (1ª execução ao vivo da skill).
//
// O script mandava `destaque: "pagina"|"perfil"` pro Worker LinkedIn na
// premissa de que `DispatchInput.destaque: string` era livre. É livre no
// TIPO, mas o Worker valida em RUNTIME contra
// /^(d[123]|weekly(-[a-z]+)?)$/ e devolveu HTTP 400 pros 2 dispatches.
// Dano real: o dispatch da PÁGINA caiu no fallback Make, que publica NA HORA
// ignorando `scheduled_at` (post saiu ~23h em vez do horário agendado, teve
// de ser apagado à mão), e o do PERFIL falhou seco — exatamente a "metade do
// anúncio" que o fail-fast do topo do script existe pra evitar.
// ---------------------------------------------------------------------------
describe("destaque compatível com o contrato do Worker (incidente 23/08/2026)", () => {
  /**
   * IMPORTADO do script, não recopiado: manter uma 3ª transcrição do regex
   * aqui só criaria mais uma fonte pra divergir (achado do review da PR
   * #6007). O que este teste trava é o elo script↔Worker; a checagem
   * script↔teste seria tautológica de qualquer jeito.
   *
   * ATENÇÃO — o que continua NÃO coberto: se o Worker mudar o regex dele, as
   * cópias locais seguem consistentes entre si, os testes passam, e o HTTP
   * 400 só reaparece em produção. Fechar isso exigiria um drift-check contra
   * o Worker publicado (nos moldes do `robots.txt`), que não existe hoje.
   */
  const WORKER_RE = WORKER_DESTAQUE_RE;

  it("o destaque enviado ao Worker casa com o regex de validação dele", () => {
    for (const target of ["pagina", "perfil"] as const) {
      const enviado = dispatchDestaqueFor(target);
      assert.ok(
        WORKER_RE.test(enviado),
        `destaque "${enviado}" (target ${target}) seria rejeitado com HTTP 400 pelo Worker`,
      );
    }
  });

  it("o valor CRU do target seria rejeitado — é a regressão que causou o incidente", () => {
    for (const cru of ["pagina", "perfil"]) {
      assert.equal(WORKER_RE.test(cru), false, `"${cru}" não deve ser considerado válido pelo Worker`);
    }
  });

  it("assertDispatchDestaquesValid não lança para os targets suportados", () => {
    assert.doesNotThrow(() => assertDispatchDestaquesValid(["pagina", "perfil"]));
  });

  it("channelForStoredDestaque lê as DUAS grafias do store (nova e pré-incidente)", () => {
    // Grafia nova: dispatchEntry persiste o destaque que foi ao Worker.
    assert.equal(channelForStoredDestaque("especial-pagina"), "linkedin_pagina");
    assert.equal(channelForStoredDestaque("especial-perfil"), "linkedin_perfil");
    // Grafia do carrossel semanal segue lida (entries antigas no store).
    assert.equal(channelForStoredDestaque("weekly-pagina"), "linkedin_pagina");
    assert.equal(channelForStoredDestaque("weekly-perfil"), "linkedin_perfil");
    // Grafia antiga: entries gravadas antes do incidente seguem no arquivo.
    assert.equal(channelForStoredDestaque("pagina"), "linkedin_pagina");
    assert.equal(channelForStoredDestaque("perfil"), "linkedin_perfil");
    // Desconhecido não pode virar canal — a reconciliação precisa pular.
    assert.equal(channelForStoredDestaque("d1"), null);
    assert.equal(channelForStoredDestaque("weekly"), null);
  });
});
