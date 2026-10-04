//! `getSignaturesForAddress`: one page of an address's transaction signatures, newest first.
//!
//! Pages are listed at `finalized` commitment, the same as transactions are read, so a listed
//! signature can always be fetched. A page that cannot be read is an error, never an empty page:
//! an empty page means "nothing older", and mistaking a failure for it would end a history listing
//! halfway. This module lists; deciding where the next page starts is the engine's job.

use binsight_solana::{Address, Commitment, Signature};
use jiff::Timestamp;
use serde::Deserialize;
use serde_json::value::RawValue;

use crate::error::RpcError;
use crate::rpc::call::CallContext;
use crate::rpc::client::RpcClient;
use crate::rpc::envelope::RpcResult;
use crate::rpc::method::RpcMethod;
use crate::rpc::wire_names::commitment_name;

/// The largest page the node returns; a shorter page is the last one.
pub const SIGNATURE_PAGE_LIMIT: usize = 1_000;

/// The commitment pages are listed at.
const LISTING_COMMITMENT: Commitment = Commitment::Finalized;

const METHOD: RpcMethod = RpcMethod::GetSignaturesForAddress;

/// Which page of signatures to list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignaturesRequest {
    /// The address whose transactions are listed.
    pub address: Address,
    /// List only signatures older than this one; `None` starts from the newest.
    pub before: Option<Signature>,
}

/// One listed transaction signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignatureInfo {
    /// The transaction signature.
    pub signature: Signature,
    /// The slot the transaction landed in.
    pub slot: u64,
    /// When its block was produced, if the node knows.
    pub block_time: Option<Timestamp>,
    /// Whether the transaction failed (it still landed and paid its fee).
    pub is_failed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignatureEntry {
    signature: String,
    slot: u64,
    #[serde(default)]
    err: Option<Box<RawValue>>,
    #[serde(default)]
    block_time: Option<i64>,
}

impl RpcClient {
    /// Lists one page of at most [`SIGNATURE_PAGE_LIMIT`] signatures, newest first.
    ///
    /// # Errors
    ///
    /// Returns an [`RpcError`] if the call fails after its retries or the page cannot be read.
    pub async fn signatures_for_address(
        &self,
        request: SignaturesRequest,
        context: CallContext,
    ) -> Result<Vec<SignatureInfo>, RpcError> {
        let mut options = serde_json::Map::new();
        options.insert("limit".to_owned(), SIGNATURE_PAGE_LIMIT.into());
        options.insert(
            "commitment".to_owned(),
            commitment_name(LISTING_COMMITMENT).into(),
        );
        if let Some(before) = request.before {
            options.insert("before".to_owned(), before.to_string().into());
        }
        let params = serde_json::json!([request.address.to_string(), options]);
        match self.call(METHOD, &params, &context).await? {
            RpcResult::Null => Err(unreadable("the node returned null instead of a page")),
            RpcResult::Value(raw) => parse_page(raw.get()),
        }
    }
}

/// Reads a page of signature entries.
fn parse_page(json: &str) -> Result<Vec<SignatureInfo>, RpcError> {
    let entries: Vec<SignatureEntry> =
        serde_json::from_str(json).map_err(|error| unreadable(&error.to_string()))?;
    entries.iter().map(read_entry).collect()
}

fn read_entry(entry: &SignatureEntry) -> Result<SignatureInfo, RpcError> {
    let signature = entry
        .signature
        .parse::<Signature>()
        .map_err(|error| unreadable(&error.to_string()))?;
    let block_time = entry
        .block_time
        .map(Timestamp::from_second)
        .transpose()
        .map_err(|error| unreadable(&error.to_string()))?;
    Ok(SignatureInfo {
        signature,
        slot: entry.slot,
        block_time,
        is_failed: entry.err.is_some(),
    })
}

fn unreadable(detail: &str) -> RpcError {
    RpcError::UnexpectedResponse {
        method: METHOD.name(),
        detail: detail.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use binsight_core::clock::FixedClock;
    use binsight_core::credits::{Priority, Purpose};
    use serde_json::json;

    use super::*;
    use crate::test_support::{ScriptedReply, ScriptedTransport, scripted_client};

    #[test]
    fn reads_a_successful_and_a_failed_entry() {
        let first = Signature::from_bytes([7; 64]).to_string();
        let json = format!(
            r#"[{{"signature":"{first}","slot":300,"err":null,"memo":null,"blockTime":1790000000,
                 "confirmationStatus":"finalized"}},
                {{"signature":"{first}","slot":299,"err":{{"InstructionError":[0,"Custom"]}},
                 "blockTime":null}}]"#
        );

        let page = parse_page(&json).unwrap();

        assert_eq!(page.len(), 2);
        assert_eq!(page[0].signature.to_string(), first);
        assert_eq!(page[0].slot, 300);
        assert_eq!(
            page[0].block_time,
            Some(Timestamp::from_second(1_790_000_000).unwrap())
        );
        assert!(!page[0].is_failed);
        assert!(page[1].is_failed);
        assert_eq!(page[1].block_time, None);
    }

    #[test]
    fn reads_an_empty_page_as_nothing_older() {
        assert_eq!(parse_page("[]").unwrap(), Vec::new());
    }

    #[test]
    fn refuses_a_page_with_an_invalid_signature() {
        let error = parse_page(r#"[{"signature":"not-base58","slot":1}]"#).unwrap_err();
        assert!(matches!(error, RpcError::UnexpectedResponse { .. }));
    }

    #[tokio::test(start_paused = true)]
    async fn lists_the_page_older_than_the_given_signature() {
        let address = Address::from_bytes([4; 32]);
        let before = Signature::from_bytes([5; 64]);
        let transport = ScriptedTransport::new();
        transport
            .expect("getSignaturesForAddress")
            .with_params(json!([
                address.to_string(),
                {"limit": 1000, "commitment": "finalized", "before": before.to_string()}
            ]))
            .respond(ScriptedReply::Result(json!([])));
        let clock = Arc::new(FixedClock::new(Timestamp::UNIX_EPOCH));
        let context = CallContext {
            priority: Priority::CatchUp,
            purpose: Purpose::HistoryListing,
            wallet: Some(address),
        };
        let request = SignaturesRequest {
            address,
            before: Some(before),
        };

        let page = scripted_client(transport.clone(), clock, None)
            .signatures_for_address(request, context)
            .await;

        assert_eq!(page, Ok(Vec::new()));
        transport.assert_no_unexpected_calls();
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_a_null_page_instead_of_reading_it_as_the_end() {
        let address = Address::from_bytes([4; 32]);
        let transport = ScriptedTransport::new();
        transport
            .expect("getSignaturesForAddress")
            .respond(ScriptedReply::Null);
        let clock = Arc::new(FixedClock::new(Timestamp::UNIX_EPOCH));
        let context = CallContext {
            priority: Priority::CatchUp,
            purpose: Purpose::HistoryListing,
            wallet: Some(address),
        };
        let request = SignaturesRequest {
            address,
            before: None,
        };

        let page = scripted_client(transport.clone(), clock, None)
            .signatures_for_address(request, context)
            .await;

        assert!(matches!(page, Err(RpcError::UnexpectedResponse { .. })));
        assert_eq!(transport.calls().len(), 1);
    }
}
