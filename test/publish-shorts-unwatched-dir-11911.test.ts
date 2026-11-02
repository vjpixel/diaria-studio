/**
 * test/publish-shorts-unwatched-dir-11911.test.ts (#11911, último resíduo)
 *
 * Em 02/11/2026 o corte "Você ainda trata a IA como máquina?" foi rodado à mão
 * de `~/diaria-cortes/261102-tratar-ia-como-humano` (`--edition-dir` fora do
 * repo). O timer do corte (`Diaria-Shorts-Cortes`) e o vigia de cortes sem dono
 * (`corte-owner-watch.ts`) só leem `data/cortes/`, então o corte ficou
 * invisível para o alarme e o Reels sumiu sem aviso.
 *
 * O comando real de 02/11 rodou no modo EDIÇÃO (`--instagram-timer
 * --edition-dir ~/diaria-cortes/...`). Agora o `publish-shorts.ts` recusa,
 * pelo caminho REAL (symlink e `..` resolvidos), pasta fora de
 * `data/cortes/{slug}/` no modo corte e fora de `data/editions/{AAMMDD}/` no
 * modo edição, com o escape explícito `--allow-unwatched-dir`, que avisa que
 * nenhum alarme de destino faltante cobre a pasta.
 *
 * Sem rede: os spawns param na recusa da pasta ou no `02-reviewed.md`
 * ausente, antes de qualquer credencial, download ou publicação.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assignShortsDestinationOwners, checkEditionDir, nonCanonicalEditionDir, ownersContextAfterPublish, parseShortsCliArgs, planShortsPublish } from "../scripts/publish-shorts.ts";
import { CORTE_SPEC_FILE, checkCorteDir, corteBaseCommand, realpathLenient } from "../scripts/lib/diaria/short-corte.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "tratar-ia-como-humano";
/** Pasta canônica da edição: aninhada por mês (`editionDir`). */
const CANON = "/repo/data/editions/2611/261102";
const REVIEWED = "DESTAQUE 1 | X\n\n[Título do D1](https://example.com/a)\n\nCorpo do D1. Mais.\n\nPor que isso importa: x.\n";

/** Raiz falsa de repo com `data/cortes/` (o `data/` real é symlink pro OneDrive: aqui também). */
function fakeRepo(): { root: string; cortes: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "corte-outside-11911-")));
  const onedrive = join(root, "OneDrive", "diaria-data");
  mkdirSync(join(onedrive, "cortes"), { recursive: true });
  symlinkSync(onedrive, join(root, "repo-data-link"));
  mkdirSync(join(root, "repo"));
  symlinkSync(onedrive, join(root, "repo", "data"));
  return { root, cortes: join(root, "repo", "data", "cortes") };
}

