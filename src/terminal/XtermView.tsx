import { memo, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { ArrowDown, ArrowUp, ClipboardPaste, Copy, Eraser, Pause, Play, RotateCw, Search, X } from "lucide-react";
import { api } from "../lib/api";
import { subscribePty } from "../lib/ptyBus";
import { toast } from "../lib/toast";
import type { PtyInfo } from "../lib/types";
import { XTERM_FONT, XTERM_THEME, useTerminalPrefs } from "./terminalPrefs";

interface Handles {
  term: Terminal;
  search: SearchAddon;
  /** Fits the terminal to its host and tells the PTY the new size. */
  refit: () => void;
}

async function copySelection(term: Terminal) {
  const text = term.getSelection();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    toast.error(e);
  }
}

async function pasteClipboard(term: Terminal) {
  try {
    term.paste(await navigator.clipboard.readText());
  } catch (e) {
    toast.error(e);
  }
}

/** Creates the xterm for one PTY session: repaints the scrollback, streams output, forwards input and size. */
function useXterm(info: PtyInfo, visible: boolean, paused: boolean, onSearch: () => void) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [handles, setHandles] = useState<Handles | null>(null);
  const pausedRef = useRef(paused);
  const held = useRef<string[]>([]);
  const fontSize = useTerminalPrefs((s) => s.fontSize);
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;
  const { id } = info;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({ fontFamily: XTERM_FONT, fontSize: useTerminalPrefs.getState().fontSize, theme: XTERM_THEME, cursorBlink: true, scrollback: 10000 });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(host);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey) return true;
      const key = e.key.toLowerCase();
      if (e.shiftKey && key === "c") void copySelection(term);
      else if (e.shiftKey && key === "v") void pasteClipboard(term);
      else if (!e.shiftKey && key === "f") searchRef.current();
      else return true;
      return false;
    });

    let ready = false;
    const early: string[] = [];
    const show = (data: string) => {
      if (pausedRef.current) held.current.push(data);
      else term.write(data);
    };
    const unsubscribe = subscribePty(id, (e) => {
      const data = e.type === "data" ? e.data : `\r\n[process exited with code ${e.code ?? "unknown"}]\r\n`;
      if (ready) show(data);
      else early.push(data);
    });
    api
      .ptyScrollback(id)
      .catch(() => "")
      .then((scrollback) => {
        if (scrollback) term.write(scrollback);
        early.forEach(show);
        ready = true;
      });

    const input = term.onData((data) => void api.ptyWrite(id, data).catch(() => undefined));
    let last = { cols: 0, rows: 0 };
    const resize = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
      if (term.cols !== last.cols || term.rows !== last.rows) {
        last = { cols: term.cols, rows: term.rows };
        void api.ptyResize(id, term.cols, term.rows).catch(() => undefined);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    setHandles({ term, search, refit: resize });
    return () => {
      observer.disconnect();
      input.dispose();
      unsubscribe();
      term.dispose();
      setHandles(null);
    };
  }, [id]);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused && handles && held.current.length > 0) {
      handles.term.write(held.current.join(""));
      held.current = [];
    }
  }, [paused, handles]);

  useEffect(() => {
    if (!handles) return;
    handles.term.options.fontSize = fontSize;
    handles.refit();
  }, [fontSize, handles]);

  useEffect(() => {
    if (!visible || !handles) return;
    handles.refit();
    handles.term.focus();
  }, [visible, handles]);

  return { hostRef, handles };
}

function SearchBox({ search, onClose }: { search: SearchAddon; onClose: () => void }) {
  const [query, setQuery] = useState("");
  return (
    <div className="term-search">
      <input
        autoFocus
        value={query}
        placeholder="Find"
        onChange={(e) => {
          setQuery(e.target.value);
          search.findNext(e.target.value, { incremental: true });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.shiftKey ? search.findPrevious(query) : search.findNext(query));
          if (e.key === "Escape") onClose();
        }}
        aria-label="Find in terminal"
      />
      <button className="icon-btn" onClick={() => search.findPrevious(query)} aria-label="Previous match">
        <ArrowUp size={12} />
      </button>
      <button className="icon-btn" onClick={() => search.findNext(query)} aria-label="Next match">
        <ArrowDown size={12} />
      </button>
      <button
        className="icon-btn"
        onClick={() => {
          search.clearDecorations();
          onClose();
        }}
        aria-label="Close search"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/** One Raw Terminal session: xterm + toolbar (copy, paste, find, clear, display pause) + exit bar. */
export const XtermView = memo(function XtermView({
  info,
  visible,
  onRestart,
  onClose,
}: {
  info: PtyInfo;
  visible: boolean;
  onRestart: (() => void) | null;
  onClose: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const [searching, setSearching] = useState(false);
  const { hostRef, handles } = useXterm(info, visible, paused, () => setSearching(true));
  const term = handles?.term;

  return (
    <div className="term-view" style={visible ? undefined : { display: "none" }}>
      <div className="term-toolbar">
        <span className="muted tiny mono ellipsis" title={`${info.program} ${info.args.join(" ")} — ${info.cwd}`}>
          {info.pid !== null ? `pid ${info.pid} · ` : ""}
          {info.cwd}
        </span>
        <span className="spacer" />
        {searching && handles && <SearchBox search={handles.search} onClose={() => setSearching(false)} />}
        <button className="icon-btn" onClick={() => term && void copySelection(term)} title="Copy selection (Ctrl+Shift+C)" aria-label="Copy">
          <Copy size={13} />
        </button>
        <button className="icon-btn" onClick={() => term && void pasteClipboard(term)} title="Paste (Ctrl+Shift+V)" aria-label="Paste" disabled={!info.running}>
          <ClipboardPaste size={13} />
        </button>
        <button className="icon-btn" onClick={() => setSearching(true)} title="Find (Ctrl+F)" aria-label="Find">
          <Search size={13} />
        </button>
        <button className="icon-btn" onClick={() => term?.clear()} title="Clear the display" aria-label="Clear">
          <Eraser size={13} />
        </button>
        <button
          className={`icon-btn${paused ? " active" : ""}`}
          onClick={() => setPaused((p) => !p)}
          title={paused ? "Resume display (buffered output is shown)" : "Pause display (the process keeps running; output is buffered)"}
          aria-label={paused ? "Resume display" : "Pause display"}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
      </div>
      {paused && <div className="term-paused">Display paused — output is buffered and shown on resume.</div>}
      <div
        className="term-host"
        ref={hostRef}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!term) return;
          if (term.hasSelection()) void copySelection(term).then(() => term.clearSelection());
          else if (info.running) void pasteClipboard(term);
        }}
      />
      {!info.running && (
        <div className="term-exit">
          <span>Process exited with code {info.exitCode ?? "unknown"}</span>
          <span className="spacer" />
          {onRestart && (
            <button className="btn btn-sm" onClick={onRestart}>
              <RotateCw size={12} /> Restart
            </button>
          )}
          <button className="btn btn-sm" onClick={onClose}>
            <X size={12} /> Close
          </button>
        </div>
      )}
    </div>
  );
});
