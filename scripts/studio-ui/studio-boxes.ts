/**
 * studio-boxes.ts (#3924 — Studio UI: seção "Caixas" — listar e editar os
 * snippets de caixa de divulgação)
 *
 * Camada de leitura/escrita pro painel "Caixas" do Studio: os snippets
 * reusáveis injetados na newsletter (recomendação de leitura, apoio, etc.)
 * vivem em `context/snippets/*.md` — este módulo lista esse diretório
 * dinamicamente, cruza com os slots ativos em `platform.config.json` →
 * `boxes_divulgacao`, edita o conteúdo de uma caixa existente, e (#3937)
 * gerencia a PRÓPRIA atribuição dos 3 slots (`readBoxSlotsState` +
 * `saveBoxSlots`) — reescrita cirúrgica de `boxes_divulgacao`, nunca do
 * arquivo inteiro (ver docstring de `replaceBoxesDivulgacaoBlock`).
 *
 * Arquivo PRÓPRIO desta fatia (mesma convenção de `studio-review.ts` #3559 /
 * `studio-apoios.ts` #3602): `server.ts` só registra rotas, toda a lógica
 * mora aqui.
 *
 * **Fonte da verdade da lista** é o diretório em si — nenhum índice
 * separado, nenhum cache. `README.md` é excluído (documentação do formato do
 * snippet, não uma caixa de verdade) e nunca é um slug válido, tanto pro
 * `GET` (lista) quanto pro `readBox`/`saveBox` (rejeitado explicitamente,
 * mesmo que alguém tente `PUT /api/boxes/README.md` direto).
 *
 * **`runtime: false` (#4500)** — mesma convenção de header de `nome:`/
 * `categoria:`: um `.md` de `context/snippets/` que é documentação/referência
 * (nunca lido em runtime pelo pipeline — ex: `intro-campeoes-sorteio.md`, cuja
 * caixa real é hardcoded/gerada por `build-champions-callout.ts`, sem ligação
 * nenhuma com os slots) declara `runtime: false` no header pra sumir de
 * `listBoxes` — mesmo efeito de exclusão do `README_FILENAME`, mas via campo
 * de conteúdo em vez de nome de arquivo fixo. Escopo DELIBERADAMENTE estreito
 * (opção 1 da issue, não a 2): só a LISTAGEM filtra; `readBox`/`saveBox`
 * continuam funcionando pra esses arquivos se chamados diretamente (edição
 * fora da UI do painel Caixas), e `saveBoxSlots` não valida esse campo — um
 * slot já atribuído a um arquivo `runtime: false` por fora da UI não é
 * rejeitado no save, só deixa de aparecer como opção na lista.
 *
 * **Slug válido** = casa `/^[a-z0-9-]+\.md$/` (sem barra, sem `..`, sem
 * maiúscula — a checagem por regex já impede traversal por construção, já
 * que nenhum caractere de separador de path é aceito) E existe como arquivo
 * em `context/snippets/`. Qualquer coisa fora disso (traversal, `README.md`,
 * extensão errada, arquivo inexistente) é tratada como "não encontrada" —
 * o caller HTTP (`server.ts`) responde 404 pra QUALQUER falha de
 * `readBox`/`saveBox` que não seja o conflito de mtime (409, ver abaixo).
 *
 * **Guard de mtime (#3729) reusado, não duplicado:** `saveBox` replica
 * literalmente o mesmo padrão de `saveReviewFile` (`studio-review.ts`) —
 * `expectedModifiedAt` (mtime ISO visto pelo client no último GET) é
 * comparado contra o mtime ATUAL em disco antes de escrever; divergência
 * (outra aba/sessão do Studio salvou a mesma caixa nesse meio tempo) aborta
 * o write e retorna `{conflict: true, currentModifiedAt}` em vez de
 * sobrescrever silenciosamente — o handler HTTP responde 409 nesse caso.
 * `force: true` ignora a divergência (o editor já confirmou no dialog de
 * conflito do client). Ao contrário de `02-reviewed.md`/`03-social.md`
 * (tocados pelo PIPELINE via `Edit`/`Write` do agente, #3729), uma caixa de
 * divulgação não é escrita automaticamente por nenhum stage — o risco aqui é
 * mais estreito (2 abas do Studio na mesma caixa), mas o mecanismo de defesa
 * é idêntico e barato de reusar.
 *
 * **Criação de caixa nova está FORA de escopo desta issue** — `saveBox` só
 * escreve em cima de um arquivo já existente (a issue pede "listar e
 * editar", não "criar"). Um `PUT` num slug bem-formado mas inexistente em
 * disco é tratado como "não encontrada" (404), igual a qualquer slug
 * inválido.
 *
 * **Atribuição de slot (#3924 leitura + #3937 escrita; slot0 #4290)** —
 * `listBoxes` cruza contra `platform.config.json` → `boxes_divulgacao.slot{0,1,2,3}`
 * pra exibir o badge "slot N"; `saveBoxSlots` é o único ponto desta fatia que
 * ESCREVE nesse arquivo, e faz isso cirurgicamente (só a chave
 * `boxes_divulgacao`, ver `replaceBoxesDivulgacaoBlock`).
 *
 * **Variante Patronos (#4275)** — MESMO mecanismo acima, chave IRMÃ plana
 * `boxes_divulgacao_patronos` (não aninhada). `readBoxSlotAssignments`/
 * `readBoxSlotsState`/`saveBoxSlots` ganharam um parâmetro `variant`
 * (`"default" | "patronos"`, default `"default"` — comportamento idêntico ao
 * pré-#4275 quando omitido); `replaceBoxesDivulgacaoBlock` ganhou `configKey`
 * (mesmo default). `listBoxes` expõe as DUAS atribuições por caixa (`slot` +
 * `slotPatronos`), e `archiveBox` bloqueia arquivamento se a caixa estiver em
 * uso em QUALQUER uma das duas variantes. Ver `scripts/lib/newsletter-patronos.ts`
 * pro consumo desses valores no render da variante Patronos (Fase 1: gerar +
 * revisar, sem publicar).
 *
 * **PARA ENCERRAR slot A/B (#4274)** — mecanismo IRMÃO, mas DIFERENTE: os
 * slots 0-3 acima atribuem um FILENAME de `context/snippets/` (pool
 * opcional); `readParaEncerrarState`/`saveParaEncerrar`/
 * `replaceParaEncerrarBlock` gerenciam 2 campos de TEXTO DIRETO (sem pool,
 * sempre presentes), escritos em `platform.config.json` → `para_encerrar.
 * {slot_a,slot_b}` — mesma disciplina de reescrita cirúrgica + guard de
 * mtime, chave de config diferente. Ver `buildParaEncerrar` em
 * `../stitch-newsletter.ts` pro consumo desses valores no stitch.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  extractHeaderRemainder,
  stripHeaderBlock,
  buildContentWithHeader,
  parseBoxHeaderField,
} from "../lib/shared/snippet-header.ts"; // #3979/#3981 — helpers genéricos de header compartilhados com o render (newsletter-parse.ts); parseBoxHeaderField reusado pro campo `runtime:` (#4500)

// ── slug / path ──────────────────────────────────────────────────────────

/** Só letras minúsculas, dígitos e hífen, terminando em `.md` — sem barra,
 * sem `..`, sem maiúscula. Isso por construção já impede path traversal
 * (nenhum separador de path é aceito) e já exclui `README.md` (maiúsculas
 * não casam) — a checagem explícita de `README_FILENAME` abaixo é defesa em
 * profundidade, não a única linha de defesa. */
const BOX_SLUG_RE = /^[a-z0-9-]+\.md$/;

const README_FILENAME = "README.md";

export function isValidBoxSlug(slug: string): boolean {
  return BOX_SLUG_RE.test(slug) && slug !== README_FILENAME;
}

export function snippetsDir(rootDir: string): string {
  return resolve(rootDir, "context", "snippets");
}

/** Subpasta de caixas ARQUIVADAS (#3928): `context/snippets/_arquivo/`. Mesma
 * convenção `_arquivo/` já usada no repo pra edições arquivadas. Arquivar =
 * mover o `.md` pra cá; a caixa some de `listBoxes` (que só enumera `.md` no
 * nível de `snippetsDir` — `readdirSync` não-recursivo + `entry.isFile()`
 * exclui subpastas) sem que o conteúdo seja deletado. `_arquivo` nunca é um
 * slug válido (`isValidBoxSlug` rejeita `_`), então não há colisão. */
const ARCHIVE_DIRNAME = "_arquivo";

export function archiveDir(rootDir: string): string {
  return resolve(snippetsDir(rootDir), ARCHIVE_DIRNAME);
}