describe("#11911 checkCorteDir: pasta do corte fora de data/cortes/ é recusada", () => {
  it("dentro de data/cortes/{slug} passa, mesmo com data/ symlink e a pasta ainda inexistente", () => {
    const { cortes } = fakeRepo();
    const r = checkCorteDir({ slug: SLUG, dir: join(cortes, SLUG), cortesRoot: cortes, allowUnwatched: false });
    assert.deepEqual(r, { ok: true, outside: false });
  });

  it("dentro por outro caminho (symlink, `..`) passa: a comparação é pelo caminho real", () => {
    const { root, cortes } = fakeRepo();
    // Pelo caminho real do OneDrive, sem passar pelo symlink data/ do repo.
    const viaLink = join(root, "repo-data-link", "cortes", SLUG);
    assert.deepEqual(checkCorteDir({ slug: SLUG, dir: viaLink, cortesRoot: cortes, allowUnwatched: false }), { ok: true, outside: false });
    const viaDotDot = join(cortes, "outro-corte", "..", SLUG);
    assert.deepEqual(checkCorteDir({ slug: SLUG, dir: viaDotDot, cortesRoot: cortes, allowUnwatched: false }), { ok: true, outside: false });
  });

  it("fora (o caso de 02/11, ~/diaria-cortes/...) recusa com mensagem acionável", () => {
    const { root, cortes } = fakeRepo();
    const fora = join(root, "diaria-cortes", `261102-${SLUG}`);
    mkdirSync(fora, { recursive: true });
    const r = checkCorteDir({ slug: SLUG, dir: fora, cortesRoot: cortes, allowUnwatched: false });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, new RegExp(`data/cortes/${SLUG}/`), "diz para onde mover/registrar");
    assert.match(r.error, /Diaria-Shorts-Cortes/);
    assert.match(r.error, /vigia de cortes sem dono/);
    assert.match(r.error, /--allow-unwatched-dir/, "oferece o escape");
  });

  it("fora disfarçado por `..` ou por symlink dentro de data/cortes/ recusa (caminho real, não texto)", () => {
    const { root, cortes } = fakeRepo();
    // Texto começa com data/cortes/, mas o `..` sai dela.
    const dotDot = join(cortes, "..", "..", "fora", SLUG);
    assert.equal(checkCorteDir({ slug: SLUG, dir: dotDot, cortesRoot: cortes, allowUnwatched: false }).ok, false);
    // Symlink em data/cortes/ apontando para fora: o texto bate com data/cortes/, o caminho real não.
    const foraReal = join(root, "fora-real");
    mkdirSync(foraReal);
    symlinkSync(foraReal, join(cortes, "atalho"));
    assert.equal(checkCorteDir({ slug: SLUG, dir: join(cortes, "atalho", SLUG), cortesRoot: cortes, allowUnwatched: false }).ok, false);
  });

  it("pasta de OUTRO corte em data/cortes/ recusa (o timer re-executa por data/cortes/{slug})", () => {
    const { cortes } = fakeRepo();
    assert.equal(checkCorteDir({ slug: SLUG, dir: join(cortes, "outro-corte"), cortesRoot: cortes, allowUnwatched: false }).ok, false);
  });

  it("fora com --allow-unwatched-dir passa com aviso de que nenhum alarme cobre o corte", () => {
    const { root, cortes } = fakeRepo();
    const fora = join(root, "diaria-cortes", `261102-${SLUG}`);
    const r = checkCorteDir({ slug: SLUG, dir: fora, cortesRoot: cortes, allowUnwatched: true });
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.outside);
    if (!r.ok || !r.outside) return;
    assert.equal(r.dir, fora);
    assert.match(r.warning, /nenhum alarme de destino faltante/);
    assert.match(r.warning, /--allow-unwatched-dir/);
  });

  it("realpathLenient resolve o maior ancestral existente e reanexa o resto", () => {
    const { root } = fakeRepo();
    assert.equal(realpathLenient(join(root, "repo", "data", "cortes", "novo", "x")), join(root, "OneDrive", "diaria-data", "cortes", "novo", "x"));
  });
});

