//! Model catalog and hardware-based recommendations.
//!
//! Sizes are the exact download sizes of the Ollama registry manifests
//! (`registry.ollama.ai/v2/library/<name>/manifests/<tag>`, sum of layers),
//! context windows and capabilities come from the ollama.com library pages.
//! Verified on 2026-10-03.

use serde::Serialize;

use crate::hardware::HardwareInfo;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    Light,
    Standard,
    Advanced,
    Heavy,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    /// Ollama model reference (`name:tag`).
    pub id: &'static str,
    pub name: &'static str,
    pub family: &'static str,
    pub size_bytes: u64,
    /// Context window in tokens.
    pub context: u32,
    pub tools: bool,
    pub vision: bool,
    pub thinking: bool,
    pub embedding: bool,
    pub tier: Tier,
    /// What it is good at, in a few words.
    pub good_for: &'static str,
    /// Relative capability among chat models (higher is better); used to pick the best fitting one.
    pub quality: u8,
}

const GB: u64 = 1_000_000_000;

pub const CATALOG: &[CatalogModel] = &[
    CatalogModel {
        id: "qwen3:1.7b",
        name: "Qwen3 1.7B",
        family: "qwen3",
        size_bytes: 1_359_293_444,
        context: 40_960,
        tools: true,
        vision: false,
        thinking: true,
        embedding: false,
        tier: Tier::Light,
        good_for: "very small machines, quick NPC lines",
        quality: 2,
    },
    CatalogModel {
        id: "llama3.2:3b",
        name: "Llama 3.2 3B",
        family: "llama3.2",
        size_bytes: 2_019_393_189,
        context: 131_072,
        tools: true,
        vision: false,
        thinking: false,
        embedding: false,
        tier: Tier::Light,
        good_for: "summaries, short dialogue",
        quality: 3,
    },
    CatalogModel {
        id: "qwen3:4b",
        name: "Qwen3 4B",
        family: "qwen3",
        size_bytes: 2_497_293_931,
        context: 262_144,
        tools: true,
        vision: false,
        thinking: true,
        embedding: false,
        tier: Tier::Light,
        good_for: "AI Town simulation on modest GPUs, long context",
        quality: 4,
    },
    CatalogModel {
        id: "gemma3:4b",
        name: "Gemma 3 4B",
        family: "gemma3",
        size_bytes: 3_338_801_804,
        context: 131_072,
        tools: false,
        vision: true,
        thinking: false,
        embedding: false,
        tier: Tier::Light,
        good_for: "dialogue and image understanding (no tool calling)",
        quality: 4,
    },
    CatalogModel {
        id: "qwen2.5-coder:7b",
        name: "Qwen2.5 Coder 7B",
        family: "qwen2.5-coder",
        size_bytes: 4_683_087_561,
        context: 32_768,
        tools: true,
        vision: false,
        thinking: false,
        embedding: false,
        tier: Tier::Standard,
        good_for: "small code edits and explanations",
        quality: 5,
    },
    CatalogModel {
        id: "llama3.1:8b",
        name: "Llama 3.1 8B",
        family: "llama3.1",
        size_bytes: 4_920_753_328,
        context: 131_072,
        tools: true,
        vision: false,
        thinking: false,
        embedding: false,
        tier: Tier::Standard,
        good_for: "general chat with tool calling, long context",
        quality: 6,
    },
    CatalogModel {
        id: "llama3:8b",
        name: "Llama 3 8B",
        family: "llama3",
        size_bytes: 4_661_224_676,
        context: 8_192,
        tools: false,
        vision: false,
        thinking: false,
        embedding: false,
        tier: Tier::Standard,
        good_for: "AI Town's default dialogue model (no tool calling, 8K context)",
        quality: 3,
    },
    CatalogModel {
        id: "qwen3:8b",
        name: "Qwen3 8B",
        family: "qwen3",
        size_bytes: 5_225_388_164,
        context: 40_960,
        tools: true,
        vision: false,
        thinking: true,
        embedding: false,
        tier: Tier::Standard,
        good_for: "general reasoning, AI Town simulation, lightweight agents",
        quality: 7,
    },
    CatalogModel {
        id: "gemma3:12b",
        name: "Gemma 3 12B",
        family: "gemma3",
        size_bytes: 8_149_190_253,
        context: 131_072,
        tools: false,
        vision: true,
        thinking: false,
        embedding: false,
        tier: Tier::Advanced,
        good_for: "richer dialogue and vision (no tool calling)",
        quality: 7,
    },
    CatalogModel {
        id: "qwen3:14b",
        name: "Qwen3 14B",
        family: "qwen3",
        size_bytes: 9_276_198_565,
        context: 40_960,
        tools: true,
        vision: false,
        thinking: true,
        embedding: false,
        tier: Tier::Advanced,
        good_for: "stronger reasoning and agents",
        quality: 8,
    },
    CatalogModel {
        id: "qwen3-coder:30b",
        name: "Qwen3 Coder 30B",
        family: "qwen3-coder",
        size_bytes: 18_556_700_761,
        context: 262_144,
        tools: true,
        vision: false,
        thinking: false,
        embedding: false,
        tier: Tier::Heavy,
        good_for: "agentic coding (needs a large GPU or lots of RAM)",
        quality: 9,
    },
    CatalogModel {
        id: "mxbai-embed-large",
        name: "mxbai-embed-large",
        family: "mxbai-embed-large",
        size_bytes: 669_615_493,
        context: 512,
        tools: false,
        vision: false,
        thinking: false,
        embedding: true,
        tier: Tier::Light,
        good_for: "embeddings for AI Town memories (1024 dimensions, AI Town's default)",
        quality: 0,
    },
    CatalogModel {
        id: "nomic-embed-text",
        name: "nomic-embed-text",
        family: "nomic-embed-text",
        size_bytes: 274_302_450,
        context: 2_048,
        tools: false,
        vision: false,
        thinking: false,
        embedding: true,
        tier: Tier::Light,
        good_for: "embeddings (768 dimensions: not compatible with AI Town's 1024)",
        quality: 0,
    },
];

