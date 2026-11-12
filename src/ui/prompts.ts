import * as clack from "@clack/prompts";
import type { SelectOptions, ConfirmOptions, TextOptions } from "@clack/prompts";
import { GhopError } from "../core/errors.ts";

export function requireTTY(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new GhopError("Interactive mode needs a terminal (TTY). In Git Bash without a pseudo console, run `winpty ghop`.", 5);
}
export async function select<T>(options: SelectOptions<T>): Promise<T> {
  requireTTY();
  const value = await clack.select(options);
  if (clack.isCancel(value)) { clack.cancel("Cancelled."); process.exit(0); }
  return value;
}
export async function confirm(options: ConfirmOptions): Promise<boolean> {
  requireTTY();
  const value = await clack.confirm(options);
  if (clack.isCancel(value)) { clack.cancel("Cancelled."); process.exit(0); }
  return value;
}
export async function text(options: TextOptions): Promise<string> {
  requireTTY();
  const value = await clack.text(options);
  if (clack.isCancel(value)) { clack.cancel("Cancelled."); process.exit(0); }
  return value;
}
