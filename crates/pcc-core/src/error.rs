use serde::Serialize;

/// Error type shared across crates. Serialized as a plain message for the UI.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("process error: {0}")]
    Process(String),
    #[error("git error: {0}")]
    Git(String),
    #[error("permission denied: {0}")]
    Denied(String),
    #[error("no project is open")]
    NoProject,
}

impl Error {
    pub fn invalid(msg: impl Into<String>) -> Self {
        Error::Invalid(msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Error::NotFound(msg.into())
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
