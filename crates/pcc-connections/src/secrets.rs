//! Secrets live in the OS credential store: Windows Credential Manager (DPAPI
//! protected, per user) or, on Linux, the Secret Service (GNOME Keyring,
//! KWallet). The project only stores an opaque `credentialRef`; secrets never
//! reach `.agent-project/`, logs, mission files or chat history.

use std::collections::BTreeMap;

use pcc_core::{Error, Result};

const SERVICE: &str = "ProjectControlCenter";

pub fn new_ref() -> String {
    format!("pcc-{}", uuid::Uuid::new_v4())
}

fn entry(reference: &str) -> Result<keyring::Entry> {
    if !reference.starts_with("pcc-") {
        return Err(Error::invalid("invalid credential reference"));
    }
    keyring::Entry::new(SERVICE, reference).map_err(|e| Error::Storage(store_error("credential store", &e)))
}

/// A readable message, with what to do when Linux has no Secret Service.
fn store_error(what: &str, e: &keyring::Error) -> String {
    let unreachable = matches!(e, keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_));
    if cfg!(target_os = "linux") && unreachable {
        format!(
            "{what}: no Secret Service is available ({e}). Start or unlock GNOME Keyring or KWallet \
             (on a server or WSL: install gnome-keyring and run it in the session); NEXUS never stores secrets in files"
        )
    } else {
        format!("{what}: {e}")
    }
}

/// Whether the credential store answers: `Ok(name)` or the reason it cannot
/// be used. Reads one entry that never exists; nothing is written.
pub fn store_status() -> std::result::Result<String, String> {
    let name = pcc_platform::credential_store_name().to_string();
    let e = keyring::Entry::new(SERVICE, "pcc-probe-never-stored").map_err(|e| store_error(&name, &e))?;
    match e.get_password() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(name),
        Err(e) => Err(store_error(&name, &e)),
    }
}

/// Stores a map of named secret values (e.g. `password`, `API_KEY`).
pub fn set(reference: &str, values: &BTreeMap<String, String>) -> Result<()> {
    let json = serde_json::to_string(values)?;
    entry(reference)?.set_password(&json).map_err(|e| Error::Storage(store_error("cannot save secret", &e)))
}

pub fn get(reference: &str) -> Result<BTreeMap<String, String>> {
    match entry(reference)?.get_password() {
        Ok(json) => Ok(serde_json::from_str(&json)?),
        Err(keyring::Error::NoEntry) => Ok(BTreeMap::new()),
        Err(e) => Err(Error::Storage(store_error("cannot read secret", &e))),
    }
}

/// Names of the stored values, never the values.
pub fn keys(reference: &str) -> Result<Vec<String>> {
    Ok(get(reference)?.into_keys().collect())
}

pub fn delete(reference: &str) -> Result<()> {
    match entry(reference)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(Error::Storage(store_error("cannot delete secret", &e))),
    }
}

/// Replaces every occurrence of a secret value in `text` (used before logging).
pub fn redact(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for s in secrets.iter().filter(|s| s.len() >= 4) {
        out = out.replace(s.as_str(), "••••••");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts() {
        assert_eq!(redact("token=abcd1234 ok", &["abcd1234".into(), "x".into()]), "token=•••••• ok");
    }

    #[test]
    fn rejects_foreign_refs() {
        assert!(get("some-other-app").is_err());
    }

    #[test]
    fn store_status_names_the_store_or_explains() {
        match store_status() {
            Ok(name) => assert_eq!(name, pcc_platform::credential_store_name()),
            Err(why) => assert!(!why.is_empty()),
        }
    }

    #[cfg(windows)]
    #[test]
    fn roundtrip_in_credential_manager() {
        let r = new_ref();
        let mut m = BTreeMap::new();
        m.insert("password".to_string(), "s3cret!".to_string());
        set(&r, &m).unwrap();
        assert_eq!(get(&r).unwrap(), m);
        assert_eq!(keys(&r).unwrap(), vec!["password"]);
        delete(&r).unwrap();
        assert!(get(&r).unwrap().is_empty());
    }
}
