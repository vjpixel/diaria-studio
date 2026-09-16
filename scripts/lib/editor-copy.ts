/**
 * editor-copy.ts (#3455)
 *
 * Garante que o editor (vjpixel@gmail.com) sempre receba uma cópia do envio
 * REAL de qualquer campanha/wave Brevo (Clarice diária ou digest mensal —
 * ambos os fluxos, canônico e legado, reusam os mesmos scripts
 * clarice-import-waves.ts / clarice-import-sends.ts / clarice-split-cells.ts,
 * ver comentário de topo de publish-monthly.ts). Sem isso o editor dependia
 * de conferir manualmente cada envio — frágil e sujeito a esquecimento
 * (pedido feito no gate da Etapa 4 da edição 260715).
 *
 * Ponto ÚNICO de injeção: `ensureEditorCopyRow` é chamado nos dois lugares
 * que produzem o CSV final passado a `POST /contacts/import` —
 * `clarice-import-waves.ts` (buildPlan, cobre waves store-driven + grupos
 * nomeados via clarice-build-segment.ts) e `clarice-import-sends.ts`
 * (toImportCsv, cobre os envios diários E — por reuso — clarice-split-cells.ts,
 * que splita um envio em células A/B/C chamando a mesma função). Mudar a
 * constante aqui propaga pra todos os pontos de montagem sem precisar tocar
 * cada script individualmente.
 *
 * NÃO cobre: `publish-monthly.ts` (fluxo legado #2009, marcado para remoção)
 * — esse script aponta `recipients: { listIds: [platform.config.json →
 * brevo_monthly.list_id] }`, uma lista Brevo ESTÁTICA já existente na conta,
 * não um CSV montado por este pipeline. Forçar a inclusão do editor ali
 * exigiria uma chamada de API contra dados AO VIVO (adicionar contato a uma
 * lista de produção), fora do escopo de uma mudança só-de-código. Ver nota
 * no próprio publish-monthly.ts (doc comment do topo) e no corpo do PR #3455
 * — ação manual 1x na UI do Brevo, se o editor quiser cobertura também
 * nesse fluxo legado enquanto ele não é removido.
 *
 * Implementação NÃO re-serializa o CSV inteiro via Papa.parse/unparse: o CSV
 * que chega aqui já passou por `normalizeImportCsv`, que só reescreve o
 * HEADER (mantendo o resto dos bytes intocado) — o resultado tem
 * terminadores de linha inconsistentes entre header (`\n`) e linhas de dados
 * (`\r\n`, herdado do default do Papa.unparse upstream). Um round-trip via
 * Papa.parse mal-interpreta essa mistura e corrompe campos (visto em teste:
 * NOME de uma linha ganhava um `\r` literal embutido). Manipulação textual
 * simples (achar o header, checar presença via regex, concatenar 1 linha
 * nova) evita esse round-trip e não depende de terminador consistente.
 */

/** Escapa caracteres especiais de regex — usado pra buscar `editorEmail` como texto literal. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Email do editor que deve receber cópia de todo envio real via Brevo.
 * Fonte única — mudar aqui propaga para todos os call-sites.
 */
export const EDITOR_COPY_EMAIL = "vjpixel@gmail.com";

