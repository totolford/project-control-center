//! Interactive pseudo-terminal sessions (ConPTY on Windows).
//!
//! Used by the Raw Terminal: an interactive `claude` exactly as in a normal
//! terminal, or a shell (PowerShell, CMD, WSL). Output is streamed through a
//! callback and kept in a bounded scrollback so a panel can re-attach.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use pcc_core::{Error, Result};

/// Scrollback kept per session for re-attaching (bytes of text).
const SCROLLBACK: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub id: String,
    pub title: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub pid: Option<u32>,
    pub started_at: String,
    pub exit_code: Option<u32>,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Data { id: String, data: String },
    Exit { id: String, code: Option<u32> },
}

pub struct PtySpec {
    pub title: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

struct Session {
    info: PtyInfo,
    /// Dropped when the process exits: closing the pseudo-console ends the output stream.
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    scrollback: String,
}

#[derive(Clone, Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

/// Decodes a byte stream as UTF-8 without splitting multi-byte characters.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(s) => {
                let out = s.to_string();
                self.pending.clear();
                out
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // An incomplete sequence at the end waits for more bytes; invalid bytes are replaced.
                let keep = if e.error_len().is_none() { self.pending.len() - valid } else { 0 };
                let cut = self.pending.len() - keep;
                let out = String::from_utf8_lossy(&self.pending[..cut]).into_owned();
                self.pending.drain(..cut);
                out
            }
        }
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn spawn(&self, spec: PtySpec, on_event: impl Fn(PtyEvent) + Send + Sync + 'static) -> Result<PtyInfo> {
        let pty = native_pty_system()
            .openpty(PtySize { rows: spec.rows.max(5), cols: spec.cols.max(20), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| Error::Process(format!("cannot open a terminal: {e}")))?;
        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        cmd.cwd(&spec.cwd);
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let mut child =
            pty.slave.spawn_command(cmd).map_err(|e| Error::Process(format!("cannot start {}: {e}", spec.program)))?;
        drop(pty.slave);
        let pid = child.process_id();
        if let Some(pid) = pid {
            pcc_claude::process::attach_pid_to_app_job(pid);
        }
        let mut reader = pty.master.try_clone_reader().map_err(|e| Error::Process(e.to_string()))?;
        let writer = pty.master.take_writer().map_err(|e| Error::Process(e.to_string()))?;
        let id = format!("pty-{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
        let info = PtyInfo {
            id: id.clone(),
            title: spec.title,
            program: spec.program,
            args: spec.args,
            cwd: spec.cwd,
            pid,
            started_at: pcc_core::now(),
            exit_code: None,
            running: true,
        };
        self.sessions.lock().insert(
            id.clone(),
            Session {
                info: info.clone(),
                master: Some(pty.master),
                writer,
                killer: child.clone_killer(),
                scrollback: String::new(),
            },
        );

        // The waiter owns the child: when it exits, record the code, close the
        // pseudo-console (which ends the reader) and report the exit.
        let sessions_w = self.sessions.clone();
        let id_w = id.clone();
        let on_event = Arc::new(on_event);
        let on_exit = on_event.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            let master = sessions_w.lock().get_mut(&id_w).and_then(|s| {
                s.info.running = false;
                s.info.exit_code = code;
                s.master.take()
            });
            drop(master);
            on_exit(PtyEvent::Exit { id: id_w, code });
        });

        let sessions = self.sessions.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut utf8 = Utf8Stream::default();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = utf8.push(&buf[..n]);
                        if text.is_empty() {
                            continue;
                        }
                        if let Some(s) = sessions.lock().get_mut(&id) {
                            s.scrollback.push_str(&text);
                            if s.scrollback.len() > SCROLLBACK {
                                let mut cut = s.scrollback.len() - SCROLLBACK;
                                while !s.scrollback.is_char_boundary(cut) {
                                    cut += 1;
                                }
                                s.scrollback.drain(..cut);
                            }
                        }
                        on_event(PtyEvent::Data { id: id.clone(), data: text });
                    }
                }
            }
        });
        Ok(info)
    }

    fn with<T>(&self, id: &str, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
        let mut map = self.sessions.lock();
        let s = map.get_mut(id).ok_or_else(|| Error::not_found(format!("terminal {id}")))?;
        f(s)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        self.with(id, |s| {
            s.writer.write_all(data.as_bytes())?;
            s.writer.flush()?;
            Ok(())
        })
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        self.with(id, |s| {
            let master = s.master.as_ref().ok_or_else(|| Error::invalid("the terminal has exited"))?;
            master
                .resize(PtySize { rows: rows.max(5), cols: cols.max(20), pixel_width: 0, pixel_height: 0 })
                .map_err(|e| Error::Process(e.to_string()))
        })
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        self.with(id, |s| {
            if s.info.running {
                s.killer.kill().map_err(|e| Error::Process(e.to_string()))?;
            }
            Ok(())
        })
    }

    /// Removes a finished session (kills it first if needed).
    pub fn close(&self, id: &str) -> Result<()> {
        let _ = self.kill(id);
        self.sessions.lock().remove(id);
        Ok(())
    }

    pub fn scrollback(&self, id: &str) -> Result<String> {
        self.with(id, |s| Ok(s.scrollback.clone()))
    }

    pub fn list(&self) -> Vec<PtyInfo> {
        let mut v: Vec<PtyInfo> = self.sessions.lock().values().map(|s| s.info.clone()).collect();
        v.sort_by(|a, b| a.started_at.cmp(&b.started_at));
        v
    }

    pub fn kill_all(&self) {
        for s in self.sessions.lock().values_mut() {
            let _ = s.killer.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn utf8_stream_keeps_split_characters() {
        let mut d = Utf8Stream::default();
        let bytes = "héllo ✓".as_bytes();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&d.push(&[*b]));
        }
        assert_eq!(out, "héllo ✓");
        assert_eq!(d.push(&[0xff, b'a']), "\u{fffd}a");
    }

    #[cfg(windows)]
    #[test]
    fn runs_a_real_shell() {
        let m = PtyManager::new();
        let (tx, rx) = mpsc::channel();
        let info = m
            .spawn(
                PtySpec {
                    title: "cmd".into(),
                    program: "cmd.exe".into(),
                    args: vec![],
                    cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                    env: vec![],
                    cols: 100,
                    rows: 30,
                },
                move |e| {
                    let _ = tx.send(e);
                },
            )
            .unwrap();
        let mut sent = false;
        let mut seen = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while seen.matches("nexus-pty-ok").count() < 2 && std::time::Instant::now() < deadline {
            if !sent && seen.contains('>') {
                m.write(&info.id, "echo nexus-pty-ok\r\n").unwrap();
                sent = true;
            }
            if let Ok(PtyEvent::Data { data, .. }) = rx.recv_timeout(Duration::from_millis(200)) {
                // ConPTY asks for the cursor position at start-up; a real terminal answers it.
                if data.contains("\x1b[6n") {
                    m.write(&info.id, "\x1b[1;1R").unwrap();
                }
                seen.push_str(&data);
            }
        }
        assert!(seen.matches("nexus-pty-ok").count() >= 2, "{seen}");
        m.resize(&info.id, 120, 40).unwrap();
        assert!(m.scrollback(&info.id).unwrap().contains("nexus-pty-ok"));
        m.write(&info.id, "exit\r\n").unwrap();
        let exited = (0..100).any(|_| matches!(rx.recv_timeout(Duration::from_millis(200)), Ok(PtyEvent::Exit { .. })));
        assert!(exited);
        assert!(!m.list()[0].running);
        m.close(&info.id).unwrap();
        assert!(m.list().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_real_shell() {
        let m = PtyManager::new();
        let (tx, rx) = mpsc::channel();
        let info = m
            .spawn(
                PtySpec {
                    title: "sh".into(),
                    program: "sh".into(),
                    args: vec![],
                    cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                    env: vec![],
                    cols: 100,
                    rows: 30,
                },
                move |e| {
                    let _ = tx.send(e);
                },
            )
            .unwrap();
        m.write(&info.id, "echo nexus-pty-$((40+2))\n").unwrap();
        let mut seen = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while !seen.contains("nexus-pty-42") && std::time::Instant::now() < deadline {
            if let Ok(PtyEvent::Data { data, .. }) = rx.recv_timeout(Duration::from_millis(200)) {
                seen.push_str(&data);
            }
        }
        assert!(seen.contains("nexus-pty-42"), "{seen}");
        m.resize(&info.id, 120, 40).unwrap();
        m.write(&info.id, "exit\n").unwrap();
        let exited = (0..100).any(|_| matches!(rx.recv_timeout(Duration::from_millis(200)), Ok(PtyEvent::Exit { .. })));
        assert!(exited);
        m.close(&info.id).unwrap();
        assert!(m.list().is_empty());
    }
}
