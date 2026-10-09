/**
 * test/regen-home-watchdog-9974.test.ts (#9974)
 *
 * Regressão: o `schedule` de `regen-home.yml` chegou 5-9h atrasado e a home
 * ficou sem a edição do dia até alguém disparar o workflow à mão. O watchdog
 * (`scripts/lib/regen-home-watchdog.ts`) precisa:
 *   - não fazer nada em dia sem edição nem quando a home já lista o slug;
 *   - disparar `gh workflow run regen-home.yml` quando a home não lista o
 *     slug e não há run ativo hoje (o cenário real de 09/10/2026);
 *   - NÃO disparar de novo se já houver run ativo criado hoje (idempotência);
 *   - alarmar (`atrasada`) se o prazo de 07:00 BRT passar sem a home mudar;
 *   - devolver `cannot-verify` (sem disparo, sem alarme) quando o site não
 *     responde.
 * `gh` é sempre mockado — nada aqui dispara workflow real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  expectedSlugsForDay,
  findActiveRunToday,
  homeListsSlug,
  runRegenHomeWatchdog,
  HOME_URL,
  SITEMAP_URL,
  type GhResult,
  type WatchdogDeps,
  type WorkflowRun,
} from "../scripts/lib/regen-home-watchdog.ts";
import { dryRunGh } from "../scripts/check-regen-home.ts";
import { getScheduledTaskByName, SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://diar.ia.br/</loc></url>
<url><loc>https://diar.ia.br/p/edicao-de-ontem</loc><lastmod>2026-10-08</lastmod></url>
<url><loc>https://diar.ia.br/p/edicao-de-hoje</loc><lastmod>2026-10-09</lastmod></url>
</urlset>`;

const HOME_OLD = `<a href="https://diar.ia.br/p/edicao-de-ontem">ontem</a>`;
const HOME_NEW = `<a href="https://diar.ia.br/p/edicao-de-hoje">hoje</a>${HOME_OLD}`;

/** 09/10/2026 06:20 BRT = 09:20 UTC. */
const T0 = Date.parse("2026-10-09T09:20:00Z");

interface Harness {
  deps: WatchdogDeps;
  ghCalls: string[][];
  sleeps: number;
}

function harness(opts: {
  homes: string[]; // home servida a cada leitura (a última se repete)
  runs?: WorkflowRun[];
  sitemap?: string | Error;
  homeError?: boolean;
  dispatchFails?: boolean;
  start?: number;
}): Harness {
  let clock = opts.start ?? T0;
  let homeReads = 0;
  const ghCalls: string[][] = [];
  const h: Harness = {
    ghCalls,
    sleeps: 0,
    deps: {
      now: () => new Date(clock),
      sleep: async (ms) => {
        h.sleeps++;
        clock += ms;
      },
      log: () => {},
      fetchText: async (url) => {
        if (url === SITEMAP_URL) {
          if (opts.sitemap instanceof Error) throw opts.sitemap;
          return opts.sitemap ?? SITEMAP;
        }
        assert.equal(url, HOME_URL);
        if (opts.homeError) throw new Error("fetch failed");
        const html = opts.homes[Math.min(homeReads, opts.homes.length - 1)];
        homeReads++;
        return html;
      },
      gh: async (args): Promise<GhResult> => {
        ghCalls.push(args);
        if (args[0] === "run" && args[1] === "list") {
          return { code: 0, stdout: JSON.stringify(opts.runs ?? []), stderr: "" };
        }
        if (args[0] === "workflow" && args[1] === "run") {
          return opts.dispatchFails
            ? { code: 1, stdout: "", stderr: "HTTP 403" }
            : { code: 0, stdout: "", stderr: "" };
        }
        throw new Error(`gh inesperado: ${args.join(" ")}`);
      },
    },
  };
  return h;
}

const dispatches = (calls: string[][]) => calls.filter((a) => a[0] === "workflow" && a[1] === "run");

describe("#9974 — helpers puros", () => {
  it("expectedSlugsForDay pega só a entrada com lastmod == hoje", () => {
    assert.deepEqual(expectedSlugsForDay(SITEMAP, "2026-10-09"), ["edicao-de-hoje"]);
    assert.deepEqual(expectedSlugsForDay(SITEMAP, "2026-10-10"), []);
  });

  it("homeListsSlug exige delimitador (prefixo de outro slug não conta)", () => {
    assert.equal(homeListsSlug(HOME_NEW, "edicao-de-hoje"), true);
    assert.equal(homeListsSlug(HOME_OLD, "edicao-de-hoje"), false);
    assert.equal(homeListsSlug(`<a href="/p/edicao-de-hoje-2">`, "edicao-de-hoje"), false);
    assert.equal(homeListsSlug(`<a href="/p/edicao-de-hoje/">`, "edicao-de-hoje"), true);
  });

  it("findActiveRunToday ignora run concluído e run ativo de outro dia (BRT)", () => {
    const runs: WorkflowRun[] = [
      { status: "completed", conclusion: "success", createdAt: "2026-10-09T09:13:00Z" },
      // 08/10 23:30 BRT — outro dia civil em BRT, apesar de ser 09/10 em UTC.
      { status: "queued", createdAt: "2026-10-09T02:30:00Z" },
    ];
    assert.equal(findActiveRunToday(runs, "2026-10-09"), null);
    const active = { status: "in_progress", createdAt: "2026-10-09T09:15:00Z", databaseId: 7 };
    assert.equal(findActiveRunToday([...runs, active], "2026-10-09"), active);
  });
});

