/**
 * test/encerramento-social-apoio-3219.test.ts (#3219, regressão #633; reescopo #4413/#4411)
 *
 * A edição mensal 2606-07 enviada saiu com um parágrafo de apoio (Apoia.se)
 * ao lado do convite social (LinkedIn/Facebook) no bloco de encerramento —
 * um ajuste feito manualmente direto na campanha, nunca refletido no
 * template/repo (mesmo padrão do #2866: ajuste aprovado numa edição
 * específica vira fonte canônica permanente).
 *
 * #4413/#4411 (260801, decisão do editor): o convite social e a lista de
 * pills "Acesse nossas curadorias" tinham, respectivamente, 5 e 3 grafias
 * divergentes entre diário/mensal/config/docs. Os dois viraram BLOCOS FIXOS
 * — `SOCIAL_INVITE`/`CURADORIA_PILLS` em `scripts/lib/shared/encerramento-snippet.ts`,
 * nunca mais editáveis por edição. `context/snippets/encerramento-social-apoio.md`
 * ficou só com o parágrafo de apoio + créditos de ferramentas (a única parte
 * ainda editável, via painel Caixas / `platform.config.json` → `para_encerrar.slot_a`).
 *
 * Este teste cobre:
 *   1. `context/snippets/encerramento-social-apoio.md` — o texto aprovado
 *      (parágrafo de apoio + ferramentas) existe, com o marcador
 *      `{{OPENING}}` e o link canônico do Apoia.se.
 *   2. `scripts/lib/shared/encerramento-snippet.ts` — o loader/render
 *      substitui `{{OPENING}}` corretamente pras duas variantes (diário
 *      vazio, mensal com a cláusula de contexto), sem vazamento cruzado;
 *      `SOCIAL_INVITE`/`CURADORIA_PILLS` são os blocos fixos.
 *   3. `scripts/stitch-newsletter.ts` — o diário (`buildParaEncerrar` /
 *      `stitchNewsletter`) usa o snippet pro slot A + os 2 blocos fixos,
 *      nessa ordem, sempre.
 *   4. `.claude/agents/writer-monthly.md` — documenta a mesma fonte E a
 *      mesma cláusula de abertura mensal, e CITA `SOCIAL_INVITE`/
 *      `CURADORIA_PILLS` literalmente (drift-guard, #4413/#4411).
 *   5. `context/templates/newsletter-monthly.md`/`newsletter.md` — citam as
 *      mesmas constantes literalmente (drift-guard entre as duas superfícies).
 *   6. Integração de render: o texto novo passa por
 *      `scripts/lib/newsletter-render-html.ts` (diário) e
 *      `scripts/lib/mensal/monthly-render.ts` (mensal) sem quebrar — CTA
 *      final continua caindo no box destacado, links resolvem certo.
 *
 * #4139 (mesma doença que o #4083 corrigiu em stitch-newsletter.test.ts):
 * testes de MECANISMO (load/render/stitch) rodam contra uma fixture ESTÁVEL
 * (`STABLE_ENCERRAMENTO_FIXTURE`, escrita transitoriamente via
 * `withSnippetContent`/`withStableSnippet`) em vez do arquivo REAL — a lista
 * de recompensas do Apoia.se é rotação editorial normal (já mudou 2×) e não
 * deveria quebrar CI sem regressão nenhuma. Só o describe "guardas de forma"
 * no topo do arquivo lê o arquivo real, e só verifica invariantes de FORMA
 * (marcador, link canônico, ausência de placeholder) — nunca texto exato de
 * recompensa.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadEncerramentoSocialApoioTemplate,
  renderEncerramentoSocialApoio,
  ENCERRAMENTO_OPENING_DAILY,
  ENCERRAMENTO_OPENING_MONTHLY,
  SOCIAL_INVITE,
  CURADORIA_PILLS,
} from "../scripts/lib/shared/encerramento-snippet.ts";
import { buildParaEncerrar, type ParaEncerrarConfig } from "../scripts/stitch-newsletter.ts";
import { renderEncerrar } from "../scripts/lib/newsletter-render-html.ts";
import { renderEncerramento } from "../scripts/lib/mensal/monthly-render.ts";
import { extractTemplateBlock } from "../scripts/lib/newsletter-parse.ts";
import {
  DIARIA_LINKEDIN_PAGE_URL,
  DIARIA_FACEBOOK_PAGE_URL,
  DIARIA_INSTAGRAM_URL,
  DIARIA_THREADS_URL,
  DIARIA_X_URL,
  DIARIA_APOIASE_URL,
} from "../scripts/lib/canonical-urls.ts";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const SNIPPET_PATH = join(ROOT, "context", "snippets", "encerramento-social-apoio.md");
const WRITER_MONTHLY_MD = join(ROOT, ".claude", "agents", "writer-monthly.md");
const NEWSLETTER_MONTHLY_TEMPLATE = join(ROOT, "context", "templates", "newsletter-monthly.md");
const NEWSLETTER_DAILY_TEMPLATE = join(ROOT, "context", "templates", "newsletter.md");

// ─── #4139 — fixture ESTÁVEL do snippet de encerramento ────────────────────
// Mesma doença que o #4083 corrigiu em test/stitch-newsletter.test.ts: testes
// de MECANISMO (load/render/stitch) não devem depender do que
// context/snippets/encerramento-social-apoio.md diz HOJE — rotação editorial
// normal (a lista de recompensas do Apoia.se já mudou 2×) quebrava CI sem
// regressão nenhuma de código. A fixture abaixo preserva a ESTRUTURA real
// (marcador {{OPENING}}, abertura do parágrafo de apoio, parágrafo de
// ferramentas) mas troca o conteúdo por texto sintético — nenhum teste de
// mecanismo deveria se importar com QUAL recompensa/ferramenta está listada,
// só que ela passe intacta. #4413: o arquivo tem só 2 parágrafos agora (o
// convite social virou bloco fixo, `SOCIAL_INVITE`, fora deste arquivo).
// Escrita via `withStableSnippet` — grava, roda, restaura no finally.
const STABLE_ENCERRAMENTO_FIXTURE = `{{OPENING}}Apoie a curadoria contribuindo a partir de R$5/mês em [apoia.se/diaria](${DIARIA_APOIASE_URL}) para ganhar recompensas como **acesso a bastidores de teste**, **brindes fixture** e **prioridade em enquetes**.

Nesta edição da **diar.ia.br**, usei uma ferramenta fixture qualquer para os testes ([link fixture](https://exemplo-fixture.test/ferramenta)).`;

const originalSnippetContent = readFileSync(SNIPPET_PATH, "utf8");

/** Grava `content` em SNIPPET_PATH, roda `fn`, restaura o original no finally. */
function withSnippetContent<T>(content: string, fn: () => T): T {
  writeFileSync(SNIPPET_PATH, content, "utf8");
  try {
    return fn();
  } finally {
    writeFileSync(SNIPPET_PATH, originalSnippetContent, "utf8");
  }
}

