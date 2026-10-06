//! Hardware detection: CPU, RAM, GPU (name, vendor, VRAM), CUDA, Vulkan, free
//! disk space where models are stored, OS. Everything is read from the
//! machine; a value that cannot be read stays `None` instead of being guessed.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use pcc_claude::process::std_command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub name: String,
    pub vendor: String,
    /// Dedicated video memory in MiB.
    pub vram_mb: Option<u64>,
    /// Where the VRAM figure comes from (`nvidia-smi`, or WMI which caps at 4 GB).
    pub vram_source: String,
    pub driver: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub cpu: Option<String>,
    pub cpu_cores: Option<u32>,
    pub cpu_threads: Option<u32>,
    pub ram_total_mb: Option<u64>,
    pub ram_free_mb: Option<u64>,
    pub gpus: Vec<Gpu>,
    /// CUDA version reported by the NVIDIA driver (`nvidia-smi`).
    pub cuda: Option<String>,
    /// The Vulkan loader is installed.
    pub vulkan: bool,
    pub os: String,
    pub arch: String,
    /// Folder where local models are stored (Ollama's models folder).
    pub models_dir: String,
    pub disk_free_mb: Option<u64>,
    pub disk_total_mb: Option<u64>,
    /// Things that could not be detected, with the reason.
    pub notes: Vec<String>,
}

impl HardwareInfo {
    /// The GPU with the most VRAM (the one local runtimes would use).
    pub fn best_gpu(&self) -> Option<&Gpu> {
        self.gpus.iter().filter(|g| g.vram_mb.is_some()).max_by_key(|g| g.vram_mb.unwrap_or(0))
    }

    pub fn vram_mb(&self) -> Option<u64> {
        self.best_gpu().and_then(|g| g.vram_mb)
    }
}

/// Ollama's models folder: `OLLAMA_MODELS`, else the folder chosen in the
/// Ollama desktop app's settings, else `~/.ollama/models`.
pub fn models_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("OLLAMA_MODELS").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    if let Some(p) = ollama_app_models_dir() {
        return p;
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    home.unwrap_or_else(std::env::temp_dir).join(".ollama").join("models")
}

/// Models folder set in the Ollama app ("Model location"), stored in
/// `%LOCALAPPDATA%\Ollama\db.sqlite` (`settings.models`). The tray app passes
/// it to its server as `OLLAMA_MODELS`; a server NEXUS starts must do the same
/// or it would see no models.
pub fn ollama_app_models_dir() -> Option<PathBuf> {
    let db = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?.join("Ollama").join("db.sqlite");
    read_app_models_setting(&db)
}

fn read_app_models_setting(db: &Path) -> Option<PathBuf> {
    if !db.is_file() {
        return None;
    }
    let conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let dir: String = conn.query_row("SELECT models FROM settings WHERE id = 1", [], |r| r.get(0)).ok()?;
    let dir = dir.trim();
    (!dir.is_empty()).then(|| PathBuf::from(dir))
}

/// Parses `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits`.
pub fn parse_nvidia_query(text: &str) -> Vec<Gpu> {
    text.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split(',').map(str::trim).collect();
            if cols.len() < 2 || cols[0].is_empty() {
                return None;
            }
            Some(Gpu {
                name: cols[0].to_string(),
                vendor: "NVIDIA".into(),
                vram_mb: cols[1].parse().ok(),
                vram_source: "nvidia-smi".into(),
                driver: cols.get(2).filter(|d| !d.is_empty()).map(|d| d.to_string()),
            })
        })
        .collect()
}

/// CUDA version from the `nvidia-smi` banner ("CUDA Version: 12.4" or "CUDA UMD Version: 13.3").
pub fn parse_cuda_version(banner: &str) -> Option<String> {
    let re = regex::Regex::new(r"CUDA (?:UMD )?Version:\s*([0-9]+(?:\.[0-9]+)*)").ok()?;
    re.captures(banner).map(|c| c[1].to_string())
}

/// GPUs from WMI (`Win32_VideoController`). `AdapterRAM` is a 32-bit value:
/// anything at or above 4 GB is reported as ~4 GB, so it is marked as a lower bound.
fn gpus_from_wmi(v: &serde_json::Value) -> Vec<Gpu> {
    let list = match v {
        serde_json::Value::Array(a) => a.clone(),
        serde_json::Value::Null => vec![],
        other => vec![other.clone()],
    };
    list.iter()
        .filter_map(|g| {
            let name = g["name"].as_str()?.trim().to_string();
            let ram = g["adapterRam"].as_u64().filter(|r| *r > 0).map(|r| r / (1024 * 1024));
            let capped = ram.is_some_and(|mb| mb >= 4095);
            Some(Gpu {
                vendor: g["vendor"].as_str().unwrap_or("").to_string(),
                vram_mb: ram,
                vram_source: if capped { "WMI (capped at 4 GB, real VRAM may be higher)".into() } else { "WMI".into() },
                driver: g["driver"].as_str().map(str::to_string),
                name,
            })
        })
        .collect()
}

