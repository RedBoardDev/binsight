//! The command line of `cargo xtask fixture capture`, parsed into a typed request.
//!
//! Two shapes exist: a mainnet case (transactions, and optionally accounts, for the domain tests)
//! and one raw JSON-RPC answer (for the chain client's tests). This module only parses the
//! arguments; it does not fetch or write anything.

use anyhow::{Context, anyhow, bail, ensure};
use serde_json::Value;

use super::identifiers::{AddressText, CaseName, RpcMethod, SignatureText};

/// How to call the command, shown with every argument error.
pub(crate) const USAGE: &str = "usage:
  cargo xtask fixture capture <signature>... --case <name> --why <sentence>
      [--account <address>]... [--perspective <address>] [--oracle <rule id>]...
  cargo xtask fixture capture --rpc <method> --params <json array> --case <name>";

/// What to capture.
#[derive(Debug, PartialEq)]
pub(crate) enum CaptureRequest {
    /// A mainnet case: transactions and accounts, under `tests/fixtures/mainnet/<case>/`.
    MainnetCase(MainnetCase),
    /// One JSON-RPC answer, under `crates/chain/tests/fixtures/rpc/<method>/<case>.json`.
    RpcAnswer(RpcAnswer),
}

/// A mainnet case to capture.
#[derive(Debug, PartialEq)]
pub(crate) struct MainnetCase {
    /// The case, which is also its folder name.
    pub(crate) name: CaseName,
    /// One sentence saying what the case shows.
    pub(crate) why: String,
    /// The transactions, in the order they happened.
    pub(crate) signatures: Vec<SignatureText>,
    /// Accounts to snapshot as well (pools, positions, mints).
    pub(crate) accounts: Vec<AddressText>,
    /// The public wallet whose point of view the tests take, if any.
    pub(crate) perspective: Option<AddressText>,
    /// The rule and oracle identifiers the case illustrates.
    pub(crate) oracles: Vec<String>,
}

/// One JSON-RPC call whose answer is recorded verbatim.
#[derive(Debug, PartialEq)]
pub(crate) struct RpcAnswer {
    /// The case, which is also the file name.
    pub(crate) name: CaseName,
    /// The method to call.
    pub(crate) method: RpcMethod,
    /// Its parameters, a JSON array.
    pub(crate) params: Value,
}

/// The raw options, before they are checked against one of the two shapes.
#[derive(Debug, Default)]
struct Options {
    positional: Vec<String>,
    case: Option<String>,
    why: Option<String>,
    perspective: Option<String>,
    rpc: Option<String>,
    params: Option<String>,
    accounts: Vec<String>,
    oracles: Vec<String>,
}

/// Parses the arguments that follow `cargo xtask fixture capture`.
pub(crate) fn parse(arguments: &[String]) -> anyhow::Result<CaptureRequest> {
    read_options(arguments)
        .and_then(Options::into_request)
        .map_err(|error| anyhow!("{error:#}\n{USAGE}"))
}

fn read_options(arguments: &[String]) -> anyhow::Result<Options> {
    let mut options = Options::default();
    let mut remaining = arguments.iter();
    while let Some(argument) = remaining.next() {
        let mut value = || {
            remaining
                .next()
                .cloned()
                .with_context(|| format!("{argument} needs a value"))
        };
        match argument.as_str() {
            "--case" => set_once(&mut options.case, argument, value()?)?,
            "--why" => set_once(&mut options.why, argument, value()?)?,
            "--perspective" => set_once(&mut options.perspective, argument, value()?)?,
            "--rpc" => set_once(&mut options.rpc, argument, value()?)?,
            "--params" => set_once(&mut options.params, argument, value()?)?,
            "--account" => options.accounts.push(value()?),
            "--oracle" => options.oracles.push(value()?),
            flag if flag.starts_with("--") => bail!("unknown option {flag}"),
            _ => options.positional.push(argument.clone()),
        }
    }
    Ok(options)
}

fn set_once(slot: &mut Option<String>, flag: &str, value: String) -> anyhow::Result<()> {
    ensure!(slot.is_none(), "{flag} is given twice");
    *slot = Some(value);
    Ok(())
}

