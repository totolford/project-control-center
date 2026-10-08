//! Hardware detection: CPU, RAM, GPU (name, vendor, VRAM), CUDA, Vulkan, free
//! disk space where models are stored, OS. Everything is read from the
//! machine; a value that cannot be read stays `None` instead of being guessed.
//!
//! GPUs: `nvidia-smi` (NVIDIA, both OSes), then WMI on Windows; on Linux
//! `rocm-smi` (AMD) and the DRM devices in `/sys/class/drm` (any vendor,
//! named through `lspci`). No GPU found means CPU-only inference.

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

/// Models folder of Ollama's Linux system service (official install script).
pub const OLLAMA_SERVICE_MODELS: &str = "/usr/share/ollama/.ollama/models";

/// Ollama's models folder: `OLLAMA_MODELS`, else the folder chosen in the
/// Ollama desktop app's settings (Windows), else `~/.ollama/models`; on Linux
/// the system service's folder when only that one exists.
pub fn models_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("OLLAMA_MODELS").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    if let Some(p) = ollama_app_models_dir() {
        return p;
    }
    let user = pcc_platform::paths::home_dir().join(".ollama").join("models");
    if cfg!(target_os = "linux") && !user.is_dir() && Path::new(OLLAMA_SERVICE_MODELS).is_dir() {
        return PathBuf::from(OLLAMA_SERVICE_MODELS);
    }
    user
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
#[cfg_attr(not(windows), allow(dead_code))]
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

#[cfg(windows)]
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

/// Parses `rocm-smi --showproductname --showmeminfo vram --json`.
pub fn parse_rocm_smi_json(text: &str) -> Vec<Gpu> {
    let Ok(serde_json::Value::Object(cards)) = serde_json::from_str::<serde_json::Value>(text) else {
        return vec![];
    };
    let mut keys: Vec<&String> = cards.keys().filter(|k| k.starts_with("card")).collect();
    keys.sort();
    keys.into_iter()
        .filter_map(|k| {
            let c = cards[k].as_object()?;
            let field = |names: &[&str]| {
                names.iter().find_map(|n| {
                    c.iter()
                        .find(|(key, _)| key.eq_ignore_ascii_case(n))
                        .and_then(|(_, v)| v.as_str())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                })
            };
            let name = field(&["Card Series", "Card SKU", "Card model"])?;
            let vram = field(&["VRAM Total Memory (B)"]).and_then(|b| b.parse::<u64>().ok()).map(|b| b / (1024 * 1024));
            Some(Gpu {
                name,
                vendor: "AMD".into(),
                vram_mb: vram,
                vram_source: "rocm-smi".into(),
                driver: field(&["Driver version"]),
            })
        })
        .collect()
}

/// Vendor and device names from one `lspci -mm` line
/// (`00:02.0 "VGA compatible controller" "Intel Corporation" "Alder Lake [Iris Xe]" -r0c …`).
pub fn parse_lspci_mm(line: &str) -> Option<(String, String)> {
    let quoted: Vec<&str> = line.split('"').skip(1).step_by(2).collect();
    match quoted.as_slice() {
        [_, vendor, device, ..] if !device.is_empty() => Some((vendor.to_string(), device.to_string())),
        _ => None,
    }
}

fn vendor_name(pci_vendor: &str) -> Option<&'static str> {
    match pci_vendor.trim().to_ascii_lowercase().as_str() {
        "0x10de" => Some("NVIDIA"),
        "0x1002" => Some("AMD"),
        "0x8086" => Some("Intel"),
        _ => None,
    }
}

