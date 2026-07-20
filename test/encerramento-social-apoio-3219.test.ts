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

describe("context/snippets/encerramento-social-apoio.md (#3219)", () => {
  const raw = readFileSync(SNIPPET_PATH, "utf8");

  it("tem o marcador {{OPENING}} pra parametrizar a abertura", () => {
    assert.match(raw, /\{\{OPENING\}\}/);
  });

  it("parágrafo de apoio menciona R$5/mês e o link apoia.se/diaria", () => {
    assert.match(
      raw,
      /Quem quiser apoiar a curadoria pode contribuir a partir de R\$5\/mês em \[apoia\.se\/diaria\]\(https:\/\/apoia\.se\/diaria\)/,
    );
    assert.match(raw, new RegExp(DIARIA_APOIASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("parágrafo de apoio cita as 3 recompensas aprovadas", () => {
    assert.match(raw, /artigo especial do mês/);
    assert.match(raw, /bastidores da produção/);
    assert.match(raw, /acesso antecipado a novos projetos/);
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

  it("convite social pergunta sobre interagir numa publicação da diar.ia.br", () => {
    assert.match(
      raw,
      /Agora que chegou ao final da edição, que tal interagir em uma publicação da \*\*diar\.ia\.br\*\* no/,
    );
  });
});

describe("scripts/lib/shared/encerramento-snippet.ts (#3219)", () => {
  it("loadEncerramentoSocialApoioTemplate retorna o corpo sem o comentário HTML de header", () => {
    const template = loadEncerramentoSocialApoioTemplate();
    assert.ok(template, "template não deveria ser null");
    assert.doesNotMatch(template!, /<!--/);
    assert.match(template!, /\{\{OPENING\}\}/);
  });

  it("variante DIÁRIA (opening vazio): abre direto em 'Quem quiser apoiar', sem a cláusula mensal", () => {
    const out = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY);
    assert.ok(out);
    assert.match(out!, /^Quem quiser apoiar a curadoria/);
    assert.doesNotMatch(out!, /Essa edição mensal nasce/);
    assert.doesNotMatch(out!, /\{\{OPENING\}\}/, "marcador não deve sobrar sem substituição");
  });

  it("variante MENSAL: inclui a cláusula de contexto antes de 'Quem quiser apoiar', com 1 espaço (sem colar as duas frases)", () => {
    const out = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_MONTHLY);
    assert.ok(out);
    assert.match(
      out!,
      /^Essa edição mensal nasce da \*\*diar\.ia\.br\*\*, newsletter diária gratuita sobre IA\. Quem quiser apoiar a curadoria/,
    );
    // nunca colado sem espaço nem espaço duplo
    assert.doesNotMatch(out!, /IA\.Quem/);
    assert.doesNotMatch(out!, /IA\.  Quem/);
  });

  it("o parágrafo de convite social é IDÊNTICO nas duas variantes (só a abertura muda)", () => {
    const daily = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY)!;
    const monthly = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_MONTHLY)!;
    const socialParaOf = (s: string) => s.split(/\n\n+/).pop();
    assert.equal(socialParaOf(daily), socialParaOf(monthly));
  });
});

describe("scripts/lib/shared/encerramento-snippet.ts — splitEncerramentoSocialApoio (#3368)", () => {
  it("separa o template em { apoio, socialInvite } sem perder conteúdo", () => {
    const split = splitEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY);
    assert.ok(split, "split não deveria ser null");
    assert.match(split!.apoio, /^Quem quiser apoiar a curadoria pode contribuir a partir de R\$5\/mês em \[apoia\.se\/diaria\]/);
    assert.match(split!.socialInvite, /^Agora que chegou ao final da edição, que tal interagir/);
    // nenhum dos dois vaza conteúdo do outro
    assert.doesNotMatch(split!.apoio, /Agora que chegou ao final da edição/);
    assert.doesNotMatch(split!.socialInvite, /apoia\.se\/diaria/);
  });

  it("aplica a cláusula de abertura só no parágrafo de apoio, nunca no convite social", () => {
    const split = splitEncerramentoSocialApoio(ENCERRAMENTO_OPENING_MONTHLY);
    assert.ok(split);
    assert.match(split!.apoio, /^Essa edição mensal nasce da \*\*diar\.ia\.br\*\*/);
    assert.doesNotMatch(split!.socialInvite, /Essa edição mensal nasce/);
  });

  it("o texto concatenado de volta (apoio + \\n\\n + socialInvite) é idêntico ao render não-splitado", () => {
    const split = splitEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY)!;
    const whole = renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY)!;
    assert.equal(`${split.apoio}\n\n${split.socialInvite}`, whole);
  });
});