/** Path absoluto do arquivo de uma caixa — só chamar depois de confirmar
 * `isValidBoxSlug(slug)` (o regex já garante que o resultado nunca escapa de
 * `snippetsDir`, mas o caller sempre valida antes de qualquer I/O). */
export function boxFilePath(rootDir: string, slug: string): string {
  return resolve(snippetsDir(rootDir), slug);
}

/** Path absoluto de uma caixa ARQUIVADA (dentro de `_arquivo/`). Mesma pré-
 * condição de `boxFilePath`: só chamar com slug já validado. */
export function archivedBoxFilePath(rootDir: string, slug: string): string {
  return resolve(archiveDir(rootDir), slug);
}

// ── título ───────────────────────────────────────────────────────────────

const TITLE_MAX_LEN = 80;

function truncateTitle(s: string): string {
  if (s.length <= TITLE_MAX_LEN) return s;
  return s.slice(0, TITLE_MAX_LEN - 1).trimEnd() + "…";
}

/** Remove blocos de comentário HTML (`<!-- ... -->`) do conteúdo, pra fins de
 * título (#3928). TODOS os snippets de divulgação abrem, por convenção, com um
 * bloco de doc `<!-- ... -->` (ver `scripts/lib/shared/snippet-loader.ts`, que
 * remove esse header em runtime) — sem este strip, `extractBoxTitle` devolvia
 * literalmente `<!--` como título. Trata comentário multi-linha, mesma-linha e
 * múltiplos (regex não-guloso). Caso degenerado de comentário NÃO-fechado (sem
 * `-->`): descarta tudo do `<!--` em diante, pra nunca vazar `<!--` como
 * título. Nunca lança. */
function stripHtmlComments(content: string): string {
  let out = content.replace(/<!--[\s\S]*?-->/g, "");
  const unclosed = out.indexOf("<!--");
  if (unclosed !== -1) out = out.slice(0, unclosed);
  return out;
}

/** Título de exibição de uma caixa: o primeiro heading Markdown (`# ...` a
 * `###### ...`, com os `#` removidos) SE a primeira linha não-vazia for um
 * heading; senão a própria primeira linha não-vazia, como está. Blocos de
 * comentário HTML no topo (convenção de todos os snippets) são ignorados
 * primeiro (#3928 — ver `stripHtmlComments`). Truncado a ~80 chars. Arquivo
 * vazio, só linhas em branco, ou só comentário vira `"(vazio)"` — nunca lança,
 * nunca retorna string vazia (uma caixa sem título visível na lista seria
 * indistinguível de um bug de render). */
export function extractBoxTitle(content: string): string {
  const lines = stripHtmlComments(content).split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Conhecido e aceito (#4141 finding 4, pré-existente — não é regressão de
    // nenhuma PR recente): `.+` guloso captura hashes de FECHAMENTO opcionais
    // (`## Título ##`) como parte do texto, então "Título ##" vaza como
    // título em vez de "Título". Nenhum snippet real do repo usa essa
    // sintaxe hoje; registrado aqui pra não ser redescoberto do zero.
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed);
    const text = (heading ? heading[1] : trimmed).trim();
    if (!text) continue;
    return truncateTitle(text);
  }
  return "(vazio)";
}

// ── nome interno vs. título de conteúdo (#3933) ────────────────────────────
//
// Uma caixa tem DOIS rótulos distintos:
//   1. **nome interno** — rótulo pra o EDITOR identificar a caixa na lista do
//      Studio. Mora num campo `nome:` DENTRO do header de comentário HTML —
//      `readSnippetFile` (scripts/lib/shared/snippet-loader.ts) já remove todo
//      comentário antes do conteúdo ir pra newsletter, então `nome:` NUNCA
//      vaza pro leitor.
//   2. **título de conteúdo** — o que renderiza dentro da caixa na edição
//      (derivado por `extractBoxTitle`).
// Iguais em muitos casos, diferentes em outros. `resolveBoxDisplayName` decide
// o rótulo da lista: `nome:` explícito > título derivado > slug.

/** Corpo do PRIMEIRO comentário HTML se o conteúdo começa (após espaço) com um
 * — o "header" convencional dos snippets. `null` se não houver. */
function leadingCommentInner(content: string): string | null {
  const m = /^\s*<!--([\s\S]*?)-->/.exec(content);
  return m ? m[1] : null;
}

/** Extrai o `nome:` do header de comentário (#3933), ou `null` se ausente.
 * Chave case-insensitive; valor = resto da linha, trimado. Só olha o header
 * (1º comentário) — um `nome:` solto no corpo não conta. Nunca lança. */
export function parseBoxNome(content: string): string | null {
  const inner = leadingCommentInner(content);
  if (inner === null) return null;
  const line = /^[ \t]*nome[ \t]*:[ \t]*(.+?)[ \t]*$/im.exec(inner);
  return line ? line[1].trim() : null;
}

/** Extrai o `categoria:` do header de comentário (#3981) — mesmo contrato de
 * `parseBoxNome` (#3933): case-insensitive, só o 1º comentário, `null` se
 * ausente. Valor é o rótulo exibido como kicker acima do box na newsletter
 * (ver `readBoxDivulgacaoCategoriaForSlot` em `scripts/lib/newsletter-parse.ts`,
 * que lê este MESMO campo direto do disco no momento do render). Nunca
 * lança. */
export function parseBoxCategoria(content: string): string | null {
  const inner = leadingCommentInner(content);
  if (inner === null) return null;
  const line = /^[ \t]*categoria[ \t]*:[ \t]*(.+?)[ \t]*$/im.exec(inner);
  return line ? line[1].trim() : null;
}

/** `true` se o header de comentário declara `runtime: false` (#4500) — sinal
 * de que o `.md` é documentação/referência (não lido em runtime pelo
 * pipeline, ex: `intro-campeoes-sorteio.md`) e por isso não deve aparecer
 * como opção selecionável no painel Caixas (`listBoxes` filtra por isso).
 * Usa o helper genérico `parseBoxHeaderField` (mesma leitura de `nome:`/
 * `categoria:`, case-insensitive, só o 1º comentário). Comparação
 * case-insensitive do VALOR também (`False`/`FALSE` contam) — qualquer outro
 * valor (`true`, ausente, string arbitrária) não exclui. Nunca lança. */
export function isRuntimeExcluded(content: string): boolean {
  const raw = parseBoxHeaderField(content, "runtime");
  return raw !== null && raw.trim().toLowerCase() === "false";
}

/** Remove a linha `nome:` do header de comentário (#3933), devolvendo o "body"
 * que o editor vê no textarea (o resto do header + o conteúdo). Se o header
 * ficar só com espaço em branco depois, remove o bloco de comentário inteiro
 * (+ as quebras de linha subsequentes) pra não deixar um `<!-- -->` vazio no
 * topo. Idempotente (rodar 2× = rodar 1×). Nunca lança. */
export function stripNomeLine(content: string): string {
  const m = /^(\s*<!--)([\s\S]*?)(-->)/.exec(content);
  if (!m) return content;
  const [full, open, inner, close] = m;
  const cleanedInner = inner.replace(/^[ \t]*nome[ \t]*:.*(?:\r?\n)?/im, "");
  if (cleanedInner === inner) return content; // não tinha nome: — no-op
  if (cleanedInner.trim() === "") {
    // Header ficou vazio: descarta o comentário e as linhas em branco após ele.
    return content.slice(full.length).replace(/^\r?\n+/, "");
  }
  return open + cleanedInner + close + content.slice(full.length);
}

/** Reconstrói o conteúdo inserindo/atualizando o `nome:` no header (#3933).
 * `body` é o conteúdo SEM a linha `nome:` (como `stripNomeLine` devolve); mas é
 * robusto a um `body` que ainda tenha `nome:` (remove antes de reinserir, nunca
 * duplica). `nome` vazio/whitespace = sem campo (remove qualquer `nome:`
 * remanescente). Nunca lança. */
export function buildBoxContentWithNome(nome: string, body: string): string {
  const clean = (nome ?? "").trim();
  const withoutNome = stripNomeLine(body ?? "");
  if (!clean) return withoutNome;
  const m = /^(\s*<!--)([\s\S]*?)(-->)/.exec(withoutNome);
  if (m) {
    const inner = m[2].replace(/^\r?\n/, "");
    return `${m[1]}\nnome: ${clean}\n${inner}${m[3]}${withoutNome.slice(m[0].length)}`;
  }
  return `<!--\nnome: ${clean}\n-->\n\n${withoutNome}`;
}

