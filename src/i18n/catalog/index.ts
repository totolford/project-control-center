// Every message namespace of the UI. To add one: create `catalog/<name>.ts` with defineMessages (keys
// prefixed "<name>."), then append it to NAMESPACES below.

import type { Namespace } from "../define";
import { LOCALES } from "../locales";
import type { Catalogs } from "../manager";
import common from "./common";
import health from "./health";
import msg from "./msg";
import bar from "./bar";
import cmd from "./cmd";
import shell from "./shell";
import nav from "./nav";
import status from "./status";
import central from "./central";
import platform from "./platform";
import settings from "./settings";
import usage from "./usage";
import worldhq from "./worldhq";
import act from "./act";
import term from "./term";
import ws from "./ws";
import panel from "./panel";
import lib from "./lib";
import comp from "./comp";

export const NAMESPACES = [common, settings, usage, worldhq, platform, central, status, nav, shell, cmd, bar, msg, health, comp, lib, panel, ws, term, act] as const;

type KeysOf<N> = N extends unknown ? keyof N & string : never;
type RawKey = KeysOf<(typeof NAMESPACES)[number]>;
type PluralBase<K> = K extends `${infer B}_${"zero" | "one" | "two" | "few" | "many" | "other"}` ? B : never;

/** Every key `t()` accepts: plain keys plus the base name of plural groups (`x` for `x_one`/`x_other`). */
export type MessageKey = RawKey | PluralBase<RawKey>;

/** Splits the rows (one per key, every language) into one flat message map per locale. */
export function buildCatalogs(namespaces: readonly Namespace[]): Catalogs {
  const out = Object.fromEntries(LOCALES.map((l) => [l, {} as Record<string, string>])) as Catalogs;
  for (const ns of namespaces) {
    for (const [key, row] of Object.entries(ns)) {
      LOCALES.forEach((locale, i) => {
        const text = row[i];
        if (typeof text === "string") out[locale][key] = text;
      });
    }
  }
  return out;
}

export const CATALOGS: Catalogs = buildCatalogs(NAMESPACES);
