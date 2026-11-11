export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }>;
export function findSecrets(text: unknown): string[];
export function redactSecrets(text: string): string;
export function isGhPublishCommand(command: unknown): boolean;
export function bodyFileArgs(command: string): string[];
export const BODY_FILE_STALE_MS: number;
export function isUniqueBodyFileName(path: string): boolean;
export function ghBodyFileValues(command: unknown): string[];
export function evaluateBodyFileName(
  command: unknown,
  cwd?: string,
  opts?: { statMtimeMs?: (path: string) => number; now?: number },
): { deny?: string; warn?: string };
export function evaluate(
  command: unknown,
  cwd?: string,
  readFile?: (path: string) => string,
): string | null;