/** Rótulo de exibição de uma caixa na lista do Studio (#3933): `nome:`
 * explícito do header, senão o título derivado do conteúdo (`extractBoxTitle`),
 * senão — se o arquivo é só comentário/vazio — o próprio slug (uma caixa que
 * existe sempre mostra algo identificável). Truncado a ~80. Nunca lança. */
export function resolveBoxDisplayName(content: string, slug: string): string {
  const nome = parseBoxNome(content);
  if (nome) return truncateTitle(nome);
  const derived = extractBoxTitle(content);
  return derived === "(vazio)" ? slug : derived;
}

// ── notas vs. conteúdo — 2 painéis separados no editor (#3979) ────────────
//
// Antes (#3933): o textarea único do editor mostrava `body` = header (menos
// `nome:`) + conteúdo, tudo misturado. #3979 separa em 2 painéis: "Conteúdo"
// (o que renderiza na edição — `extractBoxConteudo`) e "Notas" (o resto do
// header de comentário, MENOS `nome:`/`categoria:` — que têm campo dedicado
// — `extractBoxNotas`). `buildBoxContent` recompõe os 2 painéis + os 2
// campos dedicados de volta no arquivo.

/** Texto do painel "Notas" (#3979): o header de comentário MENOS as linhas
 * `nome:`/`categoria:` (que têm campo dedicado próprio), trimado. `""` se
 * não há header, ou se o header só tinha `nome:`/`categoria:`. Nunca lança. */
export function extractBoxNotas(content: string): string {
  return extractHeaderRemainder(content, ["nome", "categoria"]);
}

/** Texto do painel "Conteúdo" (#3979): o arquivo com o bloco de
 * comentário-header INTEIRO removido — exatamente o que
 * `readSnippetFile`/`stitch-newsletter.ts` injeta na newsletter. Sem header
 * -> devolve o conteúdo como está. Nunca lança. */
export function extractBoxConteudo(content: string): string {
  return stripHeaderBlock(content);
}

/** Recompõe o arquivo da caixa a partir dos 4 campos que o editor de 2
 * painéis (#3979/#3981) edita: `nome`/`categoria` (campos dedicados, viram
 * linhas `key: value` no header, nessa ordem, omitidas se vazias) + `notas`
 * (texto livre, resto do header) + `conteudo` (o que renderiza). Sem
 * nome/categoria/notas -> sem comentário no topo (conteúdo puro). Byte-
 * estável em round-trip: `buildBoxContent(readBox-fields, conteudo) ===`
 * conteúdo original, desde que o arquivo siga a convenção canônica (header
 * `<!--\n...\n-->` seguido de 1 linha em branco + conteúdo — ver
 * test/studio-boxes.test.ts). Nunca lança. */
export function buildBoxContent(
  fields: { nome?: string | null; categoria?: string | null; notas?: string | null },
  conteudo: string | null | undefined,
): string {
  return buildContentWithHeader(
    [
      { key: "nome", value: fields.nome },
      { key: "categoria", value: fields.categoria },
    ],
    fields.notas,
    conteudo,
  );
}

// ── título de conteúdo: campo dedicado (#4079) ──────────────────────────────
//
// `extractBoxTitle` já deriva o título de conteúdo (1º heading Markdown, ou a
// 1ª linha não-vazia de texto puro) — mas até aqui era só LEITURA: pra mudar
// o que o leitor vê, o editor precisava editar a 1ª linha do painel
// "Conteúdo" diretamente. As 2 funções abaixo dão um campo dedicado
// (`editor-titulo` no client) com a mesma UX de `nome`/`categoria`, sem exigir
// um 3º painel: o campo edita o TEXTO da 1ª linha do "Conteúdo", preservando o
// FORMATO original (heading vs. texto puro) e todo o resto do corpo.

/** Título de conteúdo pronto pro campo dedicado do editor (#4079): mesmo
 * algoritmo de `extractBoxTitle`, mas aplicado a `conteudo` (já sem o header
 * de comentário) e retornando `""` (não o sentinel de exibição `"(vazio)"`)
 * quando não há texto — um campo de formulário deve começar vazio, nunca com
 * o literal "(vazio)" preenchido (que pareceria um título de verdade se o
 * editor salvasse sem tocar o campo). Nunca lança. */
export function extractConteudoTitulo(conteudo: string): string {
  const t = extractBoxTitle(conteudo);
  return t === "(vazio)" ? "" : t;
}

/** Quebra `src` em segmentos `{ text, eol }` — `text` é o conteúdo de uma
 * linha SEM o terminador, `eol` é o terminador exato que a seguia no
 * original (`"\r\n"`, `"\r"`, `"\n"`, ou `""` pro último segmento se o
 * arquivo não termina em quebra de linha). Reconstruir com
 * `segments.map(s => s.text + s.eol).join("")` devolve `src` byte a byte.
 * Existe pra permitir reescrever o TEXTO de uma única linha sem normalizar o
 * terminador de NENHUMA linha do arquivo (nem sequer o da linha reescrita —
 * só o texto dela muda, o `eol` original é preservado) — ver
 * `replaceBoxContentTitle` (#4141 finding 1: `split(/\r?\n/)` +
 * `join("\n")` normalizava CRLF->LF do arquivo INTEIRO quando o título
 * mudava de fato). Nunca lança. */
function splitLinesKeepEol(src: string): Array<{ text: string; eol: string }> {
  const out: Array<{ text: string; eol: string }> = [];
  let pos = 0;
  const eolRe = /\r\n|\r|\n/g;
  while (pos <= src.length) {
    eolRe.lastIndex = pos;
    const m = eolRe.exec(src);
    if (!m) {
      out.push({ text: src.slice(pos), eol: "" });
      break;
    }
    out.push({ text: src.slice(pos, m.index), eol: m[0] });
    pos = m.index + m[0].length;
  }
  return out;
}

/** Reescreve a PRIMEIRA linha não-vazia de `conteudo` (#4079) pra refletir um
 * novo título, preservando o RESTO do corpo intacto e o FORMATO da linha
 * original — heading Markdown `#`-`######` mantém o mesmo nível (`##` continua
 * `##`), texto puro continua texto puro; nunca converte um no outro. Análogo
 * ao upsert cirúrgico de `nome:` no header (`buildBoxContentWithNome`), só que
 * aqui a "primeira linha" é o CONTEÚDO visível (o que renderiza na edição),
 * não uma linha de header.
 *
 * Byte-estável quando não há mudança real: se o título já extraído da 1ª
 * linha for IGUAL a `titulo` (trimado), devolve `conteudo` sem tocar —
 * essencial pro invariante "salvar sem alterar nada é byte-idêntico" (mesmo
 * invariante já coberto pra nome/categoria/notas/conteudo, ver
 * "PUT {conteudo} salvando SEM alterar nada é byte-estável" em
 * test/studio-boxes.test.ts): sem este guard, um heading com espaçamento
 * não-canônico (`##   Título`) seria normalizado pra `## Título` numa
 * gravação que, do ponto de vista do editor, não mudou nada.
 *
 * `titulo` vazio/whitespace -> no-op (preserva `conteudo` como está); o campo
 * dedicado nunca deveria submeter vazio na prática (a UI trata isso
 * client-side), mas o server é fail-soft e nunca apaga a 1ª linha por
 * engano com um título em branco.
 *
 * Corpo vazio ou só linhas em branco (nenhuma linha não-vazia encontrada) ->
 * cria a 1ª linha do zero como texto puro (`titulo`) — não há formato
 * original a preservar (#4079, escopo da issue: "provavelmente cria a
 * primeira linha do zero").
 *
 * CRLF/LF/misto (#4141 finding 1): opera por segmento via
 * `splitLinesKeepEol` — SÓ o texto da linha do título é substituído; o `eol`
 * dessa linha e o texto+eol de TODAS as outras linhas são preservados
 * exatamente como estavam, mesmo em corpo com terminadores mistos. Nunca
 * lança. */
export function replaceBoxContentTitle(conteudo: string, titulo: string): string {
  const clean = (titulo ?? "").trim();
  if (!clean) return conteudo;

  const src = conteudo ?? "";
  const segments = splitLinesKeepEol(src);
  for (let i = 0; i < segments.length; i++) {
    const trimmed = segments[i].text.trim();
    if (!trimmed) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    const currentText = (heading ? heading[2] : trimmed).trim();
    if (currentText === clean) return src; // já é o título desejado — byte-estável, não reescreve
    segments[i] = { text: heading ? `${heading[1]} ${clean}` : clean, eol: segments[i].eol };
    return segments.map((s) => s.text + s.eol).join("");
  }
  // Nenhuma linha não-vazia — corpo vazio/só espaço: cria a 1ª linha do zero.
  return clean;
}

