/**
 * test/publish-shorts-unwatched-dir-11911.test.ts (#11911, último resíduo)
 *
 * Em 02/11/2026 a rodada original do vertical de um corte ("Você ainda trata
 * a IA como máquina?") foi no modo EDIÇÃO com `--edition-dir
 * ~/diaria-cortes/261102-tratar-ia-como-humano`, fora do repo. Os timers de
 * Instagram da edição só procuram a pasta canônica e ficaram cegos: o Reels
 * sumiu sem alarme. O `--instagram-timer` com a mesma pasta foi a remediação
 * manual (12:38 BRT); o timer e o vigia do corte ainda não existiam ou não
 * estavam armados.
 *
 * Agora o `publish-shorts.ts` recusa, pelo caminho REAL (symlink e `..`
 * resolvidos), pasta fora de `data/cortes/{slug}/` no modo corte e fora de
 * `data/editions/{AAMM}/{AAMMDD}/` do repo no modo edição, com o escape
 * explícito `--allow-unwatched-dir`, que avisa que nenhum alarme de destino
 * faltante cobre a pasta. No corte, o escape é recusado se o corte canônico
 * (`data/cortes/{slug}/corte.json`) já existir.
 *
 * Sem rede e hermético: os spawns usam a edição sintética 991231 (nunca vai
 * existir) e param na recusa da pasta ou no `02-reviewed.md` ausente, antes de
 * qualquer credencial, download ou publicação. Toda pasta temporária é apagada.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHORTS_BOOLEAN_FLAGS,
  assignShortsDestinationOwners,
  canonicalShortsEditionDir,
  checkEditionDir,
  nonCanonicalEditionDir,
  ownersContextAfterPublish,
  parseShortsCliArgs,
  planShortsPublish,
  prepareCorteRun,
  type ShortsPlanInput,
} from "../scripts/publish-shorts.ts";
import { ALLOW_UNWATCHED_DIR_FLAG, CORTE_SPEC_FILE, checkCorteDir, corteBaseCommand, realpathLenient, shellQuote } from "../scripts/lib/diaria/short-corte.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "tratar-ia-como-humano";
/** Edição sintética: nunca existe em data/editions/, o spawn nunca acha uma edição real. */
const SYNTH = "991231";
const SYNTH_CANON_REL = "data/editions/9912/991231";
/** Pasta canônica da edição: aninhada por mês (`editionDir`). */
const CANON = "/repo/data/editions/2611/261102";
const REVIEWED = "DESTAQUE 1 | X\n\n[Título do D1](https://example.com/a)\n\nCorpo do D1. Mais.\n\nPor que isso importa: x.\n";
const SPAWN_TIMEOUT_MS = 60_000;

const tmps: string[] = [];
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmps.push(d);
  return d;
}

/** Roda o CLI de verdade, com timeout; `cwd` default é a raiz do repo. */
function runCli(args: string[], cwd = ROOT) {
  return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(ROOT, "scripts", "publish-shorts.ts"), ...args], {
    cwd,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
}

