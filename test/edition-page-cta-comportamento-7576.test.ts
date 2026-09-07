/**
 * test/edition-page-cta-comportamento-7576.test.ts (#7576)
 *
 * O review da PR #7588 fez a crítica certa sobre o arquivo irmão
 * (`edition-page-cta-7576.test.ts`): ele casa STRINGS. Verifica que o texto
 * `"Escape"`, o identificador `focoAnterior` e o número `0.5` aparecem na
 * fonte — não que a tecla fecha, que o foco volta, ou que o gatilho dispara na
 * metade. Uma comparação invertida (`<=` no lugar de `>=`), uma chave lida
 * diferente da escrita, ou uma crase solta que quebra o template literal
 * passariam por todos aqueles testes com a página quebrada em produção.
 *
 * Este arquivo executa o script de verdade, num DOM mínimo, e exercita o
 * comportamento. As duas coisas que ele trava e que regex nenhuma pegaria:
 *
 * 1. **O script é JavaScript VÁLIDO.** Ele é montado por interpolação de
 *    template literal, e este repo já teve o caso de uma crase em comentário
 *    quebrar um. `new vm.Script()` falha na compilação, não em produção.
 * 2. **A lógica faz o que a docstring promete** — nos dois sentidos, incluindo
 *    os caminhos de erro (`localStorage` lançando) que são justamente os que
 *    ninguém testa e que decidem se o convite aparece ou some.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { MODAL_DISMISSED_KEY, editionCtaScript } from "../scripts/lib/edition-page-cta.ts";

/** Só o corpo JS, sem as tags `<script>`. */
function corpoDoScript(): string {
  const m = editionCtaScript().match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, "editionCtaScript precisa devolver um bloco <script> reconhecível");
  return m[1];
}

interface ElementoFalso {
  id?: string;
  hidden: boolean;
  className: string;
  textContent: string;
  focado: number;
  focus(): void;
  addEventListener(tipo: string, fn: (ev: unknown) => void): void;
  querySelector(sel: string): ElementoFalso | null;
  querySelectorAll(sel: string): ElementoFalso[];
  disparar(tipo: string, ev?: unknown): void;
  handlers: Map<string, ((ev: unknown) => void)[]>;
}

function elemento(id?: string, filhos: Record<string, ElementoFalso> = {}, hidden = false): ElementoFalso {
  const handlers = new Map<string, ((ev: unknown) => void)[]>();
  const el: ElementoFalso = {
    id,
    hidden,
    className: "",
    textContent: "",
    focado: 0,
    handlers,
    focus() {
      el.focado += 1;
    },
    addEventListener(tipo, fn) {
      handlers.set(tipo, [...(handlers.get(tipo) ?? []), fn]);
    },
    querySelector: (sel) => filhos[sel] ?? null,
    querySelectorAll: () => [],
    disparar(tipo, ev) {
      for (const fn of handlers.get(tipo) ?? []) fn(ev ?? {});
    },
  };
  return el;
}

interface Cenario {
  modal: ElementoFalso;
  botao: ElementoFalso;
  status: ElementoFalso;
  statusRodape: ElementoFalso;
  anterior: ElementoFalso;
  /** Simula o que `signupFormScript` escreve no status e notifica os observers. */
  escreverStatus(alvo: ElementoFalso, className: string, texto: string): void;
  doc: { handlers: Map<string, ((ev: unknown) => void)[]> };
  win: { handlers: Map<string, ((ev: unknown) => void)[]>; scrollRemovido: boolean };
  store: Map<string, string>;
  rolarAte(fracao: number): void;
  teclar(key: string): void;
}

/**
 * Roda o script num DOM mínimo.
 *
 * `alturaPagina` em viewports controla a guarda de página curta;
 * `storageLanca` simula janela privada, onde `localStorage` joga exceção.
 */
