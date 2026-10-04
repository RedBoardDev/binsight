//! Captures fixtures from mainnet: check the request, fetch, check the answers, then write.
//!
//! The request itself goes through the privacy guard before any call: an answer does not always
//! echo what was asked (`getSignaturesForAddress` lists signatures, not the address), so a private
//! address in the parameters would otherwise slip through. Everything is fetched and checked
//! before the first file is written, and the files are moved into place at once, so a refused or
//! failed case leaves nothing on disk. An existing case or answer is never overwritten: delete it
//! to capture it again. This module orchestrates; the RPC client, the guard, the case file and the
//! writer live next to it.

use std::path::{Path, PathBuf};

use anyhow::ensure;
use serde::Deserialize;
use serde_json::json;

use super::case_file::{CapturedAccount, CapturedTransaction, CaseFile};
use super::command::{CaptureRequest, MainnetCase, RpcAnswer};
use super::denylist::Denylist;
use super::helius::Helius;
use super::staged_write::{PendingFile, write_new_file, write_new_folder};
use crate::git;

/// Where the mainnet cases live, relative to the repository root.
const MAINNET_FIXTURES: &str = "tests/fixtures/mainnet";

/// Where the chain client's recorded answers live, relative to the repository root.
const RPC_FIXTURES: &str = "crates/chain/tests/fixtures/rpc";

/// The newest transaction version requested, as the product requests it.
const MAX_SUPPORTED_TX_VERSION: u8 = 1;

#[derive(Deserialize)]
struct SlotOfTransaction {
    slot: u64,
}

#[derive(Deserialize)]
struct SlotOfAccount {
    context: SlotOfTransaction,
}

/// Runs a capture and returns a one-line summary of what was written.
pub(crate) fn capture(request: &CaptureRequest) -> anyhow::Result<String> {
    let root = git::repository_root()?;
    let denylist = Denylist::of_repository()?;
    check_request(&denylist, request)?;
    let mut helius = Helius::from_environment()?;
    let summary = match request {
        CaptureRequest::MainnetCase(case) => capture_case(&root, &denylist, &mut helius, case),
        CaptureRequest::RpcAnswer(answer) => record_answer(&root, &denylist, &mut helius, answer),
    }?;
    Ok(format!("{summary} ({})", denylist.coverage()))
}

/// Refuses a request that cites something private, before anything is sent.
fn check_request(denylist: &Denylist, request: &CaptureRequest) -> anyhow::Result<()> {
    match request {
        CaptureRequest::MainnetCase(case) => {
            denylist.check_text("--case", case.name.as_str())?;
            denylist.check_text("--why", &case.why)?;
            let addresses = case.accounts.iter().chain(&case.perspective);
            for address in addresses {
                denylist.check_json(
                    "--account or --perspective",
                    &json!(address.as_str()).to_string(),
                )?;
            }
            for signature in &case.signatures {
                denylist.check_text("a signature", signature.as_str())?;
            }
            Ok(())
        }
        CaptureRequest::RpcAnswer(answer) => {
            denylist.check_text("--case", answer.name.as_str())?;
            denylist.check_json("--params", &answer.params.to_string())
        }
    }
}

fn capture_case(
    root: &Path,
    denylist: &Denylist,
    helius: &mut Helius,
    case: &MainnetCase,
) -> anyhow::Result<String> {
    let folder = root.join(MAINNET_FIXTURES).join(case.name.as_str());
    ensure!(
        !folder.exists(),
        "{} already exists; delete it to capture the case again",
        folder.display()
    );
    let mut files = Vec::new();
    let mut transactions = Vec::new();
    for (position, signature) in (1_u32..).zip(&case.signatures) {
        let file = format!("tx-{position}.json");
        let params = json!([signature.as_str(), {
            "encoding": "base64",
            "maxSupportedTransactionVersion": MAX_SUPPORTED_TX_VERSION,
            "commitment": "finalized",
        }]);
        let result = helius.result("getTransaction", &params)?;
        denylist.check_json(&file, &result)?;
        let header: SlotOfTransaction = serde_json::from_str(&result)?;
        transactions.push(CapturedTransaction {
            file: file.clone(),
            signature: signature.as_str().to_owned(),
            slot: header.slot,
        });
        files.push(PendingFile {
            path: PathBuf::from(file),
            content: result,
        });
    }
    let accounts = fetch_accounts(denylist, helius, case, &mut files)?;
    let case_file = CaseFile {
        name: case.name.as_str().to_owned(),
        why: case.why.clone(),
        perspective: case.perspective.as_ref().map(ToString::to_string),
        oracles: case.oracles.clone(),
        captured_at: today(),
        transactions,
        accounts,
    }
    .render()?;
    denylist.check_text("case.toml", &case_file)?;
    files.push(PendingFile {
        path: PathBuf::from("case.toml"),
        content: case_file,
    });
    write_new_folder(&folder, &files)?;
    Ok(format!(
        "captured {} into {} with {} RPC call(s)",
        case.name.as_str(),
        folder.display(),
        helius.calls()
    ))
}

