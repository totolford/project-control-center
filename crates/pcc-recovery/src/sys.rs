//! Operating-system process inspection: liveness, creation time (to tell a
//! process from a later one that reused its PID), CPU time, the process table
//! and command lines. Everything here only reads; nothing is changed.

use std::time::Duration;

/// What the OS reports about one live process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcInfo {
    pub pid: u32,
    /// Creation time, milliseconds since the Unix epoch.
    pub created_ms: Option<u64>,
    /// Kernel + user CPU time consumed so far, in milliseconds.
    pub cpu_ms: Option<u64>,
}

/// One row of the process table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
}

/// One process with its command line (used to find sessions nobody owns).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct CmdProc {
    #[serde(rename = "ProcessId")]
    pub pid: u32,
    #[serde(rename = "ParentProcessId")]
    pub ppid: u32,
    #[serde(rename = "Name", default)]
    pub name: String,
    #[serde(rename = "CommandLine", default)]
    pub command_line: Option<String>,
}

/// The current NEXUS process.
pub fn current_pid() -> u32 {
    std::process::id()
}

pub fn pid_alive(pid: u32) -> bool {
    pid != 0 && imp::alive(pid)
}

/// Creation and CPU time of a live process, `None` when it does not exist.
pub fn process_info(pid: u32) -> Option<ProcInfo> {
    if pid == 0 {
        return None;
    }
    imp::info(pid)
}

/// The whole process table (empty when it cannot be read).
pub fn list_processes() -> Vec<ProcEntry> {
    imp::list()
}

/// Direct and indirect children of `pid` in a process table.
pub fn descendants(table: &[ProcEntry], pid: u32) -> Vec<ProcEntry> {
    let mut out: Vec<ProcEntry> = Vec::new();
    let mut frontier = vec![pid];
    while let Some(p) = frontier.pop() {
        for e in table.iter().filter(|e| e.ppid == p && e.pid != p) {
            if !out.iter().any(|o| o.pid == e.pid) && e.pid != pid {
                frontier.push(e.pid);
                out.push(e.clone());
            }
        }
    }
    out
}

/// Processes with one of these image names and their command lines. Slow
/// (one PowerShell/CIM query, about a second): call it off the UI path.
pub fn command_lines(names: &[&str], timeout: Duration) -> Result<Vec<CmdProc>, String> {
    imp::command_lines(names, timeout)
}

/// Same instant, allowing the rounding of the two sources of the time.
pub fn same_start(a: Option<u64>, b: Option<u64>) -> Option<bool> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.abs_diff(b) <= 2_000),
        _ => None,
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, FILETIME, STILL_ACTIVE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// 100 ns intervals between 1601-01-01 and 1970-01-01.
    const EPOCH_DIFF: u64 = 116_444_736_000_000_000;

    fn ft(f: &FILETIME) -> u64 {
        ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64
    }

    pub fn alive(pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                // A protected process exists but cannot be opened.
                return GetLastError() == ERROR_ACCESS_DENIED;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code) != 0;
            CloseHandle(h);
            ok && code == STILL_ACTIVE as u32
        }
    }

    pub fn info(pid: u32) -> Option<ProcInfo> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return (GetLastError() == ERROR_ACCESS_DENIED).then_some(ProcInfo {
                    pid,
                    created_ms: None,
                    cpu_ms: None,
                });
            }
            let mut code = 0u32;
            let running = GetExitCodeProcess(h, &mut code) != 0 && code == STILL_ACTIVE as u32;
            let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut c, mut e, mut k, mut u) = (zero, zero, zero, zero);
            let times = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0;
            CloseHandle(h);
            if !running {
                return None;
            }
            Some(ProcInfo {
                pid,
                created_ms: times.then(|| ft(&c).saturating_sub(EPOCH_DIFF) / 10_000),
                cpu_ms: times.then(|| (ft(&k) + ft(&u)) / 10_000),
            })
        }
    }

    pub fn list() -> Vec<ProcEntry> {
        let mut out = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap.is_null() || snap as isize == -1 {
                return out;
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut e) != 0;
            while ok {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                out.push(ProcEntry {
                    pid: e.th32ProcessID,
                    ppid: e.th32ParentProcessID,
                    name: String::from_utf16_lossy(&e.szExeFile[..len]),
                });
                ok = Process32NextW(snap, &mut e) != 0;
            }
            CloseHandle(snap);
        }
        out
    }

    pub fn command_lines(names: &[&str], timeout: Duration) -> Result<Vec<CmdProc>, String> {
        use std::os::windows::process::CommandExt;
        if names.is_empty() {
            return Ok(Vec::new());
        }
        let filter = names
            .iter()
            .filter(|n| n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')))
            .map(|n| format!("Name='{n}'"))
            .collect::<Vec<_>>()
            .join(" OR ");
        let script = format!(
            "Get-CimInstance Win32_Process -Filter \"{filter}\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"
        );
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("cannot run PowerShell: {e}"))?;
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if start.elapsed() > timeout => {
                    let _ = child.kill();
                    return Err("process query timed out".into());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => return Err(e.to_string()),
            }
        }
        let mut text = String::new();
        if let Some(mut out) = child.stdout.take() {
            use std::io::Read;
            let _ = out.read_to_string(&mut text);
        }
        parse_cim_json(&text)
    }

    pub(super) fn parse_cim_json(text: &str) -> Result<Vec<CmdProc>, String> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        // ConvertTo-Json emits an object for one result and an array for several.
        let v: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
        let items = match v {
            serde_json::Value::Array(a) => a,
            other => vec![other],
        };
        Ok(items.into_iter().filter_map(|i| serde_json::from_value(i).ok()).collect())
    }
}

