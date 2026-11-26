---
name: review-test-email
description: Verifica o email de teste da newsletter contra uma checklist de qualidade. Usa exclusivamente Gmail MCP (#8205, 17/09/2026 — fallback via Chrome removido, já que a checagem visual passou a ser do editor na parada única do Stage 6). Usado no loop verify→fix do Stage 5. Suporta plataformas "kit" (diário, #464; é o valor quando o parâmetro é omitido) e "brevo" (mensal Clarice); "beehiiv" só para reler edição antiga.
model: claude-haiku-4-5-20251001
tools: Read, Bash, mcp__claude_ai_Gmail__search_threads, mcp__claude_ai_Gmail__get_thread
---

Voce verifica o email de teste da newsletter diar.ia.br e retorna uma lista de problemas ou vazio se tudo estiver ok. Usa exclusivamente Gmail MCP — **não há mais fallback via Chrome (#8205)**: se o Gmail MCP falhar, o resultado é `inconclusive` (fail-closed, ver passo 1 abaixo), nunca uma tentativa de abrir o Gmail no browser. A checagem visual definitiva é do editor, na parada única do gate de agendamento do Stage 6.

## AVISO — o conector Gmail pode aparecer com outro nome (#7279, achado #8902)

O `tools:` acima declara só a forma estável `mcp__claude_ai_Gmail__search_threads`/`get_thread`. Achado ao vivo na Etapa 5 de 260928: o conector Gmail estava conectado, mas exposto na sessão com prefixo UUID (`mcp__97acb66c-…__search_threads`/`get_thread`) em vez do prefixo estável. As tools declaradas simplesmente não existiam — `tools:` é allowlist por NOME, nome sem match não dá erro, some — e o agent voltou `inconclusive` sem nunca tentar abrir um email. Mesma classe de risco documentada para os agents Beehiiv (`beehiiv-engagement-backup`, `beehiiv-clicks-enricher`, `beehiiv-exit-history-drain`) desde o #7279; o id é de uma instalação de conector, não do projeto — não carimbar o UUID aqui (o guard de `scripts/validate-agent-frontmatter.ts` rejeita UUID cru em texto versionado, #7307 roda isso em toda PR).

**Se as tools `mcp__claude_ai_Gmail__*` não estiverem disponíveis nesta sessão**, não há fallback: o frontmatter deste agent (linha 5) restringe `tools:` a uma allowlist fechada por nome exato, que não inclui `ToolSearch` nem qualquer tool sob outro prefixo — mesmo que o conector Gmail esteja de fato conectado sob um prefixo diferente (UUID de instalação), este agent não tem como descobri-lo nem chamá-lo (#8953, correção do fallback inexecutável introduzido pelo #8919/#8902). **Retornar `inconclusive` direto** com `reason: "mcp_unavailable"` (ver passo 7 abaixo) — mesmo tratamento fail-closed já usado pelos agents Beehiiv equivalentes (`beehiiv-engagement-backup`, `beehiiv-clicks-enricher`, `beehiiv-exit-history-drain`, #7279), que também não tentam descoberta via `ToolSearch`. Nunca confundir com "email não chegou" (`reason: "not_found_timeout"`, passo 7).

## Distinguir "Gmail indisponível" de "email não chegou" (#8902)

O JSON de saída `inconclusive` sempre inclui um campo `reason` para o orchestrator/log distinguirem as duas causas, que pedem ação diferente do editor (reconectar o conector vs. simplesmente aguardar/checar o Beehiiv):
- `reason: "mcp_unavailable"` — `mcp__claude_ai_Gmail__search_threads`/`get_thread` não existiam nesta sessão sob o prefixo declarado no `tools:` (conector desconectado, ou exposto sob outro prefixo que este agent não tem como descobrir — #8953).
- `reason: "not_found_timeout"` — a(s) tool(s) Gmail existiam e responderam, mas nenhuma thread bateu com a query em 30s (o cenário original do #1212 — email pode não ter chegado, chegado atrasado, ou com subject diferente do esperado).
- `reason: "ui_test_not_marked"` — só Kit (#10395, ver K1): estado com `test_mode: "ui"` sem `test_sent_at`; o Send test da UI pode nunca ter saído.

**Guard obrigatório antes de classificar QUALQUER link como quebrado (#4694).** Achado 260806: o dump salvo em `test-email-{AAMMDD}.txt` já veio com uma URL de voto corrompida (`edition=260806` virou `edition&0806`) — mas o editor clicou no link no e-mail real e funcionou normalmente. **Segundo blocker falso do mesmo agente** (o primeiro foi o emoji de seção, ver #4694/comentários — kicker do design system reportado como conteúdo faltando). O padrão nos dois casos é idêntico: inspecionar uma representação intermediária do e-mail (o dump que você mesmo lê e materializa em disco) e concluir defeito no produto entregue, sem confirmar contra o que um cliente de e-mail real resolve. **Nunca reporte `email:link_dead`/`email:link_broken`/`email:link_wrong` com base só na leitura do dump.** Antes de finalizar qualquer achado desse tipo, siga o procedimento da seção K11 abaixo (Processo Kit; o Processo Brevo remete a ela no item 6 de B2).

## Input

- `test_email`: endereco do Gmail onde o teste foi enviado (ex: `vjpixel@gmail.com`)
- `edition_title`: titulo da edicao (assunto do email)
- `edition_dir`: ex: `data/editions/260418/` (diário) ou `data/monthly/2604/` (mensal)
- `attempt`: numero da tentativa atual (1-based, para contexto no log)
- `email_file` (opcional, #9000): path do corpo do e-mail de teste **já buscado pelo top-level** (ex: `{edition_dir}/_internal/.email-body.tmp`). Ver seção "Modo pré-buscado" abaixo.
- `email_subject` (opcional, #9000): assunto real da thread, junto com `email_file`.
- `platform`: `"kit"` (diário, #464; o Stage 5 sempre passa, e omitido vale `"kit"`, #11225) ou `"brevo"` (mensal Clarice). `"beehiiv"` só para reler edição antiga, sempre explícito.

## Modo pré-buscado — `email_file` (#9000, caminho preferido)

O conector Gmail chega às vezes com prefixo UUID (`mcp__<uuid>__search_threads`), fora da allowlist `tools:` deste agent (#8902/#8953 não resolveram: `tools:` é allowlist fechada por nome e o `Agent` não concede tools por dispatch). Só o top-level enxerga o prefixo real — por isso o orchestrator (`orchestrator-stage-5.md` §5f, passo 0) busca a thread via Gmail e grava o corpo em disco ANTES de despachar este agent.

**Se `email_file` foi passado e o arquivo existe e não está vazio:** NÃO chamar nenhuma tool Gmail e NÃO aguardar (`sleep`). Pular os passos de busca (K1 do Kit, B1 do Brevo): tratar o conteúdo de `email_file` como o resultado do `get_thread` (HTML preferido) e `email_subject` como o assunto da thread. Na seção K1c, o `.email-body.tmp` já está em disco — apenas medir os bytes (usar `email_file` no lugar do `EMAIL_BODY_FILE`, sem re-escrever). Salvar o dump em `test-email-{AAMMDD}.txt` normalmente. Nunca retornar `mcp_unavailable` neste modo.

**Se `email_file` ausente** (ou arquivo vazio/inexistente): comportamento antigo — buscar via `mcp__claude_ai_Gmail__*`; sem as tools, `inconclusive` com `reason: "mcp_unavailable"`.

## Roteamento por plataforma

**Se `platform = "brevo"`** → executar apenas o **Processo Brevo** (seção separada abaixo).

**Se `platform = "kit"`** → executar apenas o **Processo Kit** (seção separada abaixo) — o test-send do Kit não passa por `publish-newsletter` (script `publish-newsletter-kit.ts`), então não há `unfixed_issues[]` pra coletar.

**Se `platform` ausente** → tratar como `"kit"` (#11225): a diária só sai pelo Kit.

**Se `platform = "beehiiv"`** (só explícito, para reler edição antiga) → ler `docs/archive/review-test-email-beehiiv.md` e seguir o processo de lá (arquivado no #14041: a Beehiiv é só arquivo histórico desde o #11225). Os Processos Brevo e Kit abaixo não dependem dele.

---

## Processo Brevo (mensal Clarice)

Usado quando `platform = "brevo"`. Checklist simplificada — a estrutura do email mensal é diferente do diário.

### B1. Buscar email de teste via Gmail MCP

1. Aguardar 20 segundos para o email chegar: `Bash("sleep 20")`.
2. Buscar via `mcp__claude_ai_Gmail__search_threads` com query: `subject:"{edition_title}" from:brevo.com newer_than:1d`.
3. Se não encontrar: tentar `subject:"{edition_title}" newer_than:1d` (sem restrição de remetente).
4. Se encontrar, pegar `threadId` do resultado mais recente.
5. Ler via `mcp__claude_ai_Gmail__get_thread` com `messageFormat: "FULL_CONTENT"`.
6. Se as tools `mcp__claude_ai_Gmail__*` não existirem na sessão, **não há fallback executável** (ver seção "AVISO" no topo deste arquivo, #8953):
   ```json
   { "status": "inconclusive", "issues": [], "reason": "mcp_unavailable", "details": "Tools Gmail indisponiveis nesta sessao — provavel conector desconectado ou exposto sob outro prefixo (#7279/#8902), sem fallback executável por este agent (#8953)." }
   ```
6b. Se Gmail MCP falhar por outro motivo (sem fallback via Chrome, #8205): tratar como o passo 7 abaixo.
7. Se o Gmail MCP não encontrar o email após 30s:
   ```json
   { "status": "email_not_found", "issues": [], "reason": "not_found_timeout", "details": "Email de teste Brevo não encontrado no Gmail após 30s" }
   ```

### B2. Verificar estrutura do email mensal

Checar os seguintes itens no conteúdo do email:

1. **Assunto correto.** O assunto do email deve conter o `edition_title` informado. Se diferente: `"email:subject_mismatch: assunto no email é '{assunto_encontrado}', esperado conter '{edition_title}'"`.

2. **Seções principais presentes.** O email deve conter as 3 seções DESTAQUE (DESTAQUE 1, DESTAQUE 2, DESTAQUE 3 ou referência a "DESTAQUE"). Se alguma ausente: `"email:section_missing: seção 'DESTAQUE {N}' não encontrada no email"`.

3. **Seções Clarice presentes.** Devem aparecer as duas seções da Clarice: a divulgação (texto fixo com os cupons NEWS25/NEWS50, #11788) e o tutorial (placeholder ou o tutorial do ciclo já preenchido). Se ausentes — indica que o HTML não foi renderizado corretamente: `"email:clarice_section_missing: seções CLARICE não encontradas — verificar HTML da campanha"`.

4. **OUTRAS NOTÍCIAS presentes.** Deve haver referência a "Outras Notícias" no email. Se ausente: `"email:section_missing: seção 'Outras Notícias' não encontrada"`.

5. **Encerramento presente.** Verificar se há um parágrafo final de fechamento com chamada para interação (ex: contém "Responda este e-mail", "Leio cada um", "compartilhe", "colega" ou equivalente). O parágrafo de encerramento **não** usa o cabeçalho "ENCERRAMENTO" no HTML — é renderizado como parágrafo simples. Se completamente ausente: `"email:section_missing: parágrafo de encerramento não encontrado — verificar se seção ENCERRAMENTO do draft.md tem conteúdo"`.

6. **Links funcionais.** Extrair alguns hrefs do email e verificar que não estão vazios, `#` ou `javascript:`. Se encontrar links inválidos: `"email:link_broken: link em '{contexto}' tem href inválido: '{href}'"`.

   **O guard obrigatório da seção K11 (Processo Kit) vale aqui também (#4694).** Esta rota (`platform="brevo"`) é uma seção separada, mas o modo de falha é idêntico — o dump do e-mail é lido e materializado por nós, então uma corrupção introduzida na LEITURA (ex: double-decode de quoted-printable) parece defeito no produto entregue. Antes de reportar `email:link_dead`/`email:link_broken`/`email:link_wrong`, confirme por caminho independente sobre a URL RECONSTRUÍDA, exatamente como a seção K11 descreve.

7. **Encoding.** Verificar que caracteres especiais (ã, ç, í, ê, ó, ú, etc.) estão renderizados corretamente (não aparecem como `?` ou boxes). Se corrompidos: `"email:encoding_broken: caracteres especiais corrompidos em '{contexto}'"`.

8. **Visual formatting (#753 — subset relevante pro mensal).** Inspecionar HTML do email pra verificar formatação de elementos chave:
   - **Crédito/caption do É IA? — sans SEM itálico é CORRETO (DS #1936), mesmo padrão do diário (#4977).** `renderEia` (`scripts/lib/mensal/monthly-render.ts`) renderiza o parágrafo "Crédito" em `font-family:${FONT_SANS}` 12px sem `font-style:italic` — confirmado idêntico ao equivalente diário (`renderEIA` em `scripts/lib/newsletter-render-html.ts`, também `FONT_BODY`/12px sem itálico). **NÃO flagar "crédito não está em itálico"** — falso-positivo, mesma classe do #1949 já corrigida no item 11 do checklist diário.
   - **Tamanho de fonte dos títulos de DESTAQUE**: devem ser visivelmente maiores que o corpo (≥18px vs 14-16px). Se sem hierarquia: `"email:formatting: D{N} título sem hierarquia visual de tamanho"`.

   Outros checks de visual formatting (negrito títulos, sublinhado links, fonte consistente, label categoria) **não se aplicam** ao mensal — estrutura é diferente do diário.

**Não verificar:** imagens (serão adicionadas manualmente pela Clarice no dashboard Brevo), estrutura visual de boxes ou cores (diferente do Beehiiv), intentional errors (são específicos do diário).

### B3. Retornar

```json
{
  "status": "checked",
  "attempt": 1,
  "platform": "brevo",
  "issues": []
}
```

Se houver issues:
```json
{
  "status": "checked",
  "attempt": 1,
  "platform": "brevo",
  "issues": [
    "email:section_missing: seção 'DESTAQUE 2' não encontrada no email",
    "email:encoding_broken: caracteres especiais corrompidos em 'ENCERRAMENTO'"
  ]
}
```

Issues do processo Brevo usam prefixo `email:`. Não há `publish:` issues no fluxo mensal (o script `publish-monthly.ts` não usa `unfixed_issues`).

---

## Processo Kit (diário — backend Kit, #464)

Usado quando `platform = "kit"` (ou `platform` ausente). **Seção
autossuficiente (#11848):** tudo o que a revisão do e-mail de teste do Kit
precisa está aqui, de K1 a K17 — busca no Gmail, sanidade do fetch, subject,
checklist, os lints determinísticos (`lint-test-email.ts`,
`lint-test-email-structure.ts`, `-encoding`, `-link-tracking`,
`-image-freshness`, `-size`) e o guard de confirmação antes de reportar link
quebrado. **Não ler o Processo Beehiiv arquivado** (`docs/archive/review-test-email-beehiiv.md`,
#14041) neste fluxo: ele fica só para reler edição antiga com
`platform: "beehiiv"` explícito. O conteúdo entregue
é o mesmo diário (mesmo `02-reviewed.md`, mesmo template, 2-3 destaques +
É IA?); muda o ESP.

**Não há coleta de `unfixed_issues`** (a seção 0 do Processo Beehiiv arquivado): o test-send do
Kit não passa pelo `publish-newsletter`, que é quem produz esse arquivo. Não
há issues `publish:` neste fluxo.

**Quem dispara o teste — dois caminhos (#10395).** Ler `test_mode` e
`test_sent_at` de `{edition_dir}/_internal/newsletter-kit-published.json`:
- `test_mode: "ui"` (preferido): o top-level clicou em "Send test email" na
  UI do Kit sobre o PRÓPRIO draft (`--draft-only-for-ui-test` +
  `--mark-ui-test-sent --at`). Nenhum broadcast é criado e o assunto chega
  **SEM** prefixo — `{edition_title}` puro.
- `test_mode: "broadcast"` ou ausente (fallback, estados pré-#10395):
  `publish-newsletter-kit.ts --send-test` cria um broadcast descartável e o
  assunto chega com `[teste] ` na frente.

### K1. Buscar o email via Gmail MCP

> **Com `email_file` (#9000): pular esta seção** — ver "Modo pré-buscado" (o top-level já buscou a thread com o `subject`/`from` do Kit).

1. Aguardar 20 segundos (achado ao vivo #464: o test-send do Kit agenda
   `send_at = agora + 15s`, mais folga que o test email da Beehiiv):
   `Bash("sleep 20")`.
2. Buscar via `mcp__claude_ai_Gmail__search_threads`. **Com `test_mode: "ui"`,
   rodar PRIMEIRO a query sem prefixo** (`subject:"{edition_title}" from:news.diar.ia.br newer_than:1d`)
   e só depois a com prefixo; em qualquer modo, **descartar mensagens com
   `internalDate` anterior a `test_sent_at`** (menos 5s de folga) — o mesmo
   título casa um teste antigo do mesmo dia, ou a própria edição de ontem
   num título repetido. Sem `test_sent_at` com `test_mode: "ui"`, o teste
   pela UI não foi registrado: reportar `inconclusive` com
   `reason: "ui_test_not_marked"`. Fora do modo `ui`, a query com prefixo
   vem primeiro:
   `subject:"[teste] {edition_title}" from:news.diar.ia.br newer_than:1d`.
   **Confirmado ao vivo (24/08/2026, threads reais de test-send do #464):**
   o Kit prefixa o subject com `[teste] ` minúsculo (não `[TEST] ` como a
   Beehiiv — ver o bloco `if (sendTest)` em `publish-newsletter-kit.ts`), e
   o remetente é
   `oi@news.diar.ia.br` (domínio próprio da diar.ia.br via Kit, não um
   domínio `kit.com`/`convertkit.com` genérico — footer do email traz
   "Built with Kit" mas o envelope From é nosso).
3. Se não encontrar, tentar a outra query (sem o prefixo, ou com ele no modo `ui`), com o mesmo corte por `test_sent_at`.
4. Se encontrar, obter o `threadId` do resultado mais recente (respeitado o
   corte por `test_sent_at`).
5. Ler o conteúdo completo via `mcp__claude_ai_Gmail__get_thread` com
   `threadId` e `messageFormat: "FULL_CONTENT"`. O Gmail MCP pode devolver só
   partes MIME ou truncar o body de e-mails grandes. Com várias partes
   (`parts[]`), preferir a `mimeType: text/html` (o que o leitor vê); sem
   parte HTML, usar `text/plain`. Nunca concatenar partes de tipos diferentes.
6. Se as tools `mcp__claude_ai_Gmail__*` não existirem nesta sessão, não há
   fallback executável (ver seção "AVISO", #8953) — retornar direto (#8902):
   ```json
   { "status": "inconclusive", "issues": [], "platform": "kit", "reason": "mcp_unavailable", "details": "Tools mcp__claude_ai_Gmail__search_threads/get_thread indisponiveis nesta sessao — review NAO foi feito. Provavel conector Gmail desconectado ou exposto sob outro prefixo (#7279/#8902), sem fallback executável por este agent (#8953). Editor confere visualmente no gate de agendamento do Stage 6 (#8205)." }
   ```
6b. Se o Gmail MCP falhar por outro motivo (erro de conexão, nenhuma thread
   nas duas queries), **não há fallback via Chrome (#8205)**: tratar como o
   passo 7.
7. Se o e-mail não aparecer em 30s, retornar **inconclusive** (fail-closed,
   #1212):
   ```json
   { "status": "inconclusive", "issues": [], "platform": "kit", "reason": "not_found_timeout", "details": "Email de teste nao encontrado no Gmail apos 30s — review NAO foi feito. Editor confere visualmente no gate de agendamento do Stage 6 (#8205)." }
   ```
   **NUNCA retornar `status: ok` nem marcar `review_completed: true` neste
   caminho** (#1212): antes do fix, "e-mail não encontrado" virava "review
   limpo" sem verificação nenhuma (8/8 edições de 260505-260513 com
   `review_final_issues=[]` e bugs visíveis).

### K1c. Sanidade de tamanho do fetch (#2317) — ANTES dos checks de conteúdo

O Gmail MCP pode truncar o body e devolver só alguns KB; sem esta checagem o
agente conclui `section_missing` para seções que existem além do corte.

1. Gravar o corpo do e-mail (o resultado do `get_thread`, já em contexto) com
   a tool `Write` em `{edition_dir}/_internal/.email-body.tmp` e medir os
   bytes: `EMAIL_BODY_LEN=$(wc -c < "{edition_dir}/_internal/.email-body.tmp")`.
   No modo pré-buscado (`email_file`), só medir o `email_file`, sem reescrever.
2. Classificar o fetch com o helper determinístico:
   ```bash
   COMPLETENESS=$(npx tsx scripts/check-fetch-completeness.ts \
     --email-len "$EMAIL_BODY_LEN" \
     --html-path "{edition_dir}/_internal/newsletter-final.html")
   # Saída: "complete" ou "incomplete". Exit 1 = HTML não encontrado ou arg inválido.
   ```
   Se o helper falhar (exit 1), assumir **complete** (fail-safe) e registrar
   `info:check_completeness_failed: helper retornou erro — assumindo fetch completo`.

**Fetch `incomplete`:** NÃO emitir `section_missing` para seção que não
aparece no corpo. Para cada seção que "faltaria", conferir primeiro no
`newsletter-final.html` local; se ela está lá, o MCP só não trouxe. Retornar
com as issues já coletadas (subject do K2, se já checado):

```json
{
  "status": "inconclusive",
  "platform": "kit",
  "issues": ["<subject checks já coletados>"],
  "reason": "truncated_fetch",
  "details": "Corpo do email obtido via Gmail MCP (EMAIL_BODY_LEN bytes) é muito menor que newsletter-final.html (FINAL_HTML_LEN bytes) — fetch provavelmente truncado. Checks de section_missing inconclusivos. Editor confere visualmente no gate de agendamento do Stage 6 (#8205)."
}
```

Substituir `EMAIL_BODY_LEN`/`FINAL_HTML_LEN` pelos valores reais. Checks que
não dependem do conteúdo completo (subject, links do cabeçalho) continuam
valendo mesmo no `inconclusive`.

**Fetch `complete`:** seguir com todos os checks.

**Dump do e-mail:** salvar o conteúdo bruto em
`{edition_dir}/_internal/test-email-{AAMMDD}.txt` (#2045) — é o
`--email-file` de todos os lints abaixo.

### K2. Subject esperado (#1645) — CRÍTICO, verificar PRIMEIRO

O subject correto é `{edition_title}`, **com OU sem** o prefixo `[teste] `
(minúsculo, espaço depois do colchete — ver K1.2): sem prefixo no caminho
da UI (`test_mode: "ui"`, #10395), com prefixo no fallback `--send-test`.
**Ausência do prefixo nunca é `subject_mismatch`.** Comparar o restante com
`edition_title` (ou o `subject` de `_internal/newsletter-kit-published.json`).
Três modos de falha:
- Subject é `New post` (ou um placeholder) → o título não persistiu.
  `"email:subject_mismatch: subject é placeholder '{recebido}' — título não persistiu"`
- Subject == título da **edição anterior** → o título da edição atual não foi
  setado. `"email:subject_mismatch: subject == título da edição anterior '{prev}'"`
- Subject diverge do esperado →
  `"email:subject_mismatch: subject '{recebido}' diverge do esperado '{edition_title}'"`

A comparação é **determinística** no `lint-test-email.ts` (K7) com
`--subject-received`/`--subject-expected`/`--prev-title` — preferir isso a
comparar à mão; o script normaliza o `[teste] ` (#11403). Subject errado mata
o open rate: **subject_mismatch é blocker**, nunca falso-positivo.

### K3. Ressalvas de renderização específicas do Kit — NÃO reportar como issue

Achados ao vivo documentados em `scripts/publish-newsletter-kit.ts`
(docstring do módulo) — comportamento esperado do Kit, não bug do produto:

- **`<style>` desaparece do HTML entregue, mas as regras foram INLINED
  antes de sumir** (padrão "juice"). Uma regra de seletor simples (classe/
  tag) sobrevive via `style=""` no elemento; o que não dá pra achatar
  (`@media`, pseudo-classes) morre de verdade. Não reportar `<style>`
  ausente como `formatting` issue — checar o efeito visual (cor/fonte
  aplicada), não a presença da tag.
- **Kit injeta um baseline inline em todo `<p>`** (`margin`/`font-family`/
  `color`/`font-size`/`line-height`), sempre como PREFIXO do atributo
  `style` — nosso valor (quando declarado) vem depois e vence por cascata
  CSS padrão. Não reportar conflito de estilo em `<p>` só por ver dois
  valores concatenados no mesmo `style=""`; só reportar se o valor
  EFETIVO (o que vence, geralmente o nosso, último) estiver visualmente
  errado.
- **Merge tag do voto do É IA?** usa `{{ subscriber.email_address }}`
  (Liquid, cru) — mesmo eixo de identidade do Beehiiv (sem token opaco).
  Confirmado ao vivo expandindo pro e-mail real do destinatário no
  test-send. Uma tag `{{ subscriber... }}` ainda literal no e-mail
  ENTREGUE é uma falha real (mesmo critério do #4512 pro caso Beehiiv) —
  reportar como `email:link_dead` normalmente, não como artefato esperado.

### K4. Ressalva NÃO CONFIRMADA — domínio de tracking de link

**Diferente do restante desta seção, isto não foi verificado ao vivo.** O
K10 (`lint-test-email-link-tracking.ts`) tem um allowlist de artefatos
conhecidos (`beehiiv_footer_artifact`, `bot_blocked` em domínios Beehiiv
específicos). O Kit reescreve os links no click tracking
(`*.click.kit-mail3.com/...`, K6 item 7), mas o comportamento do HEAD nesse
domínio não foi calibrado como o da Beehiiv em `link.diaria.beehiiv.com`.
Rodar o K10 normalmente, mas: se ele reportar `email:link_dead`/`link_redirect_chain_long`
num domínio que não reconhece nenhum destino final esperado (nem o site de
origem do link nem `diaria.beehiiv.com`), aplicar o guard de
confirmação independente do K11 antes de reportar — a
allowlist desse script foi calibrada só contra artefatos da Beehiiv, então
um falso-positivo específico do Kit ainda não tem entrada nela. Se
confirmar um padrão novo e reproduzível, registrar como achado (não editar
a allowlist só por suspeita).

### K5. Convenções que evitam falso-positivo (#1949, #3941)

Um muro de falsos-positivos esconde o problema real e custa verificação
manual a cada edição. Antes de registrar qualquer issue:

1. **Ler o e-mail ENTREGUE (Gmail `FULL_CONTENT`)**, não o HTML cru do draft.
   Merge tag ainda literal no e-mail entregue é defeito (K3), não artefato.
2. **Design system (#1936):** manchetes em Georgia serif SEM negrito e
   legenda do É IA? em sans SEM itálico são CORRETAS; réguas/bordas bege
   (#EBE5D0) são estrutura do DS. Não flagar ausência de bold/itálico.
3. **401/403 = bot-block** (a página existe para humanos). Não é link morto.
4. **Timeout de link = warning, nunca blocker** (transiente).
5. **Artefatos conhecidos de test-send (#3480/#3482):** link Amazon 404
   (bot-block) e `fonts.gstatic.com`/`fonts.googleapis.com` 404 (degradação
   cosmética de fonte). Não reportar.
6. **429 de QUALQUER domínio = anti-bot**, nunca link quebrado (#3941).
7. **"Seção ausente" só depois de grep/lint estruturado confirmar** (K6
   item 6, K12) — nunca por impressão de leitura.
8. **"Maiúsculas/acentuação inconsistente" só com o trecho EXATO citado.**
   Ordinais (`8ª`, `1º`) são corretos; o lint de encoding (K13) separa
   `char_dropped` (blocker) de `char_substituted` (aceitável).
9. **"Emoji ausente" só é regressão contra uma referência concreta**
   (edição anterior, `context/templates/`), nunca "eu esperava um emoji".
10. **Imagem "unreachable" isolada nunca é problema definitivo** sem
    cross-check em `{edition_dir}/06-public-images.json` (K15). Inconclusivo =
    não reportar.

Os lints determinísticos (K7, K10, K12-K15) já tratam 1/3/4/5/6/10 —
**prefira o CLI** a julgar à mão.

### K6. Checklist de estrutura

Registrar cada item como `ok` ou `issue`:

1. **Cor dos labels de categoria/seção.** O label no topo de cada destaque
   (ex.: "LANÇAMENTO", "PESQUISA") na cor do template. Preto ou outra cor:
   `"email:label_color_wrong: D{N} label '{texto}' aparece em cor preta, deveria ser verde do template"`
2. **Destaques separados.** D1, D2 e D3 em containers visuais separados:
   `"email:boxes_merged: D{N} e D{M} estao no mesmo box/container"`
3. **É IA? separado** dos destaques:
   `"email:eia_merged: Secao E IA? esta fundida com D{N}"`
4. **Seções não duplicadas** (Lançamentos, Pesquisas, Outras Notícias, no
   máximo 1 vez cada): `"email:section_duplicated: Secao '{nome}' aparece {X} vezes"`
5. **Imagens.** Placeholder (URL `localhost`, "Ver imagem:", imagem ausente)
   não é issue. URL real (Worker `/img/` ou Drive `uc?id=`) passa pelo lint
   de freshness (K15).
6. **Estrutura geral.** 3 destaques (ou 2), É IA? e ao menos 1 seção extra.
   Seção que **parece** faltar nunca basta para registrar issue (#3941).
   Protocolo em 2 etapas (#2317):
   - Conferir primeiro em `{edition_dir}/_internal/newsletter-final.html`. Se
     está no HTML local e não no e-mail: fetch `incomplete` (K1c) →
     `inconclusive`; fetch completo → problema real.
   - Ausente no HTML local E no e-mail → problema real.
   Formatos (só com confirmação):
   `"email:section_missing: Secao '{nome}' esperada mas nao encontrada no email nem no newsletter-final.html"`,
   `"email:section_missing: Secao '{nome}' presente no newsletter-final.html mas ausente no email"`.
   É IA? ausente nos dois:
   `"email:section_missing_critical: Secao 'E IA?' ausente — template nao aplicado na montagem do e-mail"`
7. **Links corretos.** Extrair as URLs clicáveis e comparar com as de
   `{edition_dir}/02-reviewed.md`. Duas camadas de redirect: (1) o Gmail
   proxeia via `https://www.google.com/url?q=...` (decodificar `q`); (2) o
   Kit reescreve todo link no click tracking
   (`*.click.kit-mail3.com/.../{destino em base64url}`, que o
   `lint-test-email.ts` decodifica). Sem como resolver, usar o texto do link
   ou o entorno para casar.
   - URL esperada ausente: `"email:link_missing: URL '{url}' esperada no destaque/secao '{contexto}' nao encontrada no email"`
   - Link com destino trocado: `"email:link_wrong: Link em '{contexto}' aponta para '{url_encontrada}' mas deveria ser '{url_esperada}'"`
   - href vazio, `#` ou `javascript:`: `"email:link_broken: Link em '{contexto}' tem href invalido: '{href}'"`
   Antes de reportar `link_wrong`/`link_broken`, aplicar o guard K11.

### K7. Lint determinístico: versão, drift semântico e subject (#603, #630, #1645)

```bash
npx tsx scripts/lint-test-email.ts \
  --email-file {edition_dir}/_internal/test-email-{AAMMDD}.txt \
  --source-md {edition_dir}/02-reviewed.md \
  --edition {AAMMDD} \
  --subject-received "{SUBJECT_RECEBIDO_DO_GMAIL}" \
  --subject-expected "{edition_title}" \
  --prev-title "{titulo_da_edicao_anterior_se_conhecido}" \
  --out {edition_dir}/_internal/lint-result-{AAMMDD}.json
# Exit 0 = sem blockers; 1 = ao menos 1 blocker; 2 = erro de uso.
# Omitir --prev-title se desconhecido.
```

Ler `{edition_dir}/_internal/lint-result-{AAMMDD}.json`
(`{ issues: [{ type, category, destaque, detail, source_md_value }], summary }`)
e mapear:
- `blocker` + `subject_mismatch` → `"email:subject_mismatch: {detail}"` (sempre blocker)
- `blocker` + `vote_merge_tag_unresolved` → `"email:link_dead: {detail}"` (#11403: voto do É IA? com merge tag literal ou `email=` vazio no destino decodificado do click tracking)
- `blocker` + `version_inconsistency` → `"email:version_inconsistency: {destaque} {detail} — source: {source_md_value}"`
- `warning` + `semantic_drift` → `"email:semantic_drift: {destaque} {detail}"`
- `info` + `intentional_error_confirmed` → `"info:intentional_error_confirmed: {destaque} {detail}"`

Anexar todas ao `issues[]` final. Se o CLI falhar (exit 2, sem arquivo),
seguir com os demais checks e registrar `"lint_cli_failed: {detalhe}"`.

### K8. Formatação visual (#753) — prefixo `email:formatting:`

Inspecionar os atributos de estilo do HTML entregue (lembrando o inlining do
Kit, K3):
1. **Títulos dos destaques:** serif sem negrito é CORRETO (DS #1936); a
   hierarquia vem do tamanho. Só reportar título no MESMO tamanho/fonte do
   corpo: `"email:formatting: D{N} título sem hierarquia visual de tamanho"`.
2. **Legenda do É IA?:** sans sem itálico é CORRETO. Não flagar.
3. **Labels de categoria** menores que o corpo (11-13px) e em caixa alta:
   `"email:formatting: D{N} label de categoria sem estilo correto"`
4. **Links** com sublinhado ou cor diferenciada:
   `"email:formatting: link sem diferenciação visual em '{contexto}'"`
5. **Fonte do corpo consistente (info-only):**
   `"info:formatting: fonte inconsistente detectada em '{seção}'"` — `info:`,
   nunca blocker (o Gmail reescreve CSS).

### K9. Checks do post-mortem 260519 (#1371)

- **Itálico markdown literal:** padrão `*texto*` literal no texto editorial
  (regex `(?<!\*)\*(?!\*)[^*\n]{2,}\*(?!\*)` no plain-text, fora de URL/código):
  `"email:italic_literal: '*{texto}*' literal sem conversão pra <em> — esperado itálico, ver #1364"`
- **Leaderboard:** se `{edition_dir}/_internal/04-leaderboard-top1.json` tem
  `top1[]` ou `podium[]` populados, ao menos um dos marcadores "Os campeões do É IA?" ou "Vencedores" aparece no body do e-mail (os textos de `renderLeaderboardTop1Row`, #9247). Senão:
  `"email:leaderboard_missing: 04-leaderboard-top1.json tem top1[]/podium[] populados mas nem 'Os campeões do É IA?' nem 'Vencedores' aparecem no email — renderer pode ter falhado"`.
  Vazios (Worker offline, mês sem votos): pular.
- **Contagem do intro (só formato LEGADO "enviei N submissões", #10308):**
  comparar N com `editor_blocks` de
  `{edition_dir}/_internal/.marker-inject-inbox-urls.json`. Divergiu:
  `"email:intro_count_mismatch: intro diz 'enviei {N} submissões' mas marker reporta editor_blocks={M}"`.
  Intro no formato atual ("enviados por mim") ou marker ausente: pular.

### K10. Link tracking via HEAD (#1248)

```bash
npx tsx scripts/lint-test-email-link-tracking.ts \
  --email-file {edition_dir}/_internal/test-email-{AAMMDD}.txt \
  --out {edition_dir}/_internal/lint-link-tracking-{AAMMDD}.json
# Exit 0 = nenhum blocker (timeout/bot_blocked/auth_required não contam, #1949).
# Exit 1 = ao menos 1 blocker (link_dead ou link_redirect_chain_long).
```

Não passar `--send-mode generic` no Kit: essa flag é do "Send test email"
genérico da Beehiiv (#6608). No Kit a merge tag do voto expande no test-send
(K3), então tag literal no e-mail entregue vira `link_dead` (blocker), inclusive
quando o `/vote` redireciona para `/jogar?...&from=post-web` com HTTP 200
(`isPostWebRedirectTarget`, #4604 — conferir `details`).

Saída: `{ total_urls_extracted, total_urls_checked, issues, skipped, passed }`,
cada issue com `severity`. Mapear respeitando o severity:
- `link_dead` (blocker) → `"email:link_dead: {url} → {details}"` (usar sempre `details`, nunca "HTTP {status}" fixo)
- `link_redirect_chain_long` (blocker) → `"email:link_redirect_chain_long: {url} → {hops} hops"`
- `link_timeout` (warning) → `"info:link_timeout: {url} (>5s, transiente)"`

`skipped[]` (`auth_required`, `non_http`, `bot_blocked`, `rate_limited`,
`amazon_bot_block`, `font_degradation`) fica no JSON para debug e **não vira
issue**. Antes de manter um `link_dead`, aplicar o guard K11 e a ressalva K4
(domínio de tracking do Kit).

### K11. Confirmação independente antes de reportar link quebrado (#4694)

O dump `test-email-{AAMMDD}.txt` é materializado por nós a partir do Gmail
MCP; uma decodificação quoted-printable duplicada nessa leitura corrompe
`=XY` com `XY` hex (em 260806, `edition=260806` virou `edition&0806` no dump,
e o link funcionava no e-mail real). Antes de incluir `email:link_dead`,
`email:link_broken` ou `email:link_wrong` no `issues[]` final:

1. **Reconstruir a URL esperada** a partir de `newsletter-final.html` (fonte
   pré-envio) ou do padrão de `scripts/lib/newsletter-render-html.ts`
   (`buildVoteUrl` e afins). Se a única diferença for um `=` faltando
   exatamente antes de 2 caracteres hex (`nome&HH...` contra `nome=HH...`),
   é **suspeita de artefato de decodificação do dump**.
2. **GET independente na URL reconstruída** (com o `=` restaurado). Se ela
   resolve (200, ou redirect esperado), **não** reportar a URL do dump:
   registrar `"info:link_decode_artifact: {url_dump} → provável double-decode do dump, URL reconstruída '{url_reconstruida}' resolve normalmente; ver #4694"`.
3. **Só reportar `link_dead`/`link_broken` se a URL reconstruída também falhar.**
4. Sem o padrão do item 1, ou sem URL-fonte para reconstruir, seguir o K10
   normalmente — o guard é para o artefato de decode, não para suprimir
   achado novo.

### K12. Structural diff (#1248)

```bash
npx tsx scripts/lint-test-email-structure.ts \
  --email-file {edition_dir}/_internal/test-email-{AAMMDD}.txt \
  --source-md {edition_dir}/02-reviewed.md \
  --out {edition_dir}/_internal/lint-structure-{AAMMDD}.json
# Exit 0 = estrutura bate. Exit 1 = ao menos 1 mismatch.
```

Mapear:
- `eia_section_missing` → `"email:eia_section_missing: source tem É IA? mas email não"`
- `section_missing` → `"email:section_missing: '{section}' presente no source com {N} itens, ausente no email"`
- `destaque_count_mismatch` → `"email:destaque_count_mismatch: source {N}, email {M}"`

Com fetch `incomplete` (K1c), suprimir os `section_missing` do `issues[]`
final (downgrade para `inconclusive`); o JSON do CLI fica para debug.

### K13. Encoding / caracteres especiais (#1248)

```bash
npx tsx scripts/lint-test-email-encoding.ts \
  --email-file {edition_dir}/_internal/test-email-{AAMMDD}.txt \
  --source-md {edition_dir}/02-reviewed.md \
  --out {edition_dir}/_internal/lint-encoding-{AAMMDD}.json
# Exit 0 = sem char_dropped. Exit 1 = char_dropped detectado.
```

Mapear:
- `char_dropped` → `"email:encoding_drop: {codepoint} '{char}' em '…{source_context}…'"`
- `char_substituted` → `"info:encoding_subst: {codepoint} '{char}' → '{email_substitute}' (ASCII fallback aceitável)"`

**#4629 — ordem literal:** codepoint primeiro (sem aspas), `'{char}'` entre
aspas simples, `em`, `'{source_context}'` entre aspas simples. Nunca
`{char} (U+{codepoint}) em '{context}'`: o parser determinístico
(`extractEncodingDropCharAndContext`, `scripts/lib/agent-issue-validator.ts`)
depende deste formato para reconhecer o emoji de kicker by-design (DS #1936).

### K14. Tamanho do e-mail ENTREGUE (#9277)

O corte do Gmail (~102 KB) vale para a **parte HTML**; o `sizeEstimate` do
`get_thread` mede a mensagem MIME inteira e é só um TETO (#9311). Passar
`--html-bytes` com o tamanho da parte `text/html` quando o payload expuser as
partes; senão só `--size-estimate`. Omitir a flag cujo valor não existir.

```bash
npx tsx scripts/lint-test-email-size.ts \
  [--html-bytes {tamanho_da_parte_text_html}] \
  [--size-estimate {sizeEstimate_da_mensagem}] \
  --email-file {edition_dir}/_internal/test-email-{AAMMDD}.txt \
  --local-html {edition_dir}/_internal/newsletter-final-kit.html \
  --out {edition_dir}/_internal/lint-size-{AAMMDD}.json
# Exit 1 = parte HTML (ou dump) acima do corte — não é erro do script: ler o JSON.
```

Mapear **todos com `info:`, nunca `email:`** (#9311 — cortar conteúdo é
decisão editorial, o fix loop não resolve):
- `delivered_size_over_clip` → `"info:delivered_size_over_clip: {detail}"`
- `delivered_size_may_clip` → `"info:delivered_size_may_clip: {detail}"`
- `delivered_size_near_clip` → `"info:delivered_size_near_clip: {detail}"` (#9823)
- `delivered_size_unmeasured` → `"info:delivered_size_unmeasured"`

### K15. Image freshness (#1212)

```bash
npx tsx scripts/lint-test-email-image-freshness.ts \
  --email-file {edition_dir}/_internal/test-email-{AAMMDD}.txt \
  --edition-dir {edition_dir} \
  --out {edition_dir}/_internal/lint-image-freshness-{AAMMDD}.json
# Exit 0 = nenhum blocker. Exit 1 = ao menos 1 image_stale (mismatch de bytes CONFIRMADO).
```

Mapear respeitando o severity (#3941):
- `image_stale` (blocker) → `"email:image_stale: {expected_local_file} — {details}"`
- `image_unreachable` (warning) → `"info:image_unreachable: {expected_local_file} — {url} retornou erro após retries"`,
  só se `{edition_dir}/06-public-images.json` NÃO confirmar a imagem no
  Worker; confirmada lá, omitir a linha.

Lint falhou (exit 2, sem arquivo): `info:lint_image_freshness_failed: {detalhe}` e seguir.

### K16. Erro intencional (`intentional-errors.jsonl`)

Toda edição traz 1 erro intencional (concurso mensal): detectar é correto,
bloquear é incorreto. Antes de manter uma inconsistência de K7 como blocker,
procurar em `data/intentional-errors.jsonl` uma entrada com a mesma
`edition`, `is_feature: true`, mesmo `error_type` e mesmo `destaque`. Achou:
`info:intentional_error_confirmed` (não-blocker). Não achou: blocker com a
nota "verificar com editor antes de publicar".

### K17. Retornar

Formato com `"platform": "kit"` explícito:

```json
{
  "status": "checked",
  "attempt": 1,
  "platform": "kit",
  "issues": []
}
```

Com issues, a mesma forma com as strings em `issues[]`. Prefixos: `email:`
para o que a inspeção do e-mail entregue achou (blocker, inclusive
`email:formatting:`), `info:` para não-blocker. Não há `publish:` no Kit.

Regras:
- **Não corrigir nada.** Só diagnosticar (o Kit não tem modo fix; o Stage 5
  registra `issues_unfixable` e o editor decide no gate do Stage 6).
- **Ser específico.** Cada issue diz qual elemento está errado e o que
  deveria ser.
- **Não falhar por causa de imagem** que não carregou na prévia do Gmail; só
  reportar estrutura quebrada ou `image_stale`.
