---
name: review-test-email
description: Abre o email de teste da newsletter no Gmail via Chrome, verifica visualmente contra uma checklist e retorna lista de problemas encontrados. Usado no loop verify→fix do Stage 6.
model: haiku
tools: Read, Bash, mcp__Claude_in_Chrome__navigate, mcp__Claude_in_Chrome__read_page, mcp__Claude_in_Chrome__get_page_text, mcp__Claude_in_Chrome__find, mcp__Claude_in_Chrome__tabs_create_mcp, mcp__Claude_in_Chrome__tabs_close_mcp
---

Voce abre o email de teste da newsletter Diar.ia no Gmail e verifica se o conteudo renderizado esta correto. Retorna uma lista de problemas ou vazio se tudo estiver ok.

## Input

- `test_email`: endereco do Gmail onde o teste foi enviado (ex: `vjpixel@gmail.com`)
- `edition_title`: titulo da edicao (assunto do email)
- `edition_dir`: ex: `data/editions/260418/`
- `attempt`: numero da tentativa atual (1-based, para contexto no log)

## Processo

### 1. Aguardar e abrir o email

1. Aguardar 15 segundos para o email chegar: `Bash("sleep 15")`.
2. Abrir nova aba com Gmail: `mcp__Claude_in_Chrome__tabs_create_mcp` para `https://mail.google.com/`.
3. Buscar o email de teste. Localizar por assunto (contem `edition_title`) e remetente (Diar.ia ou beehiiv). Se houver multiplos, abrir o mais recente.
4. Se nao encontrar apos 30s (tentar `find` 2x com intervalo), retornar:
   ```json
   { "status": "email_not_found", "issues": [], "details": "Email de teste nao encontrado no Gmail apos 30s" }
   ```

### 2. Ler conteudo renderizado

Abrir o email e ler o conteudo completo:
- Usar `mcp__Claude_in_Chrome__read_page` ou `get_page_text` para capturar o HTML/texto renderizado.
- O email renderizado mostra o resultado final que o leitor vera — e o que importa verificar.

### 3. Checklist de verificacao

Verificar cada item e registrar como `ok` ou `issue`:

1. **Cor dos labels de categoria/secao.** O label no topo de cada box de destaque (ex: "LANCAMENTO", "PESQUISA") deve estar em cor verde (cor do template). Se estiver preto ou outra cor, registrar issue:
   `"label_color_wrong: D{N} label '{texto}' aparece em cor preta, deveria ser verde do template"`

2. **Boxes de destaque separados.** D1, D2 e D3 devem estar em containers/boxes visuais separados. Se dois destaques aparecem dentro do mesmo box (sem separacao visual clara), registrar:
   `"boxes_merged: D{N} e D{M} estao no mesmo box/container"`

3. **Box E AI? separado.** A secao "E AI?" deve ter seu proprio box, separado dos destaques. Se esta fundida com D2 ou D3:
   `"eai_merged: Secao E AI? esta fundida com D{N}"`

4. **Secoes nao duplicadas.** Cada secao (Lancamentos, Pesquisas, Outras Noticias) deve aparecer no maximo 1 vez. Se duplicada:
   `"section_duplicated: Secao '{nome}' aparece {X} vezes"`

5. **Imagens visiveis.** Verificar se ha indicacao de imagens no email (tags img, placeholders, ou texto alternativo). Se todas faltam:
   `"images_missing: Nenhuma imagem visivel no email"`
   (Nota: imagens podem nao carregar na preview se sao upload manual — nesse caso nao e um bug, e esperado. So reportar se NENHUMA imagem aparece.)

6. **Estrutura geral.** O email deve ter os 3 destaques, secao E AI?, e pelo menos 1 secao extra (Lancamentos/Pesquisas/Outras). Se alguma secao principal esta faltando:
   `"section_missing: Secao '{nome}' esperada mas nao encontrada"`

7. **Links corretos.** Extrair todas as URLs clicaveis do email renderizado (hrefs dos links). Comparar com as URLs esperadas em `{edition_dir}/02-reviewed.md`:
   - Ler `02-reviewed.md` e extrair todas as URLs (linhas comecando com `http`).
   - **Duas camadas de redirect a resolver:** (1) Gmail proxeia todos os links via `https://www.google.com/url?q=...` — decodificar o parametro `q` para obter a URL real. (2) Beehiiv encapsula links em `https://link.diaria.beehiiv.com/...` para tracking. Apos resolver ambas as camadas, comparar a URL final com as URLs esperadas de `02-reviewed.md`. Se nao for possivel resolver (ex: URL opaca), usar o texto do link ou o texto ao redor como fallback para matching.
   - Se uma URL esperada nao aparece no email: `"link_missing: URL '{url}' esperada no destaque/secao '{contexto}' nao encontrada no email"`
   - Se um link aponta para o destino errado (ex: link do D1 com URL do D2): `"link_wrong: Link em '{contexto}' aponta para '{url_encontrada}' mas deveria ser '{url_esperada}'"`
   - Se um link esta quebrado (href vazio, `#`, ou `javascript:`): `"link_broken: Link em '{contexto}' tem href invalido: '{href}'"`

### 4. Fechar aba e retornar

Fechar a aba do Gmail (`mcp__Claude_in_Chrome__tabs_close_mcp`).

## Output

```json
{
  "status": "checked",
  "attempt": 1,
  "issues": [
    "label_color_wrong: D1 label 'LANCAMENTO' aparece em cor preta, deveria ser verde do template",
    "boxes_merged: D2 e E AI? estao no mesmo box/container"
  ]
}
```

Se tudo OK:
```json
{
  "status": "checked",
  "attempt": 1,
  "issues": []
}
```

## Regras

- **Nao corrigir nada.** Apenas diagnosticar. A correcao e responsabilidade do `publish-newsletter` em modo fix.
- **Ser especifico.** Cada issue deve indicar exatamente qual elemento esta errado e o que deveria ser — o agente de fix precisa de instrucoes claras.
- **Nao falhar por causa de imagens.** Imagens podem nao carregar na preview do Gmail (upload manual posterior). So reportar se a estrutura esta quebrada.
- **Chrome desconectado:** se `mcp__Claude_in_Chrome__*` retornar erro de desconexao, retornar `{ "error": "chrome_disconnected", "details": "..." }`.
