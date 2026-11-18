/**
 * test/social-invite-tiktok-13320.test.ts (#13320)
 *
 * O TikTok entra no convite "Siga a diar.ia.br:" da edição, logo depois do
 * YouTube (as duas redes de vídeo juntas), com o ícone servido pelo Worker do
 * apex. Edição já costurada sem o TikTok re-renderiza igual e não acusa drift.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOCIAL_INVITE,
  SOCIAL_INVITE_ICON_KEYS,
  SOCIAL_INVITE_NO_TIKTOK_LEGACY,
  detectSocialInviteDrift,
  parseSocialInviteIcons,
} from "../scripts/lib/shared/encerramento-snippet.ts";
import { DIARIA_TIKTOK_SLUG, DIARIA_TIKTOK_URL, FOOTER_DOMAINS } from "../scripts/lib/canonical-urls.ts";
import { renderEncerrar } from "../scripts/lib/newsletter-render-html.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function iconOrder(html: string): string[] {
  return [...html.matchAll(/<img src="https:\/\/diar\.ia\.br\/icons\/social\/([a-z]+)\.png"/g)].map((m) => m[1]);
}

describe("#13320 — TikTok no convite da edição", () => {
  it("URL canônica é o perfil @diar.ia.br", () => {
    assert.equal(DIARIA_TIKTOK_URL, "https://www.tiktok.com/@diar.ia.br");
  });

  it("o convite traz o TikTok (depois do LinkedIn desde o #13557)", () => {
    const parsed = parseSocialInviteIcons(SOCIAL_INVITE);
    assert.ok(parsed);
    assert.deepEqual(
      parsed.links.map((l) => l.label),
      ["YouTube", "Instagram", "LinkedIn", "TikTok", "Threads", "X", "Facebook"],
    );
    const tiktok = parsed.links[3];
    assert.equal(tiktok.url, DIARIA_TIKTOK_URL);
    assert.equal(tiktok.icon, "tiktok");
    assert.deepEqual([...SOCIAL_INVITE_ICON_KEYS], ["youtube", "instagram", "linkedin", "tiktok", "threads", "x", "facebook"]);
  });

  it("o e-mail diário sai com 7 ícones e o do TikTok linka o perfil", () => {
    const html = renderEncerrar(`Texto de apoio.\n\n${SOCIAL_INVITE}`);
    assert.deepEqual(iconOrder(html), ["youtube", "instagram", "linkedin", "tiktok", "threads", "x", "facebook"]);
    assert.match(html, /<a href="https:\/\/www\.tiktok\.com\/@diar\.ia\.br"[^>]*><img src="https:\/\/diar\.ia\.br\/icons\/social\/tiktok\.png"[^>]*alt="TikTok"/);
  });

  it("edição costurada antes do TikTok re-renderiza com os 6 ícones de antes e não acusa drift", () => {
    const md = `**PARA ENCERRAR**\n\nTexto.\n\n${SOCIAL_INVITE_NO_TIKTOK_LEGACY}\n`;
    assert.equal(detectSocialInviteDrift(md), null);
    const html = renderEncerrar(`Texto.\n\n${SOCIAL_INVITE_NO_TIKTOK_LEGACY}`);
    assert.deepEqual(iconOrder(html), ["youtube", "instagram", "linkedin", "threads", "facebook", "x"]);
  });

  it("convite atual também não acusa drift", () => {
    assert.equal(detectSocialInviteDrift(`**PARA ENCERRAR**\n\nTexto.\n\n${SOCIAL_INVITE}\n`), null);
  });

  it("o SVG e o PNG do ícone existem (o PNG é o que o e-mail carrega do apex)", () => {
    assert.ok(existsSync(join(ROOT, "assets/social-icons/tiktok.svg")));
    const png = readFileSync(join(ROOT, "workers/site/public/icons/social/tiktok.png"));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR: largura e altura 3x o tamanho exibido (28px), igual aos outros ícones.
    assert.equal(png.readUInt32BE(16), 84);
    assert.equal(png.readUInt32BE(20), 84);
  });

  it("o perfil do TikTok é link de rodapé próprio, não artigo de conteúdo (FOOTER_DOMAINS)", () => {
    assert.ok((FOOTER_DOMAINS as readonly string[]).includes(DIARIA_TIKTOK_SLUG));
  });

  it("templates e prompt do writer mensal carregam o convite atual, com o TikTok", () => {
    for (const rel of ["context/templates/newsletter.md", "context/templates/newsletter-monthly.md", ".claude/agents/writer-monthly.md"]) {
      assert.ok(readFileSync(join(ROOT, rel), "utf8").includes(SOCIAL_INVITE), `${rel} com convite desatualizado`);
    }
  });
});