// ── slots (platform.config.json → boxes_divulgacao, somente leitura) ────

export type BoxSlot = 0 | 1 | 2 | 3;

/** As duas variantes de seleção de caixas (#4275): `"default"` é a
 * newsletter diária de sempre (`boxes_divulgacao`); `"patronos"` é a
 * variante Patronos — mesmo shape de slots, chave IRMÃ plana
 * `boxes_divulgacao_patronos` (não aninhada — ver docstring de
 * `replaceBoxesDivulgacaoBlock` abaixo). Fase 1 da issue: só gera/revisa, não
 * publica (ver `scripts/lib/newsletter-patronos.ts`). */
export type BoxSlotVariant = "default" | "patronos";

/** Chave de `platform.config.json` correspondente à variante — único ponto
 * que conhece o nome literal das duas chaves. */
export function boxesConfigKeyForVariant(variant: BoxSlotVariant): "boxes_divulgacao" | "boxes_divulgacao_patronos" {
  return variant === "patronos" ? "boxes_divulgacao_patronos" : "boxes_divulgacao";
}

/** Lê `platform.config.json` → `boxes_divulgacao.slot0/1/2/3` (valores são
 * filenames de snippet, `slot0` pode vir `null` — default de slot vazio,
 * #4274/#4290) e inverte pra `filename -> slot`. `variant` (#4275, default
 * `"default"`) troca pra `boxes_divulgacao_patronos` sem mudar o resto do
 * contrato. Fail-soft total: config ausente, JSON corrompido, ou chave
 * ausente/malformada -> `{}` (todo box aparece sem badge de slot) — nunca
 * lança. Somente leitura: nenhuma função deste módulo escreve neste
 * arquivo. */
export function readBoxSlotAssignments(
  rootDir: string,
  variant: BoxSlotVariant = "default",
): Partial<Record<string, BoxSlot>> {
  const configPath = resolve(rootDir, "platform.config.json");
  if (!existsSync(configPath)) return {};
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
  if (!cfg || typeof cfg !== "object") return {};
  const boxes = (cfg as Record<string, unknown>)[boxesConfigKeyForVariant(variant)];
  if (!boxes || typeof boxes !== "object") return {};
  const b = boxes as Record<string, unknown>;
  const out: Partial<Record<string, BoxSlot>> = {};
  for (const [key, slot] of [
    ["slot0", 0],
    ["slot1", 1],
    ["slot2", 2],
    ["slot3", 3],
  ] as const) {
    const filename = b[key];
    if (typeof filename === "string" && filename) out[filename] = slot;
  }
  return out;
}

// ── slots: gestão pela UI (#3937 — leitura direta + ESCRITA; #4290 estende
// pro slot0, introdução, ver docstring de `locateBoxAtIntro` em
// newsletter-parse.ts pra desambiguação vs. introCallout) ─────────────────

const SLOT_KEYS = ["slot0", "slot1", "slot2", "slot3"] as const;
type SlotKey = (typeof SLOT_KEYS)[number];

export interface BoxSlotsState {
  /** #4290: slot0 (introdução) — mesma convenção "" = vazio dos demais slots
   * nesta interface, mesmo que `platform.config.json` grave `null` pra slot0
   * vazio (`boxAlreadyPresentAtIntro`/`loadDivulgacaoSnippet` em
   * stitch-newsletter.ts tratam `""` e `null` de forma idêntica — ambos
   * falsy). */
  slot0: string;
  slot1: string;
  slot2: string;
  slot3: string;
  /** mtime ISO de `platform.config.json` no momento da leitura, ou `null` se
   * o arquivo não existe. O client reenvia isto como `expectedModifiedAt` no
   * PUT (guard de mtime #3729, mesmo contrato de `saveBox`/`saveReviewFile`). */
  modifiedAt: string | null;
}

function readRawBoxesDivulgacao(cfg: unknown, variant: BoxSlotVariant = "default"): Record<string, unknown> {
  if (!cfg || typeof cfg !== "object") return {};
  const boxes = (cfg as Record<string, unknown>)[boxesConfigKeyForVariant(variant)];
  return boxes && typeof boxes === "object" ? (boxes as Record<string, unknown>) : {};
}

/** Lê `platform.config.json` → `boxes_divulgacao.slot{0,1,2,3}` na forma
 * DIRETA (slot -> filename, "" se vazio/ausente — inclusive quando slot0 é
 * `null` no JSON, seu default de vazio desde #4274) — o inverso de
 * `readBoxSlotAssignments` (que inverte pra filename -> slot, só pro badge da
 * lista). `variant` (#4275, default `"default"`) troca pra
 * `boxes_divulgacao_patronos` sem mudar o resto do contrato. Usado pela tela
 * de gestão de slots (#3937, estendida ao slot0 em #4290; à variante
 * Patronos em #4275): mostra a atribuição ATUAL de cada slot + o mtime que o
 * client reenvia como guard de conflito no save. Fail-soft total: config
 * ausente -> todos os slots "" e `modifiedAt: null`; JSON corrompido -> todos
 * os slots "" mas `modifiedAt` real (o arquivo existe, só não parseia);
 * nunca lança. */
export function readBoxSlotsState(rootDir: string, variant: BoxSlotVariant = "default"): BoxSlotsState {
  const empty = { slot0: "", slot1: "", slot2: "", slot3: "" } as const;
  const configPath = resolve(rootDir, "platform.config.json");
  if (!existsSync(configPath)) return { ...empty, modifiedAt: null };
  const modifiedAt = statSync(configPath).mtime.toISOString();
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return { ...empty, modifiedAt };
  }
  const b = readRawBoxesDivulgacao(cfg, variant);
  const get = (key: SlotKey) => (typeof b[key] === "string" ? (b[key] as string) : "");
  return { slot0: get("slot0"), slot1: get("slot1"), slot2: get("slot2"), slot3: get("slot3"), modifiedAt };
}

/** Reescreve SÓ o bloco `"boxes_divulgacao": { ... }` dentro do texto BRUTO de
 * `platform.config.json` (#3937, regra #495) — preserva todas as outras
 * chaves (`newsletter`, `socials`, `beehiiv`, etc.) e a formatação do resto
 * do arquivo byte-a-byte. NUNCA faz `JSON.parse` + `JSON.stringify` do objeto
 * inteiro por cima — mesmo que hoje o arquivo happen to reserializar
 * idêntico (checado manualmente), isso é um acidente do formato atual, não
 * uma garantia; um `note:` com caractere especial, uma futura chave com
 * formatação não-canônica, ou qualquer edição manual do editor que fuja do
 * `JSON.stringify(_, null, 2)` puro quebraria silenciosamente sob essa
 * estratégia. Regex + substituição textual é a única forma de garantir
 * "só essa chave mudou".
 *
 * Localiza o bloco via regex ancorada na indentação da linha
 * `"boxes_divulgacao": {` e no `}` de fechamento na MESMA indentação — só
 * funciona porque o valor de `boxes_divulgacao` é sempre um objeto raso
 * (slot0/1/2/3 -> string), sem chaves aninhadas por dentro (se algum dia
 * ganhar aninhamento, este regex precisa ser revisitado). Se a chave não
 * existir ainda no arquivo (defensivo — não deveria acontecer no repo, onde
 * ela sempre está presente), insere um bloco novo (2 espaços de indentação,
 * convenção do repo) logo antes do fechamento do objeto top-level.
 *
 * #4290: `values.slot0` sempre grava como STRING (`""` quando vazio) — não
 * como `null`, diferente do valor original em disco (`"slot0": null`, ver
 * platform.config.json). Isso é seguro: todo leitor de `boxes_divulgacao.slot0`
 * (`loadDivulgacaoSnippet` em stitch-newsletter.ts, `readBoxDivulgacaoCategoriaForSlot`/
 * `readBoxDivulgacaoAltForSlot`/`readBoxSlotImage` em newsletter-parse.ts)
 * trata `""` e `null` de forma IDÊNTICA (ambos falsy / `typeof !== "string"`)
 * — nenhum desses call-sites distingue "nunca configurado" de "configurado e
 * depois esvaziado". Uma vez que o editor salva pela UI, `slot0` normaliza
 * pra `""` como os demais slots (perde o `null` original, sem efeito
 * observável).
 *
 * Lança se não conseguir localizar nem o bloco nem um ponto de inserção
 * seguro (arquivo não é um objeto JSON bem-formado no nível esperado) — o
 * caller (`saveBoxSlots`) decide como reportar; nunca escreve um arquivo
 * potencialmente corrompido.
 *
 * #4275: `configKey` (default `"boxes_divulgacao"`) parametriza QUAL chave é
 * reescrita — `"boxes_divulgacao_patronos"` reusa a MESMA função pra chave
 * IRMÃ da variante Patronos, sem duplicar a lógica de regex/indentação. As
 * duas chaves têm o mesmo shape plano (slot0/1/2/3 -> string), então o
 * mesmo regex ancorado na indentação funciona pra ambas. */