describe("#9974 — runRegenHomeWatchdog com gh mockado", () => {
  it("dia sem edição: não lê runs nem dispara", async () => {
    const h = harness({ homes: [HOME_OLD], start: Date.parse("2026-10-10T09:20:00Z") });
    const out = await runRegenHomeWatchdog(h.deps);
    assert.equal(out.status, "sem-edicao");
    assert.deepEqual(h.ghCalls, []);
  });

  it("home já lista a edição (schedule pontual): ok sem disparo", async () => {
    const h = harness({ homes: [HOME_NEW] });
    const out = await runRegenHomeWatchdog(h.deps);
    assert.deepEqual(out, { status: "ok", todayBrt: "2026-10-09", slug: "edicao-de-hoje", dispatched: false });
    assert.deepEqual(h.ghCalls, []);
  });

  it("cenário real de 09/10: schedule não rodou → dispara 1 vez e espera a home atualizar", async () => {
    const h = harness({
      homes: [HOME_OLD, HOME_OLD, HOME_NEW],
      runs: [{ status: "completed", conclusion: "success", createdAt: "2026-10-08T16:24:00Z", event: "schedule" }],
    });
    const out = await runRegenHomeWatchdog(h.deps);
    assert.equal(out.status, "ok");
    assert.equal(out.status === "ok" && out.dispatched, true);
    assert.deepEqual(dispatches(h.ghCalls), [["workflow", "run", "regen-home.yml", "--ref", "master"]]);
  });

  it("idempotente: run ativo criado hoje → não dispara outro", async () => {
    const h = harness({
      homes: [HOME_OLD, HOME_NEW],
      runs: [{ status: "in_progress", createdAt: "2026-10-09T09:18:00Z", databaseId: 1 }],
    });
    const out = await runRegenHomeWatchdog(h.deps);
    assert.equal(out.status, "ok");
    assert.equal(dispatches(h.ghCalls).length, 0);
  });

  it("home não muda até 07:00 BRT → atrasada (alarme), com disparo registrado", async () => {
    const h = harness({ homes: [HOME_OLD] });
    const out = await runRegenHomeWatchdog(h.deps);
    assert.equal(out.status, "atrasada");
    assert.equal(out.status === "atrasada" && out.dispatched, true);
    assert.equal(dispatches(h.ghCalls).length, 1, "nunca redispara durante a espera");
    // 06:20 → 07:00 = 40 min em passos de 2 min.
    assert.equal(h.sleeps, 20);
  });

  it("rodado depois do prazo (manual tardio) ainda espera a janela mínima antes de alarmar", async () => {
    const h = harness({ homes: [HOME_OLD], start: Date.parse("2026-10-09T12:19:00Z") });
    const out = await runRegenHomeWatchdog(h.deps);
    assert.equal(out.status, "atrasada");
    assert.equal(h.sleeps, 10);
  });

  it("gh workflow run falhando → atrasada imediata com o erro, sem esperar", async () => {
    const h = harness({ homes: [HOME_OLD], dispatchFails: true });
    const out = await runRegenHomeWatchdog(h.deps);
    assert.equal(out.status, "atrasada");
    assert.match(out.status === "atrasada" ? out.detail : "", /HTTP 403/);
    assert.equal(h.sleeps, 0);
  });

  it("site fora do ar → cannot-verify, sem disparo nem alarme", async () => {
    const h1 = harness({ homes: [HOME_OLD], sitemap: new Error("ECONNRESET") });
    assert.equal((await runRegenHomeWatchdog(h1.deps)).status, "cannot-verify");
    const h2 = harness({ homes: [HOME_OLD], homeError: true });
    assert.equal((await runRegenHomeWatchdog(h2.deps)).status, "cannot-verify");
    assert.deepEqual([...h1.ghCalls, ...h2.ghCalls], []);
  });

  it("--dry-run nunca chega a disparar o workflow", async () => {
    const h = harness({ homes: [HOME_OLD, HOME_NEW] });
    const out = await runRegenHomeWatchdog({ ...h.deps, gh: dryRunGh(h.deps.gh, () => {}) });
    assert.equal(out.status, "ok");
    assert.equal(dispatches(h.ghCalls).length, 0);
  });
});

describe("#9974 — Diaria-Regen-Home-Watchdog no registro", () => {
  it("diária 06:20 BRT, depois do cron de 06:12 e antes do prazo de 07:00", () => {
    const t = getScheduledTaskByName("Diaria-Regen-Home-Watchdog");
    assert.ok(t);
    assert.deepEqual(t!.steps.map((s) => s.script), ["scripts/check-regen-home.ts"]);
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 6, minute: 20 });
    assert.equal(t!.issue, "#9974");
  });

  it("06:20 não colide com outra daily", () => {
    const collisions = SCHEDULED_TASKS.filter(
      (t) =>
        t.name !== "Diaria-Regen-Home-Watchdog" &&
        t.schedule.kind === "daily" &&
        t.schedule.hour === 6 &&
        t.schedule.minute === 20,
    );
    assert.deepEqual(collisions, []);
  });
});
