//! Structured logs, in a human format for a terminal or JSON lines for a log collector.
//!
//! Logs go to standard error, so standard output stays free for the output of commands. The
//! filter uses the `EnvFilter` syntax (`info`, `binsight_api=debug,info`...). This module owns
//! the two log settings (it validates them for the configuration) and installs the global
//! subscriber; the rest of binsight only uses the `tracing` macros.

use std::io::IsTerminal;

use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::MakeWriter;

/// The filter used when none is configured.
pub const DEFAULT_LOG_FILTER: &str = "info";

/// The format used when none is configured.
pub const DEFAULT_LOG_FORMAT: &str = "pretty";

/// How log lines are written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    /// One readable line per event, colored on a terminal.
    Pretty,
    /// One JSON object per line, for log collectors.
    Json,
}

/// What is logged and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogSettings {
    /// A validated `EnvFilter` directive, such as `info`.
    pub filter: String,
    /// The line format.
    pub format: LogFormat,
}

/// A log setting could not be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LoggingError {
    /// The log format is neither `pretty` nor `json`.
    #[error("the log format must be `pretty` or `json`")]
    UnknownFormat,
    /// The filter is not valid `EnvFilter` syntax.
    #[error("the log filter is not valid: {0}")]
    InvalidFilter(String),
    /// A global logger was already installed.
    #[error("logging was already initialised")]
    AlreadyInitialised,
}

impl LogFormat {
    /// Reads `pretty` or `json`.
    ///
    /// # Errors
    ///
    /// Returns [`LoggingError::UnknownFormat`] for anything else.
    pub fn parse(text: &str) -> Result<Self, LoggingError> {
        match text {
            "pretty" => Ok(Self::Pretty),
            "json" => Ok(Self::Json),
            _ => Err(LoggingError::UnknownFormat),
        }
    }
}

/// Checks that `text` is a valid filter and returns it.
///
/// # Errors
///
/// Returns [`LoggingError::InvalidFilter`] if the syntax is wrong.
pub fn parse_filter(text: &str) -> Result<String, LoggingError> {
    build_filter(text)?;
    Ok(text.to_owned())
}

fn build_filter(text: &str) -> Result<EnvFilter, LoggingError> {
    EnvFilter::builder()
        .parse(text)
        .map_err(|error| LoggingError::InvalidFilter(error.to_string()))
}

/// Installs the global logger, writing to standard error.
///
/// # Errors
///
/// Returns an error if the filter is invalid or a logger is already installed.
pub fn init(settings: &LogSettings) -> Result<(), LoggingError> {
    let is_terminal = std::io::stderr().is_terminal();
    install(settings, std::io::stderr, is_terminal)
}

/// Installs the global logger, writing to `writer`.
fn install<W>(settings: &LogSettings, writer: W, use_colors: bool) -> Result<(), LoggingError>
where
    W: for<'writer> MakeWriter<'writer> + Send + Sync + 'static,
{
    let builder = tracing_subscriber::fmt()
        .with_env_filter(build_filter(&settings.filter)?)
        .with_writer(writer);
    let installed = match settings.format {
        LogFormat::Pretty => builder.with_ansi(use_colors).try_init(),
        LogFormat::Json => builder
            .json()
            .flatten_event(true)
            .with_current_span(true)
            .try_init(),
    };
    installed.map_err(|_| LoggingError::AlreadyInitialised)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// Collects what the logger writes.
    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn writes_one_json_object_per_event() {
        let captured = Captured::default();
        let writer = captured.clone();
        let settings = LogSettings {
            filter: "info".to_owned(),
            format: LogFormat::Json,
        };

        install(&settings, move || writer.clone(), false).unwrap();
        tracing::info!(path = "/data/binsight.db", "database opened");
        tracing::debug!("filtered out");

        let output = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = output.lines().collect();
        assert_eq!(lines.len(), 1, "{output}");
        let event: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(event["message"], "database opened");
        assert_eq!(event["path"], "/data/binsight.db");
        assert_eq!(event["level"], "INFO");
    }

    #[test]
    fn reads_the_two_formats_only() {
        assert_eq!(LogFormat::parse("pretty"), Ok(LogFormat::Pretty));
        assert_eq!(LogFormat::parse("json"), Ok(LogFormat::Json));
        assert_eq!(LogFormat::parse("JSON"), Err(LoggingError::UnknownFormat));
    }

    #[test]
    fn refuses_a_filter_with_invalid_syntax() {
        assert!(parse_filter("binsight_api=debug,info").is_ok());
        assert!(matches!(
            parse_filter("binsight=loud"),
            Err(LoggingError::InvalidFilter(_))
        ));
    }
}