/** Raiz falsa de repo com `data/cortes/` (o `data/` real é symlink pro OneDrive: aqui também). */
function fakeRepo(): { root: string; cortes: string } {
  const root = tmp("corte-outside-11911-");
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

  it("fora (~/diaria-cortes/...) recusa com mensagem acionável", () => {
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

  it("o escape é RECUSADO se o corte canônico (data/cortes/{slug}/corte.json) já existe: o timer e o vigia publicariam de novo", () => {
    const { root, cortes } = fakeRepo();
    mkdirSync(join(cortes, SLUG));
    writeFileSync(join(cortes, SLUG, CORTE_SPEC_FILE), "{}\n");
    const fora = join(root, "diaria-cortes", `261102-${SLUG}`);
    const r = checkCorteDir({ slug: SLUG, dir: fora, cortesRoot: cortes, allowUnwatched: true });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.error.includes(join(cortes, SLUG, CORTE_SPEC_FILE)), `nomeia o arquivo: ${r.error}`);
    assert.match(r.error, /Revogue a autorização/);
    assert.match(r.error, /outro slug/);
    // Sem a flag, a recusa é a de sempre (pasta fora), não a do corte existente.
    const semFlag = checkCorteDir({ slug: SLUG, dir: fora, cortesRoot: cortes, allowUnwatched: false });
    assert.ok(!semFlag.ok && /fica fora de data\/cortes\//.test(semFlag.error));
    // E a pasta canônica segue passando (é ela mesma).
    assert.deepEqual(checkCorteDir({ slug: SLUG, dir: join(cortes, SLUG), cortesRoot: cortes, allowUnwatched: true }), { ok: true, outside: false });
  });

  it("realpathLenient resolve o maior ancestral existente e reanexa o resto", () => {
    const { root } = fakeRepo();
    assert.equal(realpathLenient(join(root, "repo", "data", "cortes", "novo", "x")), join(root, "OneDrive", "diaria-data", "cortes", "novo", "x"));
  });

  it("realpathLenient só sobe ao ancestral em ENOENT/ENOTDIR; outro erro é relançado", () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    const enoent = (p: string) => {
      if (p === "/a") return "/real-a";
      throw err("ENOENT");
    };
    assert.equal(realpathLenient("/a/b/c", enoent), "/real-a/b/c");
    const enotdir = (p: string) => {
      if (p === "/a") return "/real-a";
      throw err("ENOTDIR");
    };
    assert.equal(realpathLenient("/a/b", enotdir), "/real-a/b");
    assert.throws(() => realpathLenient("/a/b", () => { throw err("EACCES"); }), /EACCES/);
    assert.throws(() => realpathLenient("/a/b", () => { throw err("ELOOP"); }), /ELOOP/);
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
      assert.match(owner.command!, /--edition-dir \/home\/x\/diaria-cortes\/261102-tratar-ia-como-humano --allow-unwatched-dir/);
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
  it("--allow-unwatched-dir é flag booleana (não engole a data colada) e vem da constante", () => {
    assert.ok((SHORTS_BOOLEAN_FLAGS as readonly string[]).includes(ALLOW_UNWATCHED_DIR_FLAG));
    const r = parseShortsCliArgs(["--corte", SLUG, "--allow-unwatched-dir", "261102"]);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(r.flags.has("allow-unwatched-dir"));
    assert.equal(r.aammdd, "261102");
  });

  it("--corte com --edition-dir fora de data/cortes/ sai exit 2 sem gravar nada na pasta", () => {
    const fora = tmp("diaria-cortes-11911-");
    const r = runCli(["--corte", SLUG, "--date", SYNTH, "--at", "08:00", "--title", "T", "--hook", "H", "--video", join(fora, "v.mp4"), "--edition-dir", fora]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /fica fora de data\/cortes\/tratar-ia-como-humano\//);
    assert.match(r.stderr, /--allow-unwatched-dir/);
    assert.equal(existsSync(join(fora, CORTE_SPEC_FILE)), false, "a recusa vem antes de registrar o corte");
  });
});

describe("#11911 modo edição: --edition-dir fora de data/editions/{AAMM}/{AAMMDD} é recusado (o caso real de 02/11)", () => {
  it("checkEditionDir: pasta canônica passa; fora recusa com mensagem acionável; fora com a flag passa com aviso", () => {
    assert.deepEqual(checkEditionDir({ aammdd: "261102", override: undefined, allowUnwatched: false, canonicalDir: CANON }), { ok: true, outside: false });
    const fora = "/home/x/diaria-cortes/261102-tratar-ia-como-humano";
    const r = checkEditionDir({ aammdd: "261102", override: fora, allowUnwatched: false, canonicalDir: CANON });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /fica fora da pasta canônica da edição 261102 \(.*data\/editions\/2611\/261102\)/);
      assert.match(r.error, /timers do 300 \(Instagram, LinkedIn e Threads pessoais\)/);
      assert.doesNotMatch(r.error, /vigia/, "o vigia é de cortes, não de edição");
      assert.match(r.error, /--corte SLUG/, "orienta o corte para data/cortes/");
      assert.match(r.error, /--allow-unwatched-dir/, "oferece o escape");
    }
    const ok = checkEditionDir({ aammdd: "261102", override: fora, allowUnwatched: true, canonicalDir: CANON });
    assert.ok(ok.ok && ok.outside);
    if (ok.ok && ok.outside) {
      assert.match(ok.warning, /nenhum alarme de destino faltante/);
      assert.doesNotMatch(ok.warning, /vigia/);
    }
  });

  it("canonicalShortsEditionDir é absoluta pela raiz do repo, nunca pelo cwd", () => {
    assert.equal(canonicalShortsEditionDir(SYNTH, "/r"), `/r/${SYNTH_CANON_REL}`);
    assert.equal(canonicalShortsEditionDir(SYNTH), join(ROOT, SYNTH_CANON_REL));
  });

  it("nonCanonicalEditionDir pelo caminho real: symlink e `..` para a canônica não contam como fora", () => {
    const root = tmp("edition-unwatched-11911-");
    const real = join(root, "OneDrive", "data", "editions", "2611", "261102");
    mkdirSync(real, { recursive: true });
    mkdirSync(join(root, "repo"));
    symlinkSync(join(root, "OneDrive", "data"), join(root, "repo", "data"));
    const canonical = join(root, "repo", "data", "editions", "2611", "261102");
    assert.equal(nonCanonicalEditionDir(real, canonical), undefined, "o mesmo diretório pelo caminho do OneDrive");
    assert.equal(nonCanonicalEditionDir(join(root, "repo", "data", "editions", "2611", "x", "..", "261102"), canonical), undefined);
    const fora = join(root, "diaria-cortes", "261102-tratar-ia-como-humano");
    assert.equal(nonCanonicalEditionDir(fora, canonical), fora);
  });

  it("CLI: --instagram-timer com --edition-dir em ~/diaria-cortes/... sai exit 2 antes de ler a pasta", () => {
    const fora = tmp("diaria-cortes-261102-");
    const r = runCli([SYNTH, "--only", "instagram", "--instagram-timer", "--now", "--edition-dir", fora]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /fica fora da pasta canônica da edição 991231 \(.*data\/editions\/9912\/991231\)/);
    assert.match(r.stderr, /--allow-unwatched-dir/);
    assert.equal(r.stdout, "");
  });

  it("CLI: fora com --allow-unwatched-dir passa da recusa com aviso e para no 02-reviewed.md ausente (exit 1)", () => {
    const fora = tmp("diaria-cortes-261102-");
    const r = runCli([SYNTH, "--edition-dir", fora, "--allow-unwatched-dir"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /02-reviewed\.md não existe/);
    assert.match(r.stderr, /\[aviso\] --edition-dir .* por --allow-unwatched-dir: nenhum alarme de destino faltante/);
  });

  it("CLI: a pasta canônica (explícita, e por `..`) passa sem flag e para no 02-reviewed.md ausente (exit 1)", () => {
    for (const d of [SYNTH_CANON_REL, "data/editions/9912/outra/../991231"]) {
      const r = runCli([SYNTH, "--edition-dir", d]);
      assert.equal(r.status, 1, `${d}: ${r.stderr}`);
      assert.match(r.stderr, /02-reviewed\.md não existe/, d);
      assert.doesNotMatch(r.stderr, /allow-unwatched-dir/, d);
    }
  });

  it("CLI de outro cwd: a canônica absoluta do repo passa (a comparação é pela raiz do repo, não pelo cwd)", () => {
    const outroCwd = tmp("cwd-11911-");
    const r = runCli([SYNTH, "--edition-dir", join(ROOT, SYNTH_CANON_REL)], outroCwd);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /02-reviewed\.md não existe/);
    assert.doesNotMatch(r.stderr, /allow-unwatched-dir/);
    // E sem --edition-dir, o default é a canônica do repo (não uma data/editions/ relativa ao cwd).
    const semDir = runCli([SYNTH], outroCwd);
    assert.equal(semDir.status, 1, semDir.stderr);
    assert.ok(semDir.stderr.includes(join(ROOT, SYNTH_CANON_REL, "02-reviewed.md")), semDir.stderr);
  });

  it("os chamadores automáticos do publish-shorts montam o comando sem --edition-dir (usam a pasta canônica)", () => {
    // Cada arquivo chama o publish-shorts por um array de argumentos; exigir ≥1 match evita o guard vazio.
    // extra-verticals monta o dry-run do modo corte (`--corte`): a pasta é data/cortes/{slug}/ pelo default.
    const callers = [
      "scripts/shorts-instagram-timer.ts",
      "scripts/shorts-linkedin-profile-timer.ts",
      "scripts/shorts-threads-profile-timer.ts",
      "scripts/shorts-corte-timer.ts",
      "scripts/lib/diaria/extra-verticals.ts",
    ];
    for (const f of callers) {
      const src = readFileSync(join(ROOT, f), "utf8");
      const calls = [...src.matchAll(/\[\s*"(?:npx tsx )?scripts\/publish-shorts\.ts"[^\]]*\]/g)];
      assert.ok(calls.length >= 1, `${f}: nenhuma chamada ao publish-shorts achada (o guard ficaria vazio)`);
      for (const m of calls) assert.doesNotMatch(m[0], /edition-dir/, `${f}: ${m[0]}`);
    }
  });

  it("plano: o aviso entra em warnings e a re-execução leva --edition-dir e --allow-unwatched-dir", () => {
    const fora = "/home/x/diaria-cortes/261102-tratar-ia-como-humano";
    const warning = "aviso-unwatched-edicao";
    const edition = { ...base, corte: undefined, reviewedMd: REVIEWED, editionUrl: "https://diar.ia.br/p/x" };
    const p = planShortsPublish({ ...edition, editionDirOverride: fora, unwatchedEditionWarning: warning });
    assert.ok(p.warnings.includes(warning), p.warnings.join("\n"));
    assert.ok(p.warnings.some((w) => w.includes("fica fora de data/editions/2611/261102")), p.warnings.join("\n"));
    const owner = p.owners.find((o) => o.destination === "instagram")!;
    assert.equal(owner.by, "agent-scheduled-task");
    assert.ok(owner.command!.includes(`--edition-dir ${shellQuote(fora)} --allow-unwatched-dir --only instagram`), owner.command);
  });
});

