//! Program lookup on PATH and the per-user folders, without spawning `where`
//! or `which` (one fewer process, and the same rules on every OS).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::platform;

/// First match of `name` on PATH. On Windows a bare name is tried with every
/// PATHEXT extension (`npm` finds `npm.cmd`); a name with a directory part is
/// checked as given.
pub fn find_program(name: &str) -> Option<PathBuf> {
    let p = platform();
    find_in(name, std::env::var_os("PATH").as_deref(), &p.path_extensions())
}

/// [`find_program`] with an explicit PATH and extension list (tests).
pub fn find_in(name: &str, path_var: Option<&OsStr>, extensions: &[String]) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    let given = Path::new(name);
    if given.components().count() > 1 || given.is_absolute() {
        return candidates(given, extensions).into_iter().find(|c| is_executable(c));
    }
    let path_var = path_var?;
    std::env::split_paths(path_var)
        .filter(|d| !d.as_os_str().is_empty())
        .flat_map(|dir| candidates(&dir.join(name), extensions))
        .find(|c| is_executable(c))
}

fn candidates(base: &Path, extensions: &[String]) -> Vec<PathBuf> {
    let has_ext = base
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase()))
        .is_some_and(|e| extensions.contains(&e));
    if extensions.is_empty() || has_ext {
        return vec![base.to_path_buf()];
    }
    extensions
        .iter()
        .map(|ext| {
            let mut s = base.as_os_str().to_os_string();
            s.push(ext);
            PathBuf::from(s)
        })
        .collect()
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

/// Whether a program is on PATH.
pub fn has_program(name: &str) -> bool {
    find_program(name).is_some()
}

/// `npm`, `npx`… as the launcher this OS uses (`npm.cmd` on Windows).
pub fn script(base: &str) -> String {
    platform().script_name(base)
}

/// The user's home folder (`%USERPROFILE%`, `$HOME`); the temp folder when unknown.
pub fn home_dir() -> PathBuf {
    platform().home_dir().unwrap_or_else(std::env::temp_dir)
}

/// Per-user, non-roamed application data (`%LOCALAPPDATA%`, `~/.local/share`).
pub fn local_data_dir() -> Option<PathBuf> {
    platform().local_data_dir()
}

/// Per-user configuration (`%APPDATA%`, `~/.config`).
pub fn config_dir() -> Option<PathBuf> {
    platform().config_dir()
}

/// `~/.ssh` (the same place on Windows' OpenSSH and on Linux).
pub fn ssh_dir() -> PathBuf {
    home_dir().join(".ssh")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn make_exec(p: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(p, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(not(unix))]
    fn make_exec(p: &Path) {
        std::fs::write(p, "").unwrap();
    }

    #[test]
    fn finds_programs_with_and_without_extensions() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        make_exec(&b.path().join("npm.cmd"));
        make_exec(&b.path().join("tool"));
        let path = std::env::join_paths([a.path(), b.path()]).unwrap();
        let win = vec![".exe".to_string(), ".cmd".to_string()];
        assert_eq!(find_in("npm", Some(&path), &win), Some(b.path().join("npm.cmd")));
        assert_eq!(find_in("npm.cmd", Some(&path), &win), Some(b.path().join("npm.cmd")));
        assert_eq!(find_in("tool", Some(&path), &[]), Some(b.path().join("tool")));
        assert_eq!(find_in("missing", Some(&path), &win), None);
        assert_eq!(find_in("tool", None, &[]), None);
        let full = b.path().join("tool");
        assert_eq!(find_in(&full.to_string_lossy(), None, &[]), Some(full));
    }

    #[cfg(unix)]
    #[test]
    fn skips_files_that_are_not_executable() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("data"), "x").unwrap();
        assert_eq!(find_in("data", Some(d.path().as_os_str()), &[]), None);
    }

    #[test]
    fn script_names_follow_the_os() {
        assert_eq!(script("npm"), if cfg!(windows) { "npm.cmd" } else { "npm" });
        assert!(home_dir().is_absolute());
    }
}