/** Atalho: roda `fn` com a fixture estável de encerramento gravada no arquivo. */
function withStableSnippet<T>(fn: () => T): T {
  return withSnippetContent(STABLE_ENCERRAMENTO_FIXTURE, fn);
}

describe("context/snippets/encerramento-social-apoio.md — guardas de forma (#4139, rotação editorial não deve quebrar CI)", () => {
  // #4139: só invariantes de FORMA são verificados contra o arquivo REAL —
  // mesmo raciocínio do describe "guardas de forma" em stitch-newsletter.test.ts
  // (#4083). Conteúdo específico (recompensas, texto exato) é testado contra a
  // fixture estável acima, nos describes de mecanismo logo abaixo.
  const raw = readFileSync(SNIPPET_PATH, "utf8");

  it("tem o marcador {{OPENING}} pra parametrizar a abertura", () => {
    assert.match(raw, /\{\{OPENING\}\}/);
  });

  it("referencia o link canônico apoia.se/diaria (constante, não hardcoded)", () => {
    assert.match(raw, new RegExp(DIARIA_APOIASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("não menciona mais o convite social (#4413 — virou bloco fixo fora deste arquivo)", () => {
    assert.doesNotMatch(raw, /\[LinkedIn\]/, "convite social não deveria mais morar neste arquivo");
    assert.doesNotMatch(raw, /\[X\]\(https:\/\/x\.com/, "convite social não deveria mais morar neste arquivo");
  });

  it("não carrega placeholder não substituído além do {{OPENING}} (ex: {mês} esquecido)", () => {
    // `{{OPENING}}` pode aparecer mais de 1x no arquivo cru (o marcador em si +
    // menções em texto de documentação dentro do comentário HTML de header) —
    // /g garante que TODAS as ocorrências saem antes de procurar por outros
    // placeholders (sem /g, uma 2ª menção sobrava e o scanner genérico casava
    // um `{{OPENING}` parcial, falso-positivo).
    const withoutOpeningMarker = raw.replace(/\{\{OPENING\}\}/g, "");
    const found = withoutOpeningMarker.match(/\{[^}\n]{1,40}\}/g);
    assert.equal(
      found,
      null,
      `snippet tem placeholder não substituído: ${found?.join(", ")} — ou resolva no texto, ou implemente a substituição`,
    );
  });
});

describe("context/snippets/encerramento-social-apoio.md — mecanismo de load/render (#4139, fixture estável, independe de rotação editorial)", () => {
  it("loadEncerramentoSocialApoioTemplate retorna o corpo sem o comentário HTML de header", () => {
    withStableSnippet(() => {
      const template = loadEncerramentoSocialApoioTemplate();
      assert.ok(template, "template não deveria ser null");
      assert.doesNotMatch(template!, /<!--/);
      assert.match(template!, /\{\{OPENING\}\}/);
    });
  });

  it("variante DIÁRIA (opening vazio): abre direto em 'Apoie a curadoria', sem a cláusula mensal, preservando a recompensa do snippet intacta", () => {
    withStableSnippet(() => {
      const out = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY);
      assert.ok(out);
      assert.match(out!, /^Apoie a curadoria contribuindo/);
      assert.match(out!, /acesso a bastidores de teste/, "recompensa do fixture deveria passar intacta pelo render");
      assert.doesNotMatch(out!, /Essa edição mensal nasce/);
      assert.doesNotMatch(out!, /\{\{OPENING\}\}/, "marcador não deve sobrar sem substituição");
    });
  });

  it("variante MENSAL: inclui a cláusula de contexto antes de 'Apoie a curadoria', com 1 espaço (sem colar as duas frases)", () => {
    withStableSnippet(() => {
      const out = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_MONTHLY);
      assert.ok(out);
      assert.match(
        out!,
        /^Essa edição mensal nasce da \*\*diar\.ia\.br\*\*, newsletter diária gratuita sobre IA\. Apoie a curadoria contribuindo/,
      );
      // nunca colado sem espaço nem espaço duplo
      assert.doesNotMatch(out!, /IA\.Apoie/);
      assert.doesNotMatch(out!, /IA\.  Apoie/);
    });
  });

  it("o parágrafo de ferramentas é IDÊNTICO nas duas variantes (só a abertura do parágrafo de apoio muda)", () => {
    withStableSnippet(() => {
      const daily = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY)!;
      const monthly = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_MONTHLY)!;
      const toolsParaOf = (s: string) => s.split(/\n\n+/).pop();
      assert.equal(toolsParaOf(daily), toolsParaOf(monthly));
      assert.match(toolsParaOf(daily)!, /link fixture/);
    });
  });
});

