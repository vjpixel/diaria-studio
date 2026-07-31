/**
 * test/encerramento-social-apoio-3219.test.ts (#3219, regressão #633)
 *
 * A edição mensal 2606-07 enviada saiu com um parágrafo de apoio (Apoia.se)
 * ao lado do convite social (LinkedIn/Facebook) no bloco de encerramento —
 * um ajuste feito manualmente direto na campanha, nunca refletido no
 * template/repo (mesmo padrão do #2866: ajuste aprovado numa edição
 * específica vira fonte canônica permanente).
 *
 * Este teste cobre:
 *   1. `context/snippets/encerramento-social-apoio.md` — o texto aprovado
 *      (parágrafo de apoio + convite social) existe, com o marcador
 *      `{{OPENING}}` e os links canônicos corretos.
 *   2. `scripts/lib/shared/encerramento-snippet.ts` — o loader/render
 *      substitui `{{OPENING}}` corretamente pras duas variantes (diário
 *      vazio, mensal com a cláusula de contexto), sem vazamento cruzado.
 *   3. `scripts/stitch-newsletter.ts` — o diário (`buildParaEncerrar` /
 *      `stitchNewsletter`) usa o snippet de verdade (não duplica o texto).
 *   4. `.claude/agents/writer-monthly.md` — documenta a mesma fonte E a
 *      mesma cláusula de abertura mensal (drift-guard entre TS/prompt/MD,
 *      #2866-style).
 *   5. `context/templates/newsletter-monthly.md` — renomeou `ENCERRAMENTO`
 *      → `PARA ENCERRAR` (nome que o writer-monthly já gerava na prática).
 *   6. Integração de render: o texto novo passa por
 *      `scripts/lib/newsletter-render-html.ts` (diário) e
 *      `scripts/lib/mensal/monthly-render.ts` (mensal) sem quebrar — CTA
 *      final continua caindo no box destacado, links resolvem certo.
 *
 * #4139 (mesma doença que o #4083 corrigiu em stitch-newsletter.test.ts):
 * testes de MECANISMO (load/render/split/stitch) rodam contra uma fixture
 * ESTÁVEL (`STABLE_ENCERRAMENTO_FIXTURE`, escrita transitoriamente via
 * `withSnippetContent`/`withStableSnippet`) em vez do arquivo
 * REAL — a lista de recompensas do Apoia.se é rotação editorial normal (já
 * mudou uma vez, 260727) e não deveria quebrar CI sem regressão nenhuma.
 * Só o describe "guardas de forma" no topo do arquivo lê o arquivo real, e
 * só verifica invariantes de FORMA (marcador, links canônicos, ausência de
 * placeholder) — nunca texto exato de recompensa.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadEncerramentoSocialApoioTemplate,
  renderEncerramentoSocialApoio,
  splitEncerramentoSocialApoio,
  ENCERRAMENTO_OPENING_DAILY,
  ENCERRAMENTO_OPENING_MONTHLY,
} from "../scripts/lib/shared/encerramento-snippet.ts";
import { buildParaEncerrar } from "../scripts/stitch-newsletter.ts";
import { renderEncerrar } from "../scripts/lib/newsletter-render-html.ts";
import { renderEncerramento } from "../scripts/lib/mensal/monthly-render.ts";
import { extractTemplateBlock } from "../scripts/lib/newsletter-parse.ts";
import {
  DIARIA_LINKEDIN_PAGE_URL,
  DIARIA_FACEBOOK_PAGE_URL,
  DIARIA_INSTAGRAM_URL,
  DIARIA_APOIASE_URL,
} from "../scripts/lib/canonical-urls.ts";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const SNIPPET_PATH = join(ROOT, "context", "snippets", "encerramento-social-apoio.md");
const WRITER_MONTHLY_MD = join(ROOT, ".claude", "agents", "writer-monthly.md");
const NEWSLETTER_MONTHLY_TEMPLATE = join(ROOT, "context", "templates", "newsletter-monthly.md");
const NEWSLETTER_DAILY_TEMPLATE = join(ROOT, "context", "templates", "newsletter.md");

// ─── #4139 — fixture ESTÁVEL do snippet de encerramento ────────────────────
// Mesma doença que o #4083 corrigiu em test/stitch-newsletter.test.ts: testes
// de MECANISMO (load/render/split/stitch) não devem depender do que
// context/snippets/encerramento-social-apoio.md diz HOJE — rotação editorial
// normal (a lista de recompensas do Apoia.se já mudou uma vez, 260727: "bastidores
// da produção" → "sorteios") quebrava CI sem regressão nenhuma de código. A
// fixture abaixo preserva a ESTRUTURA real (marcador {{OPENING}}, abertura do
// parágrafo de apoio, convite social com os 3 links canônicos) mas troca a
// lista de recompensas por texto sintético — nenhum teste de mecanismo deveria
// se importar com QUAL recompensa está listada, só que ela passe intacta.
// Escrita via `withStableSnippet` (generalização do helper que já existia,
// escopado, no describe #3382 abaixo) — grava, roda, restaura no finally.
const STABLE_ENCERRAMENTO_FIXTURE = `{{OPENING}}Apoie a curadoria contribuindo a partir de R$5/mês em [apoia.se/diaria](${DIARIA_APOIASE_URL}) para ganhar recompensas como acesso a bastidores de teste, brindes fixture e prioridade em enquetes.

Agora que chegou ao final da edição, siga a **diar.ia.br** no [LinkedIn](${DIARIA_LINKEDIN_PAGE_URL}), no [Facebook](${DIARIA_FACEBOOK_PAGE_URL}) ou no [Instagram](${DIARIA_INSTAGRAM_URL}). Todo dia publicamos por lá um resumo das 3 principais notícias.`;

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

  it("convite social usa os links canônicos de LinkedIn/Facebook/Instagram (não hardcoda de novo)", () => {
    assert.match(
      raw,
      new RegExp(`\\[LinkedIn\\]\\(${DIARIA_LINKEDIN_PAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`),
    );
    assert.match(
      raw,
      new RegExp(`\\[Facebook\\]\\(${DIARIA_FACEBOOK_PAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`),
    );
    assert.match(
      raw,
      new RegExp(`\\[Instagram\\]\\(${DIARIA_INSTAGRAM_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`),
    );
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

  it("o parágrafo de convite social é IDÊNTICO nas duas variantes (só a abertura muda)", () => {
    withStableSnippet(() => {
      const daily = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY)!;
      const monthly = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_MONTHLY)!;
      const socialParaOf = (s: string) => s.split(/\n\n+/).pop();
      assert.equal(socialParaOf(daily), socialParaOf(monthly));
      assert.match(socialParaOf(daily)!, /Todo dia publicamos por lá um resumo das 3 principais notícias\./);
    });
  });
});

describe("scripts/lib/shared/encerramento-snippet.ts — splitEncerramentoSocialApoio (#3368, fixture estável #4139)", () => {
  it("separa o template em { apoio, socialInvite } sem perder conteúdo", () => {
    withStableSnippet(() => {
      const split = splitEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY);
      assert.ok(split, "split não deveria ser null");
      assert.match(split!.apoio, /^Apoie a curadoria contribuindo a partir de R\$5\/mês em \[apoia\.se\/diaria\]/);
      assert.match(split!.socialInvite, /^Agora que chegou ao final da edição, siga/);
      // nenhum dos dois vaza conteúdo do outro
      assert.doesNotMatch(split!.apoio, /Agora que chegou ao final da edição/);
      assert.doesNotMatch(split!.socialInvite, /apoia\.se\/diaria/);
    });
  });

  it("aplica a cláusula de abertura só no parágrafo de apoio, nunca no convite social", () => {
    withStableSnippet(() => {
      const split = splitEncerramentoSocialApoio(ENCERRAMENTO_OPENING_MONTHLY);
      assert.ok(split);
      assert.match(split!.apoio, /^Essa edição mensal nasce da \*\*diar\.ia\.br\*\*/);
      assert.doesNotMatch(split!.socialInvite, /Essa edição mensal nasce/);
    });
  });

  it("o texto concatenado de volta (apoio + \\n\\n + socialInvite) é idêntico ao render não-splitado", () => {
    withStableSnippet(() => {
      const split = splitEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY)!;
      const whole = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY)!;
      assert.equal(`${split.apoio}\n\n${split.socialInvite}`, whole);
    });
  });
});