function rodar(opts: { alturaPagina?: number; jaDispensado?: boolean; storageLanca?: boolean } = {}): Cenario {
  const vh = 800;
  const total = vh * (opts.alturaPagina ?? 3);
  const store = new Map<string, string>();
  if (opts.jaDispensado) store.set(MODAL_DISMISSED_KEY, "1");

  const status = elemento();
  const formModal = elemento(undefined, { ".signup-status": status });
  const botao = elemento("diaria-cta-close");
  // Nasce `hidden` porque `editionCtaModal()` grava o atributo no HTML — sem
  // isso o stub testaria um estado inicial que a página real nunca tem.
  const modal = elemento(
    "diaria-cta-modal",
    { 'input[type="email"]': elemento(), "form.signup": formModal },
    true,
  );
  const statusRodape = elemento();
  const formRodape = elemento(undefined, { ".signup-status": statusRodape });
  const anterior = elemento();

  const docHandlers = new Map<string, ((ev: unknown) => void)[]>();
  const winHandlers = new Map<string, ((ev: unknown) => void)[]>();
  let y = 0;
  let scrollRemovido = false;
  const observers: { alvo: ElementoFalso; cb: () => void }[] = [];

  const localStorage = {
    getItem(k: string) {
      if (opts.storageLanca) throw new Error("acesso negado");
      return store.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (opts.storageLanca) throw new Error("acesso negado");
      store.set(k, v);
    },
  };

  const window: Record<string, unknown> = {
    localStorage,
    innerHeight: vh,
    get pageYOffset() {
      return y;
    },
    addEventListener(tipo: string, fn: (ev: unknown) => void) {
      winHandlers.set(tipo, [...(winHandlers.get(tipo) ?? []), fn]);
    },
    removeEventListener(tipo: string) {
      if (tipo === "scroll") scrollRemovido = true;
    },
    // Observer real o bastante: guarda alvo e callback para o teste poder
    // simular a mudança de status que o signupFormScript faria.
    MutationObserver: class {
      constructor(public cb: () => void) {}
      observe(alvo: ElementoFalso) {
        observers.push({ alvo, cb: this.cb });
      }
    },
  };

  const document = {
    activeElement: anterior,
    getElementById: (id: string) => (id === "diaria-cta-modal" ? modal : id === "diaria-cta-close" ? botao : null),
    // O script varre `form.signup` para saber se o leitor já assinou pelo
    // RODAPÉ. Devolver [] deixava esse caminho inteiro sem teste — foi assim
    // que o bug do watcher prematuro passou.
    querySelectorAll: () => [formRodape] as ElementoFalso[],
    addEventListener(tipo: string, fn: (ev: unknown) => void) {
      docHandlers.set(tipo, [...(docHandlers.get(tipo) ?? []), fn]);
    },
    documentElement: { scrollHeight: total, get scrollTop() { return y; } },
    body: { scrollHeight: total },
  };

  const ctx = vm.createContext({ window, document, setTimeout, console });
  // Compilar SEPARADO de executar: um erro de sintaxe (crase solta no template
  // literal, `${}` quebrado) falha aqui, com a linha, em vez de virar uma
  // página muda em produção.
  new vm.Script(corpoDoScript(), { filename: "edition-page-cta.js" }).runInContext(ctx);

  return {
    modal,
    botao,
    status,
    statusRodape,
    anterior,
    escreverStatus(alvo, className, texto) {
      alvo.className = className;
      alvo.textContent = texto;
      for (const o of observers) if (o.alvo === alvo) o.cb();
    },
    doc: { handlers: docHandlers },
    win: { handlers: winHandlers, get scrollRemovido() { return scrollRemovido; } } as Cenario["win"],
    store,
    rolarAte(fracao) {
      y = Math.max(0, total * fracao - vh);
      for (const fn of winHandlers.get("scroll") ?? []) fn({});
    },
    teclar(key) {
      for (const fn of docHandlers.get("keydown") ?? []) fn({ key });
    },
  };
}

describe("#7576 — o script do modal é JavaScript válido", () => {
  it("compila — regex nenhuma pegaria uma crase solta no template literal", () => {
    assert.doesNotThrow(() => new vm.Script(corpoDoScript(), { filename: "edition-page-cta.js" }));
  });

  it("roda até o fim sem lançar num DOM mínimo", () => {
    assert.doesNotThrow(() => rodar());
  });
});

describe("#7576 — o gatilho dispara na metade, não antes", () => {
  it("nasce escondido e continua escondido antes dos 50%", () => {
    const c = rodar();
    assert.equal(c.modal.hidden, true, "o script não pode abrir o modal no load");
    c.rolarAte(0.3);
    assert.equal(c.modal.hidden, true);
  });

  it("abre exatamente ao cruzar 50%", () => {
    const c = rodar();
    c.rolarAte(0.49);
    assert.equal(c.modal.hidden, true, "49% ainda não");
    c.rolarAte(0.6);
    assert.equal(c.modal.hidden, false, "passou da metade, abre");
  });

  it("para de escutar scroll depois de abrir — não reprocessa a cada pixel", () => {
    const c = rodar();
    c.rolarAte(0.8);
    assert.equal(c.win.scrollRemovido, true);
  });

  it("página curta NUNCA abre, por mais que role", () => {
    // Abaixo de MIN_PAGE_VIEWPORTS_FOR_MODAL o gatilho perde o sentido: 50%
    // chegaria junto com o load.
    const c = rodar({ alturaPagina: 1.2 });
    c.rolarAte(1);
    assert.equal(c.modal.hidden, true, "numa página de 1,2 viewport o modal não pode aparecer");
  });

  it("move o foco para o campo de e-mail ao abrir", () => {
    const c = rodar();
    c.rolarAte(0.9);
    assert.equal(c.modal.querySelector('input[type="email"]')?.focado, 1);
  });
});

