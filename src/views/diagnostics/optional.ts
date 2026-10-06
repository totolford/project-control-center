// Calls to APIs owned by other 0.4 workstreams (recovery, permissions, local AI, journal).
// They are looked up on `api` at call time, so this build works whether or not they exist yet;
// an absent or failing API gives an honest "Unavailable" with the reason, never placeholder data.

import { api, errorMessage } from "../../lib/api";

export type Optional<T> = { state: "loading" } | { state: "ok"; value: T; at: number } | { state: "unavailable"; reason: string };

type AnyFn = (...args: unknown[]) => Promise<unknown>;

export function hasApi(name: string): boolean {
  return typeof (api as unknown as Record<string, unknown>)[name] === "function";
}

export async function callOptional<T>(name: string, ...args: unknown[]): Promise<Optional<T>> {
  const fn = (api as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") return { state: "unavailable", reason: `Not provided by this NEXUS build (api.${name} is missing).` };
  try {
    const value = (await (fn as AnyFn)(...args)) as T;
    if (value === null || value === undefined) return { state: "unavailable", reason: "The engine returned nothing." };
    return { state: "ok", value, at: Date.now() };
  } catch (e) {
    return { state: "unavailable", reason: errorMessage(e) };
  }
}
