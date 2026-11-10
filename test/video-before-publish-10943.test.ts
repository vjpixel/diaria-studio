/**
 * #10943 — fluxo diário /diaria-edicao → vídeo → Etapa 5. Trava: (1) o
 * pré-requisito do Stage 5 quando não há vídeo (aviso até o #12588, gate
 * desde então: sem o link do YouTube a Etapa 5 não publica); (2) a mensagem de fim do /diaria-edicao e o CLAUDE.md citando a
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

describe("assessVideoBeforePublish (#10943 item 2, gate desde #12588)", () => {
  it("sem registro nem 05-video-url.txt → no-video BLOQUEIA, com as duas saídas", () => {
    const dir = edition({});
    try {
      const r = assessVideoBeforePublish(dir, "261024");
      assert.equal(r.status, "no-video");
      assert.equal(r.blocking, true);
      assert.equal(r.videoUrl, null);
      assert.match(r.warning ?? "", /não publica sem o link do vídeo/);
      assert.match(r.warning ?? "", /\/diaria-publica-video 261024/);
      assert.match(r.warning ?? "", /set-d1-no-video\.ts 261024/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("05-video-url.txt válido → link-ready, sem aviso, não bloqueia", () => {
    const dir = edition({ "_internal/05-video-url.txt": "https://www.youtube.com/watch?v=QRbXMprk9o0\n" });
    try {
      const r = assessVideoBeforePublish(dir, "261024");
      assert.equal(r.status, "link-ready");
      assert.equal(r.blocking, false);
      assert.equal(r.videoUrl, "https://youtu.be/QRbXMprk9o0");
      assert.equal(r.warning, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("vídeo subiu mas link não liberado → video-without-link BLOQUEIA apontando o link-video-d1", () => {
    const dir = edition({ "_internal/05-youtube-published.json": "{}" });
    try {
      const r = assessVideoBeforePublish(dir, "261024");
      assert.equal(r.status, "video-without-link");
      assert.equal(r.blocking, true);
      assert.match(r.warning ?? "", /link-video-d1\.ts 261024 --save/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("05-video-url.txt inválido não lança: bloqueia com o motivo", () => {
    const dir = edition({ "_internal/05-video-url.txt": "não é url\n" });
    try {
      const r = assessVideoBeforePublish(dir, "261024");
      assert.equal(r.status, "no-video");
      assert.equal(r.blocking, true);
      assert.match(r.warning ?? "", /ignorado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição marcada sem vídeo (#11125) não bloqueia e vence a URL", () => {
    const dir = edition({ "_internal/no-video.json": "{}", "_internal/05-video-url.txt": "https://youtu.be/QRbXMprk9o0\n" });
    try {
      const r = assessVideoBeforePublish(dir, "261024");
      assert.equal(r.status, "no-video-marked");
      assert.equal(r.blocking, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--skip youtube no consent não bloqueia; consent auto ou ilegível bloqueia", () => {
    for (const [consent, blocking] of [["skipped", false], ["manual", false], ["auto", true], ["{quebrado", true]] as const) {
      const raw = consent.startsWith("{") ? consent : JSON.stringify({ youtube: consent });
      const dir = edition({ "_internal/05-publish-consent.json": raw });
      try {
        const r = assessVideoBeforePublish(dir, "261024");
        assert.equal(r.blocking, blocking, `consent ${consent}`);
        if (!blocking) assert.equal(r.status, "skipped-by-consent");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  const cli = (dir: string) =>
    spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts/check-video-before-publish.ts"), "261024", "--edition-dir", dir], {
      encoding: "utf8",
    });

  it("CLI: sem vídeo sai 3 (gate) com [halt] no stderr", () => {
    const dir = edition({});
    try {
      const res = cli(dir);
      assert.equal(res.status, 3, res.stderr);
      assert.match(res.stderr, /\[halt\]/);
      assert.equal(JSON.parse(res.stdout).blocking, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI: com o link sai 0; marcada sem vídeo sai 0 com [aviso]", () => {
    const ok = edition({ "_internal/05-video-url.txt": "https://youtu.be/QRbXMprk9o0\n" });
    const marked = edition({ "_internal/no-video.json": "{}" });
    try {
      assert.equal(cli(ok).status, 0);
      const m = cli(marked);
      assert.equal(m.status, 0, m.stderr);
      assert.match(m.stderr, /\[aviso\]/);
    } finally {
      rmSync(ok, { recursive: true, force: true });
      rmSync(marked, { recursive: true, force: true });
    }
  });
});

describe("prosa do fluxo novo (#10943 itens 1, 2 e 4)", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  // #12591: montagem → /diaria-publica-video, que roda horizontal → Etapas 5 e 6 → vertical.
  const sequence = /\/diaria-video-montagem[\s\S]{0,400}\/diaria-publica-video[\s\S]{0,300}Etapas 5 e 6/;

  it("mensagem de fim do Stage 4 cita a sequência nova, a exigência do link e diz que nada encadeia", () => {
    const stage4 = read(".claude/agents/orchestrator-stage-4.md");
    const msg = stage4.slice(stage4.indexOf("Stage 4 aprovado — edição {AAMMDD}."));
    assert.match(msg.slice(0, 1800), sequence);
    assert.match(msg.slice(0, 1800), /nenhum encadeia/);
    assert.match(msg.slice(0, 1800), /não publica sem o link do vídeo/);
    assert.match(msg.slice(0, 1800), /set-d1-no-video\.ts \{AAMMDD\}/);
    assert.doesNotMatch(msg.slice(0, 1800), /só avisa que o D1 sai sem o link/, "o aviso virou gate no #12588");
  });

  it("SKILL.md do /diaria-edicao e CLAUDE.md citam a sequência nova e não dizem mais que a Etapa 5 só avisa", () => {
    for (const p of [".claude/skills/diaria-edicao/SKILL.md", "CLAUDE.md"]) {
      const text = read(p);
      assert.match(text, sequence, p);
      assert.doesNotMatch(text, /Sem vídeo, a Etapa 5 segue e só avisa|segue normalmente e só avisa que o D1/, p);
    }
  });

  it("#12588: /diaria-5-publicacao trata o check de vídeo como gate (exit 3 = halt); /diaria-publica-video exige o Stage 4", () => {
    const s5 = read(".claude/skills/diaria-5-publicacao/SKILL.md");
    assert.match(s5, /check-video-before-publish\.ts/);
    assert.match(s5, /exit 3[\s\S]{0,200}parar antes de qualquer dispatch/);
    assert.doesNotMatch(s5, /Aviso de vídeo do D1 \(#10943, aviso, não gate\)/);
    assert.match(read(".claude/skills/diaria-publica-video/SKILL.md"), /pipeline-sentinel\.ts exists --edition \{AAMMDD\} --step 4/);
  });

  it("#12591: /diaria-publica-video roda horizontal, depois o /diaria-5-publicacao inteiro, depois o vertical", () => {
    const skill = read(".claude/skills/diaria-publica-video/SKILL.md");
    const start = skill.indexOf("## Fluxo da sessão");
    assert.ok(start > 0, "seção do fluxo da sessão");
    const flow = skill.slice(start, skill.indexOf("\n## ", start + 5));
    const a = flow.indexOf("**Parte A**");
    const s5 = flow.indexOf(".claude/skills/diaria-5-publicacao/SKILL.md");
    const b = flow.indexOf("**Parte B**");
    assert.ok(a > 0 && s5 > a && b > s5, "ordem A → Etapas 5-6 → B");
    assert.match(flow, /aliases[\s\S]{0,200}--so horizontal[\s\S]{0,200}sem as Etapas 5 e 6/);
    assert.doesNotMatch(skill, /esta skill nunca roda a Etapa 5/);
    assert.match(skill, /`--sem-publicacao`/);
    // o 5-publicacao devolve o controle à Parte B quando veio da skill de vídeo
    assert.match(read(".claude/skills/diaria-5-publicacao/SKILL.md"), /voltar para a Parte B/);
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