describe("#7576 — fechar funciona pelos três caminhos e não volta", () => {
  for (const [nome, fechar] of [
    ["Esc", (c: Cenario) => c.teclar("Escape")],
    ["botão", (c: Cenario) => c.botao.disparar("click")],
    ["clique no fundo", (c: Cenario) => c.modal.disparar("click", { target: c.modal })],
  ] as const) {
    it(`fecha por ${nome} e grava a dispensa`, () => {
      const c = rodar();
      c.rolarAte(0.9);
      assert.equal(c.modal.hidden, false);
      fechar(c);
      assert.equal(c.modal.hidden, true);
      assert.equal(c.store.get(MODAL_DISMISSED_KEY), "1", "fechar precisa gravar, senão volta na próxima edição");
    });
  }

  it("clique DENTRO do card não fecha", () => {
    const c = rodar();
    c.rolarAte(0.9);
    c.modal.disparar("click", { target: c.botao });
    assert.equal(c.modal.hidden, false, "clicar no conteúdo não pode fechar");
  });

  it("devolve o foco a quem o tinha antes", () => {
    const c = rodar();
    c.rolarAte(0.9);
    c.teclar("Escape");
    assert.equal(c.anterior.focado, 1);
  });

  it("outra tecla não fecha", () => {
    const c = rodar();
    c.rolarAte(0.9);
    c.teclar("a");
    assert.equal(c.modal.hidden, false);
  });
});

describe("#7576 — uma vez por leitor, e falha de storage nunca some com o convite", () => {
  it("quem já dispensou não vê de novo, nem rolando a página inteira", () => {
    const c = rodar({ jaDispensado: true });
    c.rolarAte(1);
    assert.equal(c.modal.hidden, true);
  });

  it("REGRESSÃO: a chave LIDA é a mesma que a ESCRITA", () => {
    // Ler uma chave e gravar outra faria o modal reaparecer para sempre, e um
    // teste de string veria as duas na fonte sem notar a divergência. Aqui a
    // segunda visita é semeada com o que a PRIMEIRA gravou, não com um valor
    // escrito à mão no teste — é o que fecha o ciclo.
    const primeira = rodar();
    primeira.rolarAte(0.9);
    primeira.teclar("Escape");
    const gravado = primeira.store.get(MODAL_DISMISSED_KEY);
    assert.equal(gravado, "1", "fechar precisa gravar algo reconhecível");

    const segunda = rodar({ jaDispensado: gravado === "1" });
    segunda.rolarAte(1);
    assert.equal(segunda.modal.hidden, true, "a dispensa gravada precisa ser reconhecida na volta");
  });

  it("localStorage lançando NÃO quebra a página e o convite CONTINUA aparecendo", () => {
    // Janela privada. O default em erro é mostrar: um detalhe de armazenamento
    // não pode nem derrubar a página nem silenciar o convite.
    const c = rodar({ storageLanca: true });
    assert.doesNotThrow(() => c.rolarAte(0.9));
    assert.equal(c.modal.hidden, false, "sem storage, mostrar é o comportamento correto");
  });

  it("localStorage lançando na ESCRITA ainda fecha o modal", () => {
    const c = rodar({ storageLanca: true });
    c.rolarAte(0.9);
    assert.doesNotThrow(() => c.teclar("Escape"));
    assert.equal(c.modal.hidden, true, "não conseguir gravar não pode prender o leitor no modal");
  });
});

describe("#7576 — o rodapé só dispensa o modal em SUCESSO, nunca ao clicar enviar", () => {
  it("REGRESSÃO P1: 'Enviando…' NÃO marca a dispensa", () => {
    // `signupFormScript` chama `setStatus("Enviando…", true)` no início do
    // envio, e esse `true` já grava a classe `ok`. Sem a guarda de "Enviando",
    // quem clicasse em enviar e o pedido falhasse (rede, timeout, 4xx) não
    // assinava E perdia o convite para sempre naquele navegador, em silêncio.
    const c = rodar();
    c.escreverStatus(c.statusRodape, "signup-status ok", "Enviando…");
    assert.equal(c.store.get(MODAL_DISMISSED_KEY), undefined, "envio em curso não é sucesso");

    c.rolarAte(0.9);
    assert.equal(c.modal.hidden, false, "e o modal precisa continuar disponível");
  });

  it("erro no envio também não dispensa", () => {
    const c = rodar();
    c.escreverStatus(c.statusRodape, "signup-status err", "Não deu. Tente de novo.");
    assert.equal(c.store.get(MODAL_DISMISSED_KEY), undefined);
    c.rolarAte(0.9);
    assert.equal(c.modal.hidden, false);
  });

  it("sucesso de verdade dispensa — e o modal não aparece depois", () => {
    const c = rodar();
    c.escreverStatus(c.statusRodape, "signup-status ok", "Pronto! Confira seu e-mail.");
    assert.equal(c.store.get(MODAL_DISMISSED_KEY), "1");
    c.rolarAte(0.9);
    assert.equal(c.modal.hidden, true, "quem já assinou pelo rodapé não deve ser convidado de novo");
  });
});
