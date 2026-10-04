//! Captures fixtures from mainnet: fetch, check against the privacy guard, then write.
//!
//! Everything is fetched and checked before the first file is written, and the files are moved
//! into place at once, so a refused or failed case leaves nothing on disk. An existing case or
//! answer is never overwritten: delete it to capture it again. This module orchestrates; the RPC
//! client, the guard, the case file and the writer live next to it.

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
    let mut helius = Helius::from_environment()?;
    match request {
        CaptureRequest::MainnetCase(case) => capture_case(&root, &denylist, &mut helius, case),
        CaptureRequest::RpcAnswer(answer) => record_answer(&root, &denylist, &mut helius, answer),
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
