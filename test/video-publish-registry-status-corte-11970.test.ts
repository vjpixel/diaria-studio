/**
 * test/video-publish-registry-status-corte-11970.test.ts (#11970)
 *
 * A vertical extra (#11900) e o corte avulso (#11795) publicam pelo modo corte
 * do `publish-shorts.ts`, que grava registro e marcas de envio em
 * `data/cortes/{slug}/_internal/`. A releitura pós-interrupção (#11741) só lia
 * a pasta da edição, então respondia `nothing-since` para um corte que o
 * processo sobrevivente publicou — e um novo "pode publicar" duplicaria o post.
 * `--corte SLUG` lê a pasta do corte, com a data do `corte.json`. Nenhum
 * publisher é executado aqui.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../scripts/video-publish-registry-status.ts";
import { persistShortEntry } from "../scripts/lib/diaria/shorts-published-store.ts";
import { markShortSending } from "../scripts/lib/diaria/shorts-sending-marker.ts";

const ROOT = join(import.meta.dirname, "..");
const SLUG = "fluxo-261104";
const DATE = "261104";
const since = "2026-11-04T13:00:00.000Z";

function withRoot(fn: (root: string, corteDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "status-corte-11970-"));
  const corteDir = join(root, "data", "cortes", SLUG);
  mkdirSync(corteDir, { recursive: true });
  try {
    fn(root, corteDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeSpec(corteDir: string, date = DATE): void {
  writeFileSync(
    join(corteDir, "corte.json"),
    JSON.stringify({ slug: SLUG, date, hhmm: "12:15", title: "Título", hook: "Gancho do corte.", video: "corte.mp4" }),
  );
}

function run(argv: string[], root: string): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    return { code: main(argv, root), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("#11970: releitura do registro do corte", () => {
  it("regressão: registro do corte depois de --since → registered_since (a releitura da edição não via)", () => {
    withRoot((root, corteDir) => {
      writeSpec(corteDir);
      persistShortEntry(corteDir, DATE, "main", { destination: "facebook:diaria", status: "published", id: "fb1", at: "2026-11-04T13:01:00.000Z" });
      const r = run(["--corte", SLUG, "--since", since], root);
      assert.equal(r.code, 0, r.err);
      const s = JSON.parse(r.out);
      assert.equal(s.verdict, "registered-since");
      assert.deepEqual(s.registered_since, ["facebook:diaria"]);
      assert.equal(s.aammdd, DATE);
      assert.deepEqual(s.corte, { slug: SLUG, dir: corteDir });
      // O buraco: a pasta da edição (vazia) dizia "nada saiu".
      const edition = run([DATE, "--edition-dir", join(root, "data", "editions", "2611", DATE), "--since", since], root);
      assert.equal(JSON.parse(edition.out).verdict, "nothing-since");
    });
  });
  it("marca de envio em aberto no corte → registered-since", () => {
    withRoot((root, corteDir) => {
      writeSpec(corteDir);
      markShortSending(corteDir, DATE, "main", { destination: "youtube_shorts", started_at: "2026-11-04T13:00:05.000Z" });
      const s = JSON.parse(run(["--corte", SLUG, "--since", since], root).out);
      assert.equal(s.verdict, "registered-since");
      assert.deepEqual(s.registered_since, ["youtube_shorts"]);
    });
  });
  it("corte sem registro nem marca → nothing-since", () => {
    withRoot((root, corteDir) => {
      writeSpec(corteDir);
      const r = run(["--corte", SLUG, "--since", since], root);
      assert.equal(r.code, 0, r.err);
      assert.equal(JSON.parse(r.out).verdict, "nothing-since");
    });
  });
  it("AAMMDD posicional diferente do corte.json → exit 2", () => {
    withRoot((root, corteDir) => {
      writeSpec(corteDir);
      const r = run(["--corte", SLUG, "261105", "--since", since], root);
      assert.equal(r.code, 2);
      assert.match(r.err, /é de 261104/);
    });
  });
  it("sem corte.json e sem AAMMDD → exit 1 (nunca nothing-since)", () => {
    withRoot((root) => {
      const r = run(["--corte", SLUG, "--since", since], root);
      assert.equal(r.code, 1);
      assert.equal(r.out, "");
      assert.match(r.err, /corte\.json ausente/);
    });
  });
  it("regressão #11975: sem corte.json COM AAMMDD (slug errado) → exit 1, nunca nothing-since", () => {
    withRoot((root) => {
      const r = run(["--corte", "fluxo-26114", DATE, "--since", since], root);
      assert.equal(r.code, 1);
      assert.equal(r.out, "");
      assert.match(r.err, /corte\.json ausente/);
    });
  });
  it("corte.json ilegível → exit 1", () => {
    withRoot((root, corteDir) => {
      writeFileSync(join(corteDir, "corte.json"), "{");
      assert.equal(run(["--corte", SLUG, "--since", since], root).code, 1);
    });
  });
  it("registro do corte ilegível → exit 1 (unreadable)", () => {
    withRoot((root, corteDir) => {
      writeSpec(corteDir);
      mkdirSync(join(corteDir, "_internal"), { recursive: true });
      writeFileSync(join(corteDir, "_internal", "06-shorts-published.json"), "{");
      const r = run(["--corte", SLUG, "--since", since], root);
      assert.equal(r.code, 1);
      assert.equal(JSON.parse(r.out).verdict, "unreadable");
    });
  });
  it("slug inválido, --corte sem valor e --corte com --edition → exit 2", () => {
    withRoot((root) => {
      assert.equal(run(["--corte", "Slug_Ruim"], root).code, 2);
      assert.equal(run(["--corte"], root).code, 2);
      assert.equal(run(["--corte", SLUG, "--edition", DATE], root).code, 2);
    });
  });
  it("--edition-dir sobrepõe a pasta do corte (rodado com --allow-unwatched-dir)", () => {
    withRoot((root) => {
      const outside = join(root, "fora");
      mkdirSync(outside, { recursive: true });
      writeSpec(outside);
      persistShortEntry(outside, DATE, "main", { destination: "x", status: "published", id: "1", at: "2026-11-04T13:02:00.000Z" });
      const s = JSON.parse(run(["--corte", SLUG, "--edition-dir", outside, "--since", since], root).out);
      assert.deepEqual(s.registered_since, ["x"]);
    });
  });
  it("modo edição não muda: sem --corte, não há campo corte", () => {
    withRoot((root) => {
      const dir = join(root, "ed");
      mkdirSync(dir);
      const s = JSON.parse(run([DATE, "--edition-dir", dir], root).out);
      assert.equal(s.verdict, "no-cutoff");
      assert.equal("corte" in s, false);
    });
  });
  it("a skill cita a forma do comando para o corte", () => {
    const skill = readFileSync(join(ROOT, ".claude", "skills", "diaria-publica-video", "SKILL.md"), "utf8");
    assert.match(skill, /video-publish-registry-status\.ts --corte \{slug\} --since/);
  });
});
