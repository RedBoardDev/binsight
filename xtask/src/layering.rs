//! Checks the declared dependencies of the workspace against the rules of `rules.rs`.
//!
//! Three rules are enforced: the internal dependency matrix, the exclusive owners of some
//! external crates, and the short list of external crates a pure crate may use. Every workspace
//! member must also have a rule. This module only compares data; it does not run cargo or print.

mod violation;

use std::collections::BTreeSet;

use crate::metadata::{Dependency, DependencyKind, Package};
use crate::rules::{
    CrateRule, EXCLUSIVE_OWNERS, INTERNAL_ALLOWED, PURE_CRATES, PURE_EXTERNAL_ALLOWLIST,
};

pub(crate) use violation::Violation;

/// Returns every rule broken by these workspace packages, in a stable order.
pub(crate) fn check(packages: &[Package]) -> Vec<Violation> {
    let members: BTreeSet<&str> = packages
        .iter()
        .map(|package| package.name.as_str())
        .collect();
    let mut violations = Vec::new();
    for package in packages {
        let Some(rule) = INTERNAL_ALLOWED
            .iter()
            .find(|rule| rule.name == package.name)
        else {
            violations.push(Violation::MissingRule {
                package: package.name.clone(),
            });
            continue;
        };
        for dependency in &package.dependencies {
            let violation = if members.contains(dependency.name.as_str()) {
                check_internal(rule, dependency)
            } else {
                check_external(rule, dependency)
            };
            violations.extend(violation);
        }
    }
    violations
}

/// The internal matrix applies to every kind of dependency, tests included.
fn check_internal(rule: &CrateRule, dependency: &Dependency) -> Option<Violation> {
    if rule.may_depend_on.contains(&dependency.name.as_str()) {
        return None;
    }
    Some(Violation::InternalNotAllowed {
        package: rule.name.to_owned(),
        dependency: dependency.name.clone(),
        kind: dependency.kind,
        allowed: rule.may_depend_on,
    })
}

/// External rules apply to what is compiled into the crate; tests may use anything.
fn check_external(rule: &CrateRule, dependency: &Dependency) -> Option<Violation> {
    if dependency.kind == DependencyKind::Dev {
        return None;
    }
    let name = dependency.name.as_str();
    if let Some(owner) = EXCLUSIVE_OWNERS
        .iter()
        .find(|owner| owner.dependency == name)
        && !owner.owners.contains(&rule.name)
    {
        return Some(Violation::NotTheOwner {
            package: rule.name.to_owned(),
            dependency: dependency.name.clone(),
            owners: owner.owners,
        });
    }
    if PURE_CRATES.contains(&rule.name) && !PURE_EXTERNAL_ALLOWLIST.contains(&name) {
        return Some(Violation::NotPure {
            package: rule.name.to_owned(),
            dependency: dependency.name.clone(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::parse_packages;

    /// `cargo metadata --no-deps` output for the planned workspace, with every crate declaring the
    /// dependencies it is meant to have. It must pass; each test below breaks it in one way.
    const FIXTURE: &str = include_str!("../tests/fixtures/metadata.json");

    fn planned_workspace() -> Vec<Package> {
        parse_packages(FIXTURE).unwrap()
    }

    fn add_dependency(packages: &mut [Package], to: &str, name: &str, kind: DependencyKind) {
        let package = packages.iter_mut().find(|p| p.name == to).unwrap();
        package.dependencies.push(Dependency {
            name: name.to_owned(),
            kind,
        });
    }

    fn messages(packages: &[Package]) -> Vec<String> {
        check(packages).iter().map(ToString::to_string).collect()
    }

    #[test]
    fn accepts_the_planned_workspace() {
        assert_eq!(messages(&planned_workspace()), Vec::<String>::new());
    }

    #[test]
    fn rejects_a_dependency_against_the_internal_matrix() {
        let mut packages = planned_workspace();
        add_dependency(
            &mut packages,
            "binsight-ledger",
            "binsight-store",
            DependencyKind::Normal,
        );
        assert_eq!(
            messages(&packages),
            ["binsight-ledger must not depend on binsight-store \
              (allowed: binsight-core, binsight-solana, binsight-dlmm)"]
        );
    }

    #[test]
    fn applies_the_internal_matrix_to_tests_too() {
        let mut packages = planned_workspace();
        add_dependency(
            &mut packages,
            "binsight-api",
            "binsight-store",
            DependencyKind::Dev,
        );
        assert_eq!(
            messages(&packages),
            [
                "binsight-api must not depend on binsight-store as a dev-dependency \
              (allowed: binsight-core, binsight-solana, binsight-dlmm, binsight-ledger, \
              binsight-engine)"
            ]
        );
    }

    #[test]
    fn rejects_an_external_crate_used_outside_its_owner() {
        let mut packages = planned_workspace();
        add_dependency(
            &mut packages,
            "binsight-engine",
            "axum",
            DependencyKind::Normal,
        );
        assert_eq!(
            messages(&packages),
            ["binsight-engine must not depend on axum (only binsight-api may)"]
        );
    }

    #[test]
    fn rejects_an_async_runtime_in_a_pure_crate() {
        let mut packages = planned_workspace();
        add_dependency(
            &mut packages,
            "binsight-core",
            "tokio",
            DependencyKind::Normal,
        );
        assert_eq!(
            messages(&packages),
            [
                "binsight-core is a pure crate and must not depend on tokio \
              (pure crates may only use: thiserror, serde, serde_json, bs58, borsh, jiff, sha2)"
            ]
        );
    }

    #[test]
    fn lets_tests_use_any_external_crate() {
        let mut packages = planned_workspace();
        add_dependency(&mut packages, "binsight-core", "tokio", DependencyKind::Dev);
        add_dependency(
            &mut packages,
            "binsight-engine",
            "axum",
            DependencyKind::Dev,
        );
        assert_eq!(messages(&packages), Vec::<String>::new());
    }

    #[test]
    fn rejects_a_crate_without_a_rule() {
        let mut packages = planned_workspace();
        packages.push(Package {
            name: "binsight-extra".to_owned(),
            dependencies: Vec::new(),
        });
        assert_eq!(
            messages(&packages),
            ["binsight-extra has no layering rule: \
              add it to INTERNAL_ALLOWED in xtask/src/rules.rs"]
        );
    }

    #[test]
    fn forbids_any_crate_from_depending_on_xtask() {
        let mut packages = planned_workspace();
        add_dependency(&mut packages, "binsight", "xtask", DependencyKind::Build);
        assert_eq!(check(&packages).len(), 1);
    }
}
