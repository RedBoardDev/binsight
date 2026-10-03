//! Reads the declared dependencies of the workspace crates from `cargo metadata`.
//!
//! Only the JSON fields the layering check needs are read: each package's name and, for each of
//! its dependencies, the name and the kind (normal, dev or build). This module does not judge
//! anything; it turns JSON into plain data.

use std::process::Command;

use anyhow::{Context, bail};
use serde_json::Value;

/// A workspace crate and the dependencies it declares in its `Cargo.toml`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Package {
    /// The package name, such as `binsight-core`.
    pub(crate) name: String,
    /// Every dependency the package declares, in the order of its manifest.
    pub(crate) dependencies: Vec<Dependency>,
}

/// One dependency declared by a workspace crate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Dependency {
    /// The package name of the dependency (not its rename, if any).
    pub(crate) name: String,
    /// The section of the manifest it is declared in.
    pub(crate) kind: DependencyKind,
}

/// The manifest section a dependency is declared in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DependencyKind {
    /// `[dependencies]`: compiled into the crate.
    Normal,
    /// `[dev-dependencies]`: only for tests, examples and benchmarks.
    Dev,
    /// `[build-dependencies]`: only for the build script.
    Build,
}

impl DependencyKind {
    /// How a message names a dependency of this kind.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Normal => "dependency",
            Self::Dev => "dev-dependency",
            Self::Build => "build-dependency",
        }
    }
}

/// Runs `cargo metadata --no-deps` in the current directory and returns its JSON output.
pub(crate) fn run_cargo_metadata() -> anyhow::Result<String> {
    let output = Command::new("cargo")
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .output()
        .context("could not run `cargo metadata`")?;
    if !output.status.success() {
        bail!(
            "`cargo metadata` failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    String::from_utf8(output.stdout).context("`cargo metadata` printed invalid UTF-8")
}

/// Extracts the workspace packages from `cargo metadata --no-deps` JSON.
pub(crate) fn parse_packages(json: &str) -> anyhow::Result<Vec<Package>> {
    let root: Value = serde_json::from_str(json).context("the metadata is not valid JSON")?;
    let packages = root
        .get("packages")
        .and_then(Value::as_array)
        .context("the metadata has no `packages` list")?;
    packages.iter().map(parse_package).collect()
}

fn parse_package(package: &Value) -> anyhow::Result<Package> {
    let name = read_string_field(package, "name").context("a package has no name")?;
    let dependencies = package
        .get("dependencies")
        .and_then(Value::as_array)
        .with_context(|| format!("package {name} has no `dependencies` list"))?
        .iter()
        .map(|dependency| parse_dependency(dependency, &name))
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(Package { name, dependencies })
}

fn parse_dependency(dependency: &Value, package_name: &str) -> anyhow::Result<Dependency> {
    let name = read_string_field(dependency, "name")
        .with_context(|| format!("a dependency of {package_name} has no name"))?;
    let kind = match dependency.get("kind").and_then(Value::as_str) {
        None => DependencyKind::Normal,
        Some("dev") => DependencyKind::Dev,
        Some("build") => DependencyKind::Build,
        Some(other) => bail!("dependency {name} of {package_name} has an unknown kind {other:?}"),
    };
    Ok(Dependency { name, kind })
}

fn read_string_field(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_names_and_dependency_kinds() {
        let json = r#"{"packages": [{"name": "a", "dependencies": [
            {"name": "b", "kind": null},
            {"name": "c", "kind": "dev"},
            {"name": "d", "kind": "build"}
        ]}]}"#;
        let packages = parse_packages(json).unwrap();
        assert_eq!(
            packages,
            vec![Package {
                name: "a".to_owned(),
                dependencies: vec![
                    Dependency {
                        name: "b".to_owned(),
                        kind: DependencyKind::Normal
                    },
                    Dependency {
                        name: "c".to_owned(),
                        kind: DependencyKind::Dev
                    },
                    Dependency {
                        name: "d".to_owned(),
                        kind: DependencyKind::Build
                    },
                ],
            }]
        );
    }

    #[test]
    fn refuses_metadata_without_packages() {
        let error = parse_packages("{}").unwrap_err();
        assert_eq!(error.to_string(), "the metadata has no `packages` list");
    }

    #[test]
    fn refuses_an_unknown_dependency_kind() {
        let json = r#"{"packages": [{"name": "a", "dependencies": [{"name": "b", "kind": "x"}]}]}"#;
        assert!(parse_packages(json).is_err());
    }
}
