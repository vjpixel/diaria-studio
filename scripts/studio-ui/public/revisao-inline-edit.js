// revisao-inline-edit.js (#3806, Opção B — spike de edição visual do título
// de destaque) — lógica PURA da edição inline na aba Preview. Mesmo padrão
// de revisao-guards.js/revisao-prompts.js (#3629/#3668): nenhuma exportação
// abaixo toca `document`/`fetch` — são testáveis com fixtures puras, sem DOM
// real (#633). A parte que TOCA o DOM (contenteditable no iframe, listeners
// de blur/keydown) mora em revisao.js, seguindo a mesma convenção: DOM-wiring
// não é unit-testado neste repo (só as funções puras que ele chama são).
//
// Escopo (ver corpo do #3806): só o campo "título de destaque" nesta 1ª
// fatia — reordenar destaques, mover itens entre seções, editar links segue
// exclusivamente no editor de Markdown (aba "Newsletter").

/**
 * Seletor do elemento de título de destaque no HTML renderizado — é a MESMA
 * classe que o template de PRODUÇÃO usa (`renderHeadline` em
 * newsletter-render-html.ts, `<a class="headline">`), então a edição inline
 * NÃO precisa de nenhuma mudança no render de produção: revisao.js só
 * pós-processa o DOM já renderizado dentro do iframe (adiciona
 * `contenteditable` + listeners), depois que a página carrega — o e-mail
 * REAL enviado nunca passa por esse pós-processamento (só o preview servido
 * pelo Studio, dentro do iframe da aba "reviewed").
 *
 * A ORDEM de aparição no DOM é sempre D1, D2, D3 — `renderHTML` itera
 * `content.destaques` em ordem sequencial (sem pular índice mesmo em
 * edições de 2 destaques, #3369), então o N-ésimo `<a class="headline">`
 * corresponde sempre ao destaque N.
 */
export const DESTAQUE_HEADLINE_SELECTOR = "a.headline";

/** Só os 3 primeiros `<a class="headline">` mapeiam pra uma região do MD
 * (D1/D2/D3) — uma edição nunca tem mais que 3 destaques (#3369), então
 * qualquer occorrência além da 3ª (não deveria existir, mas defensivo) é
 * ignorada em vez de tentar editar algo sem região correspondente. */
export const MAX_EDITABLE_DESTAQUES = 3;

/**
 * Normaliza o texto extraído de um `contenteditable` antes de salvar: some
 * quebras de linha que o navegador pode inserir num título pensado pra 1
 * linha só (Enter sem handler, paste de texto multi-linha), colapsa espaços
 * múltiplos, tira espaço de borda. Pura — sem DOM (recebe a STRING já
 * extraída via `.textContent`, não o elemento).
 */
export function sanitizeInlineTitleText(rawText) {
  return String(rawText ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Decide se vale a pena disparar o PUT de salvar — `false` quando o texto
 * sanitizado ficou vazio (o backend também recusa vazio, mas recusar aqui
 * evita o round-trip de rede + uma mensagem de erro confusa por um blur sem
 * edição real) ou é idêntico ao texto original (blur sem mudança de fato,
 * ex: clicar pra editar e sair sem digitar nada).
 */
export function shouldSaveInlineTitle(sanitizedNewText, originalText) {
  if (sanitizedNewText === "") return false;
  return sanitizedNewText !== originalText;
}

/**
 * Monta o corpo do `PUT /api/editions/:aammdd/review/reviewed/destaque-title`
 * — função pura só pra manter o shape do payload num único lugar testável
 * (o mesmo shape que `handleReviewFieldDestaqueTitle`, server.ts, espera).
 */
export function buildDestaqueTitleSavePayload(n, title, expectedModifiedAt) {
  return { n, title, expectedModifiedAt: expectedModifiedAt ?? null };
}

/**
 * Mensagem mostrada quando o PUT retorna 409 (conflito de mtime, #3729) —
 * a edição inline (diferente do editor de MD completo, `saveCurrent()` em
 * revisao.js) NÃO oferece um botão "sobrescrever mesmo assim" nesta 1ª
 * fatia: sempre recarrega a versão do disco, descartando a edição local do
 * campo. Simplificação deliberada do spike (ver corpo do #3806/PR) — um
 * campo isolado é baixo-risco o suficiente pra não precisar do dialog de
 * confirmação completo do editor de MD; o editor só reedita o campo depois
 * de recarregar.
 */
export function buildInlineTitleConflictMessage(n) {
  return (
    `Conflito: o arquivo mudou desde que você abriu o painel — recarregando a versão atual ` +
    `(a edição do título D${n} feita agora foi descartada, edite de novo depois de recarregar).`
  );
}