const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
const shorts = {
  facebook_pages: ["diaria"],
  instagram: true,
  linkedin_profile: true,
  linkedin_page_repost: false,
  x: false,
  threads_profile: true,
  linkedin_profile_via_timer: true,
  threads_profile_via_timer: true,
  instagram_backend: "timer-300",
  instagram_api_max_seconds_by_account: { diaria: null },
  corte_via_timer: true,
  schedule: { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" },
};
const base = {
  aammdd: "261102",
  reviewedMd: "",
  config: { publishing: { shorts } },
  pages: [page("diaria")],
  instagramReady: true,
  published: { aammdd: "261102", entries: [] },
  video: { path: "/videos/Tratar IA como humano_V2.mp4", exists: true, sizeBytes: 10 },
  videoDurationSeconds: 50,
  threadsPersonal: { ready: true } as const,
  linkedinPersonal: { ready: true } as const,
  publicVideo: { ready: true } as const,
  youtubeApi: { ready: true } as const,
  corte: { slug: SLUG, hhmm: "08:00", title: "Tratar IA como humano", hook: "Por que dar nome ao chatbot muda o jeito que você usa." },
  now: new Date("2026-11-02T03:00:00Z"),
};

describe("#11911 plano do corte aceito fora de data/cortes/", () => {
  it("com corte_via_timer, o timer NÃO vira dono (não enxerga a pasta): re-execução com a mesma pasta e o escape, aviso em warnings", () => {
    const fora = "/home/x/diaria-cortes/261102-tratar-ia-como-humano";
    const warning = "corte fora de data/cortes/: nenhum alarme de destino faltante cobre este corte";
    const p = planShortsPublish({ ...base, corteOutside: { dir: fora, warning } });
    assert.ok(p.warnings.includes(warning), p.warnings.join("\n"));
    for (const d of ["linkedin_profile", "threads_profile", "instagram"]) {
      const owner = p.owners.find((o) => o.destination === d)!;
      assert.equal(owner.by, "agent-scheduled-task", d);
      assert.equal(owner.command, `${corteBaseCommand(SLUG, fora)} --only ${d} --publish --confirm-publish 261102`, d);
      assert.match(owner.command!, /--edition-dir "\/home\/x\/diaria-cortes\/261102-tratar-ia-como-humano" --allow-unwatched-dir/);
    }
  });

  it("dentro de data/cortes/ (sem corteOutside) segue com o timer do corte como dono — o caminho do timer não muda", () => {
    const p = planShortsPublish(base);
    for (const d of ["linkedin_profile", "threads_profile", "instagram"]) {
      const owner = p.owners.find((o) => o.destination === d)!;
      assert.equal(owner.by, "timer-300", d);
      assert.equal(owner.task, "Diaria-Shorts-Cortes", d);
    }
    assert.ok(!p.warnings.some((w) => /nenhum alarme de destino faltante/.test(w)));
  });
});

describe("#11911 CLI do publish-shorts", () => {
  it("--allow-unwatched-dir é flag booleana (não engole a data colada)", () => {
    const r = parseShortsCliArgs(["--corte", SLUG, "--allow-unwatched-dir", "261102"]);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(r.flags.has("allow-unwatched-dir"));
    assert.equal(r.aammdd, "261102");
  });

  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/publish-shorts.ts", ...args], { cwd: ROOT, encoding: "utf8" });

  it("--corte com --edition-dir fora de data/cortes/ sai exit 2 sem gravar nada na pasta", () => {
    const fora = mkdtempSync(join(tmpdir(), "diaria-cortes-11911-"));
    const r = run(["--corte", SLUG, "--date", "261102", "--at", "08:00", "--title", "T", "--hook", "H", "--video", join(fora, "v.mp4"), "--edition-dir", fora]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /fica fora de data\/cortes\/tratar-ia-como-humano\//);
    assert.match(r.stderr, /--allow-unwatched-dir/);
    assert.equal(existsSync(join(fora, CORTE_SPEC_FILE)), false, "a recusa vem antes de registrar o corte");
  });

});

describe("#11911 modo edição: --edition-dir fora de data/editions/{AAMMDD} é recusado (o caso real de 02/11)", () => {
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/publish-shorts.ts", ...args], { cwd: ROOT, encoding: "utf8" });

  it("checkEditionDir: pasta canônica passa; fora recusa com mensagem acionável; fora com a flag passa com aviso", () => {
    assert.deepEqual(checkEditionDir({ aammdd: "261102", override: undefined, allowUnwatched: false, canonicalDir: CANON }), { ok: true, outside: false });
    const fora = "/home/x/diaria-cortes/261102-tratar-ia-como-humano";
    const r = checkEditionDir({ aammdd: "261102", override: fora, allowUnwatched: false, canonicalDir: CANON });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /fica fora da pasta canônica da edição 261102 \(.*data\/editions\/2611\/261102\)/);
      assert.match(r.error, /--corte SLUG/, "orienta o corte para data/cortes/");
      assert.match(r.error, /--allow-unwatched-dir/, "oferece o escape");
    }
    const ok = checkEditionDir({ aammdd: "261102", override: fora, allowUnwatched: true, canonicalDir: CANON });
    assert.ok(ok.ok && ok.outside);
    if (ok.ok && ok.outside) assert.match(ok.warning, /nenhum alarme de destino faltante/);
  });

  it("nonCanonicalEditionDir pelo caminho real: symlink e `..` para a canônica não contam como fora", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "edition-unwatched-11911-")));
    const real = join(root, "OneDrive", "data", "editions", "261102");
    mkdirSync(real, { recursive: true });
    mkdirSync(join(root, "repo"));
    symlinkSync(join(root, "OneDrive", "data"), join(root, "repo", "data"));
    const canonical = join(root, "repo", "data", "editions", "261102");
    assert.equal(nonCanonicalEditionDir(real, canonical), undefined, "o mesmo diretório pelo caminho do OneDrive");
    assert.equal(nonCanonicalEditionDir(join(root, "repo", "data", "editions", "x", "..", "261102"), canonical), undefined);
    const fora = join(root, "diaria-cortes", "261102-tratar-ia-como-humano");
    assert.equal(nonCanonicalEditionDir(fora, canonical), fora);
  });

  it("CLI: --instagram-timer com --edition-dir em ~/diaria-cortes/... sai exit 2 antes de ler a pasta", () => {
    const fora = mkdtempSync(join(tmpdir(), "diaria-cortes-261102-"));
    const r = run(["261102", "--only", "instagram", "--instagram-timer", "--now", "--edition-dir", fora]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /fica fora da pasta canônica da edição 261102 \(.*data\/editions\/2611\/261102\)/);
    assert.match(r.stderr, /--allow-unwatched-dir/);
    assert.equal(r.stdout, "");
  });

  it("CLI: fora com --allow-unwatched-dir passa da recusa com aviso (para no 02-reviewed.md ausente)", () => {
    const fora = mkdtempSync(join(tmpdir(), "diaria-cortes-261102-"));
    const r = run(["261102", "--edition-dir", fora, "--allow-unwatched-dir"]);
    assert.notEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /\[aviso\] --edition-dir .* por --allow-unwatched-dir: nenhum alarme de destino faltante/);
    assert.doesNotMatch(r.stderr, /publish-shorts: --edition-dir/);
  });

  it("CLI: a pasta canônica (explícita, e por `..`) passa sem flag — o caminho dos timers e da skill", () => {
    for (const d of ["data/editions/2611/261102", "data/editions/2611/outra/../261102"]) {
      const r = run(["261102", "--edition-dir", d]);
      assert.doesNotMatch(r.stderr, /fica fora da pasta canônica/, `${d}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /allow-unwatched-dir/, d);
    }
  });

  it("os chamadores automáticos do publish-shorts não passam --edition-dir (usam a pasta canônica)", () => {
    for (const f of ["shorts-instagram-timer.ts", "shorts-linkedin-profile-timer.ts", "shorts-threads-profile-timer.ts", "shorts-corte-timer.ts", "video-extra-verticals.ts"]) {
      const src = readFileSync(join(ROOT, "scripts", f), "utf8");
      for (const m of src.matchAll(/\[\s*"scripts\/publish-shorts\.ts"[^\]]*\]/g)) assert.doesNotMatch(m[0], /edition-dir/, `${f}: ${m[0]}`);
    }
  });

  it("plano: o aviso entra em warnings e a re-execução leva --edition-dir e --allow-unwatched-dir", () => {
    const fora = "/home/x/diaria-cortes/261102-tratar-ia-como-humano";
    const warning = "aviso-unwatched-edicao";
    const edition = { ...base, corte: undefined, reviewedMd: REVIEWED, editionUrl: "https://diar.ia.br/p/x" };
    const p = planShortsPublish({ ...edition, editionDirOverride: fora, unwatchedEditionWarning: warning });
    assert.ok(p.warnings.includes(warning), p.warnings.join("\n"));
    const owner = p.owners.find((o) => o.destination === "instagram")!;
    assert.equal(owner.by, "agent-scheduled-task");
    assert.match(owner.command!, new RegExp(`--edition-dir ${JSON.stringify(fora).replace(/[/]/g, "\\/")} --allow-unwatched-dir --only instagram`));
  });
});

describe("#11911 donos recalculados depois da publicação (ownersContextAfterPublish)", () => {
  const items = [{ destination: "instagram", action: "pending_schedule", scheduledAt: "2026-11-02T11:00:00.000Z" }] as any;
  const now = new Date("2026-11-02T03:00:00Z");
  const fora = "/home/x/diaria-cortes/261102-tratar-ia-como-humano";

  it("edição fora da canônica: não delega o Instagram ao timer e o comando leva a pasta e o escape (antes perdia o --edition-dir)", () => {
    const ctx = ownersContextAfterPublish({ aammdd: "261102", now, instagramBackend: "timer-300", corteViaTimer: true, editionDirOverride: fora });
    assert.equal(ctx.instagramViaTimer, false);
    const [o] = assignShortsDestinationOwners(items, ctx);
    assert.equal(o.by, "agent-scheduled-task");
    assert.ok(o.command!.includes(`--edition-dir ${JSON.stringify(fora)} --allow-unwatched-dir`), o.command);
  });

  it("edição na canônica: o Instagram segue com o timer", () => {
    const [o] = assignShortsDestinationOwners(items, ownersContextAfterPublish({ aammdd: "261102", now, instagramBackend: "timer-300", corteViaTimer: true }));
    assert.equal(o.by, "timer-300");
  });

  it("corte fora de data/cortes/: sem timer do corte, re-execução com a pasta e o escape", () => {
    const ctx = ownersContextAfterPublish({ aammdd: "261102", now, instagramBackend: "timer-300", corteViaTimer: true, corteSlug: SLUG, corteOutsideDir: fora });
    assert.equal(ctx.corteTimer, false);
    const [o] = assignShortsDestinationOwners(items, ctx);
    assert.equal(o.by, "agent-scheduled-task");
    assert.equal(o.command, `${corteBaseCommand(SLUG, fora)} --only instagram --publish --confirm-publish 261102`);
  });

  it("corte em data/cortes/: o timer do corte segue dono", () => {
    const [o] = assignShortsDestinationOwners(items, ownersContextAfterPublish({ aammdd: "261102", now, instagramBackend: "timer-300", corteViaTimer: true, corteSlug: SLUG }));
    assert.equal(o.by, "timer-300");
    assert.equal(o.task, "Diaria-Shorts-Cortes");
  });
});
