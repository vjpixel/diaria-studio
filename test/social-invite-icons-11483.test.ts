/**
 * #11483 — convite social do PARA ENCERRAR vira "Siga a diar.ia.br:" seguido
 * dos ícones das redes, cada um linkando a rede. Edições já costuradas
 * (261029 e anteriores) guardam o texto corrido em `02-reviewed.md` e devem
 * re-renderizar exatamente como antes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOCIAL_INVITE,
  SOCIAL_INVITE_PREFIX,
  SOCIAL_INVITE_LEGACY,
  SOCIAL_INVITE_ICON_KEYS,
  CURADORIA_PILLS,
  isSocialInviteParagraph,
  detectSocialInviteDrift,
  parseSocialInviteIcons,
  socialInviteIconUrl,
} from "../scripts/lib/shared/encerramento-snippet.ts";
import { renderEncerrar, mdInlineToHtml } from "../scripts/lib/newsletter-render-html.ts";
import { renderEncerramento } from "../scripts/lib/mensal/monthly-render.ts";
import { buildParaEncerrar } from "../scripts/stitch-newsletter.ts";
import { recolorSvg } from "../scripts/gen-social-invite-icons.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NETWORKS = ["LinkedIn", "Instagram", "Threads", "Facebook", "X", "YouTube"];

function encerrarWith(invite: string): string {
  return `Texto de apoio qualquer.\n\n${CURADORIA_PILLS}\n\n${invite}`;
}

/** Última `<table>` do bloco = a caixa "painel" do convite. */
function painel(html: string): string {
  const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>/g)];
  return tables.at(-1)?.[0] ?? "";
}

describe("#11483 — SOCIAL_INVITE no formato de ícones", () => {
  it("abre com 'Siga a diar.ia.br:' e traz um link por rede, na ordem, sem texto entre eles", () => {
    assert.ok(SOCIAL_INVITE.startsWith("Siga a **diar.ia.br**:"));
    assert.equal(SOCIAL_INVITE_PREFIX, "Siga a **diar.ia.br**:");
    const parsed = parseSocialInviteIcons(SOCIAL_INVITE);
    assert.ok(parsed);
    assert.deepEqual(parsed.links.map((l) => l.label), NETWORKS);
    assert.deepEqual(parsed.links.map((l) => l.icon), [...SOCIAL_INVITE_ICON_KEYS]);
    assert.doesNotMatch(SOCIAL_INVITE, /Para acompanhar|→|←/);
  });

  it("o stitch costura o convite novo como último parágrafo do PARA ENCERRAR", () => {
    const out = buildParaEncerrar({ slotA: "Texto de apoio qualquer." }, null, undefined, "codex");
    assert.ok(out.trimEnd().endsWith(SOCIAL_INVITE));
  });
});

