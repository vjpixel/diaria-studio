/**
 * #10943 — fluxo diário /diaria-edicao → /diaria-youtube → /diaria-shorts →
 * /diaria-5-publicacao. Trava: (1) o aviso (não gate) do Stage 5 quando não
 * há vídeo; (2) a mensagem de fim do /diaria-edicao e o CLAUDE.md citando a
 * sequência nova sem encadear; (4) a pré-condição Stage 4 da /diaria-youtube.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { assessVideoBeforePublish } from "../scripts/lib/diaria/video-before-publish.ts";

const ROOT = join(import.meta.dirname, "..");

function edition(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "video-before-publish-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("assessVideoBeforePublish (#10943 item 2)", () => {
  it("sem registro nem 05-video-url.txt → no-video com aviso de D1 sem link", () => {
    const dir = edition({});
    try {
      const r = assessVideoBeforePublish(dir, "261024");
      assert.equal(r.status, "no-video");
      assert.equal(r.videoUrl, null);
      assert.match(r.warning ?? "", /SEM o link do vídeo/);
      assert.match(r.warning ?? "", /\/diaria-publica-video 261024/);
      assert.match(r.warning ?? "", /aviso, não gate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("05-video-url.txt válido → link-ready, sem aviso", () => {
    const dir = edition({ "_internal/05-video-url.txt": "https://www.youtube.com/watch?v=QRbXMprk9o0\n" });
    try {
      const r = assessVideoBeforePublish(dir, "261024");
      assert.equal(r.status, "link-ready");
      assert.equal(r.videoUrl, "https://youtu.be/QRbXMprk9o0");
      assert.equal(r.warning, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("vídeo subiu mas link não liberado → video-without-link apontando o link-video-d1", () => {
    const dir = edition({ "_internal/05-youtube-published.json": "{}" });
    try {
      const r = assessVideoBeforePublish(dir, "261024");
      assert.equal(r.status, "video-without-link");
      assert.match(r.warning ?? "", /link-video-d1\.ts 261024 --save --assume-public/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("05-video-url.txt inválido não lança: vira aviso", () => {
    const dir = edition({ "_internal/05-video-url.txt": "não é url\n" });
    try {
      const r = assessVideoBeforePublish(dir, "261024");
      assert.equal(r.status, "no-video");
      assert.match(r.warning ?? "", /ignorado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI sai 0 mesmo sem vídeo (aviso, nunca gate) e escreve [aviso] no stderr", () => {
    const dir = edition({});
    try {
      const res = spawnSync(
        process.execPath,
        ["--import", "tsx", join(ROOT, "scripts/check-video-before-publish.ts"), "261024", "--edition-dir", dir],
        { encoding: "utf8" },
      );
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /\[aviso\]/);
      assert.equal(JSON.parse(res.stdout).status, "no-video");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("prosa do fluxo novo (#10943 itens 1, 2 e 4)", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  // #11209: os dois vídeos saem por uma skill só, entre o gate 4 e a Etapa 5.
  const sequence = /\/diaria-publica-video[\s\S]{0,200}\/diaria-5-publicacao/;

  it("mensagem de fim do Stage 4 cita a sequência nova e diz que nada encadeia", () => {
    const stage4 = read(".claude/agents/orchestrator-stage-4.md");
    const msg = stage4.slice(stage4.indexOf("Stage 4 aprovado — edição {AAMMDD}."));
    assert.match(msg.slice(0, 1500), sequence);
    assert.match(msg.slice(0, 1500), /nenhum encadeia/);
  });

  it("SKILL.md do /diaria-edicao e CLAUDE.md citam a sequência nova", () => {
    assert.match(read(".claude/skills/diaria-edicao/SKILL.md"), sequence);
    assert.match(read("CLAUDE.md"), sequence);
  });

  it("/diaria-5-publicacao roda o aviso de vídeo; /diaria-publica-video exige o Stage 4 aprovado", () => {
    assert.match(read(".claude/skills/diaria-5-publicacao/SKILL.md"), /check-video-before-publish\.ts/);
    assert.match(read(".claude/skills/diaria-publica-video/SKILL.md"), /pipeline-sentinel\.ts exists --edition \{AAMMDD\} --step 4/);
  });

  it("#11209: /diaria-youtube e /diaria-shorts são aliases finos da /diaria-publica-video, sem duplicar o fluxo", () => {
    for (const [alias, part] of [["diaria-youtube", "--so horizontal"], ["diaria-shorts", "--so vertical"]] as const) {
      const skill = read(`.claude/skills/${alias}/SKILL.md`);
      assert.match(skill, new RegExp(`^---\\nname: ${alias}\\n`));
      assert.ok(skill.includes(".claude/skills/diaria-publica-video/SKILL.md"), `${alias} aponta para a skill nova`);
      assert.ok(skill.includes(part), `${alias} repassa ${part}`);
      assert.ok(skill.split("\n").length < 30, `${alias} é só um alias (${skill.split("\n").length} linhas)`);
      assert.doesNotMatch(skill, /publish-(youtube|shorts)\.ts/, `${alias} não repete os comandos do fluxo`);
    }
    const merged = read(".claude/skills/diaria-publica-video/SKILL.md");
    assert.match(merged, /^---\nname: diaria-publica-video\n/);
    assert.match(merged, /--so horizontal\|vertical/);
    assert.ok(merged.indexOf("## Parte A") < merged.indexOf("## Parte B"), "horizontal antes do vertical (o Short aponta pro horizontal)");
  });
});