impl Options {
    fn into_request(self) -> anyhow::Result<CaptureRequest> {
        let name = CaseName::parse(self.case.as_deref().context("--case is required")?)?;
        match self.rpc.clone() {
            Some(method) => self.into_rpc_answer(name, &method),
            None => self.into_mainnet_case(name),
        }
    }

    fn into_rpc_answer(self, name: CaseName, method: &str) -> anyhow::Result<CaptureRequest> {
        ensure!(
            self.positional.is_empty() && self.accounts.is_empty() && self.why.is_none(),
            "--rpc records one answer: it takes only --params and --case"
        );
        let params_text = self.params.context("--rpc needs --params")?;
        let params: Value = serde_json::from_str(&params_text)
            .with_context(|| format!("--params is not valid JSON: {params_text}"))?;
        ensure!(params.is_array(), "--params must be a JSON array");
        Ok(CaptureRequest::RpcAnswer(RpcAnswer {
            name,
            method: RpcMethod::parse(method)?,
            params,
        }))
    }

    fn into_mainnet_case(self, name: CaseName) -> anyhow::Result<CaptureRequest> {
        ensure!(self.params.is_none(), "--params only goes with --rpc");
        ensure!(!self.positional.is_empty(), "give at least one signature");
        let why = self
            .why
            .context("--why is required: one sentence on what the case shows")?;
        Ok(CaptureRequest::MainnetCase(MainnetCase {
            name,
            why,
            signatures: parse_all(&self.positional, SignatureText::parse)?,
            accounts: parse_all(&self.accounts, AddressText::parse)?,
            perspective: self
                .perspective
                .as_deref()
                .map(AddressText::parse)
                .transpose()?,
            oracles: self.oracles,
        }))
    }
}

fn parse_all<T>(texts: &[String], parse: fn(&str) -> anyhow::Result<T>) -> anyhow::Result<Vec<T>> {
    texts.iter().map(|text| parse(text)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADDRESS: &str = "11111111111111111111111111111111";

    fn arguments(text: &[&str]) -> Vec<String> {
        text.iter().map(|argument| (*argument).to_owned()).collect()
    }

    #[test]
    fn reads_a_mainnet_case_with_its_accounts_and_oracles() {
        let signature = "1".repeat(64);
        let request = parse(&arguments(&[
            &signature,
            "--case",
            "legacy-sol-transfer",
            "--why",
            "a plain transfer",
            "--account",
            ADDRESS,
            "--oracle",
            "L-2",
            "--perspective",
            ADDRESS,
        ]))
        .unwrap();
        let CaptureRequest::MainnetCase(case) = request else {
            panic!("expected a mainnet case, got {request:?}");
        };
        assert_eq!(case.name.as_str(), "legacy-sol-transfer");
        assert_eq!(case.signatures.len(), 1);
        assert_eq!(case.accounts.len(), 1);
        assert_eq!(case.oracles, ["L-2"]);
        assert!(case.perspective.is_some());
    }

    #[test]
    fn reads_an_rpc_answer_with_its_params() {
        let request = parse(&arguments(&[
            "--rpc",
            "getSlot",
            "--params",
            "[]",
            "--case",
            "current-slot",
        ]))
        .unwrap();
        assert_eq!(
            request,
            CaptureRequest::RpcAnswer(RpcAnswer {
                name: CaseName::parse("current-slot").unwrap(),
                method: RpcMethod::parse("getSlot").unwrap(),
                params: Value::Array(Vec::new()),
            })
        );
    }

    #[test]
    fn refuses_a_mainnet_case_without_a_reason() {
        let signature = "1".repeat(64);
        let error = parse(&arguments(&[&signature, "--case", "no-reason"])).unwrap_err();
        assert!(format!("{error:#}").contains("--why is required"));
    }

    #[test]
    fn refuses_unknown_options_and_repeated_ones() {
        assert!(parse(&arguments(&["--case", "a", "--verbose"])).is_err());
        assert!(parse(&arguments(&["--case", "a", "--case", "b"])).is_err());
        assert!(
            parse(&arguments(&[
                "--rpc", "getSlot", "--params", "{}", "--case", "a"
            ]))
            .is_err()
        );
    }
}