fn fetch_accounts(
    denylist: &Denylist,
    helius: &mut Helius,
    case: &MainnetCase,
    files: &mut Vec<PendingFile>,
) -> anyhow::Result<Vec<CapturedAccount>> {
    let mut accounts = Vec::new();
    for address in &case.accounts {
        let file = format!("accounts/{address}.json");
        let params = json!([address.as_str(), {"encoding": "base64", "commitment": "finalized"}]);
        let result = helius.result("getAccountInfo", &params)?;
        denylist.check_json(&file, &result)?;
        let header: SlotOfAccount = serde_json::from_str(&result)?;
        accounts.push(CapturedAccount {
            file: file.clone(),
            address: address.to_string(),
            slot: header.context.slot,
        });
        files.push(PendingFile {
            path: PathBuf::from(file),
            content: result,
        });
    }
    Ok(accounts)
}

fn record_answer(
    root: &Path,
    denylist: &Denylist,
    helius: &mut Helius,
    answer: &RpcAnswer,
) -> anyhow::Result<String> {
    let file = format!("{}.json", answer.name.as_str());
    let path = root
        .join(RPC_FIXTURES)
        .join(answer.method.as_str())
        .join(&file);
    ensure!(
        !path.exists(),
        "{} already exists; delete it to record it again",
        path.display()
    );
    let body = helius.call(answer.method.as_str(), &answer.params)?;
    denylist.check_json(&file, &body)?;
    write_new_file(&path, &body)?;
    Ok(format!(
        "recorded {} into {}",
        answer.method.as_str(),
        path.display()
    ))
}

/// Today's date in UTC, `YYYY-MM-DD`.
fn today() -> String {
    #[expect(
        clippy::disallowed_methods,
        reason = "xtask is tooling outside the product; the capture date is the real date"
    )]
    let now = jiff::Timestamp::now();
    now.strftime("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use serde_json::Value;

    use super::*;
    use crate::fixture::identifiers::{CaseName, RpcMethod};

    /// The bytes of the address standing in for a private one.
    const LISTED_BYTES: [u8; 32] = [7; 32];

    fn denylist() -> (tempfile::TempDir, Denylist) {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("private-denylist");
        let listed = bs58::encode(LISTED_BYTES).into_string();
        std::fs::write(&path, format!("{listed}\nsecret-project\n")).unwrap();
        let list = Denylist::read(&path).unwrap();
        (folder, list)
    }

    fn rpc_request(case: &str, params: Value) -> CaptureRequest {
        CaptureRequest::RpcAnswer(RpcAnswer {
            name: CaseName::parse(case).unwrap(),
            method: RpcMethod::parse("getSignaturesForAddress").unwrap(),
            params,
        })
    }

    #[test]
    fn refuses_rpc_params_that_cite_a_listed_address() {
        let (_folder, list) = denylist();
        let listed = bs58::encode(LISTED_BYTES).into_string();
        let as_text = rpc_request("history", json!([listed, {"limit": 10}]));
        assert!(check_request(&list, &as_text).is_err());
        let filter = json!({"memcmp": {"offset": 8, "bytes": STANDARD.encode(LISTED_BYTES)}});
        let as_bytes = rpc_request(
            "program-accounts",
            json!(["11111111111111111111111111111111", {"filters": [filter]}]),
        );
        assert!(check_request(&list, &as_bytes).is_err());
    }

    #[test]
    fn refuses_an_rpc_case_name_that_matches_the_denylist() {
        let (_folder, list) = denylist();
        let request = rpc_request("secret-project", json!([]));
        assert!(check_request(&list, &request).is_err());
    }

    #[test]
    fn accepts_rpc_params_that_cite_nothing_listed() {
        let (_folder, list) = denylist();
        let request = rpc_request("history", json!(["11111111111111111111111111111111"]));
        assert!(check_request(&list, &request).is_ok());
    }
}
