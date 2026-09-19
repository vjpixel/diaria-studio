import { claimWorktree } from "./lib/session-registry.ts";
const path = process.argv[2];
const sessionId = process.argv[3];
const repoRoot = process.argv[4];
const branch = process.argv[5] || undefined;
const ok = claimWorktree(path, sessionId, repoRoot, branch);
console.log(ok ? "claimed" : "refused");
