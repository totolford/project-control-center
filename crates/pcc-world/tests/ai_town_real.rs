//! Patches a real AI Town checkout: `PCC_AI_TOWN_DIR=<clone> cargo test -p pcc-world --test ai_town_real -- --ignored`

#[test]
#[ignore = "needs an ai-town checkout in PCC_AI_TOWN_DIR"]
fn patches_real_characters_file() {
    let dir = std::path::PathBuf::from(std::env::var("PCC_AI_TOWN_DIR").unwrap());
    let file = dir.join("data").join("characters.ts");
    let source = std::fs::read_to_string(&file).unwrap();
    let seeds = vec![
        pcc_world::characters::AgentSeed {
            id: "central".into(),
            name: "Central".into(),
            role: "Orchestrator".into(),
            is_central: true,
            ..Default::default()
        },
        pcc_world::characters::AgentSeed {
            id: "roblox".into(),
            name: "Roblox Agent".into(),
            role: "Roblox systems".into(),
            ..Default::default()
        },
    ];
    let chars = pcc_world::characters::from_agents(&seeds);
    let patched = pcc_world::providers::patch_characters_ts(&source, &chars).unwrap();
    assert!(patched.contains("export const characters = ["), "rest of the file kept");
    assert!(patched.contains("name: `Roblox Agent`"));
    std::fs::write(&file, patched).unwrap();
}