export function replaceBoxesDivulgacaoBlock(
  raw: string,
  values: { slot0: string; slot1: string; slot2: string; slot3: string },
  configKey: string = "boxes_divulgacao",
): string {
  const outerIndent = "  ";
  const innerIndent = "    ";
  const block = [
    `${outerIndent}"${configKey}": {`,
    `${innerIndent}"slot0": ${JSON.stringify(values.slot0)},`,
    `${innerIndent}"slot1": ${JSON.stringify(values.slot1)},`,
    `${innerIndent}"slot2": ${JSON.stringify(values.slot2)},`,
    `${innerIndent}"slot3": ${JSON.stringify(values.slot3)}`,
    `${outerIndent}}`,
  ].join("\n");

  const escapedKey = configKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`([ \\t]*)"${escapedKey}"\\s*:\\s*\\{[\\s\\S]*?\\n\\1\\}`);
  if (blockRe.test(raw)) {
    return raw.replace(blockRe, () => block);
  }

  const topCloseRe = /\n\}(\s*)$/;
  const m = topCloseRe.exec(raw);
  if (!m) {
    throw new Error(
      `platform.config.json: não foi possível localizar ${configKey} nem um ponto seguro de inserção`,
    );
  }
  return raw.slice(0, m.index) + `,\n${block}\n}` + m[1];
}

export interface SaveBoxSlotsInput {
  slot0: string;
  slot1: string;
  slot2: string;
  slot3: string;
}

export interface SaveBoxSlotsOptions {
  /** mtime (ISO) visto pelo client no último GET — `undefined` pula a
   * checagem de divergência inteiramente (mesma semântica de
   * `SaveBoxOptions.expectedModifiedAt`). */
  expectedModifiedAt?: string | null;
  /** `true` = ignora divergência detectada e sobrescreve mesmo assim (o
   * editor já confirmou no dialog de conflito do client). */
  force?: boolean;
  /** #4275: qual chave de `platform.config.json` esta chamada escreve —
   * `"default"` (padrão) é `boxes_divulgacao`, `"patronos"` é a chave irmã
   * `boxes_divulgacao_patronos`. As caixas VIVAS candidatas (guard 1) são as
   * MESMAS pras duas variantes — `context/snippets/` é um pool único
   * compartilhado, não há um pool separado por variante. */
  variant?: BoxSlotVariant;
}

export interface SaveBoxSlotsResult {
  ok: boolean;
  error?: string;
  modifiedAt: string | null;
  /** `true` quando o save foi recusado por divergência de mtime (#3729) — o
   * caller HTTP responde 409. */
  conflict?: boolean;
  /** mtime atual em disco no momento da tentativa — só presente quando
   * `conflict` é `true`. */
  currentModifiedAt?: string | null;
  /** `true` quando algum slot aponta pra uma caixa inexistente/arquivada
   * (guard 1) OU a mesma caixa foi atribuída a mais de um slot (guard 2) — o
   * caller HTTP responde 400 nesse caso. */
  invalid?: boolean;
  /** Estado novo dos slots (eco pós-write), só presente em sucesso. */
  slots?: BoxSlotsState;
}

function normalizeSlotValue(v: string | undefined | null): string {
  return (v ?? "").trim();
}

/** Escreve a atribuição dos 3 slots de divulgação em `platform.config.json`
 * (#3937). Guards, na ordem em que são checados:
 *   1. cada slot não-vazio precisa ser uma caixa VIVA existente em
 *      `context/snippets/` (não arquivada, não inexistente) — senão o
 *      `stitch-newsletter` quebraria a montagem da edição;
 *   2. a mesma caixa não pode ocupar 2 slots ao mesmo tempo (injetaria a
 *      mesma divulgação 2× na mesma edição);
 *   3. escrita CIRÚRGICA — só a chave `boxes_divulgacao` é reescrita
 *      (`replaceBoxesDivulgacaoBlock`), nunca o objeto inteiro (#495);
 *   4. guard de mtime (#3729) — mesmo contrato de `saveBox`/`saveReviewFile`,
 *      checado ANTES da escrita, depois dos guards 1/2 (não faz sentido
 *      recusar por conflito uma escrita que já seria inválida por outro
 *      motivo).
 * Fail-soft: nunca lança, sempre retorna resultado tipado. */
export function saveBoxSlots(
  rootDir: string,
  input: SaveBoxSlotsInput,
  opts: SaveBoxSlotsOptions = {},
): SaveBoxSlotsResult {
  const variant = opts.variant ?? "default";
  const configKey = boxesConfigKeyForVariant(variant);
  const configPath = resolve(rootDir, "platform.config.json");
  if (!existsSync(configPath)) {
    return { ok: false, error: "platform.config.json não encontrado", modifiedAt: null };
  }

  const values: Record<SlotKey, string> = {
    slot0: normalizeSlotValue(input.slot0),
    slot1: normalizeSlotValue(input.slot1),
    slot2: normalizeSlotValue(input.slot2),
    slot3: normalizeSlotValue(input.slot3),
  };

  // Guard 1: cada slot não-vazio precisa ser uma caixa VIVA existente.
  for (const key of SLOT_KEYS) {
    const slug = values[key];
    if (slug && (!isValidBoxSlug(slug) || !existsSync(boxFilePath(rootDir, slug)))) {
      return {
        ok: false,
        error: `a caixa "${slug}" (${key}) não existe em context/snippets/ (ou está arquivada) — atribuição rejeitada`,
        modifiedAt: null,
        invalid: true,
      };
    }
  }

  // Guard 2: nenhuma caixa em 2 slots ao mesmo tempo.
  const filled = SLOT_KEYS.map((k) => values[k]).filter((v) => v !== "");
  const dupe = filled.find((v, i) => filled.indexOf(v) !== i);
  if (dupe) {
    return {
      ok: false,
      error: `a caixa "${dupe}" foi atribuída a mais de um slot — cada caixa só pode ocupar 1 slot por vez`,
      modifiedAt: null,
      invalid: true,
    };
  }

  // Guard 4: mtime — checado antes de tocar o disco, depois dos guards 1/2.
  const currentModifiedAt = statSync(configPath).mtime.toISOString();
  if (!opts.force && opts.expectedModifiedAt !== undefined) {
    if (currentModifiedAt !== opts.expectedModifiedAt) {
      return {
        ok: false,
        error: "platform.config.json foi modificado desde que você abriu a tela — recarregue ou sobrescreva explicitamente",
        modifiedAt: currentModifiedAt,
        conflict: true,
        currentModifiedAt,
      };
    }
  }

  // Guard 3: escrita cirúrgica — só a chave da variante (`configKey`) é tocada.
  let rewritten: string;
  try {
    const raw = readFileSync(configPath, "utf8");
    rewritten = replaceBoxesDivulgacaoBlock(raw, values, configKey);
  } catch (e) {
    return { ok: false, error: (e as Error).message, modifiedAt: null };
  }

  try {
    writeFileSync(configPath, rewritten, "utf8");
  } catch (e) {
    return { ok: false, error: (e as Error).message, modifiedAt: null };
  }

  const modifiedAt = statSync(configPath).mtime.toISOString();
  return { ok: true, modifiedAt, slots: readBoxSlotsState(rootDir, variant) };
}

// ── PARA ENCERRAR: slots A/B de texto direto (#4274 — reescopo do gate
// /diaria-develop 260729) ───────────────────────────────────────────────
//
// Diferença de mecanismo vs. os slots 0-3 acima: aqueles atribuem um
// FILENAME de `context/snippets/` (pool de candidatos, opcionais, podem
// ficar vazios). Slot A (parágrafo de apoio + bloco de ferramentas) e Slot B
// (convite social) são conteúdo SEMPRE-PRESENTE da seção PARA ENCERRAR — 1
// campo de TEXTO DIRETO por slot, editado no painel Caixas como um textarea
// comum, persistido em `platform.config.json` → `para_encerrar.{slot_a,slot_b}`
// (ver `loadParaEncerrarConfig`/`buildParaEncerrar` em `../stitch-newsletter.ts`).
// #4357: o Slot A NÃO inclui mais a lista de pills "Acesse nossas
// curadorias" — ela é navegação estrutural permanente
// (`FIXED_BLOCKS.para_encerrar_curadorias`), concatenada por
// `buildParaEncerrar` FORA do alcance deste override (antes, sobrescrever o
// Slot A apagava as pills junto, em silêncio — achado 260730/731).
//
// `readParaEncerrarState` devolve o valor CRU do config ("" se ausente/
// vazio) — NÃO resolve o texto-default de fallback (que `buildParaEncerrar`
// computa a partir de `context/snippets/encerramento-social-apoio.md`
// quando o campo está vazio): esse default depende do snippet no ROOT REAL
// do repo (via `readSnippetFile`), não do `rootDir` de teste que este
// módulo aceita como parâmetro — resolver aqui quebraria o isolamento dos
// testes (mesmo motivo por que `readBoxSlotsState` também nunca resolve
// nada além do valor cru do config). Um campo "" na tela do painel
// significa "sem override — a edição usa o texto padrão do snippet"; a UI
// mostra essa explicação, não o texto resolvido.

