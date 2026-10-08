//! Process helpers: hidden console windows and a kill-on-close job object on
//! Windows, process groups and parent-death signals on Linux (see
//! `pcc_platform::process`), and process-tree termination on both.

use std::process::Stdio;

/// Builds a command that never flashes a console window on Windows.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(program);
    c.stdin(Stdio::null()).kill_on_drop(true);
    pcc_platform::process::prepare_tokio(&mut c);
    c
}

/// Blocking variant for short synchronous calls.
pub fn std_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut c = std::process::Command::new(program);
    c.stdin(Stdio::null());
    pcc_platform::process::prepare_std(&mut c);
    c
}

/// Places the process in a job object that kills it (and its children) when
/// the application exits, even on a crash. On Linux the same guarantee comes
/// from `PR_SET_PDEATHSIG`, set when the command is built ([`command`]) or
/// spawned (`pcc_platform::process::spawn_tied`): nothing to do here.
pub fn attach_to_app_job(child: &tokio::process::Child) {
    #[cfg(windows)]
    win::attach(child);
    #[cfg(not(windows))]
    let _ = child;
}

/// Same as [`attach_to_app_job`] for a process known only by its pid.
pub fn attach_pid_to_app_job(pid: u32) {
    #[cfg(windows)]
    win::attach_pid(pid);
    #[cfg(not(windows))]
    let _ = pid;
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
        pcc_platform::process::kill_tree(pid, true);
    }
}

/// Whether a process with this pid currently exists.
pub fn pid_alive(pid: u32) -> bool {
    pcc_platform::process::pid_alive(pid)
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

    pub fn attach_pid(pid: u32) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
        let Some(job) = job() else { return };
        unsafe {
            let h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if h.is_null() {
                return;
            }
            if AssignProcessToJobObject(job as _, h) == 0 {
                tracing::warn!("could not assign process {pid} to job object");
            }
            CloseHandle(h);
        }
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
