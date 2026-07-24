/**
 * test/poll-brand-shell-3113.test.ts (#3113)
 *
 * Regressão para 3 achados da issue #3113 (Bloco B, brand `diaria` e `clarice`):
 *
 *   Item 5 — shell editorial ausente (régua teal, rodapé de marca) nas páginas
 *   leaderboard (`renderLeaderboardHtml`) e arquivo (`renderArchiveListHtml`)
 *   do poll worker — antes só o `<title>` carregava identidade.
 *
 *   Item 11 — rodapé mínimo de marca ausente na página de voto do arquivo
 *   (`renderArchiveVoteHtml`) — o corpo não tinha identidade nenhuma (nem
 *   kicker, nem régua, nem rodapé).
 *
 *   Item 8 — no mobile da página de pré-voto do arquivo, a imagem A + botão
 *   preenchiam a tela sozinhos, dando pra votar em A sem nunca rolar até ver
 *   a imagem B. Fix: hint textual real (não CSS ::after, pra leitor de tela
 *   também anunciar) entre as 2 escolhas, visível só no recorte mobile.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderBrandShellStyles, renderBrandFooter, buildBrandSiteUrl } from "../workers/poll/src/lib.ts";
import { renderArchiveListHtml, renderArchiveVoteHtml } from "../workers/poll/src/leaderboard-routes.ts";
import workerDefault from "../workers/poll/src/index.ts";
import type { Env } from "../workers/poll/src/index.ts";

// #3978: renderBrandFooter passou a incluir UTM do funil "É IA?" → site
// (medium "footer") — os testes abaixo constroem o href esperado via
// `buildBrandSiteUrl` (a MESMA função de produção) em vez de hardcodear a
// string, pra não ficar acoplado à ordem exata dos parâmetros. `htmlEscape`
// (renderBrandFooter escapa o href como qualquer atributo) troca "&" por
// "&amp;" no HTML final — `footerHrefEscaped` espelha isso pra comparação.
function footerHref(brand: "diaria" | "clarice"): string {
  return buildBrandSiteUrl(brand, "footer", "eia-footer");
}
function footerHrefEscaped(brand: "diaria" | "clarice"): string {
  return footerHref(brand).replace(/&/g, "&amp;");
}

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const data: Record<string, string> = { ...seed };
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => { data[key] = value; },
    delete: async (key: string) => { delete data[key]; },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Object.keys(data).filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
}

function makeEnv(seed: Record<string, string> = {}): Env {
  return {
    POLL: makeKv(seed),
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}

async function fetchHtml(path: string, env: Env = makeEnv()): Promise<string> {
  const req = new Request(`https://poll.diaria.workers.dev${path}`);
  const res = await workerDefault.fetch(req, env, {} as ExecutionContext);
  assert.equal(res.status, 200, `esperava 200 para ${path}, recebeu ${res.status}`);
  return res.text();
}

describe("#3113 item 5 — renderBrandShellStyles / renderBrandFooter (pure)", () => {
  it("renderBrandShellStyles inclui régua teal e borda do rodapé", () => {
    const css = renderBrandShellStyles();
    assert.match(css, /\.rule\s*\{[^}]*background:\s*#00A0A0/);
    assert.match(css, /footer\.brand-footer\s*\{[^}]*border-top:\s*1px solid #EBE5D0/);
  });

  it("renderBrandFooter(diaria) linka pro diar.ia.br (com UTM do funil, #3978) com o label 'Diar.ia'", () => {
    const html = renderBrandFooter("diaria");
    assert.match(html, /<footer class="brand-footer">/);
    assert.ok(html.includes(`<a href="${footerHrefEscaped("diaria")}">Diar.ia</a>`), html);
  });

  it("renderBrandFooter(clarice) linka pro clarice.ai (com UTM do funil, #3978, preservando ?via=diaria) com o shortName 'Clarice' (não 'Clarice News')", () => {
    const html = renderBrandFooter("clarice");
    const href = footerHref("clarice");
    assert.ok(href.startsWith("https://clarice.ai/?via=diaria&"), `via=diaria deve ser preservado: ${href}`);
    assert.ok(html.includes(`<a href="${footerHrefEscaped("clarice")}">Clarice</a>`), html);
    assert.doesNotMatch(html, />Clarice News</);
  });
});

describe("#3113 item 5 — /leaderboard e /leaderboard/{YYYY}/arquivo ganham régua + rodapé de marca", () => {
  it("GET /leaderboard: régua teal entre kicker e h1, rodapé de marca antes de </body>", async () => {
    const html = await fetchHtml("/leaderboard");
    const kickerIdx = html.indexOf('<p class="kicker">');
    const ruleIdx = html.indexOf('<hr class="rule">');
    const h1Idx = html.indexOf("<h1>");
    const footerIdx = html.indexOf('<footer class="brand-footer">');
    const bodyCloseIdx = html.indexOf("</body>");
    assert.ok(kickerIdx >= 0 && ruleIdx >= 0 && h1Idx >= 0, "kicker, régua e h1 devem existir");
    assert.ok(kickerIdx < ruleIdx && ruleIdx < h1Idx, "ordem deve ser kicker → régua → h1");
    assert.ok(footerIdx >= 0 && footerIdx < bodyCloseIdx, "rodapé de marca deve existir antes de </body>");
    assert.ok(html.includes(`<a href="${footerHrefEscaped("diaria")}">Diar.ia</a>`), html);
  });

  it("GET /leaderboard/{YYYY}/arquivo: mesma régua + rodapé de marca", async () => {
    const html = await fetchHtml("/leaderboard/2026/arquivo");
    assert.match(html, /<p class="kicker">É IA\? — arquivo<\/p>\s*<hr class="rule">\s*<h1>/);
    assert.match(html, /<footer class="brand-footer">.*<\/footer>\s*<\/body>/s);
  });

  it("brand clarice: rodapé de marca usa clarice.ai (shortName), não diar.ia.br", async () => {
    const html = await fetchHtml("/leaderboard/2026?brand=clarice");
    assert.ok(html.includes(`<a href="${footerHrefEscaped("clarice")}">Clarice</a>`), html);
  });
});

describe("#3113 item 11 — renderArchiveVoteHtml ganha kicker + régua + rodapé de marca", () => {
  it("página de voto do arquivo: antes só tinha <title> como identidade — agora tem kicker, régua e rodapé", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    const kickerIdx = html.indexOf('<p class="kicker">É IA?</p>');
    const ruleIdx = html.indexOf('<hr class="rule">');
    const h1Idx = html.indexOf("<h1>Qual imagem");
    assert.ok(kickerIdx >= 0 && ruleIdx >= 0 && h1Idx >= 0, "kicker, régua e h1 devem existir");
    assert.ok(kickerIdx < ruleIdx && ruleIdx < h1Idx, "ordem deve ser kicker → régua → h1");
    assert.match(html, /<footer class="brand-footer">.*<\/footer>\s*<\/body>/s);
  });

  it("brand clarice: rodapé da página de voto do arquivo usa clarice.ai", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "clarice");
    const html = await res.text();
    assert.ok(html.includes(`<a href="${footerHrefEscaped("clarice")}">Clarice</a>`), html);
  });

  it("anti-gaming preservado: kicker/régua/rodapé novos não revelam qual imagem é IA (guarda de regressão do #2867)", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    assert.doesNotMatch(html, /🤖/);
    assert.doesNotMatch(html, /📷/);
    assert.doesNotMatch(html, /clicked|"you"/i);
  });
});

describe("#3113 item 8 — hint de scroll mobile na página de voto do arquivo", () => {
  it("hint textual real (não CSS ::after) entre as 2 escolhas, escondido por padrão", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    const choiceAIdx = html.indexOf('name="choice" value="A"');
    const hintIdx = html.indexOf('class="scroll-hint"');
    const choiceBIdx = html.indexOf('name="choice" value="B"');
    assert.ok(choiceAIdx >= 0 && hintIdx >= 0 && choiceBIdx >= 0, "escolha A, hint e escolha B devem existir");
    assert.ok(choiceAIdx < hintIdx && hintIdx < choiceBIdx, "hint deve ficar ENTRE as 2 escolhas no DOM");
    assert.match(html, /<p class="scroll-hint">.*Imagem B.*<\/p>/);
  });

  it("hint invisível por padrão (desktop já mostra as 2 lado a lado) e visível só no recorte mobile (<=600px)", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    assert.match(html, /\.scroll-hint\s*\{\s*display:\s*none;\s*\}/);
    const mediaBlockMatch = html.match(/@media \(max-width: 600px\) \{([^]*?)\n\s*\}\n/);
    assert.ok(mediaBlockMatch, "media query mobile deve existir");
    assert.match(mediaBlockMatch![1], /\.scroll-hint\s*\{[^}]*display:\s*block/);
  });
});
