import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { prepareSocialSignup, signupTestUrl, signupTestWindow } from "../scripts/lib/social-signup-preparation.ts";
import { injectChannelLine } from "../scripts/lib/social-cta-lines.ts";
import { UTM_EMITTERS, findUtmEmitterCollisions } from "../scripts/lib/shared/utm-registry.ts";

const body = "Primeiro parágrafo.\n\nSegundo parágrafo.\n\nTerceiro parágrafo.\n\n#IA #Brasil";
const md = "# Social\n" + ["d1", "d2", "d3"].map(id => `## ${id}\n${body}\n`).join("\n") + "\n## um\nNão incluir este bloco.\n";

test("D1 recebe assinatura nas duas redes; D2/D3 e os três parágrafos ficam intactos", () => {
  const plan = prepareSocialSignup(md, "2026-11-04", "2026-11-04");
  assert.equal(plan.posts.length, 3);
  for (const post of plan.posts) {
    for (const channel of ["linkedin", "facebook", "instagram"] as const) {
      const text = post.texts[channel];
      assert.ok(text.startsWith(body.split("\n\n#")[0]));
      assert.ok(!text.includes("Não incluir"));
      if (post.id === "d1" && channel !== "instagram") {
        assert.ok(text.endsWith(`${signupTestUrl(channel)}.`));
        assert.equal(text.match(/assine grátis/g)?.length, 1);
      } else {
        assert.equal(text, injectChannelLine(body, channel));
      }
    }
  }
  assert.equal(md.includes("post-cta-12038"), false);
  assert.equal(plan.instagram.firstComment.endsWith(`${plan.instagram.bioUrl}.`), true);
  assert.equal(plan.instagram.pinRequired, true);
  assert.ok(!plan.posts[0].texts.instagram.includes("post-cta-12038"));
  assert.equal(plan.preparationOnly, true);
});

test("quatro semanas exatas, fim exclusivo, datas inválidas e posts incompletos recusados", () => {
  assert.deepEqual(signupTestWindow("2026-12-20"), { start: "2026-12-20", endExclusive: "2027-01-17", weeks: 4 });
  prepareSocialSignup(md.replaceAll("\n", "\r\n"), "2026-12-01", "2026-11-04");
  for (const date of ["2026-11-03", "2026-12-02", "2026-02-30", "bad"]) {
    assert.throws(() => prepareSocialSignup(md, date, "2026-11-04"));
  }
  assert.throws(() => signupTestWindow("2026-02-30"));
  assert.throws(() => prepareSocialSignup(md.replace("## d3", "## outro"), "2026-11-04", "2026-11-04"));
  assert.throws(() => prepareSocialSignup(md.replace("Segundo parágrafo.\n\n", ""), "2026-11-04", "2026-11-04"), /três parágrafos/);
});

test("URLs por rede têm emissor registrado e não colidem com o CTA histórico do Facebook", () => {
  for (const channel of ["linkedin", "facebook", "instagram"] as const) {
    const url = new URL(signupTestUrl(channel));
    const emitter = UTM_EMITTERS.find(e => e.id === `${channel}-signup-test-12038`)!;
    assert.equal(url.origin, "https://diar.ia.br");
    assert.equal(url.searchParams.get("utm_source"), emitter.source);
    assert.equal(url.searchParams.get("utm_campaign"), emitter.campaignPattern);
    assert.equal(url.searchParams.get("utm_medium"), emitter.medium);
  }
  assert.ok(!findUtmEmitterCollisions().flat().some(id => id.includes("signup-test-12038")));
});

test("CLI gera só stdout e mantém a edição sem alterações", () => {
  const dir = mkdtempSync(join(tmpdir(), "signup-12038-"));
  try {
    const editionDir = join(dir, "data/editions/261104");
    mkdirSync(editionDir, { recursive: true });
    const file = join(editionDir, "03-social.md");
    writeFileSync(file, md);
    const cli = resolve("scripts/prep-social-signup-cta.ts");
    const tsx = resolve("node_modules/tsx/dist/cli.mjs");
    const result = spawnSync(process.execPath, [tsx, cli, "--edition", "261104", "--start", "2026-11-04"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).posts.length, 3);
    assert.equal(readFileSync(file, "utf8"), md);
    assert.deepEqual(readdirSync(editionDir), ["03-social.md"]);
    const invalid = spawnSync(process.execPath, [tsx, cli, "--edition", "../261104"], { cwd: dir, encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