export interface ParaEncerrarState {
  slotA: string;
  slotB: string;
  /** mtime ISO de `platform.config.json` no momento da leitura, ou `null` se
   * o arquivo não existe. Mesmo guard de mtime (#3729) de `BoxSlotsState`. */
  modifiedAt: string | null;
}

function readRawParaEncerrar(cfg: unknown): Record<string, unknown> {
  if (!cfg || typeof cfg !== "object") return {};
  const pe = (cfg as Record<string, unknown>).para_encerrar;
  return pe && typeof pe === "object" ? (pe as Record<string, unknown>) : {};
}

/** Lê `platform.config.json` → `para_encerrar.{slot_a,slot_b}` cru ("" se
 * ausente/vazio/não-string) + mtime. Fail-soft total: config ausente ->
 * slots "" e `modifiedAt: null`; JSON corrompido -> slots "" mas
 * `modifiedAt` real; nunca lança. */
export function readParaEncerrarState(rootDir: string): ParaEncerrarState {
  const empty = { slotA: "", slotB: "" } as const;
  const configPath = resolve(rootDir, "platform.config.json");
  if (!existsSync(configPath)) return { ...empty, modifiedAt: null };
  const modifiedAt = statSync(configPath).mtime.toISOString();
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return { ...empty, modifiedAt };
  }
  const pe = readRawParaEncerrar(cfg);
  const get = (key: "slot_a" | "slot_b") => (typeof pe[key] === "string" ? (pe[key] as string) : "");
  return { slotA: get("slot_a"), slotB: get("slot_b"), modifiedAt };
}

/** Reescreve SÓ o bloco `"para_encerrar": { ... }` dentro do texto BRUTO de
 * `platform.config.json` — mesma disciplina de `replaceBoxesDivulgacaoBlock`
 * (regra #495, preserva todas as outras chaves e formatação byte-a-byte,
 * NUNCA `JSON.parse`+`JSON.stringify` do objeto inteiro). Localiza o bloco
 * via regex ancorada na indentação; se a chave ainda não existir no arquivo
 * (config anterior ao #4274), insere um bloco novo antes do fechamento do
 * objeto top-level. Lança se não conseguir localizar nem o bloco nem um
 * ponto de inserção seguro — o caller (`saveParaEncerrar`) decide como
 * reportar. */
export function replaceParaEncerrarBlock(
  raw: string,
  values: { slotA: string; slotB: string },
): string {
  const outerIndent = "  ";
  const innerIndent = "    ";
  const block = [
    `${outerIndent}"para_encerrar": {`,
    `${innerIndent}"slot_a": ${JSON.stringify(values.slotA)},`,
    `${innerIndent}"slot_b": ${JSON.stringify(values.slotB)}`,
    `${outerIndent}}`,
  ].join("\n");

  const blockRe = /([ \t]*)"para_encerrar"\s*:\s*\{[\s\S]*?\n\1\}/;
  if (blockRe.test(raw)) {
    return raw.replace(blockRe, () => block);
  }

  const topCloseRe = /\n\}(\s*)$/;
  const m = topCloseRe.exec(raw);
  if (!m) {
    throw new Error(
      "platform.config.json: não foi possível localizar para_encerrar nem um ponto seguro de inserção",
    );
  }
  return raw.slice(0, m.index) + `,\n${block}\n}` + m[1];
}

export interface SaveParaEncerrarInput {
  slotA: string;
  slotB: string;
}

export interface SaveParaEncerrarOptions {
  /** mtime (ISO) visto pelo client no último GET — `undefined` pula a
   * checagem de divergência inteiramente (mesma semântica de
   * `SaveBoxSlotsOptions.expectedModifiedAt`). */
  expectedModifiedAt?: string | null;
  /** `true` = ignora divergência detectada e sobrescreve mesmo assim (o
   * editor já confirmou no dialog de conflito do client). */
  force?: boolean;
}

export interface SaveParaEncerrarResult {
  ok: boolean;
  error?: string;
  modifiedAt: string | null;
  /** `true` quando o save foi recusado por divergência de mtime (#3729) — o
   * caller HTTP responde 409. */
  conflict?: boolean;
  /** mtime atual em disco no momento da tentativa — só presente quando
   * `conflict` é `true`. */
  currentModifiedAt?: string | null;
  /** Estado novo dos slots (eco pós-write), só presente em sucesso. */
  state?: ParaEncerrarState;
}

/** Escreve o conteúdo dos slots A/B do PARA ENCERRAR em `platform.config.json`
 * (#4274). Trim em cada valor (mesma normalização de `normalizeSlotValue`
 * pros slots 0-3); um valor vazio pós-trim volta a "" no disco, que
 * `loadParaEncerrarConfig`/`buildParaEncerrar` (stitch-newsletter.ts) tratam
 * como "sem override" — cai de volta pro texto-padrão do snippet, nunca
 * produz uma seção PARA ENCERRAR com um parágrafo faltando. Guard de mtime
 * (#3729) idêntico a `saveBoxSlots`. Escrita CIRÚRGICA via
 * `replaceParaEncerrarBlock` — só a chave `para_encerrar` é tocada. Fail-soft:
 * nunca lança, sempre retorna resultado tipado. */
export function saveParaEncerrar(
  rootDir: string,
  input: SaveParaEncerrarInput,
  opts: SaveParaEncerrarOptions = {},
): SaveParaEncerrarResult {
  const configPath = resolve(rootDir, "platform.config.json");
  if (!existsSync(configPath)) {
    return { ok: false, error: "platform.config.json não encontrado", modifiedAt: null };
  }

  const values = {
    slotA: normalizeSlotValue(input.slotA),
    slotB: normalizeSlotValue(input.slotB),
  };

  const currentModifiedAt = statSync(configPath).mtime.toISOString();
  if (!opts.force && opts.expectedModifiedAt !== undefined) {
    if (currentModifiedAt !== opts.expectedModifiedAt) {
      return {
        ok: false,
        error: "platform.config.json foi modificado desde que você abriu a tela — recarregue ou sobrescreva explicitamente",
        modifiedAt: currentModifiedAt,
        conflict: true,
        currentModifiedAt,
      };
    }
  }

  let rewritten: string;
  try {
    const raw = readFileSync(configPath, "utf8");
    rewritten = replaceParaEncerrarBlock(raw, values);
  } catch (e) {
    return { ok: false, error: (e as Error).message, modifiedAt: null };
  }

  try {
    writeFileSync(configPath, rewritten, "utf8");
  } catch (e) {
    return { ok: false, error: (e as Error).message, modifiedAt: null };
  }

  const modifiedAt = statSync(configPath).mtime.toISOString();
  return { ok: true, modifiedAt, state: readParaEncerrarState(rootDir) };
}

// ── dirty vs. git (defesa fail-soft — sem repo git no fixture de teste) ──

/**
 * `git status --porcelain -- context/snippets/<file>` via spawn síncrono —
 * saída não-vazia = arquivo modificado/untracked vs. o HEAD do repo. Fail-soft
 * total: `git` ausente do PATH, `rootDir` não sendo um repo git (comum em
 * fixture de teste), ou qualquer erro de spawn -> `false` (nunca lança, nunca
 * derruba `listBoxes`).
 */
