//! Child-process lifetime on each OS.
//!
//! - **Windows**: no console window (`CREATE_NO_WINDOW`); kill-on-close comes
//!   from the job object in `pcc_claude::process`; trees are stopped with
//!   `taskkill /T`.
//! - **Linux**: every child starts in its own process group (so the whole
//!   group can be signalled); long-lived children also get
//!   `PR_SET_PDEATHSIG(SIGKILL)` so they die with NEXUS even on a crash.
//!   `PR_SET_PDEATHSIG` fires when the *thread* that forked exits, so
//!   [`spawn_tied`] forks from one thread that lives as long as the process.
//!   Trees are stopped by signalling the group and every descendant found in
//!   `/proc`.

use std::io;
use std::process::{Child, Command};

/// `CREATE_NO_WINDOW`: a console program started from the GUI shows no window.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// One row of the process table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
}

/// Platform conventions for a short or blocking command: no console window on
/// Windows, an own process group on Unix.
pub fn prepare_std(c: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
}

/// Same for an async command. Tokio spawns from a runtime worker thread,
/// which lives as long as the runtime, so on Linux the child is also tied to
/// NEXUS with `PR_SET_PDEATHSIG`.
pub fn prepare_tokio(c: &mut tokio::process::Command) {
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    #[cfg(unix)]
    c.process_group(0);
    #[cfg(target_os = "linux")]
    {
        let parent = std::process::id() as libc::pid_t;
        // SAFETY: the closure only makes async-signal-safe calls.
        unsafe {
            c.pre_exec(move || linux::die_with_parent(parent));
        }
    }
}

/// Spawns a long-lived child that must not outlive NEXUS. On Linux the fork
/// happens on a dedicated thread with `PR_SET_PDEATHSIG`; elsewhere this is
/// a plain spawn (Windows callers add the child to the app job object).
pub fn spawn_tied(mut c: Command) -> io::Result<Child> {
    prepare_std(&mut c);
    #[cfg(target_os = "linux")]
    {
        linux::spawn_on_spawner_thread(c)
    }
    #[cfg(not(target_os = "linux"))]
    {
        c.spawn()
    }
}

/// Whether a process with this pid exists (zombies count as gone).
pub fn pid_alive(pid: u32) -> bool {
    pid != 0 && imp::alive(pid)
}

/// The process table (empty when it cannot be read).
pub fn list() -> Vec<ProcEntry> {
    imp::list()
}

/// Direct and indirect children of `pid`, parents before children.
pub fn descendants(table: &[ProcEntry], pid: u32) -> Vec<ProcEntry> {
    let mut out: Vec<ProcEntry> = Vec::new();
    let mut frontier = vec![pid];
    while let Some(p) = frontier.pop() {
        for e in table.iter().filter(|e| e.ppid == p && e.pid != p && e.pid != pid) {
            if !out.iter().any(|o| o.pid == e.pid) {
                frontier.push(e.pid);
                out.push(e.clone());
            }
        }
    }
    out
}

/// Stops a process and all of its descendants. `force` kills at once
/// (`taskkill /F`, `SIGKILL`); otherwise the processes are asked to exit
/// (`taskkill` without `/F`, `SIGTERM`). Returns whether the request reached
/// the process.
pub fn kill_tree(pid: u32, force: bool) -> bool {
    if pid == 0 || pid == std::process::id() {
        return false;
    }
    imp::kill_tree(pid, force)
}

/// Running as root / an elevated administrator: NEXUS never installs or
/// registers services in that state.
pub fn is_root() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions.
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// `/proc/<pid>/stat` fields NEXUS uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcStat {
    pub pid: u32,
    pub name: String,
    pub state: char,
    pub ppid: u32,
    /// user + system time, in clock ticks.
    pub cpu_ticks: u64,
    /// Start time after boot, in clock ticks.
    pub start_ticks: u64,
}

/// Parses `/proc/<pid>/stat`. The name is in parentheses and may itself
/// contain spaces or parentheses, so the fields are read after the last `)`.
pub fn parse_proc_stat(text: &str) -> Option<ProcStat> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let pid = text[..open].trim().parse().ok()?;
    let name = text[open + 1..close].to_string();
    let f: Vec<&str> = text[close + 1..].split_whitespace().collect();
    // f[0] is field 3 (state): field N is f[N - 3].
    let num = |i: usize| f.get(i).and_then(|v| v.parse::<u64>().ok());
    Some(ProcStat {
        pid,
        name,
        state: f.first()?.chars().next()?,
        ppid: num(1)? as u32,
        cpu_ticks: num(11)? + num(12)?,
        start_ticks: num(19)?,
    })
}

