import { test } from "node:test";
import * as assert from "node:assert";
import {
  buildThumbnailToggleReadJs,
  buildThumbnailToggleClickJs,
  classifyThumbnailToggleResult,
  classifyThumbnailToggleClick,
  needsManualCheck,
  formatThumbnailToggleMessage,
} from "../scripts/lib/beehiiv-thumbnail-toggle.ts";

/**
 * DOM mínimo replicando a estrutura REAL do passo Web do Beehiiv, conferida ao
 * vivo em 05/09/2026 (post_78ed9837-bae3-41d4-ab09-84176b86f430):
 *
 *   <label for="hide-thumbnail">Show thumbnail on top in web</label>
 *   <button role="switch" id="hide-thumbnail" aria-checked="false">
 *
 * O controle é um <button>, não um <input> — e `.checked` nele é `undefined`.
 */
function fakeDom(opts: {
  ariaChecked?: string | null;
  /** Omite o id, forçando o fallback pelo `for` do label. */
  withoutId?: boolean;
  /** Remove o controle inteiro. */
  missing?: boolean;
  /** Faz querySelectorAll estourar, para exercitar o catch. */
  throws?: boolean;
} = {}) {
  const clicks = { count: 0 };
  // `?? "false"` seria errado aqui: apagaria a diferença entre "não informado"
  // (default "false") e um `null` explícito, que é justamente o caso de teste
  // do atributo ausente.
  const aria = "ariaChecked" in opts ? opts.ariaChecked : "false";
  const button = {
    tagName: "BUTTON",
    getAttribute: (n: string) => (n === "aria-checked" ? aria : null),
    click: () => { clicks.count++; },
  };
  const label = {
    textContent: "Show thumbnail on top in web",
    getAttribute: (n: string) => (n === "for" ? "hide-thumbnail" : null),
  };
  const document = {
    getElementById: (id: string) => {
      if (opts.missing) return null;
      if (opts.withoutId && id === "hide-thumbnail") return null;
      return id === "hide-thumbnail" ? button : null;
    },
    querySelectorAll: (_sel: string) => {
      if (opts.throws) throw new Error("boom");
      return opts.missing ? [] : [label];
    },
  };
  return { document, clicks };
}

function runJs(js: string, dom: ReturnType<typeof fakeDom>): any {
  return new Function("document", `return ${js};`)(dom.document);
}

// ---------------------------------------------------------------- geração

test("read JS: sintaticamente válido (#7412 regressão do await em IIFE não-async)", () => {
  assert.doesNotThrow(() => new Function(buildThumbnailToggleReadJs()));
  assert.doesNotThrow(() => new Function(buildThumbnailToggleClickJs()));
});

test("JS gerado é SÍNCRONO — async/await faz javascript_tool devolver {} (#2341)", () => {
  for (const js of [buildThumbnailToggleReadJs(), buildThumbnailToggleClickJs()]) {
    assert.ok(!/\basync\b/.test(js), "não pode conter async");
    assert.ok(!/\bawait\b/.test(js), "não pode conter await");
    assert.ok(!/setTimeout/.test(js), "espera vai FORA do javascript_tool (#1766)");
  }
});

test("JS usa o controle real (#hide-thumbnail / aria-checked), não input.checked", () => {
  const js = buildThumbnailToggleReadJs();
  assert.match(js, /hide-thumbnail/);
  assert.match(js, /aria-checked/);
  assert.ok(!/\.checked\b/.test(js), "<button> não tem .checked — estado vive em aria-checked");
});

// ------------------------------------------------- execução contra DOM real

test("read: lê o estado do <button role=switch> pelo id", () => {
  assert.deepEqual(runJs(buildThumbnailToggleReadJs(), fakeDom({ ariaChecked: "true" })), {
    found: true,
    enabled: true,
  });
  assert.deepEqual(runJs(buildThumbnailToggleReadJs(), fakeDom({ ariaChecked: "false" })), {
    found: true,
    enabled: false,
  });
});

