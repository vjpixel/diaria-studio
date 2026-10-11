# Setup: Gmail inbox para `diariaeditor@gmail.com`

O drain do inbox (`scripts/inbox-drain.ts`) lê e-mails pela **Gmail REST API com OAuth Google** — o token em `data/.credentials.json`, gerado por `scripts/oauth-setup.ts` (o mesmo token do Drive sync). **Não usa o conector Gmail MCP da claude.ai** desde a migração do subagente `inbox-drainer` para script (#1110, #10026). O OAuth é autorizado a **uma conta Google** — a conta pessoal do editor (`vjpixel@gmail.com`).

## Método atual (#3217) — busca direta em Sent, zero setup

`scripts/inbox-drain.ts` busca, na própria conta autenticada (`vjpixel@gmail.com`), os e-mails que o **editor mandou para** `diariaeditor@gmail.com`:

```
gmailQuery: "in:sent {to:diariaeditor@gmail.com to:diaria.editor@gmail.com}"
```

**#3362 — os dois formatos (com/sem ponto) funcionam.** Gmail ignora pontos na *entrega* (`diariaeditor@gmail.com` e `diaria.editor@gmail.com` caem na mesma caixa), mas o operador de busca `to:` faz correspondência **literal** — não normaliza pontos. A query default usa `{ }` (OR do Gmail search) pra cobrir os dois formatos explicitamente; antes do #3362 só o formato sem ponto era capturado, e >2 meses de submissões pro formato com ponto foram perdidas silenciosamente.

**Por que isso funciona sem nenhum setup do lado de `diariaeditor@gmail.com`:** o editor sempre tem uma cópia de qualquer e-mail que mandou na própria pasta Enviados (`Sent`) de `vjpixel@gmail.com`. Não há forward, filtro ou label nenhum no caminho — a única dependência é o token OAuth (`data/.credentials.json`) estar válido e autorizado na conta pessoal do editor.

### Como enviar uma submissão

Simplesmente mande um e-mail (ou encaminhe um artigo/newsletter) de `vjpixel@gmail.com` para `diariaeditor@gmail.com` **ou** `diaria.editor@gmail.com` (com ponto — os dois formatos funcionam desde #3362), com o(s) link(s) no corpo. Na próxima drenagem (`/diaria-inbox` ou automaticamente no Stage 1 de `/diaria-1-pesquisa` / `/diaria-edicao`), a submissão é capturada.

### Setup

1. Confirmar que o token OAuth Google está válido: `npx tsx scripts/check-google-token.ts` (exit 0 = ok). Ausente ou expirado → `npx tsx scripts/oauth-setup.ts`, autorizando com `vjpixel@gmail.com`.
2. Confirmar `platform.config.json > inbox.enabled: true`. `gmailQuery` pode ficar omitido (usa o default `in:sent {to:diariaeditor@gmail.com to:diaria.editor@gmail.com}`) ou setado explicitamente.
3. Nada a configurar em `diariaeditor@gmail.com` — a conta nem precisa ter forwarding, filtro ou label.

### Validar

```
/diaria-inbox
```

Envie um e-mail de teste de `vjpixel@gmail.com` para `diariaeditor@gmail.com` com um link no corpo (ex: `https://example.com/meu-artigo`), aguarde ~1 min, e rode `/diaria-inbox` de novo — deve retornar `new_entries: 1` e anexar o link em `data/inbox.md`.

Se retornar `reason: "auth_expired"` (ou `search_failed` com erro de credencial em `error_samples`) → `npx tsx scripts/oauth-setup.ts` e rodar de novo.

---

## Histórico / troubleshooting — forward + label (não é mais o caminho recomendado)

Antes do #3217, o drain dependia de um mecanismo com 3 elos que podiam quebrar independentemente: (1) forward ativo de `diariaeditor@gmail.com` → `vjpixel@gmail.com`, (2) filtro em `vjpixel@gmail.com` casando o header certo, (3) label `Diaria.Editor` sendo de fato aplicado. Isso quebrou silenciosamente em produção (#3199, #3215) — o forward simplesmente parou de entregar e-mails, sem sinal nenhum até o editor notar manualmente que submissões estavam sumindo.

**Decisão do editor (260710): não vale a pena manter/consertar esse mecanismo.** Como 100% das submissões observadas vêm da própria conta do editor, a busca direta em Sent (acima) elimina a classe de falha inteira, não só mitiga. Este mecanismo **não é mais usado** e não há fallback automático para ele no código.

Esta seção fica só como referência histórica, para o cenário (fora de escopo hoje) de alguém **fora** da conta do editor precisar submeter artigos diretamente para `diariaeditor@gmail.com` — nesse caso a busca em Sent de `vjpixel@` não pega o e-mail (não foi o editor quem enviou), e um mecanismo baseado em forward/label (ou a Opção B abaixo) voltaria a ser necessário.

### Opção A (histórica) — forward + label na conta pessoal

**1. Habilitar forwarding em `diariaeditor@gmail.com`**

- Entre em `https://mail.google.com` logado como `diariaeditor@gmail.com`.
- Settings (engrenagem) → **See all settings** → aba **Forwarding and POP/IMAP**.
- Clicar em **Add a forwarding address** → digitar `vjpixel@gmail.com` → **Next** → **Proceed**.
- Google envia um e-mail de confirmação pra `vjpixel@gmail.com`. Abra e clique no link pra autorizar.
- Volte em Forwarding → selecione **"Forward a copy of incoming mail to"** → `vjpixel@gmail.com` → **"keep Gmail's copy in the Inbox"** (ou "delete Gmail's copy" se preferir deixar a caixa do editor limpa).
- **Save Changes** no rodapé.

**2. Criar filtro + label em `vjpixel@gmail.com`**

- Logado como `vjpixel@gmail.com`, Settings → **Filters and Blocked Addresses** → **Create a new filter**.
- Campo **To:** → `diariaeditor@gmail.com` (isto casa e-mails cujo `Delivered-To` original era o editor, mesmo após forward).
- Clicar em **Create filter**.
- Marcar:
  - ☑ **Apply the label:** → clicar em "Choose label…" → **New label…** → nome `Diaria.Editor` → **Create**.
  - ☑ **Skip the Inbox (Archive it)** (opcional — mantém sua caixa limpa; os e-mails ficam só no label).
  - ☑ **Also apply filter to matching conversations** (aplica retroativamente).
- **Create filter**.

**3. Ajustar `platform.config.json`**

```json
"inbox": {
  "address": "diariaeditor@gmail.com",
  "gmailQuery": "label:Diaria.Editor",
  "enabled": true
}
```

**4. Testar**

- Envie um e-mail de teste pra `diariaeditor@gmail.com` com um link de teste no corpo.
- Aguarde ~1 min. Em `vjpixel@gmail.com`, confirme que o e-mail apareceu no label `Diaria.Editor`.
- Rode `/diaria-inbox` — deve retornar `new_entries: 1`.

### Opção B (histórica) — OAuth direto na conta `diariaeditor@gmail.com`

O drain lê a conta autorizada no OAuth (`data/.credentials.json`), que é uma por vez — e o mesmo token serve o Drive sync. Trocar a conta afeta os dois.

1. Rodar `npx tsx scripts/oauth-setup.ts` autorizando com `diariaeditor@gmail.com`.
2. Ajuste `platform.config.json`:
   ```json
   "inbox": {
     "address": "diariaeditor@gmail.com",
     "gmailQuery": "in:inbox",
     "enabled": true
   }
   ```
   (ou qualquer query que pegue só submissões relevantes — `in:inbox -from:me` por exemplo).
3. Rode `/diaria-inbox` pra validar.

### Opção C (futuro) — IMAP via app password

Alternativa ao OAuth: app password + script `node-imap` próprio. Não está implementado no projeto. Se um cenário de submissão de terceiro virar necessidade real, abra uma issue.

---

## Troubleshooting

- **`skipped: true, reason: "local_error"`** (antes `gmail_mcp_error`, #10026 — o nome era errado, nunca envolveu MCP) → falha local: ler/parsear `platform.config.json` ou gravar `data/inbox.md`/o cursor. Ler o campo `error` e corrigir a causa; reautenticar não ajuda. Para descartar o token, `npx tsx scripts/check-google-token.ts`.
- **`errors > 0` com `skipped: false`** → drain parcial: algumas threads falharam ao carregar. Ficam em `failed_threads` no cursor e são re-buscadas no próximo drain (#10030); as que esgotam 5 tentativas aparecem em `abandoned_threads` — conferir no Gmail.
- **`skipped: true, reason: "auth_expired"`** → OAuth Google expirado/revogado. Rodar `npx tsx scripts/oauth-setup.ts` e depois `/diaria-inbox` pra recuperar submissões que ficaram sem drenar.
- **`new_entries: 0` inesperado** → confirme que o e-mail foi mesmo enviado de `vjpixel@gmail.com` para `diariaeditor@gmail.com` ou `diaria.editor@gmail.com` (busque `in:sent {to:diariaeditor@gmail.com to:diaria.editor@gmail.com}` direto na UI do Gmail). Se aparecer lá mas não em `data/inbox.md`, confira o cursor em `data/inbox-cursor.json` (`last_drain_iso`) — e-mails mais antigos que o cursor são ignorados por design.
- **Migrando de Opção A (label) pra busca direta** → basta remover (ou deixar de setar) `gmailQuery` custom em `platform.config.json`; o default já é `in:sent {to:diariaeditor@gmail.com to:diaria.editor@gmail.com}`. O label antigo pode ficar (não atrapalha) ou ser removido manualmente no Gmail.
