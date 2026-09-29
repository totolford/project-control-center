//! Recently opened projects, stored in the application data directory.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use pcc_core::Result;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub name: String,
    pub root: String,
    pub last_opened: String,
    /// False when the folder or its `.agent-project` no longer exists.
    #[serde(default)]
    pub available: bool,
}

const MAX_RECENT: usize = 12;

pub fn load(file: &Path) -> Vec<RecentProject> {
    let mut list: Vec<RecentProject> =
        fs::read_to_string(file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    for p in &mut list {
        p.available = crate::Layout::exists(Path::new(&p.root));
    }
    list
}

pub fn touch(file: &Path, name: &str, root: &str) -> Result<Vec<RecentProject>> {
    let mut list = load(file);
    list.retain(|p| !same_path(&p.root, root));
    list.insert(
        0,
        RecentProject { name: name.to_string(), root: root.to_string(), last_opened: pcc_core::now(), available: true },
    );
    list.truncate(MAX_RECENT);
    crate::layout::write_json_atomic(file, &list)?;
    Ok(list)
}

pub fn remove(file: &Path, root: &str) -> Result<Vec<RecentProject>> {
    let mut list = load(file);
    list.retain(|p| !same_path(&p.root, root));
    crate::layout::write_json_atomic(file, &list)?;
    Ok(list)
}

fn same_path(a: &str, b: &str) -> bool {
    let n = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    n(a) == n(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touch_dedupes_and_orders() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("recent.json");
        touch(&f, "A", r"C:\p\a").unwrap();
        touch(&f, "B", r"C:\p\b").unwrap();
        let l = touch(&f, "A", r"c:/p/a/").unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].name, "A");
        assert_eq!(remove(&f, r"C:\p\b").unwrap().len(), 1);
    }
}
