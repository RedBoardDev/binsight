//! `getTransaction`: one transaction, kept exactly as the node wrote it.
//!
//! Transactions are requested in `base64` (the signed bytes as they were sent, the same for every
//! node version) at `finalized` commitment (a rooted transaction can never disappear, so the
//! registry stays immutable), and up to the newest version binsight can read. The node's `result`
//! is returned untouched, next to the few fields the engine needs to file it. A `null` answer is
//! [`TransactionLookup::NotFound`]: the node does not have it yet, which is not the same as "it
//! does not exist". This module reads; decoding the transaction is the domain's job.

use binsight_solana::transaction::{MAX_SUPPORTED_TX_VERSION, TxEncoding, TxVersion};
use binsight_solana::{Commitment, Signature};
use jiff::Timestamp;
use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;

use crate::error::RpcError;
use crate::rpc::call::CallContext;
use crate::rpc::client::RpcClient;
use crate::rpc::envelope::RpcResult;
use crate::rpc::method::RpcMethod;
use crate::rpc::wire_names::{commitment_name, encoding_name};

/// The encoding transactions are requested in.
const TRANSACTION_ENCODING: TxEncoding = TxEncoding::Base64;

/// The commitment transactions are requested at.
const TRANSACTION_COMMITMENT: Commitment = Commitment::Finalized;

const METHOD: RpcMethod = RpcMethod::GetTransaction;

/// The answer to a transaction lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransactionLookup {
    /// The node returned the transaction.
    Found(RawTransaction),
    /// The node answered `null`: it does not have the transaction (yet).
    NotFound,
}

/// A transaction as the node returned it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawTransaction {
    /// The signature that was looked up.
    pub signature: Signature,
    /// The slot it landed in.
    pub slot: u64,
    /// When its block was produced, if the node knows.
    pub block_time: Option<Timestamp>,
    /// Its format version.
    pub version: TxVersion,
    /// Whether it failed (it still landed and paid its fee).
    pub is_failed: bool,
    /// The encoding it was requested in.
    pub encoding: TxEncoding,
    /// The commitment it was requested at.
    pub commitment: Commitment,
    /// The node's `result`, exactly as written.
    pub result_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionFields {
    slot: u64,
    #[serde(default)]
    block_time: Option<i64>,
    #[serde(default)]
    version: Option<Value>,
    #[serde(default)]
    meta: Option<MetaFields>,
}

#[derive(Deserialize)]
struct MetaFields {
    #[serde(default)]
    err: Option<Box<RawValue>>,
}

impl RpcClient {
    /// Looks up one transaction by signature.
    ///
    /// # Errors
    ///
    /// Returns [`RpcError::UnsupportedTransactionVersion`] if the transaction is newer than
    /// binsight can read, or another [`RpcError`] if the call fails after its retries or the
    /// answer cannot be read.
    pub async fn transaction(
        &self,
        signature: Signature,
        context: CallContext,
    ) -> Result<TransactionLookup, RpcError> {
        let params = serde_json::json!([
            signature.to_string(),
            {
                "encoding": encoding_name(TRANSACTION_ENCODING),
                "commitment": commitment_name(TRANSACTION_COMMITMENT),
                "maxSupportedTransactionVersion": MAX_SUPPORTED_TX_VERSION,
            }
        ]);
        match self.call(METHOD, &params, &context).await? {
            RpcResult::Null => Ok(TransactionLookup::NotFound),
            RpcResult::Value(raw) => read_transaction(signature, raw).map(TransactionLookup::Found),
        }
    }
}

/// Reads the filing fields and keeps the whole result.
fn read_transaction(signature: Signature, raw: Box<RawValue>) -> Result<RawTransaction, RpcError> {
    let fields: TransactionFields =
        serde_json::from_str(raw.get()).map_err(|error| unreadable(&error.to_string()))?;
    let block_time = fields
        .block_time
        .map(Timestamp::from_second)
        .transpose()
        .map_err(|error| unreadable(&error.to_string()))?;
    Ok(RawTransaction {
        signature,
        slot: fields.slot,
        block_time,
        version: read_version(fields.version.as_ref())?,
        is_failed: fields.meta.is_some_and(|meta| meta.err.is_some()),
        encoding: TRANSACTION_ENCODING,
        commitment: TRANSACTION_COMMITMENT,
        result_json: String::from(Box::<str>::from(raw)),
    })
}

