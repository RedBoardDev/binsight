//! The broken layering rules and how they are explained to a human.
//!
//! Each variant of [`Violation`] is one kind of broken rule; its message names the crates involved
//! and what is allowed instead. This module only describes; the checks live in `layering.rs`.

use std::fmt;

use crate::metadata::DependencyKind;
use crate::rules::PURE_EXTERNAL_ALLOWLIST;

/// One broken layering rule, with a message that says how to read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Violation {
    /// A workspace member is missing from the internal dependency table.
    MissingRule {
        /// The crate without a rule.
        package: String,
    },
    /// A crate depends on a workspace crate the matrix does not allow.
    InternalNotAllowed {
        /// The crate that declares the dependency.
        package: String,
        /// The workspace crate it depends on.
        dependency: String,
        /// The manifest section of the dependency.
        kind: DependencyKind,
        /// The workspace crates it may depend on.
        allowed: &'static [&'static str],
    },
    /// A crate uses an external crate reserved to other crates.
    NotTheOwner {
        /// The crate that declares the dependency.
        package: String,
        /// The reserved external crate.
        dependency: String,
        /// The only crates allowed to use it.
        owners: &'static [&'static str],
    },
    /// A pure crate uses an external crate outside the pure allowlist.
    NotPure {
        /// The pure crate that declares the dependency.
        package: String,
        /// The external crate it is not allowed to use.
        dependency: String,
    },
}

impl fmt::Display for Violation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingRule { package } => write!(
                formatter,
                "{package} has no layering rule: add it to INTERNAL_ALLOWED in xtask/src/rules.rs"
            ),
            Self::InternalNotAllowed {
                package,
                dependency,
                kind,
                allowed,
            } => write!(
                formatter,
                "{package} must not depend on {dependency}{} (allowed: {})",
                describe_kind(*kind),
                describe_allowed(allowed)
            ),
            Self::NotTheOwner {
                package,
                dependency,
                owners,
            } => write!(
                formatter,
                "{package} must not depend on {dependency} (only {} may)",
                owners.join(", ")
            ),
            Self::NotPure {
                package,
                dependency,
            } => write!(
                formatter,
                "{package} is a pure crate and must not depend on {dependency} \
                 (pure crates may only use: {})",
                PURE_EXTERNAL_ALLOWLIST.join(", ")
            ),
        }
    }
}

/// " as a dev-dependency" or " as a build-dependency"; nothing for a normal dependency.
fn describe_kind(kind: DependencyKind) -> String {
    match kind {
        DependencyKind::Normal => String::new(),
        DependencyKind::Dev | DependencyKind::Build => format!(" as a {}", kind.label()),
    }
}

/// The allowed crates as a list, or a plain phrase when there are none.
fn describe_allowed(allowed: &[&str]) -> String {
    if allowed.is_empty() {
        "no workspace crate".to_owned()
    } else {
        allowed.join(", ")
    }
}
