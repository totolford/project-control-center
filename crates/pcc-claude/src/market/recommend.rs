//! Deterministic, explainable skill recommendations for a piece of text
//! (a mission, a request): no model call. Candidates are the installed skills
//! and the market entries that are not installed; each score is the sum of
//! the rules below and the reason lists the rules that matched.

use std::collections::{BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use super::{words, MarketEntry, MarketIndex};
use crate::skills::{Skill, SkillScope};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecommendation {
    /// Skill name (or market entry name when not installed).
    pub skill: String,
    /// Plugin id, `global`, `project`, `synced`, `owner/repo` or a marketplace plugin id.
    pub source: String,
    pub score: u32,
    pub reason: String,
    pub installed: bool,
    pub enabled: bool,
    /// `Skill.id` when installed.
    pub skill_id: Option<String>,
    /// Market entry id (details / install).
    pub market_id: Option<String>,
}

/// (label, words or phrases of the text, skills by name with a weight).
pub type DomainRule = (&'static str, &'static [&'static str], &'static [(&'static str, u32)]);

/// Domain rules: words or phrases of the text → skills (by name) with a weight.
pub const DOMAINS: &[DomainRule] = &[
    (
        "UI/UX",
        &[
            "ui",
            "ux",
            "redesign",
            "interface",
            "landing page",
            "design",
            "layout",
            "styling",
            "css",
            "tailwind",
            "frontend",
            "website",
            "web page",
            "dashboard",
            "accessibility",
            "theme",
        ],
        &[
            ("ui-ux-pro-max", 10),
            ("ui-styling", 8),
            ("frontend-design", 8),
            ("design-system", 7),
            ("design", 6),
            ("brand", 4),
        ],
    ),
    ("Slides", &["slides", "slide", "presentation", "deck", "pitch deck"], &[("slides", 10), ("pptx", 6)]),
    (
        "Branding",
        &["brand", "branding", "logo", "visual identity"],
        &[("brand", 9), ("design", 6), ("banner-design", 4)],
    ),
    (
        "Banners",
        &["banner", "banners", "social media", "hero image", "ad creative"],
        &[("banner-design", 9), ("design", 4)],
    ),
    (
        "Design tokens",
        &["design system", "design tokens", "tokens", "component library"],
        &[("design-system", 9), ("ui-styling", 5)],
    ),
    ("PDF", &["pdf"], &[("pdf", 9)]),
    ("Word", &["word document", "docx"], &[("docx", 9)]),
    ("Spreadsheets", &["excel", "spreadsheet", "xlsx", "csv"], &[("xlsx", 9)]),
    ("PowerPoint", &["powerpoint", "pptx"], &[("pptx", 9), ("slides", 5)]),
    (
        "Roblox",
        &["roblox", "luau", "roblox studio"],
        &[
            ("roblox-luau", 9),
            ("roblox-ui", 6),
            ("roblox-datastores", 5),
            ("roblox-networking", 5),
            ("strict-typing-luau", 5),
        ],
    ),
    ("Godot", &["godot", "gdscript"], &[("godot-gdscript", 9), ("godot-3d-essentials", 6)]),
    ("Shaders", &["shader", "shaders", "glsl", "hlsl"], &[("shader-programming", 9)]),
    ("Game feel", &["game feel", "juice", "screen shake"], &[("game-feel", 9)]),
    ("Kubernetes", &["kubernetes", "k8s", "helm", "kustomize"], &[("kubernetes-skill", 9), ("timoni", 5)]),
    ("React", &["react", "next.js", "nextjs"], &[("vercel-react-best-practices", 8), ("frontend-design", 3)]),
    ("Vercel", &["vercel", "deploy to vercel"], &[("deploy-to-vercel", 9)]),
    (
        "Testing",
        &["tdd", "unit test", "unit tests", "test-driven"],
        &[("test-driven-development", 7), ("webapp-testing", 5)],
    ),
    (
        "Security review",
        &["security", "audit", "vulnerability", "vulnerabilities"],
        &[("differential-review", 5), ("audit-context-building", 5)],
    ),
    ("Claude API", &["claude api", "anthropic sdk", "anthropic api"], &[("claude-api", 9)]),
    ("Skills", &["create a skill", "new skill", "skill.md"], &[("skill-creator", 9)]),
    ("MCP", &["mcp server", "model context protocol"], &[("mcp-builder", 9)]),
];

const STOP: &[&str] = &[
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "from",
    "into",
    "your",
    "you",
    "our",
    "are",
    "use",
    "using",
    "when",
    "what",
    "how",
    "all",
    "any",
    "can",
    "will",
    "should",
    "make",
    "add",
    "new",
    "skill",
    "skills",
    "best",
    "practices",
    "code",
    "project",
    "app",
    "please",
    "need",
    "want",
    "also",
    "more",
    "its",
    "it's",
    "have",
    "has",
    "not",
    "them",
    "then",
    "than",
    "only",
    "each",
    "other",
    "like",
    "used",
    "user",
    "users",
    "files",
    "file",
];

fn stem(w: &str) -> &str {
    if w.len() > 3 && w.ends_with('s') && !w.ends_with("ss") {
        &w[..w.len() - 1]
    } else {
        w
    }
}

/// Significant words (and their singular) of a text.
fn bag(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for w in words(&text.replace('-', " ")) {
        if w.len() < 2 || STOP.contains(&w.as_str()) {
            continue;
        }
        out.insert(stem(&w).to_string());
        out.insert(w);
    }
    out
}

/// Text normalized for phrase search: lowercase words separated by single spaces.
fn phrase_text(text: &str) -> String {
    format!(" {} ", words(text).join(" "))
}

fn has_phrase(norm: &str, bag: &BTreeSet<String>, phrase: &str) -> bool {
    if phrase.contains(' ') || phrase.contains('.') {
        norm.contains(&format!(" {phrase} "))
    } else {
        bag.contains(phrase)
    }
}

struct Candidate<'a> {
    name: &'a str,
    /// Names the domain rules can target (the skill, or an entry and its skills).
    names: Vec<&'a str>,
    description: &'a str,
    tags: &'a [String],
    source: String,
    installed: bool,
    enabled: bool,
    skill_id: Option<String>,
    market_id: Option<String>,
}

fn score(c: &Candidate, norm: &str, text: &BTreeSet<String>) -> (u32, Vec<String>) {
    let mut total = 0;
    let mut why = Vec::new();
    for (label, triggers, targets) in DOMAINS {
        let Some(hit) = triggers.iter().find(|t| has_phrase(norm, text, t)) else { continue };
        let best =
            targets.iter().filter(|(n, _)| c.names.iter().any(|x| x.eq_ignore_ascii_case(n))).map(|(_, w)| *w).max();
        if let Some(w) = best {
            total += w;
            why.push(format!("{label} request (\"{hit}\")"));
        }
    }
    let name_words: Vec<String> =
        bag(c.name).into_iter().filter(|w| w.len() >= 3 && text.contains(w) && !STOP.contains(&w.as_str())).collect();
    let name_hits: BTreeSet<&str> = name_words.iter().map(|w| stem(w)).collect();
    if !name_hits.is_empty() {
        total += 3 * name_hits.len() as u32;
        why.push(format!("name matches {}", name_hits.into_iter().collect::<Vec<_>>().join(", ")));
    }
    let tag_hits: Vec<&str> =
        c.tags.iter().map(String::as_str).filter(|t| has_phrase(norm, text, &t.replace('-', " "))).collect();
    if !tag_hits.is_empty() {
        total += 2 * tag_hits.len().min(3) as u32;
        why.push(format!("tags {}", tag_hits.join(", ")));
    }
    let desc: BTreeSet<String> = bag(c.description).into_iter().filter(|w| w.len() >= 4).collect();
    let shared: BTreeSet<&str> = desc.iter().filter(|w| text.contains(*w)).map(|w| stem(w)).collect();
    if !shared.is_empty() {
        total += shared.len().min(4) as u32;
        why.push(format!("description mentions {}", shared.into_iter().take(4).collect::<Vec<_>>().join(", ")));
    }
    if total > 0 && c.installed && c.enabled {
        total += 1;
        why.push("installed and enabled".into());
    }
    (total, why)
}

fn skill_source(s: &Skill, repos: &HashMap<&str, &str>) -> String {
    match s.scope {
        SkillScope::Plugin => s.source.clone().unwrap_or_else(|| "plugin".into()),
        _ if s.source.as_deref() == Some("synced") => "synced".into(),
        _ => match repos.get(s.id.as_str()) {
            Some(repo) => repo.to_string(),
            None if s.scope == SkillScope::Project => "project".into(),
            None => "global".into(),
        },
    }
}

fn entry_source(e: &MarketEntry) -> String {
    e.plugin_id.clone().or_else(|| e.repository.clone()).unwrap_or_else(|| "catalog".into())
}

/// Minimum score of a recommendation.
pub const THRESHOLD: u32 = 4;

/// Recommendations for `text`, best first (at most `limit`).
pub fn recommend(text: &str, index: &MarketIndex, skills: &[Skill], limit: usize) -> Vec<SkillRecommendation> {
    let text_bag = bag(text);
    let norm = phrase_text(text);
    let empty: Vec<String> = vec![];
    // Tags and repository of the entry each installed skill belongs to.
    let mut tags_of: HashMap<&str, &Vec<String>> = HashMap::new();
    let mut repo_of: HashMap<&str, &str> = HashMap::new();
    for e in &index.entries {
        for id in &e.installed_skill_ids {
            tags_of.insert(id, &e.tags);
            if e.install_method == super::InstallMethod::GithubSkill {
                if let Some(r) = &e.repository {
                    repo_of.insert(id, r);
                }
            }
        }
    }
    let mut candidates: Vec<Candidate> = skills
        .iter()
        .map(|s| Candidate {
            name: &s.name,
            names: vec![s.name.as_str()],
            description: &s.description,
            tags: tags_of.get(s.id.as_str()).copied().unwrap_or(&empty),
            source: skill_source(s, &repo_of),
            installed: true,
            enabled: s.enabled,
            skill_id: Some(s.id.clone()),
            market_id: index.entries.iter().find(|e| e.installed_skill_ids.contains(&s.id)).map(|e| e.id.clone()),
        })
        .collect();
    for e in index.entries.iter().filter(|e| !e.installed) {
        let mut names = vec![e.name.as_str()];
        names.extend(e.skills.iter().map(|s| s.name.as_str()));
        candidates.push(Candidate {
            name: &e.name,
            names,
            description: &e.description,
            tags: &e.tags,
            source: entry_source(e),
            installed: false,
            enabled: false,
            skill_id: None,
            market_id: Some(e.id.clone()),
        });
    }
    let mut out: Vec<SkillRecommendation> = candidates
        .iter()
        .filter_map(|c| {
            let (score, why) = score(c, &norm, &text_bag);
            (score >= THRESHOLD).then(|| SkillRecommendation {
                skill: c.name.to_string(),
                source: c.source.clone(),
                score,
                reason: why.join("; "),
                installed: c.installed,
                enabled: c.enabled,
                skill_id: c.skill_id.clone(),
                market_id: c.market_id.clone(),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.installed.cmp(&a.installed))
            .then_with(|| b.enabled.cmp(&a.enabled))
            .then_with(|| a.skill.cmp(&b.skill))
    });
    // One line per skill name: the best (installed first on ties).
    let mut seen = BTreeSet::new();
    out.retain(|r| seen.insert(r.skill.to_ascii_lowercase()));
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::super::tests::skill;
    use super::super::{build, catalog, IndexInput};
    use super::*;

    fn installed() -> Vec<Skill> {
        let pid = Some("ui-ux-pro-max@ui-ux-pro-max-skill");
        let mut out: Vec<Skill> =
            ["ui-ux-pro-max", "ui-styling", "design-system", "design", "brand", "slides", "banner-design"]
                .iter()
                .map(|n| skill(&format!("plugin:/c/{n}"), n, SkillScope::Plugin, pid, &format!("/c/{n}")))
                .collect();
        out.push(skill("user:/h/deploy", "deploy", SkillScope::User, None, "/h/deploy"));
        out
    }

    fn index(skills: &[Skill]) -> MarketIndex {
        build(&IndexInput { catalog: catalog(), skills: skills.to_vec(), ..Default::default() })
    }

    #[test]
    fn ui_redesign_recommends_the_design_skills() {
        let skills = installed();
        let recs = recommend("Redesign the landing page interface of the app", &index(&skills), &skills, 10);
        let names: Vec<&str> = recs.iter().map(|r| r.skill.as_str()).collect();
        assert_eq!(names[0], "ui-ux-pro-max", "{recs:#?}");
        for n in ["frontend-design", "ui-styling", "design-system", "design", "brand"] {
            assert!(names.contains(&n), "missing {n}: {names:?}");
        }
        let top = &recs[0];
        assert!(top.installed && top.enabled);
        assert_eq!(top.source, "ui-ux-pro-max@ui-ux-pro-max-skill");
        assert!(top.reason.contains("UI/UX request"), "{}", top.reason);
        assert_eq!(top.skill_id.as_deref(), Some("plugin:/c/ui-ux-pro-max"));
        let fd = recs.iter().find(|r| r.skill == "frontend-design").unwrap();
        assert!(!fd.installed && fd.market_id.is_some());
        assert!(!names.contains(&"deploy"));
    }

    #[test]
    fn slides_and_determinism() {
        let skills = installed();
        let idx = index(&skills);
        let a = recommend("Prepare slides for the investor presentation", &idx, &skills, 5);
        assert_eq!(a[0].skill, "slides");
        assert_eq!(a, recommend("Prepare slides for the investor presentation", &idx, &skills, 5));
        let roblox = recommend("Fix the Roblox datastore saving bug in Luau", &idx, &skills, 5);
        assert_eq!(roblox[0].skill, "roblox-luau");
        assert!(roblox.iter().any(|r| r.skill == "roblox-datastores"));
        assert!(recommend("hello", &idx, &skills, 5).is_empty());
    }
}