/**
 * Endereços SEED incluídos em todo envio real (#4045).
 *
 * Motivação: nenhuma métrica da Brevo diz ONDE a mensagem caiu — "entregue" só
 * significa que o servidor aceitou. Aba Principal, Promoções e Spam são
 * indistinguíveis nos relatórios. Foi essa cegueira que deixou o braço B do
 * CTA-01 (#4045) perder ~90% do alcance sem sinal nenhum até o dia seguinte.
 *
 * Cada endereço aqui é uma caixa de um PROVEDOR diferente; depois de cada
 * disparo o editor confere em qual aba a mensagem apareceu.
 *
 * **Reduzido de 5 pra 2 (16/09/2026, decisão do editor).** `apixel@gmail.com`
 * (2ª caixa Gmail), `vjpixel@hotmail.com` (Microsoft) e `vjpixel@yahoo.com`
 * (Yahoo) saíram — eram os mesmos 3 endereços cuja presença dupla em Brevo+Kit
 * o #8180/#8183 tentaram tratar como sobreposição bloqueante antes de o
 * editor esclarecer que eram sondas de propósito; ele então redistribuiu os 3
 * (removidos de tudo ou restritos a um único canal) em vez de manter o setup
 * de medição multi-provedor. Custo aceito: perde-se cobertura de colocação
 * pra Microsoft (~10% da base) e Yahoo (~5%) — só Gmail pessoal e Google
 * Workspace corporativo seguem instrumentados.
 *
 * `EDITOR_COPY_EMAIL` continua sendo a cópia QA canônica do editor e segue
 * primeiro na lista; `pixel@memelab.com.br` é a caixa Google Workspace
 * corporativa (Exchange/filtro distinto do Gmail pessoal), a única seed de
 * colocação restante.
 *
 * COBERTURA: o `ensureEditorCopyRow` só alcança os CSVs montados por este
 * pipeline. O fluxo legado `publish-monthly.ts` usa a lista Brevo ESTÁTICA de
 * `platform.config.json → brevo_monthly.list_id` (hoje 7) — os endereços
 * foram adicionados àquela lista manualmente via API, fechando o furo
 * descrito no comentário de topo deste arquivo; essa lista estática NÃO foi
 * tocada por esta redução (fora do escopo de uma mudança só-de-código).
 */
export const EDITOR_SEED_EMAILS: readonly string[] = [
  EDITOR_COPY_EMAIL,            // Gmail pessoal — 73% da base é Gmail
  "pixel@memelab.com.br",       // Google Workspace — Gmail corporativo filtra diferente do pessoal
];

/**
 * Garante que `csv` (já normalizado — header com uma coluna `EMAIL`, ver
 * `normalizeImportCsv`) contém uma linha para `editorEmail`. Idempotente:
 * não duplica se o email já estiver presente (dedupe case-insensitive,
 * delimitado por vírgula/quebra de linha/início-fim de string — não
 * confunde com um email que apenas CONTÉM `editorEmail` como substring).
 * Demais colunas ficam vazias, exceto uma coluna `NOME`/`Nome`/`nome`
 * reconhecível (se existir), preenchida com um valor identificável — assim
 * a linha não se confunde com um assinante real ao inspecionar a lista no
 * Brevo.
 *
 * Retorna `csv` inalterado (fail-soft) se o shape não tiver uma coluna EMAIL
 * reconhecível, ou se não houver quebra de linha (só header, sem como saber
 * onde termina) — nunca lança, e nunca força uma coluna que não existe.
 */
export function ensureEditorCopyRow(
  csv: string,
  editorEmail: string | readonly string[] = EDITOR_SEED_EMAILS,
): string {
  // #4045: aceita um endereço (forma original, back-compat com chamadas e testes
  // que passam EDITOR_COPY_EMAIL explicitamente) OU a lista de seeds. Cada
  // endereço passa pelo mesmo caminho idempotente, um de cada vez.
  const emails = typeof editorEmail === "string" ? [editorEmail] : editorEmail;
  return emails.reduce((acc, e) => addOneCopyRow(acc, e), csv);
}

/** Insere UMA linha de cópia (idempotente). Núcleo original de `ensureEditorCopyRow`. */
function addOneCopyRow(csv: string, editorEmail: string): string {
  const nl = csv.indexOf("\n");
  if (nl < 0) return csv;

  const headerLine = csv.slice(0, nl).replace(/\r$/, "");
  const fields = headerLine.split(",").map((f) => f.trim());
  const emailIdx = fields.findIndex((f) => f.toUpperCase() === "EMAIL");
  if (emailIdx < 0) return csv;

  const alreadyPresent = new RegExp(
    `(^|[,\\r\\n])${escapeRegex(editorEmail)}([,\\r\\n]|$)`,
    "i",
  ).test(csv);
  if (alreadyPresent) return csv;

  const nomeIdx = fields.findIndex((f) => /^nome$/i.test(f));
  const row = fields.map((_, i) => (i === emailIdx ? editorEmail : i === nomeIdx ? "Pixel (editor)" : ""));
  const rowLine = row.join(",");

  const sep = csv.endsWith("\n") ? "" : "\n";
  return csv + sep + rowLine;
}
