// #11482: scope local Studio checks independently of the merge allowlist.
// Security checks (PII, secrets, merge authorization) keep their own policy.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DIARIA_STUDIO_REPO, ghPrSegments, commandComplexity, commandWithoutMessageText } from './gh-target-repo.mjs';
import { resolveRepoRootCandidates } from '../block-pr-create-pii-runtime-artifacts.mjs';

export function studioPrCreateCwd(command, payloadCwd, hookDir) {
  const segments = ghPrSegments(command, ['create']);
  // Unknown/complex targets remain guarded; mixed commands retain Studio checks.
  if (segments.length && commandComplexity(commandWithoutMessageText(command)).length === 0 &&
      segments.every(({ repo }) => repo && repo !== DIARIA_STUDIO_REPO)) return null;

  // Use only the effective cwd. Falling back to the hook's checkout when an
  // explicit cwd is outside git would audit the wrong branch (#11482).
  const candidate = resolveRepoRootCandidates(payloadCwd, hookDir, command)[0];
  const git = (args, cwd) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  }).trim();
  try {
    const common = (cwd) => git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
    // Linked worktrees share the common directory and must keep their guards.
    if (common(candidate) !== common(resolve(hookDir, '../..'))) return null;
    return git(['rev-parse', '--show-toplevel'], candidate);
  } catch {
    return null;
  }
}
