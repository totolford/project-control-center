//! Process helpers: hidden console windows, a kill-on-close job object and
//! process-tree termination on Windows.

use std::process::Stdio;

/// Builds a command that never flashes a console window on Windows.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(program);
    c.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Blocking variant for short synchronous calls.
pub fn std_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut c = std::process::Command::new(program);
    c.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Places the process in a job object that kills it (and its children) when
/// the application exits, even on a crash. No-op outside Windows.
pub fn attach_to_app_job(child: &tokio::process::Child) {
    #[cfg(windows)]
    win::attach(child);
    #[cfg(not(windows))]
    let _ = child;
}

/// Kills a process and all of its descendants.
pub async fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    #[cfg(not(windows))]
    {
        let _ = command("kill").args(["-9", &pid.to_string()]).status().await;
    }
}

/// Whether a process with this pid currently exists.
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        std_command("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
}

#[cfg(windows)]
mod win {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// The job handle lives for the whole process; the OS closes it on exit,
    /// which terminates every assigned session.
    static JOB: OnceLock<usize> = OnceLock::new();

    fn job() -> Option<usize> {
        let h = *JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return 0;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            job as usize
        });
        (h != 0).then_some(h)
    }

    pub fn attach(child: &tokio::process::Child) {
        let (Some(job), Some(handle)) = (job(), child.raw_handle()) else {
            return;
        };
        unsafe {
            if AssignProcessToJobObject(job as _, handle as _) == 0 {
                tracing::warn!("could not assign session process to job object");
            }
        }
    }
}
