/**
 * test/social-invite-ordem-13557.test.ts (#13557)
 *
 * Pedido do editor (edição 261118): o box "Siga a diar.ia.br:" do e-mail sai
 * na ordem YouTube, Instagram, LinkedIn, TikTok, Threads, X, Facebook. O
 * rodapé social do site lê a mesma lista (`DIARIA_SOCIAL_NETWORKS`, #13321) e
 * segue a mesma ordem. Edição já costurada na ordem do #13320 (a 261118
 * inclusive) re-renderiza na ordem em que foi escrita e não acusa drift.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SOCIAL_INVITE,
  SOCIAL_INVITE_ICON_KEYS,
  SOCIAL_INVITE_TIKTOK_SECOND_LEGACY,
  detectSocialInviteDrift,
  isSocialInviteParagraph,
} from "../scripts/lib/shared/encerramento-snippet.ts";
import { DIARIA_SOCIAL_NETWORKS } from "../scripts/lib/shared/social-networks.ts";
import { renderSiteSocialIcons } from "../scripts/lib/shared/site-social.ts";
import { renderEncerrar } from "../scripts/lib/newsletter-render-html.ts";

const ORDEM = ["youtube", "instagram", "linkedin", "tiktok", "threads", "x", "facebook"];

function iconOrder(html: string): string[] {
  return [...html.matchAll(/<img src="https:\/\/diar\.ia\.br\/icons\/social\/([a-z]+)\.png"/g)].map((m) => m[1]);
}

describe("#13557 — ordem do convite social", () => {
  it("lista canônica e convite na ordem pedida", () => {
    assert.deepEqual([...SOCIAL_INVITE_ICON_KEYS], ORDEM);
    assert.deepEqual(
      DIARIA_SOCIAL_NETWORKS.map((n) => n.label),
      ["YouTube", "Instagram", "LinkedIn", "TikTok", "Threads", "X", "Facebook"],
    );
    const labels = [...SOCIAL_INVITE.matchAll(/\[([^\]]+)\]\(/g)].map((m) => m[1]);
    assert.deepEqual(labels, ["YouTube", "Instagram", "LinkedIn", "TikTok", "Threads", "X", "Facebook"]);
  });

  it("e-mail diário renderiza os ícones na ordem pedida", () => {
    assert.deepEqual(iconOrder(renderEncerrar(`Texto de apoio.\n\n${SOCIAL_INVITE}`)), ORDEM);
  });

  it("rodapé social do site segue a mesma ordem", () => {
    const hosts = [...renderSiteSocialIcons().matchAll(/<a href="([^"]+)"/g)].map((m) => new URL(m[1].replace(/&amp;/g, "&")).host);
    assert.deepEqual(hosts, [
      "www.youtube.com",
      "www.instagram.com",
      "www.linkedin.com",
      "www.tiktok.com",
      "www.threads.net",
      "x.com",
      "www.facebook.com",
    ]);
  });

  it("edição costurada na ordem do #13320 re-renderiza como foi escrita e não acusa drift", () => {
    assert.notEqual(SOCIAL_INVITE_TIKTOK_SECOND_LEGACY, SOCIAL_INVITE);
    assert.ok(isSocialInviteParagraph(SOCIAL_INVITE_TIKTOK_SECOND_LEGACY));
    assert.equal(detectSocialInviteDrift(`**PARA ENCERRAR**\n\nTexto.\n\n${SOCIAL_INVITE_TIKTOK_SECOND_LEGACY}\n`), null);
    assert.deepEqual(
      iconOrder(renderEncerrar(`Texto.\n\n${SOCIAL_INVITE_TIKTOK_SECOND_LEGACY}`)),
      ["youtube", "tiktok", "instagram", "linkedin", "threads", "facebook", "x"],
    );
  });
});