fn mb(v: &serde_json::Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)).map(|b| b / (1024 * 1024))
}

fn nvidia() -> (Vec<Gpu>, Option<String>) {
    let query = std_command("nvidia-smi")
        .args(["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"])
        .output();
    let gpus = match query {
        Ok(o) if o.status.success() => parse_nvidia_query(&String::from_utf8_lossy(&o.stdout)),
        _ => return (vec![], None),
    };
    let cuda =
        std_command("nvidia-smi").output().ok().and_then(|o| parse_cuda_version(&String::from_utf8_lossy(&o.stdout)));
    (gpus, cuda)
}

fn vulkan_present() -> bool {
    if cfg!(windows) {
        let sys = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        sys.join("System32").join("vulkan-1.dll").is_file()
    } else {
        ["/usr/lib/x86_64-linux-gnu/libvulkan.so.1", "/usr/lib/libvulkan.so.1", "/usr/lib64/libvulkan.so.1"]
            .iter()
            .any(|p| Path::new(p).is_file())
    }
}

/// Merges WMI GPUs into the nvidia-smi list (nvidia-smi wins for NVIDIA cards).
fn merge_gpus(mut exact: Vec<Gpu>, wmi: Vec<Gpu>) -> Vec<Gpu> {
    for g in wmi {
        if !exact.iter().any(|e| e.name.eq_ignore_ascii_case(&g.name)) {
            exact.push(g);
        }
    }
    exact
}

#[cfg(windows)]
fn system(models: &Path, info: &mut HardwareInfo) -> Vec<Gpu> {
    let root = models
        .ancestors()
        .last()
        .map(|r| r.to_string_lossy().into_owned())
        .unwrap_or_else(|| "C:\\".into())
        .replace('\'', "");
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue';\
         $cs=Get-CimInstance Win32_ComputerSystem; $os=Get-CimInstance Win32_OperatingSystem;\
         $cpu=Get-CimInstance Win32_Processor | Select-Object -First 1;\
         $g=@(Get-CimInstance Win32_VideoController | ForEach-Object {{ [pscustomobject]@{{name=$_.Name;adapterRam=$_.AdapterRAM;driver=$_.DriverVersion;vendor=$_.AdapterCompatibility}} }});\
         $d=[System.IO.DriveInfo]::new('{root}');\
         [pscustomobject]@{{cpu=$cpu.Name;cores=$cpu.NumberOfCores;threads=$cpu.NumberOfLogicalProcessors;\
         ramTotal=$cs.TotalPhysicalMemory;ramFree=[int64]$os.FreePhysicalMemory*1024;os=$os.Caption;osVersion=$os.Version;\
         gpus=$g;diskFree=$d.AvailableFreeSpace;diskTotal=$d.TotalSize}} | ConvertTo-Json -Compress -Depth 4"
    );
    let out = std_command("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output();
    let v: serde_json::Value = match out {
        Ok(o) => serde_json::from_slice(&o.stdout).unwrap_or_default(),
        Err(e) => {
            info.notes.push(format!("PowerShell/WMI unavailable: {e}"));
            return vec![];
        }
    };
    if v.is_null() {
        info.notes.push("WMI returned nothing".into());
        return vec![];
    }
    info.cpu = v["cpu"].as_str().map(|s| s.trim().to_string());
    info.cpu_cores = v["cores"].as_u64().map(|n| n as u32);
    info.cpu_threads = v["threads"].as_u64().map(|n| n as u32);
    info.ram_total_mb = mb(&v["ramTotal"]);
    info.ram_free_mb = mb(&v["ramFree"]);
    info.disk_free_mb = mb(&v["diskFree"]);
    info.disk_total_mb = mb(&v["diskTotal"]);
    if let Some(os) = v["os"].as_str() {
        info.os = format!("{} {}", os.trim(), v["osVersion"].as_str().unwrap_or("")).trim().to_string();
    }
    gpus_from_wmi(&v["gpus"])
}