describe("scripts/stitch-newsletter.ts — PARA ENCERRAR usa o snippet compartilhado (#3219, reorder #3368)", () => {
  it("buildParaEncerrar preserva o cabeçalho + parágrafo de ferramentas + pills Acesse (inalterado)", () => {
    const out = buildParaEncerrar();
    assert.match(out, /\*\*🙋🏼‍♀️ PARA ENCERRAR\*\*/);
    assert.match(out, /usei Claude Code para automatizar parte da pesquisa/);
    assert.match(out, /- \[Cursos de IA\]\(https:\/\/cursos\.diaria\.workers\.dev\)/);
    assert.match(out, /- \[Livros sobre IA\]\(https:\/\/livros\.diaria\.workers\.dev\)/);
  });

  it("buildParaEncerrar inclui o parágrafo de apoio (Apoia.se) e o convite social do snippet", () => {
    const out = buildParaEncerrar();
    assert.match(out, /Quem quiser apoiar a curadoria pode contribuir a partir de R\$5\/mês em \[apoia\.se\/diaria\]\(https:\/\/apoia\.se\/diaria\)/);
    assert.match(out, /Agora que chegou ao final da edição, que tal interagir em uma publicação da \*\*diar\.ia\.br\*\* no \[LinkedIn\]/);
  });

  it("buildParaEncerrar NÃO vaza a cláusula de abertura mensal pro diário", () => {
    const out = buildParaEncerrar();
    assert.doesNotMatch(out, /Essa edição mensal nasce/);
  });

  it("buildParaEncerrar não regride pro texto antigo sem o apoio ('ajuda bastante' sem CTA de apoio)", () => {
    const out = buildParaEncerrar();
    // Antes do #3219 a última frase era só o convite social + esta cauda —
    // se ela reaparecer sem o parágrafo de apoio antes, é regressão.
    const apoioIdx = out.indexOf("apoia.se/diaria");
    const socialIdx = out.indexOf("Agora que chegou ao final da edição");
    assert.ok(apoioIdx >= 0 && socialIdx >= 0, "os dois parágrafos precisam estar presentes");
    assert.ok(apoioIdx < socialIdx, "apoio deve vir ANTES do convite social");
  });

  it("ordem final (#3368, pedido do editor 260713): cabeçalho > apoio > ferramentas > Acesse > convite social", () => {
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

  it("o parágrafo de apoio é o PRIMEIRO parágrafo depois do cabeçalho (#3368)", () => {
    const out = buildParaEncerrar();
    const afterHeader = out.slice(out.indexOf("**🙋🏼‍♀️ PARA ENCERRAR**") + "**🙋🏼‍♀️ PARA ENCERRAR**".length).trimStart();
    assert.match(afterHeader, /^Quem quiser apoiar a curadoria/);
  });

  it("o convite social é o ÚLTIMO parágrafo da seção (#3368)", () => {
    const out = buildParaEncerrar();
    assert.match(out.trimEnd(), /Agora que chegou ao final da edição, que tal interagir em uma publicação da \*\*diar\.ia\.br\*\* no \[LinkedIn\]\([^)]+\), no \[Facebook\]\([^)]+\) ou no \[Instagram\]\([^)]+\)\?$/);
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

describe("integração de render — diário (renderEncerrar processa o novo bloco, #3219)", () => {
  it("o HTML resultante inclui o link de apoio e o CTA social, com o parágrafo social boxed (CTA)", () => {
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

describe("integração de render — mensal (renderEncerramento processa o novo bloco, #3219)", () => {
  it("o HTML resultante inclui o link de apoio e o CTA social ao lado do encerramento padrão existente", () => {
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

describe("buildParaEncerrar — split falho NÃO descarta conteúdo real (#3382, regressão do self-review do #3368)", () => {
  // #3382: `splitEncerramentoSocialApoio` retorna `null` tanto quando o
  // arquivo está ausente/vazio QUANTO quando o arquivo existe mas não separa
  // em exatamente 2 parágrafos (ex: editor fundiu apoio+social num parágrafo
  // só). Antes deste fix, os 2 casos eram tratados IGUAL por
  // `buildParaEncerrar` — caindo no fallback hardcoded genérico e perdendo
  // silenciosamente o conteúdo real do editor no 2º caso. Testamos aqui
  // sobrescrevendo transitoriamente o snippet real (não há hook de injeção
  // de conteúdo — `readSnippetFile` lê direto do path fixo em
  // `context/snippets/`), sempre restaurando o original no `finally`.
  const originalSnippet = readFileSync(SNIPPET_PATH, "utf8");

  function withSnippetContent(content: string, fn: () => void): void {
    writeFileSync(SNIPPET_PATH, content, "utf8");
    try {
      fn();
    } finally {
      writeFileSync(SNIPPET_PATH, originalSnippet, "utf8");
    }
  }

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