/// GPUs from a `/sys/class/drm`-shaped folder: every `cardN` whose PCI device
/// is a known GPU vendor. `name_of` resolves a PCI slot to a marketing name.
pub fn gpus_from_drm(drm: &Path, name_of: &dyn Fn(&str) -> Option<String>) -> Vec<Gpu> {
    let Ok(rd) = std::fs::read_dir(drm) else { return vec![] };
    let mut cards: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            n.strip_prefix("card").is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
        })
        .collect();
    cards.sort();
    let mut out: Vec<Gpu> = Vec::new();
    let mut slots: Vec<String> = Vec::new();
    for card in cards {
        let dev = card.join("device");
        let read = |f: &str| std::fs::read_to_string(dev.join(f)).ok().map(|s| s.trim().to_string());
        let Some(vendor) = read("vendor").as_deref().and_then(vendor_name) else { continue };
        let slot = read("uevent")
            .and_then(|u| u.lines().find_map(|l| l.strip_prefix("PCI_SLOT_NAME=").map(str::to_string)))
            .unwrap_or_default();
        if !slot.is_empty() {
            if slots.contains(&slot) {
                continue;
            }
            slots.push(slot.clone());
        }
        let device_id = read("device").unwrap_or_default();
        let name = name_of(&slot).unwrap_or_else(|| format!("{vendor} GPU (PCI {device_id})"));
        let driver = std::fs::read_link(dev.join("driver"))
            .ok()
            .and_then(|l| l.file_name().map(|n| n.to_string_lossy().into_owned()));
        let vram = read("mem_info_vram_total").and_then(|b| b.parse::<u64>().ok()).map(|b| b / (1024 * 1024));
        out.push(Gpu {
            name,
            vendor: vendor.into(),
            vram_source: match (vram, vendor) {
                (Some(_), _) => "sysfs (amdgpu)".into(),
                (None, "Intel") => "shared system memory".into(),
                _ => "sysfs (VRAM not reported by the driver)".into(),
            },
            vram_mb: vram,
            driver,
        });
    }
    out
}

/// Adds the GPUs a generic source found for vendors the exact tools
/// (nvidia-smi, rocm-smi) did not cover.
fn merge_by_vendor(mut exact: Vec<Gpu>, generic: Vec<Gpu>) -> Vec<Gpu> {
    let covered: Vec<String> = exact.iter().map(|g| g.vendor.to_ascii_lowercase()).collect();
    exact.extend(generic.into_iter().filter(|g| !covered.contains(&g.vendor.to_ascii_lowercase())));
    exact
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
fn lspci_name(slot: &str) -> Option<String> {
    if slot.is_empty() {
        return None;
    }
    let out = std_command("lspci").args(["-mm", "-s", slot]).output().ok()?;
    let (vendor, device) = parse_lspci_mm(String::from_utf8_lossy(&out.stdout).lines().next()?)?;
    let vendor = vendor.trim_end_matches(" Corporation").trim_end_matches(", Inc.").to_string();
    Some(if device.contains(&vendor) { device } else { format!("{vendor} {device}") })
}

#[cfg(not(windows))]
fn linux_gpus(info: &mut HardwareInfo) -> Vec<Gpu> {
    let rocm = match std_command("rocm-smi").args(["--showproductname", "--showmeminfo", "vram", "--json"]).output() {
        Ok(o) if o.status.success() => parse_rocm_smi_json(&String::from_utf8_lossy(&o.stdout)),
        _ => vec![],
    };
    let drm = gpus_from_drm(Path::new("/sys/class/drm"), &lspci_name);
    if drm.iter().any(|g| g.vendor == "AMD" && g.vram_mb.is_none()) && rocm.is_empty() {
        info.notes.push("AMD GPU found but rocm-smi did not answer: VRAM unknown".into());
    }
    merge_by_vendor(rocm, drm)
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
        // Physical cores: distinct (physical id, core id) pairs.
        let mut cores = std::collections::BTreeSet::new();
        let mut phys = String::new();
        for l in t.lines() {
            if let Some(v) = l.strip_prefix("physical id").and_then(|r| r.split(':').nth(1)) {
                phys = v.trim().to_string();
            } else if let Some(v) = l.strip_prefix("core id").and_then(|r| r.split(':').nth(1)) {
                cores.insert((phys.clone(), v.trim().to_string()));
            }
        }
        info.cpu_cores = (!cores.is_empty()).then_some(cores.len() as u32);
    }
    if let Some(r) = pcc_platform::os_release() {
        info.os = if pcc_platform::is_wsl() { format!("{} (WSL)", r.pretty_name) } else { r.pretty_name };
    }
    let dir = models.ancestors().find(|p| p.exists()).unwrap_or(Path::new("/"));
    if let Ok(o) = std_command("df").arg("-Pk").arg(dir).output() {
        let text = String::from_utf8_lossy(&o.stdout);
        if let Some(cols) = text.lines().nth(1).map(|l| l.split_whitespace().collect::<Vec<_>>()) {
            info.disk_total_mb = cols.get(1).and_then(|n| n.parse::<u64>().ok()).map(|k| k / 1024);
            info.disk_free_mb = cols.get(3).and_then(|n| n.parse::<u64>().ok()).map(|k| k / 1024);
        }
    }
    linux_gpus(info)
}

