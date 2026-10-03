//! Minimal client for Convex's HTTP API (`POST /api/query|mutation`).

use pcc_core::{Error, Result};
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct ConvexClient {
    url: String,
    agent: ureq::Agent,
}

impl ConvexClient {
    pub fn new(url: &str) -> Self {
        let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(15)).build();
        Self { url: url.trim_end_matches('/').to_string(), agent }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    fn call(&self, kind: &str, path: &str, args: Value) -> Result<Value> {
        let body = json!({ "path": path, "args": args, "format": "json" });
        let response = match self.agent.post(&format!("{}/api/{kind}", self.url)).send_json(body) {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) => {
                let text = r.into_string().unwrap_or_default();
                return Err(Error::Invalid(format!("Convex {path} failed ({code}): {text}")));
            }
            Err(e) => return Err(Error::Invalid(format!("Convex unreachable: {e}"))),
        };
        let v: Value = response.into_json().map_err(|e| Error::Invalid(e.to_string()))?;
        match v["status"].as_str() {
            Some("success") => Ok(v["value"].clone()),
            _ => {
                Err(Error::Invalid(format!("Convex {path}: {}", v["errorMessage"].as_str().unwrap_or("unknown error"))))
            }
        }
    }

    pub fn query(&self, path: &str, args: Value) -> Result<Value> {
        self.call("query", path, args)
    }

    pub fn mutation(&self, path: &str, args: Value) -> Result<Value> {
        self.call("mutation", path, args)
    }
}