/// AI Town's default embedding model (1024 dimensions, `ai-town/convex/util/llm.ts`).
pub const AI_TOWN_EMBEDDING_MODEL: &str = "mxbai-embed-large";

pub fn find(id: &str) -> Option<&'static CatalogModel> {
    let bare = id.strip_suffix(":latest").unwrap_or(id);
    CATALOG.iter().find(|m| m.id == id || m.id == bare || (bare == "llama3" && m.id == "llama3:8b"))
}

/// Memory a model needs once loaded: weights plus ~20 % for the KV cache and runtime buffers.
pub fn memory_needed_mb(size_bytes: u64) -> u64 {
    size_bytes * 12 / 10 / (1024 * 1024)
}

/// Disk space kept free after a download.
pub const DISK_MARGIN_BYTES: u64 = 2 * GB;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Fit {
    /// Whole model in GPU memory: fast.
    Gpu,
    /// Split between GPU and RAM (or CPU only): works, slowly.
    Partial,
    /// Does not fit in GPU + RAM.
    TooLarge,
    /// Hardware unknown.
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelAssessment {
    pub model: CatalogModel,
    pub installed: bool,
    pub fit: Fit,
    /// Can be downloaded now (enough disk space, not installed).
    pub installable: bool,
    pub memory_needed_mb: u64,
    /// Why it is or is not offered.
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    /// One-line hardware summary.
    pub hardware: String,
    pub recommended: Option<String>,
    pub alternative: Option<String>,
    pub embedding: Option<String>,
    /// Human explanation (several lines).
    pub explanation: Vec<String>,
    pub models: Vec<ModelAssessment>,
}

fn gb(mb: u64) -> String {
    let g = mb as f64 / 1024.0;
    if g >= 10.0 {
        format!("{g:.0} GB")
    } else {
        format!("{g:.1} GB")
    }
}

fn is_installed(id: &str, installed: &[String]) -> bool {
    let norm = |s: &str| s.strip_suffix(":latest").unwrap_or(s).to_string();
    let want = norm(id);
    installed.iter().any(|i| {
        let have = norm(i);
        have == want || (want == "llama3:8b" && have == "llama3")
    })
}

pub fn assess(m: &CatalogModel, hw: &HardwareInfo, installed: &[String]) -> ModelAssessment {
    let need = memory_needed_mb(m.size_bytes);
    let is_in = is_installed(m.id, installed);
    let mut notes = Vec::new();
    let fit = match (hw.vram_mb(), hw.ram_total_mb) {
        (Some(v), _) if need <= v => Fit::Gpu,
        (v, Some(r)) if need <= v.unwrap_or(0) + r * 3 / 4 => Fit::Partial,
        (_, Some(_)) => Fit::TooLarge,
        (Some(_), None) => Fit::Partial,
        (None, None) => Fit::Unknown,
    };
    match fit {
        Fit::Gpu => notes.push(format!("Fits in GPU memory (needs ~{})", gb(need))),
        Fit::Partial => notes.push(format!("Needs ~{}: runs partly on CPU (slow)", gb(need))),
        Fit::TooLarge => notes.push(format!("Needs ~{}: more than GPU + RAM", gb(need))),
        Fit::Unknown => notes.push("Hardware unknown".into()),
    }
    let disk_ok = match hw.disk_free_mb {
        Some(free) => free * 1024 * 1024 >= m.size_bytes + DISK_MARGIN_BYTES,
        None => false,
    };
    if !is_in {
        match hw.disk_free_mb {
            Some(free) if !disk_ok => notes.push(format!(
                "Not enough disk space: {} download, {} free (2 GB kept free)",
                gb(m.size_bytes / (1024 * 1024)),
                gb(free)
            )),
            None => notes.push("Free disk space unknown: download not offered".into()),
            _ => {}
        }
    }
    if !m.tools && !m.embedding {
        notes.push("No tool calling: cannot run a NEXUS agent".into());
    }
    ModelAssessment {
        model: m.clone(),
        installed: is_in,
        fit,
        installable: !is_in && disk_ok && fit != Fit::TooLarge,
        memory_needed_mb: need,
        notes,
    }
}

/// Usable now or after a download.
fn available(a: &ModelAssessment) -> bool {
    a.installed || a.installable
}

pub fn hardware_summary(hw: &HardwareInfo) -> String {
    let mut parts = Vec::new();
    match hw.best_gpu() {
        Some(g) => parts.push(format!(
            "{}, {} VRAM",
            g.name.trim_start_matches("NVIDIA ").trim_start_matches("GeForce "),
            g.vram_mb.map(gb).unwrap_or_else(|| "unknown".into())
        )),
        None => parts.push("no dedicated GPU detected".into()),
    }
    if let Some(r) = hw.ram_total_mb {
        parts.push(format!("{} RAM", gb(r)));
    }
    if let Some(d) = hw.disk_free_mb {
        parts.push(format!("{} free disk", gb(d)));
    }
    parts.join(", ")
}

/// Picks a model for AI Town and lightweight agents, an alternative and an
/// embedding model, and explains the choice.
pub fn recommend(hw: &HardwareInfo, installed: &[String]) -> Recommendation {
    let models: Vec<ModelAssessment> = CATALOG.iter().map(|m| assess(m, hw, installed)).collect();
    let chat = |a: &&ModelAssessment| !a.model.embedding && available(a);
    let best = |pred: &dyn Fn(&ModelAssessment) -> bool| {
        models
            .iter()
            .filter(chat)
            .filter(|a| pred(a))
            .max_by_key(|a| (a.model.quality, a.installed, std::cmp::Reverse(a.model.size_bytes)))
    };
    let primary = best(&|a| a.fit == Fit::Gpu && a.model.tools).or_else(|| {
        // Partly on CPU: bigger models become unusably slow.
        best(&|a| a.fit == Fit::Partial && a.model.tools && a.model.tier <= Tier::Standard)
    });
    let alternative = primary.and_then(|p| {
        best(&|a| a.fit == Fit::Gpu && a.model.family != p.model.family && a.model.size_bytes < p.model.size_bytes)
            .or_else(|| best(&|a| a.fit == Fit::Gpu && a.model.id != p.model.id))
    });
    let embedding = models.iter().find(|a| a.model.id == AI_TOWN_EMBEDDING_MODEL && available(a));

    let mut explanation = vec![format!("Your hardware: {}.", hardware_summary(hw))];
    match primary {
        Some(p) => {
            let mut why = Vec::new();
            match p.fit {
                Fit::Gpu => why.push("fits in VRAM".to_string()),
                _ => why.push("runs partly on CPU (no model with tool calling fits in VRAM)".to_string()),
            }
            why.push(p.model.good_for.to_string());
            if p.installed {
                why.push("already installed".into());
            }
            explanation.push(format!("Recommended: {}. Why: {}.", p.model.name, why.join(", ")));
        }
        None => explanation.push(
            "No local model can be recommended: not enough GPU memory, RAM or disk space for a model with tool calling."
                .into(),
        ),
    }
    if let Some(a) = alternative {
        let caveat = if a.model.tools { "" } else { " (no tool calling: AI Town dialogue only)" };
        explanation.push(format!("Alternative: {}{caveat}.", a.model.name));
    }
    let coder_fits =
        models.iter().any(|a| a.model.family.contains("coder") && a.model.tier >= Tier::Heavy && a.fit == Fit::Gpu);
    if !coder_fits {
        explanation.push("For heavier coding: use Claude.".into());
    }
    let too_big: Vec<&str> =
        models.iter().filter(|a| !a.installed && !a.installable && !a.model.embedding).map(|a| a.model.name).collect();
    if !too_big.is_empty() {
        explanation.push(format!("Not offered on this machine: {}.", too_big.join(", ")));
    }
    Recommendation {
        hardware: hardware_summary(hw),
        recommended: primary.map(|p| p.model.id.to_string()),
        alternative: alternative.map(|a| a.model.id.to_string()),
        embedding: embedding.map(|e| e.model.id.to_string()),
        explanation,
        models,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware::Gpu;

    fn machine(vram: Option<u64>, ram: u64, disk_gb: u64) -> HardwareInfo {
        HardwareInfo {
            gpus: vram
                .map(|v| {
                    vec![Gpu {
                        name: "NVIDIA GeForce RTX 4060 Ti".into(),
                        vendor: "NVIDIA".into(),
                        vram_mb: Some(v),
                        vram_source: "nvidia-smi".into(),
                        driver: None,
                    }]
                })
                .unwrap_or_default(),
            ram_total_mb: Some(ram),
            disk_free_mb: Some(disk_gb * 1024),
            ..Default::default()
        }
    }

    #[test]
    fn this_pc_gets_qwen3_8b_with_an_alternative() {
        // RTX 4060 Ti 8 GB, 16 GB RAM, 15 GB free, llama3 installed.
        let hw = machine(Some(8188), 16_226, 15);
        let r = recommend(&hw, &["llama3:latest".into()]);
        assert_eq!(r.recommended.as_deref(), Some("qwen3:8b"));
        assert_eq!(r.alternative.as_deref(), Some("llama3.1:8b"));
        assert_eq!(r.embedding.as_deref(), Some("mxbai-embed-large"));
        let text = r.explanation.join("\n");
        assert!(text.contains("4060 Ti, 8.0 GB VRAM, 16 GB RAM, 15 GB free disk"), "{text}");
        assert!(text.contains("Recommended: Qwen3 8B. Why: fits in VRAM"), "{text}");
        assert!(text.contains("For heavier coding: use Claude."));
        // 19 GB download does not fit in 15 GB free.
        let coder = r.models.iter().find(|a| a.model.id == "qwen3-coder:30b").unwrap();
        assert!(!coder.installable);
        assert!(coder.notes.iter().any(|n| n.contains("Not enough disk space")));
        // llama3 is recognised as installed.
        assert!(r.models.iter().find(|a| a.model.id == "llama3:8b").unwrap().installed);
        // 14B is downloadable but does not fit in VRAM.
        let q14 = r.models.iter().find(|a| a.model.id == "qwen3:14b").unwrap();
        assert_eq!(q14.fit, Fit::Partial);
    }

    #[test]
    fn disk_space_limits_what_is_offered() {
        let hw = machine(Some(8188), 16_000, 4);
        let r = recommend(&hw, &[]);
        // qwen3:8b (5.2 GB + 2 GB margin) does not fit on 4 GB.
        assert_ne!(r.recommended.as_deref(), Some("qwen3:8b"));
        assert_eq!(r.recommended.as_deref(), Some("llama3.2:3b"));
        // Installed models stay usable whatever the disk.
        let r = recommend(&hw, &["qwen3:8b".into()]);
        assert_eq!(r.recommended.as_deref(), Some("qwen3:8b"));
    }

    #[test]
    fn small_gpu_and_no_gpu() {
        let r = recommend(&machine(Some(4096), 8_000, 100), &[]);
        assert_eq!(r.recommended.as_deref(), Some("qwen3:4b"));
        let r = recommend(&machine(None, 32_000, 100), &[]);
        let p = r.recommended.unwrap();
        assert_eq!(p, "qwen3:8b");
        let a = r.models.iter().find(|a| a.model.id == p).unwrap();
        assert_eq!(a.fit, Fit::Partial);
        assert!(r.explanation[1].contains("partly on CPU"));
        // Big GPU: coder fits, no "use Claude" line.
        let r = recommend(&machine(Some(24_576), 64_000, 500), &[]);
        assert_eq!(r.recommended.as_deref(), Some("qwen3-coder:30b"));
        assert_eq!(r.alternative.as_deref(), Some("qwen3:14b"));
        assert!(!r.explanation.iter().any(|l| l.contains("use Claude")));
    }

    #[test]
    fn nothing_fits() {
        let r = recommend(&machine(Some(1024), 2_000, 1), &[]);
        assert_eq!(r.recommended, None);
        assert!(r.explanation[1].starts_with("No local model"));
    }

    #[test]
    fn finds_models_by_reference() {
        assert_eq!(find("llama3:latest").unwrap().id, "llama3:8b");
        assert_eq!(find("mxbai-embed-large:latest").unwrap().id, "mxbai-embed-large");
        assert!(find("unknown:1b").is_none());
    }
}