describe("#11911 donos recalculados depois da publicação (ownersContextAfterPublish)", () => {
  const items = [{ destination: "instagram", action: "pending_schedule", scheduledAt: "2026-11-02T11:00:00.000Z" }] as any;
  const late = [{ destination: "linkedin_profile", action: "skip_late" }] as any;
  const now = new Date("2026-11-02T03:00:00Z");
  const fora = "/home/x/diaria-cortes/261102-tratar-ia-como-humano";

  it("edição fora da canônica: não delega o Instagram ao timer e o comando leva a pasta e o escape (antes perdia o --edition-dir)", () => {
    const ctx = ownersContextAfterPublish({ aammdd: "261102", now, instagramBackend: "timer-300", corteViaTimer: true, editionDirOverride: fora });
    assert.equal(ctx.instagramViaTimer, false);
    const [o] = assignShortsDestinationOwners(items, ctx);
    assert.equal(o.by, "agent-scheduled-task");
    assert.ok(o.command!.includes(`--edition-dir ${shellQuote(fora)} --allow-unwatched-dir`), o.command);
  });

  it("skip_late (o agente publica com --now) também leva a pasta e o escape, na edição e no corte", () => {
    const [e] = assignShortsDestinationOwners(late, ownersContextAfterPublish({ aammdd: "261102", now, instagramBackend: "timer-300", corteViaTimer: true, editionDirOverride: fora }));
    assert.equal(e.action, "skip_late");
    assert.ok(e.command!.includes(`--edition-dir ${shellQuote(fora)} --allow-unwatched-dir`), e.command);
    const [c] = assignShortsDestinationOwners(late, ownersContextAfterPublish({ aammdd: "261102", now, instagramBackend: "timer-300", corteViaTimer: true, corteSlug: SLUG, corteOutsideDir: fora }));
    assert.ok(c.command!.startsWith(corteBaseCommand(SLUG, fora)), c.command);
    assert.ok(c.command!.includes("--allow-unwatched-dir"), c.command);
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


describe("#11944 resíduos do guard de pasta", () => {
  it("a comparação real ignora caixa só no Windows", () => {
    const real = (p: string) => p;
    assert.equal(nonCanonicalEditionDir("/DATA/Edicao", "/data/edicao", real, "win32"), undefined);
    assert.equal(nonCanonicalEditionDir("/DATA/Edicao", "/data/edicao", real, "linux"), "/DATA/Edicao");
  });

  it("grava o aviso também num corte existente sem alterar o plano ou perder a autorização", () => {
    const dir = tmp("warning-11944-");
    const input = { slug: SLUG, dir, positionalDate: "261102", values: { at: "08:00", title: "Título", hook: "Gancho", video: join(dir, "v.mp4") }, log: () => {} };
    prepareCorteRun(input);
    const path = join(dir, CORTE_SPEC_FILE);
    const old = JSON.parse(readFileSync(path, "utf8"));
    const authorization = { publish_confirmed_at: "2026-11-02T00:00:00Z", publish_confirmed_destinations: ["instagram"], publish_confirmed_content: { video_sha256: "a".repeat(64), cover_sha256: null } };
    writeFileSync(path, JSON.stringify({ ...old, ...authorization }));
    const warning = "nenhum timer vigia esta pasta";
    prepareCorteRun({ ...input, values: {}, unwatchedDirWarning: warning });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...old, ...authorization, unwatched_dir_warning: warning });
    prepareCorteRun({ ...input, values: {} });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).unwatched_dir_warning, warning);
  });
});

// Exercitado pelo typecheck de test/**: combinações inválidas nunca chegam ao plano.
function invalidInputsForTypecheck(common: Omit<ShortsPlanInput, "corte" | "corteOutside" | "editionDirOverride" | "unwatchedEditionWarning">) {
  // @ts-expect-error pasta externa de edição exige aviso
  const noWarning: ShortsPlanInput = { ...common, editionDirOverride: "/fora" };
  // @ts-expect-error pasta externa de corte exige corte
  const noCorte: ShortsPlanInput = { ...common, corteOutside: { dir: "/fora", warning: "aviso" } };
  // @ts-expect-error corte não aceita override de edição
  const mixed: ShortsPlanInput = { ...common, corte: base.corte, editionDirOverride: "/fora", unwatchedEditionWarning: "aviso" };
  return [noWarning, noCorte, mixed];
}
