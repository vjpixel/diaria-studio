/**
 * #12946 — na edição 261113 o D1 foi trocado no gate e a newsletter saiu
 * renderizada com o convite "Clique para assistir meus comentários" numa
 * edição sem vídeo. O gate passa a mostrar o estado do convite e os scripts
 * que trocam o D1 passam a citar set-d1-no-video.ts antes do upload.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  d1NoVideoSwapStep,
  formatD1VideoInviteLine,
  noVideoGateSteps,
  readD1VideoInviteStatus,
} from "../scripts/lib/diaria/d1-video-invite-status.ts";
import { buildSwapNextSteps } from "../scripts/swap-destaques.ts";
import { buildSwapDestaqueSteps } from "../scripts/swap-destaque.ts";

function edition(): string {
  const root = mkdtempSync(join(tmpdir(), "d1-invite-12946-"));
  const dir = join(root, "261113");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

describe("readD1VideoInviteStatus (#12946)", () => {
  it("cópia com o convite no disco = invite; a linha oferece 'sem vídeo'", () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, "04-d1-2x1-play.jpg"), "x");
      const s = readD1VideoInviteStatus(dir);
      assert.equal(s.state, "invite");
      const line = formatD1VideoInviteLine(s, dir);
      assert.match(line, /COM o convite "Clique para assistir meus comentários"/);
      assert.match(line, /sem vídeo/);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  it("chave d1_play no cache público também conta como invite", () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({ images: { d1_play: { url: "u" } } }));
      assert.equal(readD1VideoInviteStatus(dir).state, "invite");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  it("marcador no-video vence a cópia que sobrou", () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, "04-d1-2x1-play.jpg"), "x");
      writeFileSync(join(dir, "_internal", "no-video.json"), "{}");
      const s = readD1VideoInviteStatus(dir);
      assert.equal(s.state, "no-video");
      assert.match(formatD1VideoInviteLine(s, dir), /SEM convite/);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  it("nada no disco = pending (o upload ainda vai gerar)", () => {
    const dir = edition();
    try {
      assert.equal(readD1VideoInviteStatus(dir).state, "pending");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  it("passos do 'sem vídeo': marcar, upload newsletter, re-render", () => {
    const steps = noVideoGateSteps("data/editions/2611/261113/");
    assert.match(steps[0], /set-d1-no-video\.ts 261113 --edition-dir data\/editions\/2611\/261113$/);
    assert.match(steps[1], /--mode newsletter/);
    assert.match(steps[2], /Re-render/);
  });
});

describe("troca de D1 cita set-d1-no-video.ts antes do upload (#12946)", () => {
  it("d1NoVideoSwapStep: só quando o D1 mudou e a edição não está marcada", () => {
    const dir = edition();
    try {
      assert.equal(d1NoVideoSwapStep(dir, false), null);
      assert.match(d1NoVideoSwapStep(dir, true) ?? "", /set-d1-no-video\.ts 261113/);
      writeFileSync(join(dir, "_internal", "no-video.json"), "{}");
      assert.equal(d1NoVideoSwapStep(dir, true), null);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  it("swap-destaques.ts: passo aparece antes do upload quando o slot 1 troca, e não no D2", () => {
    const dir = edition();
    try {
      const d1 = buildSwapNextSteps(dir, [{ position: 1, url: "https://x.com/a", title: "A" }] as never);
      const iNoVideo = d1.findIndex((s) => s.includes("set-d1-no-video.ts"));
      const iUpload = d1.findIndex((s) => s.includes("--mode newsletter"));
      assert.ok(iNoVideo >= 0 && iNoVideo < iUpload, "no-video antes do upload");
      const d2 = buildSwapNextSteps(dir, [{ position: 2, url: "https://x.com/b", title: "B" }] as never);
      assert.ok(!d2.some((s) => s.includes("set-d1-no-video.ts")));
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  it("swap-destaque.ts: idem para a promoção do pool ao D1", () => {
    const dir = edition();
    try {
      assert.ok(buildSwapDestaqueSteps(dir, 1, "Novo").some((s) => s.includes("set-d1-no-video.ts")));
      assert.ok(!buildSwapDestaqueSteps(dir, 3, "Novo").some((s) => s.includes("set-d1-no-video.ts")));
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });
});