test("read: cai no fallback do label quando o id muda", () => {
  const out = runJs(buildThumbnailToggleReadJs(), fakeDom({ withoutId: true, ariaChecked: "true" }));
  // o fallback resolve o `for` do label, que aponta para o mesmo id
  assert.equal(out.found, false);
  assert.match(out.reason, /nao encontrado/);
});

test("read: controle ausente e exceção viram found:false COM motivo", () => {
  const missing = runJs(buildThumbnailToggleReadJs(), fakeDom({ missing: true }));
  assert.equal(missing.found, false);
  assert.match(missing.reason, /nao encontrado/);

  const boom = runJs(buildThumbnailToggleReadJs(), fakeDom({ missing: true, throws: true }));
  assert.equal(boom.found, false);
  assert.match(boom.reason, /excecao: boom/);
});

test("read: aria-checked ausente NÃO é lido como OFF", () => {
  const out = runJs(buildThumbnailToggleReadJs(), fakeDom({ ariaChecked: null }));
  assert.equal(out.found, false, "sem aria-checked o estado é desconhecido, não OFF");
  assert.match(out.reason, /aria-checked/);
});

test("click: só dispara quando o toggle está LIGADO", () => {
  const on = fakeDom({ ariaChecked: "true" });
  const rOn = runJs(buildThumbnailToggleClickJs(), on);
  assert.deepEqual(rOn, { found: true, clicked: true, before: true });
  assert.equal(on.clicks.count, 1);

  const off = fakeDom({ ariaChecked: "false" });
  const rOff = runJs(buildThumbnailToggleClickJs(), off);
  assert.equal(rOff.clicked, false);
  assert.equal(off.clicks.count, 0, "não pode clicar com o toggle já OFF — ligaria o hero");
});

// ------------------------------------------------------------ classificação

test("resultado vazio do javascript_tool NUNCA vira 'está OFF' (#2341)", () => {
  for (const empty of [{}, null, undefined]) {
    const s = classifyThumbnailToggleResult(empty);
    assert.equal(s.found, false, "vazio é desconhecido, não sucesso");
    assert.ok(s.reason && s.reason.length > 0);
    assert.equal(needsManualCheck(s), true);
  }
});

test("classify preserva o motivo e não infere enabled sem found", () => {
  const s = classifyThumbnailToggleResult({ found: false, reason: "controle sumiu" });
  assert.equal(s.found, false);
  assert.equal(s.enabled, false);
  assert.equal(s.reason, "controle sumiu");

  // `enabled` sem `found` não pode virar um estado "conhecido"
  const bogus = classifyThumbnailToggleResult({ enabled: true });
  assert.equal(bogus.found, false);
});

test("classify do clique normaliza retorno vazio", () => {
  const c = classifyThumbnailToggleClick({});
  assert.equal(c.found, false);
  assert.equal(c.clicked, false);
  assert.ok(c.reason);

  const ok = classifyThumbnailToggleClick({ found: true, clicked: true, before: true });
  assert.deepEqual({ f: ok.found, c: ok.clicked, b: ok.before }, { f: true, c: true, b: true });
});

test("needsManualCheck: só dispensa o editor quando lido E desligado", () => {
  assert.equal(needsManualCheck({ found: true, enabled: false }), false);
  assert.equal(needsManualCheck({ found: true, enabled: true }), true);
  assert.equal(needsManualCheck({ found: false, enabled: false, reason: "x" }), true);
});

// --------------------------------------------------------------- mensagens

test("mensagem de estado não-verificado carrega o motivo (não some no genérico)", () => {
  const msg = formatThumbnailToggleMessage({
    found: false,
    enabled: false,
    reason: "excecao: Cannot read properties of null",
  });
  assert.match(msg, /NAO verificado/);
  assert.match(msg, /Cannot read properties of null/, "o motivo precisa aparecer no log");
});

test("mensagens distinguem ligado, desligado e não-verificado", () => {
  assert.match(formatThumbnailToggleMessage({ found: true, enabled: true }), /LIGADO/);
  assert.match(formatThumbnailToggleMessage({ found: true, enabled: false }), /OFF/);
  assert.match(
    formatThumbnailToggleMessage({ found: false, enabled: false, reason: "r" }),
    /NAO verificado/,
  );
});