describe("SOCIAL_INVITE / CURADORIA_PILLS — blocos fixos, mesma constante em diária e mensal (#4413/#4411, drift-guard)", () => {
  it("SOCIAL_INVITE menciona os 5 canais na ordem LinkedIn > Instagram > Threads > Facebook > X", () => {
    const order = [
      DIARIA_LINKEDIN_PAGE_URL,
      DIARIA_INSTAGRAM_URL,
      DIARIA_THREADS_URL,
      DIARIA_FACEBOOK_PAGE_URL,
      DIARIA_X_URL,
    ].map((url) => SOCIAL_INVITE.indexOf(url));
    assert.ok(order.every((i) => i >= 0), "algum canal está ausente do SOCIAL_INVITE");
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i] > order[i - 1], "ordem dos canais incorreta em SOCIAL_INVITE");
    }
  });

  it("CURADORIA_PILLS tem exatamente 4 pills, nesta ordem: Cursos, Livros, Equipamentos, Arquivo (#4536)", () => {
    const idxCursos = CURADORIA_PILLS.indexOf("[Cursos]");
    const idxLivros = CURADORIA_PILLS.indexOf("[Livros]");
    const idxEquip = CURADORIA_PILLS.indexOf("[Equipamentos]");
    const idxArquivo = CURADORIA_PILLS.indexOf("[Arquivo]");
    assert.ok(
      idxCursos >= 0 && idxLivros > idxCursos && idxEquip > idxLivros && idxArquivo > idxEquip,
      "ordem/labels das pills incorretos",
    );
    assert.equal(CURADORIA_PILLS.split("\n").length, 4, "deveriam existir exatamente 4 linhas de pill");
  });

  it("Cursos/Livros/Arquivo levam UTM (newsletter→curadoria); Equipamentos fica sem, #4553)", () => {
    assert.match(
      CURADORIA_PILLS,
      /\[Cursos\]\(https:\/\/cursos\.diar\.ia\.br\?utm_source=newsletter&utm_medium=email&utm_campaign=cursos-rodape\)/,
    );
    assert.match(
      CURADORIA_PILLS,
      /\[Livros\]\(https:\/\/livros\.diar\.ia\.br\?utm_source=newsletter&utm_medium=email&utm_campaign=livros-rodape\)/,
    );
    assert.match(
      CURADORIA_PILLS,
      /\[Arquivo\]\(https:\/\/arquivo\.diar\.ia\.br\?utm_source=newsletter&utm_medium=email&utm_campaign=arquivo-rodape\)/,
    );
    assert.match(CURADORIA_PILLS, /\[Equipamentos\]\(https:\/\/www\.amazon\.com\.br\/shop\/vjpixel\)/);
  });

  it("buildParaEncerrar() (diária) usa exatamente SOCIAL_INVITE como último parágrafo", () => {
    const out = buildParaEncerrar({ slotA: null });
    assert.ok(out.trimEnd().endsWith(SOCIAL_INVITE), "convite social deveria ser o SOCIAL_INVITE exato, no final da seção");
  });

  it("buildParaEncerrar() (diária) inclui CURADORIA_PILLS antes do convite social", () => {
    const out = buildParaEncerrar({ slotA: null });
    assert.ok(out.includes(CURADORIA_PILLS));
    assert.ok(out.indexOf(CURADORIA_PILLS) < out.indexOf(SOCIAL_INVITE));
  });

  it("writer-monthly.md cita SOCIAL_INVITE e CURADORIA_PILLS literalmente (drift-guard, mesma fonte do diário)", () => {
    const content = readFileSync(WRITER_MONTHLY_MD, "utf8");
    assert.ok(content.includes(SOCIAL_INVITE), "writer-monthly.md deve citar o convite social literalmente igual à constante SOCIAL_INVITE");
    assert.ok(content.includes(CURADORIA_PILLS), "writer-monthly.md deve citar as pills literalmente iguais à constante CURADORIA_PILLS");
  });

  it("newsletter-monthly.md (template doc) cita SOCIAL_INVITE e CURADORIA_PILLS literalmente", () => {
    const content = readFileSync(NEWSLETTER_MONTHLY_TEMPLATE, "utf8");
    assert.ok(content.includes(SOCIAL_INVITE));
    assert.ok(content.includes(CURADORIA_PILLS));
  });

  it("newsletter.md (template doc diário) cita SOCIAL_INVITE e CURADORIA_PILLS literalmente", () => {
    const content = readFileSync(NEWSLETTER_DAILY_TEMPLATE, "utf8");
    assert.ok(content.includes(SOCIAL_INVITE));
    assert.ok(content.includes(CURADORIA_PILLS));
  });
});