#[cfg(not(windows))]
fn system(models: &Path, info: &mut HardwareInfo) -> Vec<Gpu> {
    if let Ok(t) = std::fs::read_to_string("/proc/meminfo") {
        let field = |k: &str| {
            t.lines()
                .find(|l| l.starts_with(k))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|n| n.parse::<u64>().ok())
                .map(|kb| kb / 1024)
        };
        info.ram_total_mb = field("MemTotal:");
        info.ram_free_mb = field("MemAvailable:");
    }
    if let Ok(t) = std::fs::read_to_string("/proc/cpuinfo") {
        info.cpu =
            t.lines().find(|l| l.starts_with("model name")).and_then(|l| l.split(':').nth(1)).map(|s| s.trim().into());
        info.cpu_threads = Some(t.lines().filter(|l| l.starts_with("processor")).count() as u32);
    }
    let dir = models.ancestors().find(|p| p.exists()).unwrap_or(Path::new("/"));
    if let Ok(o) = std_command("df").arg("-Pk").arg(dir).output() {
        let text = String::from_utf8_lossy(&o.stdout);
        if let Some(cols) = text.lines().nth(1).map(|l| l.split_whitespace().collect::<Vec<_>>()) {
            info.disk_total_mb = cols.get(1).and_then(|n| n.parse::<u64>().ok()).map(|k| k / 1024);
            info.disk_free_mb = cols.get(3).and_then(|n| n.parse::<u64>().ok()).map(|k| k / 1024);
        }
    }
    vec![]
}

/// Blocking: runs nvidia-smi and one PowerShell/WMI query (a few seconds).
pub fn detect() -> HardwareInfo {
    let models = models_dir();
    let mut info = HardwareInfo {
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        models_dir: models.display().to_string(),
        vulkan: vulkan_present(),
        ..Default::default()
    };
    let wmi = system(&models, &mut info);
    let (nv, cuda) = nvidia();
    if nv.is_empty() && wmi.iter().any(|g| g.vendor.to_ascii_lowercase().contains("nvidia")) {
        info.notes.push("NVIDIA GPU found but nvidia-smi did not answer: VRAM comes from WMI (max 4 GB shown)".into());
    }
    info.cuda = cuda;
    info.gpus = merge_gpus(nv, wmi);
    if info.ram_total_mb.is_none() {
        info.notes.push("RAM size unknown".into());
    }
    if info.disk_free_mb.is_none() {
        info.notes.push("Free disk space unknown".into());
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nvidia_smi_query() {
        let gpus = parse_nvidia_query("NVIDIA GeForce RTX 4060 Ti, 8188, 610.88\r\n");
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].name, "NVIDIA GeForce RTX 4060 Ti");
        assert_eq!(gpus[0].vram_mb, Some(8188));
        assert_eq!(gpus[0].driver.as_deref(), Some("610.88"));
        assert!(parse_nvidia_query("").is_empty());
        let two = parse_nvidia_query("A100, 40960, 550.1\nRTX 3060, 12288, 550.1\n");
        assert_eq!(two.len(), 2);
    }

    #[test]
    fn parses_cuda_version_from_both_banners() {
        let new = "| NVIDIA-SMI 610.88                 KMD Version: 610.88        CUDA UMD Version: 13.3     |";
        assert_eq!(parse_cuda_version(new).as_deref(), Some("13.3"));
        let old = "| NVIDIA-SMI 551.86   Driver Version: 551.86   CUDA Version: 12.4     |";
        assert_eq!(parse_cuda_version(old).as_deref(), Some("12.4"));
        assert_eq!(parse_cuda_version("no gpu"), None);
    }

    #[test]
    fn wmi_vram_is_flagged_when_capped_and_nvidia_smi_wins() {
        let v: serde_json::Value = serde_json::from_str(
            r#"[{"name":"NVIDIA GeForce RTX 4060 Ti","adapterRam":4293918720,"driver":"32.0","vendor":"NVIDIA"},
                {"name":"spacedesk Graphics Adapter","adapterRam":null,"vendor":"datronicsoft"}]"#,
        )
        .unwrap();
        let wmi = gpus_from_wmi(&v);
        assert_eq!(wmi.len(), 2);
        assert!(wmi[0].vram_source.contains("capped"));
        assert_eq!(wmi[1].vram_mb, None);
        let merged = merge_gpus(parse_nvidia_query("NVIDIA GeForce RTX 4060 Ti, 8188, 610.88"), wmi);
        assert_eq!(merged.len(), 2);
        let info = HardwareInfo { gpus: merged, ..Default::default() };
        assert_eq!(info.vram_mb(), Some(8188));
        assert_eq!(info.best_gpu().unwrap().vram_source, "nvidia-smi");
    }

    #[test]
    fn reads_the_ollama_app_models_folder() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("db.sqlite");
        assert_eq!(read_app_models_setting(&db), None);
        let c = rusqlite::Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE settings (id INTEGER PRIMARY KEY, models TEXT NOT NULL DEFAULT '');").unwrap();
        c.execute("INSERT INTO settings (id, models) VALUES (1, '')", []).unwrap();
        assert_eq!(read_app_models_setting(&db), None);
        c.execute("UPDATE settings SET models = 'D:\\' WHERE id = 1", []).unwrap();
        drop(c);
        assert_eq!(read_app_models_setting(&db), Some(PathBuf::from("D:\\")));
    }

    /// Live: prints what this machine reports.
    #[test]
    #[ignore]
    fn live_detect() {
        let hw = detect();
        println!("{hw:#?}");
        assert!(hw.ram_total_mb.is_some());
    }
}