describe("#11483 — render diário", () => {
  it("troca cada link pelo ícone PNG hospedado, com o nome da rede no alt, dentro da caixa", () => {
    const box = painel(renderEncerrar(encerrarWith(SOCIAL_INVITE)));
    assert.match(box, /border-radius:12px/);
    assert.match(box, />Siga a /);
    for (const [i, key] of SOCIAL_INVITE_ICON_KEYS.entries()) {
      const url = socialInviteIconUrl(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(box, new RegExp(`<img src="${url}" width="28" height="28" alt="${NETWORKS[i]}"`));
    }
    assert.equal((box.match(/<img /g) ?? []).length, 6);
    assert.doesNotMatch(box, /<svg/i, "SVG inline não renderiza em Gmail/Outlook");
    assert.doesNotMatch(box, /Para acompanhar/);
    assert.doesNotMatch(box, /\*\*|\]\(/, "markdown cru vazou");
  });

  it("cada ícone linka a URL da rede", () => {
    const box = painel(renderEncerrar(encerrarWith(SOCIAL_INVITE)));
    const parsed = parseSocialInviteIcons(SOCIAL_INVITE)!;
    for (const { url, icon } of parsed.links) {
      const re = new RegExp(`<a href="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*><img src="${socialInviteIconUrl(icon!).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
      assert.match(box, re);
    }
  });

  it("edição já costurada (texto corrido, 261029 e anteriores) re-renderiza igual: sem ícones, mesmo parágrafo", () => {
    const box = painel(renderEncerrar(encerrarWith(SOCIAL_INVITE_LEGACY)));
    assert.match(box, /border-radius:12px/);
    assert.ok(box.includes(mdInlineToHtml(SOCIAL_INVITE_LEGACY)), "parágrafo legado deve sair verbatim como antes do #11483");
    assert.doesNotMatch(box, /<img /);
    assert.doesNotMatch(box, /Siga a /);
  });

  it("fixture real da 261028 (texto corrido) continua sem ícones", () => {
    const md = readFileSync(join(ROOT, "test/fixtures/kit-delivered-test-email-11403/02-reviewed-261028.md"), "utf8");
    assert.ok(md.includes(SOCIAL_INVITE_LEGACY), "fixture deveria ter o convite legado");
    assert.ok(isSocialInviteParagraph(SOCIAL_INVITE_LEGACY));
    assert.equal(parseSocialInviteIcons(SOCIAL_INVITE_LEGACY), null);
  });

  it("convite editado com vírgulas ou texto entre os links cai no texto corrido, sem perder conteúdo", () => {
    const edited = `${SOCIAL_INVITE_PREFIX} [LinkedIn](https://www.linkedin.com/company/diar.ia.br/), ou [X](https://x.com/diariabr)`;
    assert.equal(parseSocialInviteIcons(edited), null);
    const box = painel(renderEncerrar(encerrarWith(edited)));
    assert.match(box, /border-radius:12px/);
    assert.match(box, />LinkedIn<\/a>/);
    assert.doesNotMatch(box, /<img /);
  });

  it("rede sem ícone conhecido sai como link de texto", () => {
    const withUnknown = `${SOCIAL_INVITE_PREFIX} [LinkedIn](https://www.linkedin.com/company/diar.ia.br/) [Bluesky](https://bsky.app/profile/diar.ia.br)`;
    const box = painel(renderEncerrar(encerrarWith(withUnknown)));
    assert.match(box, /alt="LinkedIn"/);
    assert.match(box, /<a href="https:\/\/bsky\.app\/profile\/diar\.ia\.br"[^>]*>Bluesky<\/a>/);
  });

  it("a fileira de ícones custa pouco no tamanho do e-mail (limite de clipping do Gmail)", () => {
    const legacy = painel(renderEncerrar(encerrarWith(SOCIAL_INVITE_LEGACY))).length;
    const icons = painel(renderEncerrar(encerrarWith(SOCIAL_INVITE))).length;
    assert.ok(icons - legacy < 2500, `convite com ícones cresceu ${icons - legacy} bytes`);
  });
});

describe("#11483 — render mensal usa os mesmos ícones", () => {
  it("renderEncerramento troca os links do convite pelos ícones", () => {
    const html = renderEncerramento(`Texto de apoio.\n\n${CURADORIA_PILLS}\n\n${SOCIAL_INVITE}`);
    assert.equal((html.match(/<img src="https:\/\/diar\.ia\.br\/icons\/social\//g) ?? []).length, 6);
    assert.match(html, /Siga a /);
  });

  it("renderEncerramento com o texto corrido legado continua sem ícones", () => {
    const html = renderEncerramento(`Texto de apoio.\n\n${SOCIAL_INVITE_LEGACY}`);
    assert.doesNotMatch(html, /icons\/social/);
    assert.match(html, /Para acompanhar as 3 principais/);
  });
});

describe("#11483 — drift do convite (invariante social-invite-drift)", () => {
  it("convite atual e convite legado exato não avisam", () => {
    assert.equal(detectSocialInviteDrift(`x\n\n${SOCIAL_INVITE}`), null);
    assert.equal(detectSocialInviteDrift(`x\n\n${SOCIAL_INVITE_LEGACY}`), null);
  });

  it("convite novo com rede faltando é 'outdated'", () => {
    const partial = `${SOCIAL_INVITE_PREFIX} [LinkedIn](https://www.linkedin.com/company/diar.ia.br/) [X](https://x.com/diariabr)`;
    assert.equal(detectSocialInviteDrift(`x\n\n${partial}`)?.kind, "outdated");
  });
});

describe("#11483 — assets dos ícones", () => {
  it("cada rede tem o SVG-fonte e o PNG servido pelo Worker do apex", () => {
    for (const key of SOCIAL_INVITE_ICON_KEYS) {
      assert.ok(existsSync(join(ROOT, "assets/social-icons", `${key}.svg`)), `${key}.svg ausente`);
      const png = join(ROOT, "workers/site/public/icons/social", `${key}.png`);
      assert.ok(existsSync(png), `${key}.png ausente`);
      const buf = readFileSync(png);
      assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${key}.png não é PNG`);
      assert.equal(socialInviteIconUrl(key), `https://diar.ia.br/icons/social/${key}.png`);
    }
  });

  it("recolorSvg põe a cor e tira o <title>", () => {
    const out = recolorSvg('<svg role="img" viewBox="0 0 24 24"><title>X</title><path d="M0 0"/></svg>', "#171411");
    assert.equal(out, '<svg fill="#171411" role="img" viewBox="0 0 24 24"><path d="M0 0"/></svg>');
  });
});
