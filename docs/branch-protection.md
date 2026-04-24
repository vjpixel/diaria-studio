# Branch Protection — master

Setup único pra exigir CI verde antes de merge em `master`. Não é strictly necessário (ninguém deveria commitar direto em master), mas protege contra accidental pushes e garante que PRs sejam merjados só com CI passed.

## Pré-requisitos

- GitHub repo com CI workflow (este repo já tem — `.github/workflows/ci.yml`, shipado em #50).
- Permissão de admin no repo (normalmente o owner).

## Passos (UI do GitHub)

1. Abrir o repo em `https://github.com/vjpixel/diaria-studio`.
2. **Settings** → **Branches** (barra lateral).
3. Em **Branch protection rules**, clicar em **Add rule**.
4. Preencher:
   - **Branch name pattern**: `master`
   - **Require a pull request before merging**: ✅ marcar
     - **Require approvals**: opcional (1 pro workflow atual, 0 se editor trabalha sozinho).
     - **Dismiss stale pull request approvals when new commits are pushed**: ✅ recomendado.
   - **Require status checks to pass before merging**: ✅ marcar
     - **Require branches to be up to date before merging**: ✅ recomendado (evita merge de PR desatualizada).
     - Buscar o status check `test` (o job definido em `ci.yml`) e marcar como required.
   - **Require conversation resolution before merging**: opcional.
   - **Require linear history**: opcional (se quiser evitar merge commits, usa squash/rebase).
   - **Include administrators**: ✅ marcar se quer que a regra se aplique ao owner também (mais rígido). Desmarcar se quer override ocasional.
5. **Create** / **Save changes**.

## Passos (via GitHub CLI)

Se tiver `gh` instalado:

```bash
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  /repos/vjpixel/diaria-studio/branches/master/protection \
  -f required_status_checks[strict]=true \
  -f required_status_checks[contexts][]='test' \
  -f enforce_admins=true \
  -f required_pull_request_reviews[required_approving_review_count]=0 \
  -f required_pull_request_reviews[dismiss_stale_reviews]=true \
  -f restrictions=
```

Ajustar `required_approving_review_count` pra 1 se quiser exigir approval.

## Validação

Após configurar:
1. Abrir um PR de teste (ex: branch descartável com uma mudança trivial).
2. Push com teste quebrado → CI deve ficar vermelho → botão **Merge pull request** fica desabilitado com mensagem "Required statuses must pass before merging".
3. Arrumar o teste, push novo commit → CI verde → merge permitido.
4. Fechar PR / deletar branch.

## Comportamento esperado

- **PRs com CI vermelho**: merge bloqueado até CI passar.
- **Commits direto em master**: rejeitados com "protected branch hook declined" (a menos que você desmarque "Include administrators").
- **Force push em master**: bloqueado (protection sempre bloqueia force push em branches protegidas).

## Desfazer

**Settings** → **Branches** → clicar na regra → **Delete**.

## Considerações editor-solo

Se você é único contribuidor:

- Approval count = 0 (auto-approve).
- Include administrators = desmarcado (você pode override em emergência).
- Require status checks = marcado (proteção que realmente importa — CI verde).

Se futuramente entrar mais um contribuidor:

- Approval count = 1 (cada PR precisa de 1 review).
- Include administrators = marcado (trata todos igual).

## Related

- **#50** — CI workflow inicial (shipado).
- **#56** — concurrency group (shipado).
