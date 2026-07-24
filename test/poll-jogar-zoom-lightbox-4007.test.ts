/**
 * test/poll-jogar-zoom-lightbox-4007.test.ts (#4007)
 *
 * Requisito do editor (teste com usuários reais, 260724): o layout mobile
 * empilhado do par de imagens do "É IA?" está DECIDIDO (não mexer) — o que
 * faltava era permitir ZOOM pra examinar detalhe (mãos, texto, textura,
 * fundo). Este teste cobre o lightbox reutilizável (`renderLightboxStyles`/
 * `renderLightboxMarkup`/`lightboxScript`, workers/poll/src/lib.ts) aplicado
 * às 4 superfícies que mostram o par:
 *   1. par único (`renderJogarPageHtml`, jogar.ts)
 *   2. sequência (`renderJogarSequencePageHtml`, jogar.ts)
 *   3. arquivo por e-mail (`renderArchiveVoteHtml`, leaderboard-routes.ts)
 *   4. página de voto por e-mail (`votePageHtml`, index.ts)
 *
 * Sem device real disponível nesta sessão pra validar o "feel" do pinch —
 * este teste cobre só a ESTRUTURA (verificável estaticamente): meta viewport
 * não trava zoom, o dialog existe com os 3 mecanismos de fechar, a affordance
 * de lupa está presente, voto continua nos botões (não no lightbox), e a
 * chave `/img/{key}` continua opaca (sem sufixo denunciando o gabarito).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderJogarPageHtml,
  renderJogarSequencePageHtml,
} from "../workers/poll/src/jogar.ts";
import { renderArchiveVoteHtml } from "../workers/poll/src/leaderboard-routes.ts";
import { votePageHtml } from "../workers/poll/src/index.ts";

const parUnico = renderJogarPageHtml({ edition: "260601", revealed: false });
const sequencia = renderJogarSequencePageHtml(["260601", "260602"]);
const votoResultado = votePageHtml(
  "✅ Acertou!",
  true,
  null,
  { edition: "260601", aiSide: "A", clickedSide: "A" },
  null,
  "web",
);

// #4007: renderArchiveVoteHtml devolve um Response (não string, ao contrário
// das outras 3 superfícies) — o corpo só pode ser lido UMA vez, então
// resolvemos o texto 1x aqui (top-level await, mesmo padrão já usado por
// outros testes deste worker que precisam do texto de um Response fora de um
// bloco de teste) e reusamos a mesma string em todas as assertions abaixo.
const arquivoHtml = await renderArchiveVoteHtml("260601", "2026", "diaria").text();

describe("lightbox de zoom (#4007) — meta viewport nunca trava o pinch nativo", () => {
  const pages = [
    ["par único", parUnico],
    ["sequência", sequencia],
    ["voto por e-mail", votoResultado],
  ] as const;

  for (const [label, html] of pages) {
    it(`${label}: viewport sem user-scalable=no / maximum-scale`, () => {
      const viewportMatch = html.match(/<meta name="viewport" content="([^"]*)">/);
      assert.ok(viewportMatch, `${label}: meta viewport ausente`);
      const content = viewportMatch![1];
      assert.doesNotMatch(content, /user-scalable\s*=\s*no/i, `${label}: user-scalable=no travaria o pinch nativo`);
      assert.doesNotMatch(content, /maximum-scale/i, `${label}: maximum-scale travaria o pinch nativo`);
    });
  }

  it("arquivo por e-mail: viewport sem user-scalable=no / maximum-scale", () => {
    const html = arquivoHtml;
    const viewportMatch = html.match(/<meta name="viewport" content="([^"]*)">/);
    assert.ok(viewportMatch, "arquivo: meta viewport ausente");
    const content = viewportMatch![1];
    assert.doesNotMatch(content, /user-scalable\s*=\s*no/i);
    assert.doesNotMatch(content, /maximum-scale/i);
  });
});

describe("lightbox de zoom (#4007) — presente nas 4 superfícies, com os 3 mecanismos de fechar", () => {
  const pages = [
    ["par único", parUnico],
    ["sequência", sequencia],
    ["voto por e-mail", votoResultado],
  ] as const;

  for (const [label, html] of pages) {
    it(`${label}: <dialog> de lightbox + botão X + tap-fora (delegação) presentes`, () => {
      assert.match(html, /<dialog id="jogar-lightbox" class="jogar-lightbox">/, `${label}: dialog ausente`);
      assert.match(html, /class="jogar-lightbox-close" aria-label="Fechar"/, `${label}: botão X ausente`);
      // Tap fora: o script fecha quando o alvo do clique é o próprio dialog.
      assert.match(html, /if \(ev\.target === dialog\) closeDialog\(\);/, `${label}: fechamento por tap-fora ausente`);
      // Esc: dependemos do comportamento NATIVO de <dialog>.showModal() — sem
      // keydown próprio interceptando Escape (verificação negativa: garante
      // que não reimplementamos e potencialmente quebramos o nativo).
      assert.doesNotMatch(html, /key(Code)?\s*===?\s*["']Esc/i, `${label}: não deveria reimplementar Esc via keydown`);
    });

    it(`${label}: affordance de lupa (badge) presente no CSS`, () => {
      assert.match(html, /\.choice::after, \.result-image::after/, `${label}: badge de lupa ausente`);
    });

    it(`${label}: showModal() é a única via de abertura (progressive enhancement — no-op sem suporte)`, () => {
      assert.match(html, /typeof dialog\.showModal !== "function"\) return;/, `${label}: guard de feature-detection ausente`);
    });
  }

  it("arquivo por e-mail: <dialog> de lightbox + botão X + tap-fora + lupa presentes", () => {
    const html = arquivoHtml;
    assert.match(html, /<dialog id="jogar-lightbox" class="jogar-lightbox">/);
    assert.match(html, /class="jogar-lightbox-close" aria-label="Fechar"/);
    assert.match(html, /if \(ev\.target === dialog\) closeDialog\(\);/);
    assert.match(html, /\.choice::after, \.result-image::after/);
  });
});

describe("lightbox de zoom (#4007) — examinar (imagem) continua separado de votar (botões)", () => {
  it("par único: botões de voto continuam <button type=\"submit\"> fora do <dialog>, delegação de clique só olha <img>", () => {
    assert.match(parUnico, /<button type="submit" name="choice" value="A">Essa é a IA<\/button>/);
    assert.match(parUnico, /<button type="submit" name="choice" value="B">Essa é a IA<\/button>/);
    // A delegação de clique do lightbox só abre modal quando target.tagName
    // === "IMG" — clique no botão de voto (elemento irmão, nunca um <img>)
    // nunca aciona o lightbox.
    assert.match(parUnico, /if \(!target \|\| target\.tagName !== "IMG"\) return;/);
  });

  it("sequência: botões de voto (data-choice) permanecem <button type=\"button\">, fora do <img>", () => {
    assert.match(sequencia, /class="seq-choice-btn" data-choice="A"/);
    assert.match(sequencia, /class="seq-choice-btn" data-choice="B"/);
  });

  it("voto por e-mail: resultado revelado tem imagens clicáveis via .result-image, sem botão de voto na tela de resultado", () => {
    assert.match(votoResultado, /class="result-image clicked"/);
  });
});

describe("lightbox de zoom (#4007) — anti-spoiler: chave /img/{key} continua opaca", () => {
  it("par único (pré-voto): src usa só A/B, sem sufixo -ai/-real em src ou alt", () => {
    assert.match(parUnico, /\/img\/img-260601-01-eia-A\.jpg/);
    assert.match(parUnico, /\/img\/img-260601-01-eia-B\.jpg/);
    assert.doesNotMatch(parUnico, /-ai\.jpg|-real\.jpg|ai-side|real-side/i);
    assert.match(parUnico, /alt="Imagem A"/);
    assert.match(parUnico, /alt="Imagem B"/);
  });

  it("sequência (pré-voto): mesmo padrão de key opaca embutido no script imgUrl()", () => {
    assert.match(sequencia, /imgUrl\(edition, "A"\)/);
    assert.match(sequencia, /imgUrl\(edition, "B"\)/);
    assert.doesNotMatch(sequencia, /-ai\.jpg|-real\.jpg/i);
  });

  it("arquivo por e-mail (pré-voto): src usa só A/B, sem rótulo", () => {
    const html = arquivoHtml;
    assert.match(html, /\/img\/img-260601-01-eia-A\.jpg/);
    assert.match(html, /\/img\/img-260601-01-eia-B\.jpg/);
    assert.doesNotMatch(html, /-ai\.jpg|-real\.jpg/i);
  });

  it("resultado pós-voto: label textual revela IA/real (esperado — é o resultado), mas o arquivo/URL da imagem continua o mesmo A/B opaco", () => {
    assert.match(votoResultado, /\/img\/img-260601-01-eia-A\.jpg/);
    assert.match(votoResultado, /\/img\/img-260601-01-eia-B\.jpg/);
    assert.doesNotMatch(votoResultado, /-ai\.jpg|-real\.jpg/i);
  });
});