describe("scripts/stitch-newsletter.ts — PARA ENCERRAR usa o snippet compartilhado + blocos fixos (#3219/#4413/#4411)", () => {
  it("buildParaEncerrar preserva o cabeçalho + parágrafo de ferramentas + pills de curadoria (labels curtos, #4411)", () => {
    const out = buildParaEncerrar();
    assert.match(out, /\*\*🙋🏼‍♀️ PARA ENCERRAR\*\*/);
    assert.match(out, /usei Claude Code para automatizar parte da pesquisa/);
    // #4411: labels curtos ("Cursos de IA"/"Livros sobre IA" → "Cursos"/"Livros").
    // #4536/#4553: Cursos/Livros/Arquivo levam UTM newsletter→curadoria; Equipamentos não.
    assert.match(out, /- \[Cursos\]\(https:\/\/cursos\.diar\.ia\.br\?utm_source=newsletter&utm_medium=email&utm_campaign=cursos-rodape\)/);
    assert.match(out, /- \[Livros\]\(https:\/\/livros\.diar\.ia\.br\?utm_source=newsletter&utm_medium=email&utm_campaign=livros-rodape\)/);
    assert.match(out, /- \[Equipamentos\]\(https:\/\/www\.amazon\.com\.br\/shop\/vjpixel\)/);
    assert.match(out, /- \[Arquivo\]\(https:\/\/arquivo\.diar\.ia\.br\?utm_source=newsletter&utm_medium=email&utm_campaign=arquivo-rodape\)/);
  });

  it("#4357: override de para_encerrar.slot_a (texto arbitrário, sem lista) NÃO apaga a linha de pills 'Acesse nossas curadorias'", () => {
    // Reprodução exata do bug relatado: editor sobrescreve o Slot A pelo
    // painel Caixas com texto arbitrário (sem a lista `- [...]`) — antes do
    // #4357, isso apagava as pills junto (concatenadas dentro do default do
    // slot A). Agora as pills são um bloco fixo, concatenado FORA do
    // alcance do override.
    const out = buildParaEncerrar({
      slotA: "Apoie a curadoria contribuindo a partir de R$5/mês em [apoia.se/diaria](https://apoia.se/diaria). Nesta edição, usei alguns equipamentos legais.",
    });
    assert.equal((out.match(/\[Cursos\]/g) ?? []).length, 1, "não deveria haver duplicação — só 1 ocorrência da pill");
    assert.match(out, /- \[Cursos\]\(https:\/\/cursos\.diar\.ia\.br\?utm_source=newsletter&utm_medium=email&utm_campaign=cursos-rodape\)/);
    assert.match(out, /- \[Livros\]\(https:\/\/livros\.diar\.ia\.br\?utm_source=newsletter&utm_medium=email&utm_campaign=livros-rodape\)/);
    assert.match(out, /- \[Equipamentos\]\(https:\/\/www\.amazon\.com\.br\/shop\/vjpixel\)/);
    assert.match(out, /- \[Arquivo\]\(https:\/\/arquivo\.diar\.ia\.br\?utm_source=newsletter&utm_medium=email&utm_campaign=arquivo-rodape\)/);
  });

  it("#4413: um eventual slot_b em platform.config.json/override (config legado) é ignorado — convite social nunca varia", () => {
    const out = buildParaEncerrar({ slotA: null, slotB: "Um convite social qualquer, sem nenhuma lista." } as ParaEncerrarConfig);
    assert.ok(out.includes(SOCIAL_INVITE), "convite social deveria ser sempre o texto fixo, ignorando qualquer slotB");
    assert.ok(!out.includes("Um convite social qualquer"), "slotB nunca deveria aparecer no output — bloco fixo (#4413)");
  });

  it("buildParaEncerrar inclui o parágrafo de apoio (Apoia.se, do snippet) e o convite social fixo (SOCIAL_INVITE)", () => {
    withStableSnippet(() => {
      const out = buildParaEncerrar();
      assert.match(out, /Apoie a curadoria contribuindo a partir de R\$5\/mês em \[apoia\.se\/diaria\]\(https:\/\/apoia\.se\/diaria\)/);
      assert.ok(out.includes(SOCIAL_INVITE));
    });
  });

  it("buildParaEncerrar NÃO vaza a cláusula de abertura mensal pro diário", () => {
    withStableSnippet(() => {
      // #4139 (mesmo cuidado do #4044/#4138): prova PRIMEIRO que o parágrafo
      // de apoio da fixture foi de fato injetado (positivo) antes de provar a
      // AUSÊNCIA da cláusula mensal — senão a ausência seria satisfeita tanto
      // pelo comportamento correto quanto por um bug que descartasse o
      // snippet inteiro (ex: caísse sempre no fallback hardcoded genérico,
      // que também não contém "Essa edição mensal nasce").
      const out = buildParaEncerrar();
      assert.match(out, /Apoie a curadoria contribuindo/, "pré-condição: parágrafo de apoio foi de fato injetado");
      assert.doesNotMatch(out, /Essa edição mensal nasce/);
    });
  });

  it("ordem final (#3368/#4413): cabeçalho > apoio > ferramentas > pills > convite social fixo", () => {
    withStableSnippet(() => {
      const out = buildParaEncerrar();
      const headerIdx = out.indexOf("PARA ENCERRAR");
      const apoioIdx = out.indexOf("apoia.se/diaria");
      const toolsIdx = out.indexOf("Nesta edição da");
      const pillsIdx = out.indexOf("[Cursos]");
      const socialIdx = out.indexOf(SOCIAL_INVITE);
      assert.ok(
        headerIdx >= 0 && headerIdx < apoioIdx && apoioIdx < toolsIdx && toolsIdx < pillsIdx && pillsIdx < socialIdx,
        "ordem incorreta",
      );
    });
  });

  it("o parágrafo de apoio é o PRIMEIRO parágrafo depois do cabeçalho (#3368)", () => {
    withStableSnippet(() => {
      const out = buildParaEncerrar();
      const afterHeader = out.slice(out.indexOf("**🙋🏼‍♀️ PARA ENCERRAR**") + "**🙋🏼‍♀️ PARA ENCERRAR**".length).trimStart();
      assert.match(afterHeader, /^Apoie a curadoria contribuindo/);
    });
  });

  it("o convite social fixo é o ÚLTIMO parágrafo da seção (#3368/#4413), mesmo com slotA customizado", () => {
    const out = buildParaEncerrar({ slotA: "Texto A qualquer, customizado pelo editor." });
    assert.match(out.trimEnd(), new RegExp(`${SOCIAL_INVITE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  });
});

describe(".claude/agents/writer-monthly.md — parágrafo de apoio + convite social (#3219)", () => {
  const content = readFileSync(WRITER_MONTHLY_MD, "utf8");

  it("referencia o snippet canônico context/snippets/encerramento-social-apoio.md", () => {
    assert.match(content, /context\/snippets\/encerramento-social-apoio\.md/);
  });

  it("instrui a substituir {{OPENING}} pela variante mensal", () => {
    assert.match(content, /\{\{OPENING\}\}/);
  });

  it("a cláusula de abertura mensal documentada no prompt bate EXATAMENTE com ENCERRAMENTO_OPENING_MONTHLY (drift-guard)", () => {
    assert.ok(
      content.includes(ENCERRAMENTO_OPENING_MONTHLY.trim()),
      "writer-monthly.md deve citar a cláusula de abertura mensal literalmente igual à constante ENCERRAMENTO_OPENING_MONTHLY — evita 2 fontes de verdade divergindo",
    );
  });

  it("passo 8 usa o label canônico PARA ENCERRAR (renomeado de ENCERRAMENTO, #3219)", () => {
    assert.match(content, /\*\*PARA ENCERRAR\*\*/);
  });
});

describe("templates — nomeação de seção PARA ENCERRAR (#3219)", () => {
  it("newsletter-monthly.md usa **PARA ENCERRAR** no bloco de formato (não mais ENCERRAMENTO)", () => {
    const content = readFileSync(NEWSLETTER_MONTHLY_TEMPLATE, "utf8");
    assert.match(content, /\*\*PARA ENCERRAR\*\*/);
    assert.doesNotMatch(content, /\*\*ENCERRAMENTO\*\*/, "nome antigo não deve mais aparecer no bloco de formato — writer-monthly já gerava PARA ENCERRAR na prática");
  });

  it("newsletter.md (diário) documenta a fonte do parágrafo de apoio/ferramentas", () => {
    const content = readFileSync(NEWSLETTER_DAILY_TEMPLATE, "utf8");
    assert.match(content, /encerramento-social-apoio\.md/);
  });
});

describe("integração de render — diário (renderEncerrar processa o novo bloco, #3219/#4413, fixture estável #4139)", () => {
  it("o HTML resultante inclui o link de apoio e o CTA social (5 canais), com o parágrafo social boxed (CTA)", () => {
    withStableSnippet(() => {
      const full = buildParaEncerrar();
      const body = extractTemplateBlock(full, "🙋🏼‍♀️ PARA ENCERRAR");
      assert.ok(body, "extractTemplateBlock deveria achar o corpo do bloco");
      const html = renderEncerrar(body!);
      assert.match(html, /href="https:\/\/apoia\.se\/diaria"/);
      assert.match(html, new RegExp(`href="${DIARIA_LINKEDIN_PAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      assert.match(html, new RegExp(`href="${DIARIA_INSTAGRAM_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      assert.match(html, new RegExp(`href="${DIARIA_THREADS_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      assert.match(html, new RegExp(`href="${DIARIA_FACEBOOK_PAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      assert.match(html, new RegExp(`href="${DIARIA_X_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      assert.match(html, /Para acompanhar as 3 principais notícias de IA todos os dias/);
    });
  });
});

describe("integração de render — mensal (renderEncerramento processa o novo bloco, #3219/#4413/#4411, fixture estável #4139)", () => {
  it("o HTML resultante inclui o link de apoio, as pills e o CTA social ao lado do encerramento padrão existente", () => {
    withStableSnippet(() => {
      const encerramentoPadrao =
        "Quer sugerir um tema ou tirar uma dúvida sobre o que está aqui? Responda a este e-mail. Se ainda não recebe a diar.ia.br diária, assine em https://diar.ia.br/?utm_source=mensal-brevo.";
      const apoioFerramentas = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_MONTHLY)!;
      const body = `${encerramentoPadrao}\n\n${apoioFerramentas}\n\n${CURADORIA_PILLS}\n\n${SOCIAL_INVITE}`;
      const html = renderEncerramento(body);
      assert.match(html, /href="https:\/\/apoia\.se\/diaria"/);
      assert.match(html, new RegExp(`href="${DIARIA_LINKEDIN_PAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      assert.match(html, new RegExp(`href="${DIARIA_FACEBOOK_PAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      // #4536/#4553: pill "Cursos" agora carrega UTM (query string) — o href
      // não termina mais logo após o domínio.
      assert.match(html, /href="https:\/\/cursos\.diar\.ia\.br\?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=cursos-rodape"/);
      assert.match(html, /href="https:\/\/arquivo\.diar\.ia\.br\?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=arquivo-rodape"/);
      assert.match(html, /Essa edição mensal nasce/);
      // encerramento padrão pré-existente continua presente — não foi substituído
      assert.match(html, /assine em/);
    });
  });
});

describe("buildParaEncerrar — slot A usa o snippet inteiro, qualquer forma (#4413 simplifica: não há mais split entre apoio/social nesta função, porque o social virou bloco fixo)", () => {
  it("arquivo com conteúdo em 1 parágrafo só (sem estrutura de 2 parágrafos): aparece integralmente em slotA, convite social fixo continua presente", () => {
    withSnippetContent(
      "{{OPENING}}Texto único do editor, com link exclusivo https://exemplo-editor-fundiu.test/apoio e sem quebra de linha.",
      () => {
        const out = buildParaEncerrar({ slotA: null });
        assert.match(out, /Texto único do editor, com link exclusivo/);
        assert.match(out, /https:\/\/exemplo-editor-fundiu\.test\/apoio/);
        assert.ok(out.includes(SOCIAL_INVITE), "convite social fixo continua presente, independente da forma do snippet");
      },
    );
  });

  it("arquivo com 3+ parágrafos (editor adicionou parágrafo extra): conteúdo do editor inteiro é preservado em slotA", () => {
    withSnippetContent(
      "{{OPENING}}Quem quiser apoiar a curadoria, o link é https://exemplo-editor-3par.test/apoio.\n\nParágrafo extra que o editor adicionou no meio, fora do formato de 2 parágrafos original.\n\nMais um parágrafo qualquer do editor.",
      () => {
        const out = buildParaEncerrar({ slotA: null });
        assert.match(out, /Quem quiser apoiar a curadoria, o link é https:\/\/exemplo-editor-3par\.test\/apoio/);
        assert.match(out, /Parágrafo extra que o editor adicionou no meio/);
        assert.match(out, /Mais um parágrafo qualquer do editor/);
        assert.ok(out.includes(SOCIAL_INVITE));
      },
    );
  });

  it("arquivo de fato ausente/vazio cai no fallback hardcoded genérico (FIXED_BLOCKS.para_encerrar_tools) — convite social continua fixo", () => {
    withSnippetContent("<!-- só comentário, sem conteúdo real -->", () => {
      const whole = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY);
      assert.equal(whole, null, "pré-condição do teste: arquivo precisa renderizar null (vazio após strip)");

      const out = buildParaEncerrar({ slotA: null });
      assert.match(out, /usei Claude Code para automatizar parte da pesquisa/, "cai no fallback hardcoded de ferramentas");
      assert.ok(out.includes(SOCIAL_INVITE), "convite social continua presente mesmo com slotA no fallback genérico");
    });
  });
});