/// Boot time (`btime` in `/proc/stat`), seconds since the Unix epoch.
pub fn parse_boot_time(proc_stat: &str) -> Option<u64> {
    proc_stat.lines().find_map(|l| l.strip_prefix("btime ")).and_then(|v| v.trim().parse().ok())
}

/// Creation time (ms since the epoch) and CPU time (ms) of a live process,
/// from `/proc` on Linux. `None` elsewhere or when the process is gone.
pub fn times(pid: u32) -> Option<(Option<u64>, Option<u64>)> {
    #[cfg(target_os = "linux")]
    {
        linux::times(pid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

/// The command line of a process (`/proc/<pid>/cmdline`), Linux only.
pub fn command_line(pid: u32) -> Option<String> {
    if cfg!(target_os = "linux") {
        let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        let parts: Vec<String> =
            raw.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect();
        (!parts.is_empty()).then(|| parts.join(" "))
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::io;
    use std::process::{Child, Command};
    use std::sync::mpsc;
    use std::sync::{Mutex, OnceLock};

    /// In the forked child, before exec: die when NEXUS dies. If NEXUS is
    /// already gone (it died between fork and here), exit now.
    pub fn die_with_parent(parent: libc::pid_t) -> io::Result<()> {
        // SAFETY: prctl, getppid and raise are async-signal-safe.
        unsafe {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                libc::raise(libc::SIGKILL);
            }
        }
        Ok(())
    }

    type Job = (Command, mpsc::Sender<io::Result<Child>>);

    fn spawner() -> Option<&'static Mutex<mpsc::Sender<Job>>> {
        static SPAWNER: OnceLock<Option<Mutex<mpsc::Sender<Job>>>> = OnceLock::new();
        SPAWNER
            .get_or_init(|| {
                let (tx, rx) = mpsc::channel::<Job>();
                std::thread::Builder::new()
                    .name("nexus-spawner".into())
                    .spawn(move || {
                        for (mut c, back) in rx {
                            let _ = back.send(c.spawn());
                        }
                    })
                    .ok()
                    .map(|_| Mutex::new(tx))
            })
            .as_ref()
    }

    pub fn spawn_on_spawner_thread(mut c: Command) -> io::Result<Child> {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id() as libc::pid_t;
        // SAFETY: the closure only makes async-signal-safe calls.
        unsafe {
            c.pre_exec(move || die_with_parent(parent));
        }
        let Some(spawner) = spawner() else {
            // No thread could be started: spawn here (still tied while this thread lives).
            return c.spawn();
        };
        let (tx, rx) = mpsc::channel();
        spawner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .send((c, tx))
            .map_err(|_| io::Error::other("spawner gone"))?;
        rx.recv().map_err(|_| io::Error::other("spawner gone"))?
    }

    fn clock_ticks() -> u64 {
        // SAFETY: sysconf has no preconditions.
        let t = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if t > 0 {
            t as u64
        } else {
            100
        }
    }

    pub fn times(pid: u32) -> Option<(Option<u64>, Option<u64>)> {
        let stat = super::parse_proc_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)?;
        if matches!(stat.state, 'Z' | 'X') {
            return None;
        }
        let hz = clock_ticks();
        let boot = std::fs::read_to_string("/proc/stat").ok().and_then(|t| super::parse_boot_time(&t));
        let created = boot.map(|b| b * 1000 + stat.start_ticks * 1000 / hz);
        Some((created, Some(stat.cpu_ticks * 1000 / hz)))
    }
}

#[cfg(windows)]
mod imp {
    use super::ProcEntry;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, STILL_ACTIVE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    pub fn alive(pid: u32) -> bool {
        // SAFETY: plain Win32 calls on a handle closed before returning.
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

    pub fn list() -> Vec<ProcEntry> {
        let mut out = Vec::new();
        // SAFETY: the snapshot handle is closed before returning.
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

    pub fn kill_tree(pid: u32, force: bool) -> bool {
        let mut c = std::process::Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T"]);
        if force {
            c.arg("/F");
        }
        super::prepare_std(&mut c);
        c.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
}

#[cfg(unix)]
mod imp {
    use super::ProcEntry;

    pub fn alive(pid: u32) -> bool {
        if let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            return super::parse_proc_stat(&text).is_some_and(|s| !matches!(s.state, 'Z' | 'X'));
        }
        if std::path::Path::new("/proc/self").exists() {
            return false;
        }
        // No procfs (macOS): signal 0 only checks for existence.
        // SAFETY: kill with signal 0 sends nothing.
        let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
        r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    pub fn list() -> Vec<ProcEntry> {
        let Ok(rd) = std::fs::read_dir("/proc") else { return Vec::new() };
        rd.flatten()
            .filter_map(|e| {
                e.file_name().to_string_lossy().parse::<u32>().ok()?;
                let stat = super::parse_proc_stat(&std::fs::read_to_string(e.path().join("stat")).ok()?)?;
                Some(ProcEntry { pid: stat.pid, ppid: stat.ppid, name: stat.name })
            })
            .collect()
    }

    pub fn kill_tree(pid: u32, force: bool) -> bool {
        let sig = if force { libc::SIGKILL } else { libc::SIGTERM };
        let kids = super::descendants(&list(), pid);
        // SAFETY: plain signal delivery; pids come from the live table.
        unsafe {
            let target = pid as libc::pid_t;
            // NEXUS starts children as group leaders: one call reaches the group.
            if libc::getpgid(target) == target {
                libc::killpg(target, sig);
            }
            // Children that left the group (setsid, their own groups), deepest first.
            for k in kids.iter().rev() {
                libc::kill(k.pid as libc::pid_t, sig);
            }
            libc::kill(target, sig) == 0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proc_stat_with_odd_names() {
        let s = parse_proc_stat(
            "4242 (node (convex) x) S 4200 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 11 0 123456 1000 10 18446744073709551615",
        )
        .unwrap();
        assert_eq!(s.pid, 4242);
        assert_eq!(s.name, "node (convex) x");
        assert_eq!(s.state, 'S');
        assert_eq!(s.ppid, 4200);
        assert_eq!(s.cpu_ticks, 300);
        assert_eq!(s.start_ticks, 123456);
        assert!(parse_proc_stat("garbage").is_none());
        assert_eq!(parse_boot_time("cpu 1 2 3\nbtime 1760000000\nprocesses 9\n"), Some(1_760_000_000));
    }

    #[test]
    fn descendants_walk_the_tree() {
        let e = |pid, ppid| ProcEntry { pid, ppid, name: String::new() };
        let t = vec![e(10, 1), e(11, 10), e(12, 11), e(13, 1), e(14, 10)];
        let d: Vec<u32> = descendants(&t, 10).iter().map(|p| p.pid).collect();
        assert_eq!(d.len(), 3);
        assert!(d.contains(&11) && d.contains(&12) && d.contains(&14));
        let pos = |p| d.iter().position(|x| *x == p).unwrap();
        assert!(pos(11) < pos(12), "parents come before their children");
    }

    #[test]
    fn own_process_is_alive_and_absent_ones_are_not() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0));
        assert!(!pid_alive(0xFFFF_FFF1));
        assert!(list().iter().any(|p| p.pid == std::process::id()));
        assert!(!kill_tree(std::process::id(), true), "never kills itself");
        if cfg!(target_os = "linux") {
            let (created, cpu) = times(std::process::id()).unwrap();
            assert!(created.is_some() && cpu.is_some());
            assert!(command_line(std::process::id()).is_some());
        }
    }

    fn sleeper() -> Command {
        if cfg!(windows) {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"]);
            c
        } else {
            // A shell with a child of its own: the whole tree must go.
            let mut c = Command::new("sh");
            c.args(["-c", "sleep 60 & sleep 60; wait"]);
            c
        }
    }

    #[test]
    fn kills_a_whole_tree() {
        let mut child = spawn_tied(sleeper()).unwrap();
        let pid = child.id();
        std::thread::sleep(std::time::Duration::from_millis(400));
        let kids: Vec<u32> = descendants(&list(), pid).iter().map(|k| k.pid).collect();
        assert!(pid_alive(pid));
        assert!(kill_tree(pid, true));
        let _ = child.wait();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while kids.iter().any(|k| pid_alive(*k)) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(!pid_alive(pid));
        assert!(kids.iter().all(|k| !pid_alive(*k)), "descendants survived: {kids:?}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn tied_children_get_their_own_group() {
        let mut child = spawn_tied(sleeper()).unwrap();
        let pid = child.id() as libc::pid_t;
        // SAFETY: getpgid only reads.
        assert_eq!(unsafe { libc::getpgid(pid) }, pid);
        kill_tree(child.id(), true);
        let _ = child.wait();
    }
}