/// Blocking: runs nvidia-smi and one PowerShell/WMI query on Windows, or
/// rocm-smi, lspci and `/proc` / `/sys` reads on Linux (a few seconds).
pub fn detect() -> HardwareInfo {
    let models = models_dir();
    let mut info = HardwareInfo {
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        models_dir: models.display().to_string(),
        vulkan: vulkan_present(),
        ..Default::default()
    };
    let os_gpus = system(&models, &mut info);
    let (nv, cuda) = nvidia();
    if nv.is_empty() && os_gpus.iter().any(|g| g.vendor.to_ascii_lowercase().contains("nvidia")) {
        info.notes.push(if cfg!(windows) {
            "NVIDIA GPU found but nvidia-smi did not answer: VRAM comes from WMI (max 4 GB shown)".into()
        } else {
            "NVIDIA GPU found but nvidia-smi did not answer: install the NVIDIA driver (ubuntu-drivers) for CUDA".into()
        });
    }
    info.cuda = cuda;
    info.gpus = if cfg!(windows) { merge_gpus(nv, os_gpus) } else { merge_by_vendor(nv, os_gpus) };
    if info.gpus.is_empty() {
        info.notes.push("No GPU detected: local models run on the CPU".into());
    }
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

    #[test]
    fn parses_rocm_smi() {
        let j = r#"{"card0": {"Card Series": "Radeon RX 7900 XTX", "Card model": "0x744c", "VRAM Total Memory (B)": "25753026560", "VRAM Total Used Memory (B)": "1"}, "system": {}}"#;
        let g = parse_rocm_smi_json(j);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].name, "Radeon RX 7900 XTX");
        assert_eq!(g[0].vram_mb, Some(24560));
        assert_eq!(g[0].vendor, "AMD");
        assert!(parse_rocm_smi_json("not json").is_empty());
    }

    #[test]
    fn parses_lspci_machine_format() {
        let l = r#"00:02.0 "VGA compatible controller" "Intel Corporation" "Alder Lake-P GT2 [Iris Xe Graphics]" -r0c -p00 "Dell" "Device 0b19""#;
        assert_eq!(parse_lspci_mm(l), Some(("Intel Corporation".into(), "Alder Lake-P GT2 [Iris Xe Graphics]".into())));
        assert_eq!(parse_lspci_mm("garbage"), None);
    }

    #[test]
    fn reads_gpus_from_a_drm_tree() {
        let d = tempfile::tempdir().unwrap();
        let card = |n: &str, vendor: &str, slot: &str, vram: Option<&str>| {
            let dev = d.path().join(n).join("device");
            std::fs::create_dir_all(&dev).unwrap();
            std::fs::write(dev.join("vendor"), format!("{vendor}\n")).unwrap();
            std::fs::write(dev.join("device"), "0x744c\n").unwrap();
            std::fs::write(dev.join("uevent"), format!("DRIVER=x\nPCI_SLOT_NAME={slot}\n")).unwrap();
            if let Some(v) = vram {
                std::fs::write(dev.join("mem_info_vram_total"), v).unwrap();
            }
        };
        card("card0", "0x8086", "0000:00:02.0", None);
        card("card1", "0x1002", "0000:03:00.0", Some("17163091968"));
        card("card2", "0x1af4", "0000:00:05.0", None); // virtio: not a GPU vendor we know
        std::fs::create_dir_all(d.path().join("card1-DP-1")).unwrap(); // a connector, ignored
        let names = |slot: &str| (slot == "0000:03:00.0").then(|| "AMD Radeon RX 7800 XT".to_string());
        let g = gpus_from_drm(d.path(), &names);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].vendor, "Intel");
        assert_eq!(g[0].vram_source, "shared system memory");
        assert_eq!(g[0].name, "Intel GPU (PCI 0x744c)");
        assert_eq!(g[1].name, "AMD Radeon RX 7800 XT");
        assert_eq!(g[1].vram_mb, Some(16368));
        // nvidia-smi / rocm-smi entries win for their vendor.
        let rocm = parse_rocm_smi_json(r#"{"card0":{"Card Series":"RX","VRAM Total Memory (B)":"1048576"}}"#);
        let merged = merge_by_vendor(rocm, g);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].vram_source, "rocm-smi");
        assert_eq!(merged[1].vendor, "Intel");
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