/// Reads the `version` field: `"legacy"`, a version number, or absent for a legacy transaction.
fn read_version(version: Option<&Value>) -> Result<TxVersion, RpcError> {
    match version {
        None => Ok(TxVersion::Legacy),
        Some(Value::String(text)) if text == "legacy" => Ok(TxVersion::Legacy),
        Some(Value::Number(number)) => number
            .as_u64()
            .and_then(|number| u8::try_from(number).ok())
            .and_then(|number| TxVersion::try_from(number).ok())
            .ok_or_else(|| unreadable(&format!("unknown transaction version {number}"))),
        Some(other) => Err(unreadable(&format!("unknown transaction version {other}"))),
    }
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

    fn fetch_context() -> CallContext {
        CallContext {
            priority: Priority::History,
            purpose: Purpose::TransactionFetch,
            wallet: None,
        }
    }

    fn client(transport: &Arc<ScriptedTransport>) -> RpcClient {
        let clock = Arc::new(FixedClock::new(Timestamp::UNIX_EPOCH));
        scripted_client(transport.clone(), clock, None)
    }

    fn read(json: &str) -> Result<RawTransaction, RpcError> {
        let raw = RawValue::from_string(json.to_owned()).unwrap();
        read_transaction(Signature::from_bytes([3; 64]), raw)
    }

    #[test]
    fn keeps_the_result_byte_for_byte_and_reads_its_filing_fields() {
        let json = r#"{"blockTime":1790000000,"meta":{"err":null,"fee":5000},"slot":312,
                       "transaction":["AQID","base64"],"transactionIndex":17,"version":0}"#;

        let transaction = read(json).unwrap();

        assert_eq!(transaction.result_json, json);
        assert_eq!(transaction.slot, 312);
        assert_eq!(
            transaction.block_time,
            Some(Timestamp::from_second(1_790_000_000).unwrap())
        );
        assert_eq!(transaction.version, TxVersion::V0);
        assert!(!transaction.is_failed);
        assert_eq!(transaction.encoding, TxEncoding::Base64);
        assert_eq!(transaction.commitment, Commitment::Finalized);
    }

    #[test]
    fn reads_legacy_and_version_1_transactions_and_failures() {
        let legacy =
            read(r#"{"slot":1,"version":"legacy","meta":{"err":{"InstructionError":[0,"x"]}}}"#)
                .unwrap();
        assert_eq!(legacy.version, TxVersion::Legacy);
        assert!(legacy.is_failed);

        let version_1 = read(r#"{"slot":1,"version":1,"meta":null}"#).unwrap();
        assert_eq!(version_1.version, TxVersion::V1);
        assert!(!version_1.is_failed);
    }

    #[test]
    fn refuses_a_version_binsight_cannot_read() {
        assert!(matches!(
            read(r#"{"slot":1,"version":2}"#),
            Err(RpcError::UnexpectedResponse { .. })
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn asks_for_a_finalized_base64_transaction_up_to_version_1() {
        let signature = Signature::from_bytes([2; 64]);
        let transport = ScriptedTransport::new();
        transport
            .expect("getTransaction")
            .with_params(json!([
                signature.to_string(),
                {"encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": 1}
            ]))
            .respond(ScriptedReply::Result(json!({"slot": 9, "version": 1, "meta": {"err": null}})));

        let outcome = client(&transport)
            .transaction(signature, fetch_context())
            .await
            .unwrap();

        let TransactionLookup::Found(transaction) = outcome else {
            panic!("not found");
        };
        assert_eq!(transaction.version, TxVersion::V1);
        transport.assert_no_unexpected_calls();
    }

    #[tokio::test(start_paused = true)]
    async fn parks_a_transaction_too_new_to_read_without_retrying() {
        let transport = ScriptedTransport::new();
        transport
            .expect("getTransaction")
            .respond(ScriptedReply::RpcError {
                code: -32015,
                message: "Transaction version (2) is not supported".to_owned(),
            });

        let outcome = client(&transport)
            .transaction(Signature::from_bytes([1; 64]), fetch_context())
            .await;

        assert_eq!(outcome, Err(RpcError::UnsupportedTransactionVersion));
        assert_eq!(transport.calls().len(), 1);
    }
}