/// Linux (and other Unix): `/proc` through `pcc_platform::process`.
#[cfg(not(windows))]
mod imp {
    use super::*;
    use pcc_platform::process as platform;

    pub fn alive(pid: u32) -> bool {
        platform::pid_alive(pid)
    }

    pub fn info(pid: u32) -> Option<ProcInfo> {
        if !alive(pid) {
            return None;
        }
        let (created_ms, cpu_ms) = platform::times(pid).unwrap_or((None, None));
        Some(ProcInfo { pid, created_ms, cpu_ms })
    }

    pub fn list() -> Vec<ProcEntry> {
        platform::list().into_iter().map(|p| ProcEntry { pid: p.pid, ppid: p.ppid, name: p.name }).collect()
    }

    /// Image names are compared without `.exe`; `/proc/<pid>/stat` truncates
    /// names to 15 bytes, so a longer name matches on its first 15.
    pub fn command_lines(names: &[&str], _timeout: Duration) -> Result<Vec<CmdProc>, String> {
        let wanted: Vec<String> = names.iter().map(|n| n.trim_end_matches(".exe").chars().take(15).collect()).collect();
        Ok(list()
            .into_iter()
            .filter(|p| wanted.contains(&p.name))
            .map(|p| CmdProc { pid: p.pid, ppid: p.ppid, command_line: platform::command_line(p.pid), name: p.name })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_is_alive_with_times() {
        let me = current_pid();
        assert!(pid_alive(me));
        let info = process_info(me).expect("own process");
        if cfg!(any(windows, target_os = "linux")) {
            let created = info.created_ms.unwrap();
            let now = chrono::Utc::now().timestamp_millis() as u64;
            assert!(created <= now && now - created < 24 * 3600 * 1000);
        }
        assert!(list_processes().iter().any(|p| p.pid == me));
    }

    #[test]
    fn absent_pid_is_dead() {
        // PIDs are multiples of 4 on Windows; this one is never used.
        assert!(!pid_alive(0));
        assert!(!pid_alive(0xFFFF_FFF1));
        assert!(process_info(0xFFFF_FFF1).is_none());
    }

    #[test]
    fn descendants_walk_the_tree() {
        let t = vec![
            ProcEntry { pid: 10, ppid: 1, name: "claude.exe".into() },
            ProcEntry { pid: 11, ppid: 10, name: "node.exe".into() },
            ProcEntry { pid: 12, ppid: 11, name: "cmd.exe".into() },
            ProcEntry { pid: 13, ppid: 1, name: "other.exe".into() },
        ];
        let d: Vec<u32> = descendants(&t, 10).iter().map(|p| p.pid).collect();
        assert_eq!(d.len(), 2);
        assert!(d.contains(&11) && d.contains(&12));
    }

    #[test]
    fn start_times_tolerate_rounding() {
        assert_eq!(same_start(Some(1000), Some(2500)), Some(true));
        assert_eq!(same_start(Some(1000), Some(9000)), Some(false));
        assert_eq!(same_start(None, Some(1)), None);
    }

    #[cfg(windows)]
    #[test]
    fn cim_json_single_and_many() {
        let one =
            imp::parse_cim_json(r#"{"ProcessId":5,"ParentProcessId":4,"Name":"claude.exe","CommandLine":"claude -p"}"#)
                .unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].command_line.as_deref(), Some("claude -p"));
        let many = imp::parse_cim_json(
            r#"[{"ProcessId":5,"ParentProcessId":4,"Name":"a","CommandLine":null},{"ProcessId":6,"ParentProcessId":4,"Name":"b"}]"#,
        )
        .unwrap();
        assert_eq!(many.len(), 2);
        assert!(imp::parse_cim_json("").unwrap().is_empty());
    }
}
