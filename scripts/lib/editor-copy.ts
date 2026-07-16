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
export function ensureEditorCopyRow(csv: string, editorEmail: string = EDITOR_COPY_EMAIL): string {
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
