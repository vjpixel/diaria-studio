/**
 * test/chat-drawer-mobile.test.ts (#3851) — cobertura estrutural do overlay
 * mobile do chat drawer (`chat-drawer.css`/`chat-drawer.js`). Mesmo
 * precedente já estabelecido em `studio-review-server.test.ts`
 * ("GET /chat-drawer.js expõe prefillMessage...") e documentado em
 * `studio-edicao-page.test.ts`: este projeto não tem harness de DOM
 * (sem jsdom/happy-dom no package.json) — a página real roda no browser, e a
 * cobertura possível daqui é "contrato estático": buscar o asset servido via
 * HTTP (mesmo static-serve.ts de produção) e afirmar estrutura via regex no
 * corpo, não render/clique simulado.
 *
 * Cobre especificamente os 5 problemas do #3851:
 *   1. chat aberto não espreme mais o conteúdo (nunca reserva margem no
 *      mobile, nem aberto nem fechado).
 *   2. modelo passa de "empurra" (margin-left) pra "overlay" (sobrepõe) só
 *      abaixo do breakpoint — o desktop (regras FORA do media query)
 *      continua no modelo push, byte-a-byte.
 *   3. o trilho colapsado de 44px deixa de ser um raíl grudado na borda
 *      esquerda — vira um FAB circular só no mobile.
 *   4. `dvh`/`var(--chat-viewport-height, …)` com cascade de fallback,
 *      escrita por `visualViewport` em chat-drawer.js — nome da custom
 *      property consistente entre os dois arquivos.
 *   5. alvos de toque ≥44px nos elementos interativos do estado mobile
 *      aberto + o botão de fechar explícito novo (`#chat-mobile-close`).
 *
 * Não cobre (documentado no PR body): validação visual em viewport real de
 * celular via Cloudflare Tunnel — este subagente não tem acesso a um
 * dispositivo real nem a Claude in Chrome nesta sessão.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

/** Remove comentários `/* ... *\/` antes das asserções estruturais — sem
 * isto, prosa de comentário que MENCIONA um valor antigo (ex: "removemos
 * `78vw`") faria uma asserção negativa (`doesNotMatch`) falhar por citar o
 * próprio valor que documenta ter sido removido, mesmo com o CSS real já
 * corrigido. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("chat-drawer overlay mobile (#3851)", () => {
  let root: string;
  let server: StudioServer;
  let cssBody: string; // corpo cru, só pra content-type/smoke check
  let css: string; // sem comentários — usado em TODAS as asserções estruturais
  let jsBody: string;
  let mediaIndex: number;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "chat-drawer-mobile-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });

    const cssRes = await fetch(new URL("/chat-drawer.css", server.url));
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get("content-type") ?? "", /text\/css/);
    cssBody = await cssRes.text();
    css = stripCssComments(cssBody);

    const jsRes = await fetch(new URL("/chat-drawer.js", server.url));
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get("content-type") ?? "", /javascript/);
    jsBody = await jsRes.text();

    mediaIndex = css.indexOf("@media (max-width: 720px)");
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe("breakpoint reaproveitado, não duplicado", () => {
    it("usa o breakpoint mobile já existente (720px) — decisão conservadora do PR", () => {
      assert.ok(mediaIndex > -1, "media query mobile deveria existir");
    });

    it("não introduz um SEGUNDO breakpoint no componente", () => {
      const mediaOccurrences = css.match(/@media/g) ?? [];
      assert.equal(mediaOccurrences.length, 1);
    });
  });

  describe("desktop intacto (regras FORA do media query, acima do breakpoint)", () => {
    it("o modelo push (margin-left) do desktop continua byte-a-byte", () => {
      const desktopBlock = css.slice(0, mediaIndex);
      assert.match(
        desktopBlock,
        /body\.chat-drawer-present\s*\{\s*margin-left:\s*var\(--chat-drawer-width\);\s*transition:\s*margin-left 0\.18s ease-out;\s*\}/,
      );
      assert.match(
        desktopBlock,
        /body\.chat-drawer-present\.chat-drawer-collapsed\s*\{\s*margin-left:\s*var\(--chat-drawer-collapsed-width\);\s*\}/,
      );
    });

    it("o painel base continua fixed/left/top/bottom (o antigo modelo de 'trilho à esquerda')", () => {
      const desktopBlock = css.slice(0, mediaIndex);
      assert.match(desktopBlock, /\.chat-drawer\s*\{[^}]*position:\s*fixed;[^}]*top:\s*0;[^}]*left:\s*0;[^}]*bottom:\s*0;/s);
      assert.match(desktopBlock, /\.chat-drawer\.collapsed\s*\{\s*width:\s*var\(--chat-drawer-collapsed-width\);\s*\}/);
    });

    it("o botão de fechar explícito mobile fica invisível por padrão (fora do media query)", () => {
      const desktopBlock = css.slice(0, mediaIndex);
      assert.match(desktopBlock, /\.chat-mobile-close\s*\{[^}]*display:\s*none;/s);
    });

    it("o antigo override '78vw' que espremia o conteúdo (#3851 problema 1) foi removido", () => {
      assert.doesNotMatch(css, /78vw/);
    });
  });

  describe("mobile: overlay em tela cheia, nunca mais 'empurra' o conteúdo", () => {
    it("nunca reserva margem pro chat no mobile — nem aberto, nem colapsado", () => {
      const mobileBlock = css.slice(mediaIndex);
      assert.match(
        mobileBlock,
        /body\.chat-drawer-present,\s*body\.chat-drawer-present\.chat-drawer-collapsed\s*\{\s*margin-left:\s*0;\s*\}/,
      );
    });

    it("o painel expandido cobre a tela inteira (overlay), não uma fatia lateral", () => {
      const mobileBlock = css.slice(mediaIndex);
      assert.match(mobileBlock, /\.chat-drawer\s*\{[^}]*left:\s*0;[^}]*right:\s*0;[^}]*top:\s*0;[^}]*width:\s*100%;/s);
    });
  });

  describe("teclado virtual (#3851 problema 4): cascade dvh/var(--chat-viewport-height)", () => {
    it("declara a altura em 3 camadas de fallback, na ordem certa (menos->mais preciso)", () => {
      const mobileBlock = css.slice(mediaIndex);
      const vhIndex = mobileBlock.indexOf("height: 100vh;");
      const dvhIndex = mobileBlock.indexOf("height: 100dvh;");
      const varIndex = mobileBlock.indexOf("height: var(--chat-viewport-height, 100dvh);");
      assert.ok(vhIndex > -1, "fallback 100vh universal deveria existir");
      assert.ok(dvhIndex > vhIndex, "100dvh deveria vir DEPOIS do fallback 100vh (cascade)");
      assert.ok(varIndex > dvhIndex, "var(--chat-viewport-height) deveria vir DEPOIS de 100dvh (cascade)");
    });

    it("o nome da custom property é o MESMO nos dois arquivos (CSS lê o que o JS escreve)", () => {
      assert.match(css, /var\(--chat-viewport-height, 100dvh\)/);
      assert.match(jsBody, /setProperty\("--chat-viewport-height",/);
    });

    it("chat-drawer.js sincroniza a var via visualViewport, fail-soft sem a API", () => {
      assert.match(jsBody, /function syncViewportHeight\(\)\s*\{/);
      assert.match(jsBody, /if\s*\(!window\.visualViewport\)\s*return;/);
      assert.match(jsBody, /window\.visualViewport\.addEventListener\("resize",\s*syncViewportHeight\)/);
      assert.match(jsBody, /window\.visualViewport\.addEventListener\("scroll",\s*syncViewportHeight\)/);
    });
  });

  describe("colapsado vira FAB, não um trilho de 44px sempre presente (#3851 problema 3)", () => {
    it("o FAB mobile é circular e >=44px de alvo de toque nos dois eixos", () => {
      const mobileBlock = css.slice(mediaIndex);
      assert.match(mobileBlock, /\.chat-drawer\.collapsed\s*\{[^}]*width:\s*56px;[^}]*height:\s*56px;[^}]*border-radius:\s*50%;/s);
    });

    it("o FAB fica ancorado num canto flutuante (right/bottom), não mais colado na borda esquerda", () => {
      const mobileBlock = css.slice(mediaIndex);
      assert.match(mobileBlock, /\.chat-drawer\.collapsed\s*\{[^}]*right:\s*1rem;[^}]*bottom:\s*1rem;/s);
    });
  });

  describe("alvos de toque ≥44px (#3851 problema 5)", () => {
    it("elementos interativos do estado aberto ganham min-height: 44px no mobile", () => {
      const mobileBlock = css.slice(mediaIndex);
      const touchTargetsRuleMatch = mobileBlock.match(
        /([^{}]+)\{\s*min-height:\s*44px;\s*\}/,
      );
      assert.ok(touchTargetsRuleMatch, "deveria existir uma regra min-height: 44px no mobile");
      const selectorList = touchTargetsRuleMatch![1];
      for (const selector of [
        "#chat-reset",
        ".chat-mobile-close",
        "#chat-send",
        ".chat-permission-option",
        ".chat-permission-submit",
        ".chat-tool-permission-btn",
      ]) {
        assert.ok(selectorList.includes(selector), `esperava "${selector}" na lista de alvos de toque, recebeu: ${selectorList}`);
      }
    });

    it("o botão de fechar explícito (#chat-mobile-close) só aparece quando o painel está expandido", () => {
      const mobileBlock = css.slice(mediaIndex);
      assert.match(
        mobileBlock,
        /\.chat-drawer:not\(\.collapsed\)\s*\.chat-mobile-close\s*\{\s*display:\s*inline-flex;/,
      );
    });
  });

  describe("chat-drawer.js: botão de fechar explícito (#chat-mobile-close)", () => {
    it("o markup do botão existe no template do painel", () => {
      assert.match(jsBody, /id="chat-mobile-close"/);
      assert.match(jsBody, /class="chat-mobile-close"/);
    });

    it("o botão é resolvido em `el` e reusa setCollapsed(true) — mesma ação do toggle, não lógica nova", () => {
      assert.match(jsBody, /mobileClose:\s*drawer\.querySelector\("#chat-mobile-close"\)/);
      assert.match(jsBody, /el\.mobileClose\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*setCollapsed\(true\);\s*\}\);/);
    });
  });

  describe("regressão — comportamento pré-#3851 preservado", () => {
    it("o toggle de expandir/recolher original continua intacto", () => {
      assert.match(
        jsBody,
        /el\.expandToggle\.addEventListener\("click", \(\) => \{\s*setCollapsed\(!drawer\.classList\.contains\("collapsed"\)\);\s*\}\);/,
      );
    });

    it("prefillMessage e o contrato de window.diariaStudioChat continuam expostos (#3629, +scrollToPendingCard #3870)", () => {
      assert.match(jsBody, /function prefillMessage\(/);
      assert.match(
        jsBody,
        /window\.diariaStudioChat\s*=\s*\{\s*sendMessage,\s*openDrawer:\s*expandDrawer,\s*prefillMessage,\s*setContext,\s*scrollToPendingCard\s*\};/,
      );
    });
  });
});