export function checkDirtyVsGit(rootDir: string, filename: string): boolean {
  try {
    const result = spawnSync(
      "git",
      ["status", "--porcelain", "--", `context/snippets/${filename}`],
      { cwd: rootDir, encoding: "utf8" },
    );
    if (result.error || result.status !== 0) return false;
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ── listagem ─────────────────────────────────────────────────────────────

export interface BoxListEntry {
  slug: string;
  /** Rótulo de exibição na lista (#3933): `nome:` do header se houver, senão o
   * título derivado do conteúdo, senão o slug (`resolveBoxDisplayName`). */
  title: string;
  /** `nome:` interno explícito do header, ou `null` se a caixa não tem um
   * (título derivado do conteúdo). #3933. */
  nome: string | null;
  /** `categoria:` do header (#3981) — rótulo exibido como kicker acima do
   * box na newsletter quando o slug ocupa um slot ativo. `null` se ausente. */
  categoria: string | null;
  /** Título derivado do CONTEÚDO (`extractBoxTitle`) — o que renderiza na
   * edição. A UI mostra "na edição: …" quando difere de `title`. #3933. */
  contentTitle: string;
  mtimeIso: string;
  /** Slot da variante PADRÃO (`boxes_divulgacao`), ou `null` se não atribuída. */
  slot: BoxSlot | null;
  /** #4275: slot da variante PATRONOS (`boxes_divulgacao_patronos`), ou
   * `null` se não atribuída — badge SEPARADO do `slot` padrão acima; uma
   * caixa pode ocupar um slot em uma variante e outro (ou nenhum) na outra. */
  slotPatronos: BoxSlot | null;
  dirtyVsGit: boolean;
}

/** Lista dinâmica de `context/snippets/*.md`, excluindo `README.md` e
 * qualquer arquivo com `runtime: false` no header (#4500 — documentação/
 * referência que não é uma caixa de verdade, ex: `intro-campeoes-sorteio.md`)
 * — ordenada por slug (ordem estável e previsível pra UI/testes). Diretório
 * ausente (clone fresco sem `context/snippets/`, ou `rootDir` de teste sem
 * essa pasta) -> `[]`, nunca lança. */
export function listBoxes(rootDir: string): BoxListEntry[] {
  const dir = snippetsDir(rootDir);
  if (!existsSync(dir)) return [];
  const slots = readBoxSlotAssignments(rootDir);
  // #4275: badge separado da variante Patronos — mesma lista de caixas
  // (pool único em context/snippets/), atribuição independente por variante.
  const slotsPatronos = readBoxSlotAssignments(rootDir, "patronos");
  const filenames = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isValidBoxSlug(entry.name))
    .map((entry) => entry.name)
    .sort();

  const entries: BoxListEntry[] = [];
  for (const filename of filenames) {
    const filePath = resolve(dir, filename);
    const content = readFileSync(filePath, "utf8");
    if (isRuntimeExcluded(content)) continue; // #4500
    const mtimeIso = statSync(filePath).mtime.toISOString();
    entries.push({
      slug: filename,
      title: resolveBoxDisplayName(content, filename),
      nome: parseBoxNome(content),
      categoria: parseBoxCategoria(content),
      contentTitle: extractBoxTitle(content),
      mtimeIso,
      slot: slots[filename] ?? null,
      slotPatronos: slotsPatronos[filename] ?? null,
      dirtyVsGit: checkDirtyVsGit(rootDir, filename),
    });
  }
  return entries;
}

// ── leitura de 1 caixa ───────────────────────────────────────────────────

export interface BoxContentState {
  ok: boolean;
  error?: string;
  slug: string;
  /** Conteúdo BRUTO completo do arquivo (inclui o header com `nome:`). Mantido
   * pra compat; o editor do Studio usa `body`+`nome` (#3933). */
  content: string;
  /** `nome:` interno parseado do header (#3933), ou `null`. */
  nome?: string | null;
  /** `categoria:` parseado do header (#3981), ou `null`. */
  categoria?: string | null;
  /** Conteúdo SEM a linha `nome:` — o que o textarea do editor mostra (#3933).
   * O campo "Nome interno" separado edita o `nome`. Mantido pra compat; a UI
   * atual (#3979) usa `notas`/`conteudo` (painéis separados). */
  body?: string;
  /** Painel "Notas" (#3979): header MENOS `nome:`/`categoria:`, trimado. */
  notas?: string;
  /** Painel "Conteúdo" (#3979): o arquivo com o header inteiro removido — o
   * que renderiza na newsletter. */
  conteudo?: string;
  /** Título de conteúdo pronto pro campo dedicado do editor (#4079): a 1ª
   * linha de `conteudo` (heading ou texto puro), ou `""` se o conteúdo
   * estiver vazio/só branco. Salvar por este campo reescreve só essa 1ª
   * linha via `replaceBoxContentTitle` — ver `handleApiBoxSave` (server.ts). */
  titulo?: string;
  modifiedAt: string | null;
}

/** Lê o conteúdo + mtime de UMA caixa. `ok: false` (nunca lança) tanto pra
 * slug inválido (traversal, `README.md`, extensão errada) quanto pra caixa
 * inexistente em disco — o caller HTTP (`server.ts`) trata TUDO que não é
 * `ok` como 404 (ver docstring do módulo: "qualquer outra coisa -> 404"). */
export function readBox(rootDir: string, slug: string): BoxContentState {
  if (!isValidBoxSlug(slug)) {
    return { ok: false, error: `slug inválido: ${slug}`, slug, content: "", modifiedAt: null };
  }
  const filePath = boxFilePath(rootDir, slug);
  if (!existsSync(filePath)) {
    return { ok: false, error: `caixa não encontrada: ${slug}`, slug, content: "", modifiedAt: null };
  }
  const content = readFileSync(filePath, "utf8");
  const modifiedAt = statSync(filePath).mtime.toISOString();
  const conteudo = extractBoxConteudo(content);
  return {
    ok: true,
    slug,
    content,
    nome: parseBoxNome(content),
    categoria: parseBoxCategoria(content),
    body: stripNomeLine(content),
    notas: extractBoxNotas(content),
    conteudo,
    titulo: extractConteudoTitulo(conteudo),
    modifiedAt,
  };
}

// ── escrita de 1 caixa (guard de mtime #3729, reusado de studio-review.ts) ─

export interface SaveBoxOptions {
  /** mtime (ISO) visto pelo client no último GET — `undefined` pula a
   * checagem de divergência inteiramente (mesma semântica de
   * `SaveReviewOptions.expectedModifiedAt` em studio-review.ts). */
  expectedModifiedAt?: string | null;
  /** `true` = ignora divergência detectada e sobrescreve mesmo assim (o
   * editor já confirmou no dialog de conflito do client). */
  force?: boolean;
}

export interface SaveBoxResult {
  ok: boolean;
  error?: string;
  slug: string;
  modifiedAt: string | null;
  /** `true` quando o save foi recusado por divergência de mtime (#3729) — o
   * caller HTTP responde 409 (não 404/400) nesse caso. */
  conflict?: boolean;
  /** mtime atual em disco no momento da tentativa — só presente quando
   * `conflict` é `true`. */
  currentModifiedAt?: string | null;
  /** `true` quando o slug é inválido OU a caixa não existe em disco — o
   * caller HTTP responde 404 nesse caso (distinto de `conflict`, que é 409,
   * e de uma falha de escrita genuína, que é 400). */
  notFound?: boolean;
}

function currentMtimeOf(filePath: string): string | null {
  return existsSync(filePath) ? statSync(filePath).mtime.toISOString() : null;
}

/** Escreve o conteúdo inteiro do editor de volta no arquivo da caixa — MESMO
 * guard de mtime de `saveReviewFile` (studio-review.ts, #3729): quando
 * `opts.expectedModifiedAt` é fornecido (não `undefined`) e `opts.force` não
 * é `true`, compara contra o mtime ATUAL em disco antes de escrever;
 * divergência aborta o write e retorna `{conflict: true}` em vez de
 * sobrescrever silenciosamente. */
export function saveBox(
  rootDir: string,
  slug: string,
  content: string,
  opts: SaveBoxOptions = {},
): SaveBoxResult {
  if (!isValidBoxSlug(slug)) {
    return { ok: false, error: `slug inválido: ${slug}`, slug, modifiedAt: null, notFound: true };
  }
  const filePath = boxFilePath(rootDir, slug);
  if (!existsSync(filePath)) {
    return { ok: false, error: `caixa não encontrada: ${slug}`, slug, modifiedAt: null, notFound: true };
  }
  if (!opts.force && opts.expectedModifiedAt !== undefined) {
    const currentModifiedAt = currentMtimeOf(filePath);
    if (currentModifiedAt !== opts.expectedModifiedAt) {
      return {
        ok: false,
        error: "o arquivo foi modificado desde que você abriu o editor — recarregue ou sobrescreva explicitamente",
        slug,
        modifiedAt: currentModifiedAt,
        conflict: true,
        currentModifiedAt,
      };
    }
  }
  try {
    writeFileSync(filePath, content, "utf8");
    const modifiedAt = statSync(filePath).mtime.toISOString();
    return { ok: true, slug, modifiedAt };
  } catch (e) {
    return { ok: false, error: (e as Error).message, slug, modifiedAt: null };
  }
}

// ── criação de caixa nova (#3928) ──────────────────────────────────────────

export interface CreateBoxResult {
  ok: boolean;
  error?: string;
  slug: string;
  modifiedAt: string | null;
  /** `true` quando o slug é inválido (traversal, `README.md`, maiúscula,
   * extensão errada) — o caller HTTP responde 400. */
  invalidSlug?: boolean;
  /** `true` quando já existe uma caixa (viva) com esse slug — o caller HTTP
   * responde 409 (edite em vez de criar). */
  exists?: boolean;
}

/** Cria uma caixa NOVA em `context/snippets/{slug}` (#3928). Ao contrário de
 * `saveBox` (que rejeita slug inexistente de propósito — a #3924 não cobria
 * criação), esta função exige que o arquivo NÃO exista ainda. Slot NÃO é
 * atribuído aqui (atribuição de slot segue fora de escopo, como na #3924).
 * Fail-soft: nunca lança, sempre retorna resultado tipado. */
export function createBox(rootDir: string, slug: string, content: string): CreateBoxResult {
  if (!isValidBoxSlug(slug)) {
    return {
      ok: false,
      error: `slug inválido: ${slug} — use só minúsculas, dígitos e hífen, terminando em .md`,
      slug,
      modifiedAt: null,
      invalidSlug: true,
    };
  }
  const filePath = boxFilePath(rootDir, slug);
  // Colide tanto com uma caixa viva quanto com uma arquivada de mesmo slug:
  // criar por cima de uma arquivada perderia a referência à arquivada.
  if (existsSync(filePath) || existsSync(archivedBoxFilePath(rootDir, slug))) {
    return {
      ok: false,
      error: `já existe uma caixa com o slug "${slug}" (viva ou arquivada) — edite ou restaure em vez de criar`,
      slug,
      modifiedAt: null,
      exists: true,
    };
  }
  try {
    mkdirSync(snippetsDir(rootDir), { recursive: true });
    writeFileSync(filePath, content, "utf8");
    const modifiedAt = statSync(filePath).mtime.toISOString();
    return { ok: true, slug, modifiedAt };
  } catch (e) {
    return { ok: false, error: (e as Error).message, slug, modifiedAt: null };
  }
}

// ── arquivar / restaurar / listar arquivadas (#3928) ───────────────────────

export interface ArchiveBoxResult {
  ok: boolean;
  error?: string;
  slug: string;
  /** `true` quando o slug é inválido OU a caixa não existe (viva) — 404. */
  notFound?: boolean;
  /** `true` quando a caixa está atribuída a um slot ativo em
   * `platform.config.json` (auto-injetada em toda newsletter) — arquivar
   * quebraria o pipeline, então é BLOQUEADO. Caller HTTP responde 409. */
  blockedBySlot?: boolean;
  slot?: BoxSlot;
}

/** Arquiva uma caixa: MOVE `context/snippets/{slug}` -> `context/snippets/
 * _arquivo/{slug}` (#3928). A caixa some de `listBoxes` (que não enumera
 * subpastas) mas o conteúdo NÃO é deletado — reversível via `unarchiveBox`.
 *
 * **Guard de slot (defense-in-depth):** uma caixa atribuída a
 * `boxes_divulgacao.slot{0,1,2,3}` é auto-injetada em toda newsletter pelo
 * `stitchNewsletter` (que procura o arquivo por nome em `context/snippets/`).
 * Arquivá-la quebraria o pipeline, então é bloqueado no server mesmo que o
 * client tente — não só desabilitado na UI. Fail-soft: nunca lança.
 *
 * #4290: a checagem é `slot !== undefined`, NÃO um truthy check (`if (slot)`)
 * — `BoxSlot` inclui `0` (slot0, introdução) desde #4290, e `0` é falsy em JS.
 * Um truthy check deixaria uma caixa no slot0 arquivar sem bloqueio, quebrando
 * o mesmo invariante que já vale pros slots 1/2/3.
 *
 * #4275: o guard cobre AS DUAS variantes — `boxes_divulgacao` (padrão) E
 * `boxes_divulgacao_patronos` — não só a padrão. Uma caixa usada só na
 * variante Patronos é igualmente auto-injetada (na edição Patronos) e
 * arquivá-la quebraria essa montagem do mesmo jeito. */
export function archiveBox(rootDir: string, slug: string): ArchiveBoxResult {
  if (!isValidBoxSlug(slug)) {
    return { ok: false, error: `slug inválido: ${slug}`, slug, notFound: true };
  }
  const filePath = boxFilePath(rootDir, slug);
  if (!existsSync(filePath)) {
    return { ok: false, error: `caixa não encontrada: ${slug}`, slug, notFound: true };
  }
  const slot = readBoxSlotAssignments(rootDir)[slug];
  if (slot !== undefined) {
    return {
      ok: false,
      error: `a caixa "${slug}" está no slot ${slot} (platform.config.json → boxes_divulgacao) e é injetada em toda newsletter — remova a atribuição de slot antes de arquivar`,
      slug,
      blockedBySlot: true,
      slot,
    };
  }
  const slotPatronos = readBoxSlotAssignments(rootDir, "patronos")[slug];
  if (slotPatronos !== undefined) {
    return {
      ok: false,
      error: `a caixa "${slug}" está no slot ${slotPatronos} da variante Patronos (platform.config.json → boxes_divulgacao_patronos) e é injetada em toda edição Patronos — remova a atribuição de slot antes de arquivar`,
      slug,
      blockedBySlot: true,
      slot: slotPatronos,
    };
  }
  try {
    mkdirSync(archiveDir(rootDir), { recursive: true });
    renameSync(filePath, archivedBoxFilePath(rootDir, slug));
    return { ok: true, slug };
  } catch (e) {
    return { ok: false, error: (e as Error).message, slug };
  }
}

export interface UnarchiveBoxResult {
  ok: boolean;
  error?: string;
  slug: string;
  /** `true` quando o slug é inválido OU não há caixa arquivada com esse slug. */
  notFound?: boolean;
  /** `true` quando já existe uma caixa VIVA com o mesmo slug — restaurar
   * sobrescreveria; bloqueado. Caller HTTP responde 409. */
  conflict?: boolean;
}

/** Restaura uma caixa arquivada: MOVE `context/snippets/_arquivo/{slug}` de
 * volta pra `context/snippets/{slug}` (#3928). Bloqueia se já existe uma caixa
 * viva com o mesmo slug (não sobrescreve). Fail-soft: nunca lança. */
export function unarchiveBox(rootDir: string, slug: string): UnarchiveBoxResult {
  if (!isValidBoxSlug(slug)) {
    return { ok: false, error: `slug inválido: ${slug}`, slug, notFound: true };
  }
  const archivedPath = archivedBoxFilePath(rootDir, slug);
  if (!existsSync(archivedPath)) {
    return { ok: false, error: `caixa arquivada não encontrada: ${slug}`, slug, notFound: true };
  }
  const livePath = boxFilePath(rootDir, slug);
  if (existsSync(livePath)) {
    return {
      ok: false,
      error: `já existe uma caixa viva com o slug "${slug}" — renomeie ou remova antes de restaurar`,
      slug,
      conflict: true,
    };
  }
  try {
    renameSync(archivedPath, livePath);
    return { ok: true, slug };
  } catch (e) {
    return { ok: false, error: (e as Error).message, slug };
  }
}

export interface ArchivedBoxEntry {
  slug: string;
  title: string;
  nome: string | null;
  /** `categoria:` do header (#3981) — ver `BoxListEntry.categoria`. */
  categoria: string | null;
  contentTitle: string;
  mtimeIso: string;
}

/** Lista as caixas arquivadas em `context/snippets/_arquivo/*.md` (#3928),
 * ordenada por slug. Sem badge de slot (uma arquivada nunca está num slot) e
 * sem dirty-vs-git (irrelevante pra restaurar). Pasta ausente (nada foi
 * arquivado ainda) -> `[]`, nunca lança. */
export function listArchivedBoxes(rootDir: string): ArchivedBoxEntry[] {
  const dir = archiveDir(rootDir);
  if (!existsSync(dir)) return [];
  const filenames = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isValidBoxSlug(entry.name))
    .map((entry) => entry.name)
    .sort();
  return filenames.map((filename) => {
    const filePath = resolve(dir, filename);
    const content = readFileSync(filePath, "utf8");
    return {
      slug: filename,
      title: resolveBoxDisplayName(content, filename),
      nome: parseBoxNome(content),
      categoria: parseBoxCategoria(content),
      contentTitle: extractBoxTitle(content),
      mtimeIso: statSync(filePath).mtime.toISOString(),
    };
  });
}
