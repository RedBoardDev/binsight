//! Reading the token accounts' amounts on chain, a hundred accounts per request.
//!
//! Only the eight bytes of the amount are asked for each account. An account that no longer
//! exists, or that no token program owns any more, holds no amount. The reads are history work:
//! a comparison the budget defers waits, it is never dropped. This module reads; the rules
//! compare.

use binsight_chain::{ACCOUNT_BATCH_LIMIT, AccountBatch, AccountData, CallContext, DataSlice};
use binsight_core::credits::{Priority, Purpose};
use binsight_solana::Address;
use binsight_solana::programs::TokenProgram;
use binsight_solana::programs::token_account::{AMOUNT_LENGTH, AMOUNT_OFFSET, amount_from_slice};

use super::balance_rules::OnChain;
use crate::ingestion::Ingestion;
use crate::ingestion::listing::{PageError, page_error_of};

/// The class the comparison reads at.
pub(super) const CHECK_CLASS: Priority = Priority::History;

/// What the chain holds in each of `accounts`, in their order.
pub(super) async fn read_amounts(
    ingestion: &Ingestion,
    accounts: &[Address],
) -> Result<Vec<OnChain>, PageError> {
    let context = CallContext {
        priority: CHECK_CLASS,
        purpose: Purpose::BalanceCheck,
        wallet: None,
    };
    let slice = DataSlice {
        offset: AMOUNT_OFFSET,
        length: AMOUNT_LENGTH,
    };
    let mut amounts = Vec::with_capacity(accounts.len());
    for chunk in accounts.chunks(ACCOUNT_BATCH_LIMIT) {
        // A chunk is never empty nor longer than the limit, so the batch always parses.
        let Ok(batch) = AccountBatch::new(chunk.to_vec()) else {
            continue;
        };
        let read = ingestion
            .rpc
            .multiple_accounts(&batch, Some(slice), context)
            .await
            .map_err(|error| page_error_of(error, ingestion.clock.now()))?;
        amounts.extend(read.accounts.iter().map(|account| OnChain {
            slot: read.slot,
            amount: account.as_ref().and_then(token_amount),
        }));
    }
    Ok(amounts)
}

/// The amount `account` holds, if a token program owns it.
fn token_amount(account: &AccountData) -> Option<binsight_core::units::RawTokenAmount> {
    TokenProgram::of(account.owner)?;
    amount_from_slice(&account.data)
}