describe("scripts/stitch-newsletter.ts — PARA ENCERRAR usa o snippet compartilhado (#3219, reorder #3368)", () => {
  it("buildParaEncerrar preserva o cabeçalho + parágrafo de ferramentas + pills Acesse (inalterado)", () => {
    const out = buildParaEncerrar();
    assert.match(out, /\*\*🙋🏼‍♀️ PARA ENCERRAR\*\*/);
    assert.match(out, /usei Claude Code para automatizar parte da pesquisa/);
    // #3698: domínio de marca (era cursos/livros.diaria.workers.dev).
    assert.match(out, /- \[Cursos de IA\]\(https:\/\/cursos\.diar\.ia\.br\)/);
    assert.match(out, /- \[Livros sobre IA\]\(https:\/\/livros\.diar\.ia\.br\)/);
    // #4356: 3º pill "Equipamentos" — link direto pro Amazon (sem redirect worker).
    assert.match(out, /- \[Equipamentos\]\(https:\/\/www\.amazon\.com\.br\/shop\/vjpixel\)/);
  });

  it("#4357: override de para_encerrar.slot_a (texto arbitrário, sem lista) NÃO apaga a linha de pills 'Acesse nossas curadorias'", () => {
    // Reprodução exata do bug relatado: editor sobrescreve o Slot A pelo
    // painel Caixas com texto arbitrário (sem a lista `- [...]`) — antes do
    // #4357, isso apagava as pills junto (concatenadas dentro do default do
    // slot A). Agora as pills são um bloco fixo, concatenado FORA do
    // alcance do override.
    const out = buildParaEncerrar({
      slotA: "Apoie a curadoria contribuindo a partir de R$5/mês em [apoia.se/diaria](https://apoia.se/diaria). Nesta edição, usei alguns equipamentos legais.",
      slotB: null,
    });
    assert.equal((out.match(/Cursos de IA/g) ?? []).length, 1, "não deveria haver duplicação — só 1 ocorrência da pill");
    assert.match(out, /- \[Cursos de IA\]\(https:\/\/cursos\.diar\.ia\.br\)/);
    assert.match(out, /- \[Livros sobre IA\]\(https:\/\/livros\.diar\.ia\.br\)/);
    assert.match(out, /- \[Equipamentos\]\(https:\/\/www\.amazon\.com\.br\/shop\/vjpixel\)/);
  });

  it("#4357: override de para_encerrar.slot_b (texto arbitrário) também preserva as pills (concatenadas ANTES do slotB)", () => {
    const out = buildParaEncerrar({
      slotA: null,
      slotB: "Um convite social qualquer, sem nenhuma lista.",
    });
    assert.match(out, /- \[Cursos de IA\]\(https:\/\/cursos\.diar\.ia\.br\)/);
    assert.match(out, /- \[Livros sobre IA\]\(https:\/\/livros\.diar\.ia\.br\)/);
    assert.match(out, /- \[Equipamentos\]\(https:\/\/www\.amazon\.com\.br\/shop\/vjpixel\)/);
    // Pills continuam vindo ANTES do slotB (invariante: convite social é
    // sempre o ÚLTIMO parágrafo, #3219/#3368).
    const pillsIdx = out.indexOf("[Cursos de IA]");
    const slotBIdx = out.indexOf("Um convite social qualquer");
    assert.ok(pillsIdx >= 0 && slotBIdx >= 0 && pillsIdx < slotBIdx);
  });

  it("buildParaEncerrar inclui o parágrafo de apoio (Apoia.se) e o convite social do snippet", () => {
    withStableSnippet(() => {
      const out = buildParaEncerrar();
      assert.match(out, /Apoie a curadoria contribuindo a partir de R\$5\/mês em \[apoia\.se\/diaria\]\(https:\/\/apoia\.se\/diaria\)/);
      assert.match(out, /Agora que chegou ao final da edição, siga a \*\*diar\.ia\.br\*\* no \[LinkedIn\]/);
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

  it("buildParaEncerrar não regride pro texto antigo sem o apoio ('ajuda bastante' sem CTA de apoio)", () => {
    withStableSnippet(() => {
      // Antes do #3219 a última frase era só o convite social + esta cauda —
      // se ela reaparecer sem o parágrafo de apoio antes, é regressão.
      const out = buildParaEncerrar();
      const apoioIdx = out.indexOf("apoia.se/diaria");
      const socialIdx = out.indexOf("Agora que chegou ao final da edição");
      assert.ok(apoioIdx >= 0 && socialIdx >= 0, "os dois parágrafos precisam estar presentes");
      assert.ok(apoioIdx < socialIdx, "apoio deve vir ANTES do convite social");
    });
  });

  it("ordem final (#3368, pedido do editor 260713): cabeçalho > apoio > ferramentas > Acesse > convite social", () => {
    withStableSnippet(() => {
      const out = buildParaEncerrar();
      const headerIdx = out.indexOf("PARA ENCERRAR");
      const apoioIdx = out.indexOf("apoia.se/diaria");
      const toolsIdx = out.indexOf("usei Claude Code");
      const acesseIdx = out.indexOf("[Cursos de IA]");
      const socialIdx = out.indexOf("Agora que chegou ao final da edição");
      assert.ok(
        headerIdx >= 0 && headerIdx < apoioIdx && apoioIdx < toolsIdx && toolsIdx < acesseIdx && acesseIdx < socialIdx,
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

  it("o convite social é o ÚLTIMO parágrafo da seção (#3368)", () => {
    withStableSnippet(() => {
      const out = buildParaEncerrar();
      assert.match(out.trimEnd(), /Agora que chegou ao final da edição, siga a \*\*diar\.ia\.br\*\* no \[LinkedIn\]\([^)]+\), no \[Facebook\]\([^)]+\) ou no \[Instagram\]\([^)]+\)\. Todo dia publicamos por lá um resumo das 3 principais notícias\.$/);
    });
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

  it("newsletter.md (diário) documenta a fonte do parágrafo de apoio/social", () => {
    const content = readFileSync(NEWSLETTER_DAILY_TEMPLATE, "utf8");
    assert.match(content, /encerramento-social-apoio\.md/);
  });
});

describe("integração de render — diário (renderEncerrar processa o novo bloco, #3219, fixture estável #4139)", () => {
  it("o HTML resultante inclui o link de apoio e o CTA social, com o parágrafo social boxed (CTA)", () => {
    withStableSnippet(() => {
      const full = buildParaEncerrar();
      const body = extractTemplateBlock(full, "🙋🏼‍♀️ PARA ENCERRAR");
      assert.ok(body, "extractTemplateBlock deveria achar o corpo do bloco");
      const html = renderEncerrar(body!);
      assert.match(html, /href="https:\/\/apoia\.se\/diaria"/);
      assert.match(html, new RegExp(`href="${DIARIA_LINKEDIN_PAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      assert.match(html, new RegExp(`href="${DIARIA_FACEBOOK_PAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      assert.match(html, /Agora que chegou ao final da edição/);
    });
  });
});

describe("integração de render — mensal (renderEncerramento processa o novo bloco, #3219, fixture estável #4139)", () => {
  it("o HTML resultante inclui o link de apoio e o CTA social ao lado do encerramento padrão existente", () => {
    withStableSnippet(() => {
      const encerramentoPadrao =
        "Quer sugerir um tema, responder a uma análise ou compartilhar a Diar.ia com um colega? Responda a este e-mail. Leio cada um. Se ainda não recebe a Diar.ia diária, assine em https://diar.ia.br/?utm_source=mensal-brevo.";
      const apoioSocial = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_MONTHLY)!;
      const body = `${encerramentoPadrao}\n\n${apoioSocial}`;
      const html = renderEncerramento(body);
      assert.match(html, /href="https:\/\/apoia\.se\/diaria"/);
      assert.match(html, new RegExp(`href="${DIARIA_LINKEDIN_PAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      assert.match(html, new RegExp(`href="${DIARIA_FACEBOOK_PAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      assert.match(html, /Essa edição mensal nasce/);
      // encerramento padrão pré-existente continua presente — não foi substituído
      assert.match(html, /assine em/);
    });
  });
});

describe("buildParaEncerrar — split falho NÃO descarta conteúdo real (#3382, regressão do self-review do #3368)", () => {
  // #3382: `splitEncerramentoSocialApoio` retorna `null` tanto quando o
  // arquivo está ausente/vazio QUANTO quando o arquivo existe mas não separa
  // em exatamente 2 parágrafos (ex: editor fundiu apoio+social num parágrafo
  // só). Antes deste fix, os 2 casos eram tratados IGUAL por
  // `buildParaEncerrar` — caindo no fallback hardcoded genérico e perdendo
  // silenciosamente o conteúdo real do editor no 2º caso. Testamos aqui
  // sobrescrevendo transitoriamente o snippet real via `withSnippetContent`
  // (hoisted pro topo do arquivo, #4139 — usado por todos os describes deste
  // arquivo agora, não só este), sempre restaurando o original no `finally`.

  it("arquivo com 1 parágrafo só (editor fundiu apoio+social): splitEncerramentoSocialApoio retorna null, mas o conteúdo real aparece em buildParaEncerrar (não cai no hardcoded genérico)", () => {
    withSnippetContent(
      "{{OPENING}}Texto único do editor fundindo apoio e social num parágrafo só, com link exclusivo https://exemplo-editor-fundiu.test/apoio-e-social e sem quebra de linha.",
      () => {
        const split = splitEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY);
        assert.equal(split, null, "pré-condição do teste: split precisa falhar com 1 parágrafo só");

        const out = buildParaEncerrar();
        // conteúdo real do editor está presente...
        assert.match(out, /Texto único do editor fundindo apoio e social/);
        assert.match(out, /https:\/\/exemplo-editor-fundiu\.test\/apoio-e-social/);
        // ...e o fallback hardcoded genérico (que NUNCA existiu no arquivo) NÃO aparece
        assert.doesNotMatch(out, /Seguir, comentar e compartilhar nossas publicações por lá ajuda bastante/);
      },
    );
  });

  it("arquivo com 3 parágrafos (editor adicionou um parágrafo extra no meio): conteúdo do editor inteiro é preservado em buildParaEncerrar", () => {
    withSnippetContent(
      "{{OPENING}}Quem quiser apoiar a curadoria, o link é https://exemplo-editor-3par.test/apoio.\n\nParágrafo extra que o editor adicionou no meio, fora do formato de 2 parágrafos original.\n\nConvite social customizado pelo editor: https://exemplo-editor-3par.test/social.",
      () => {
        const out = buildParaEncerrar();
        // os 3 parágrafos do editor aparecem, nenhum foi descartado
        assert.match(out, /Quem quiser apoiar a curadoria, o link é https:\/\/exemplo-editor-3par\.test\/apoio/);
        assert.match(out, /Parágrafo extra que o editor adicionou no meio/);
        assert.match(out, /Convite social customizado pelo editor: https:\/\/exemplo-editor-3par\.test\/social/);
        // fallback hardcoded genérico não aparece
        assert.doesNotMatch(out, /Seguir, comentar e compartilhar nossas publicações por lá ajuda bastante/);
      },
    );
  });

  it("arquivo de fato ausente/vazio ainda cai no fallback hardcoded genérico (caso 1, comportamento preservado)", () => {
    withSnippetContent("<!-- só comentário, sem conteúdo real -->", () => {
      const whole = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY);
      assert.equal(whole, null, "pré-condição do teste: arquivo precisa renderizar null (vazio após strip)");

      const out = buildParaEncerrar();
      assert.match(out, /Seguir, comentar e compartilhar nossas publicações por lá ajuda bastante/);
    });
  });
});
