//! Charge only the payer and keep inclusion tips separate from transaction fees.
use super::instructions::{Decoded, native_transfer};
use super::worksheet::Worksheet;
use super::{Asset, BookError, EntryKind};
use binsight_solana::Address;
use binsight_solana::transaction::TransactionView;
use binsight_solana::well_known::JITO_TIP_ACCOUNTS;

pub(super) fn failed(
    wallet: Address,
    tx: &TransactionView,
    sheet: &mut Worksheet,
) -> Result<(), BookError> {
    if tx.fee_payer == wallet {
        sheet.book(
            Asset::Sol,
            0_i128
                .checked_sub(i128::from(tx.fee.total.0))
                .ok_or(BookError::Overflow)?,
            EntryKind::FailedTxFee,
        )?;
    }
    Ok(())
}

pub(super) fn successful(
    wallet: Address,
    tx: &TransactionView,
    decoded: &Decoded,
    sheet: &mut Worksheet,
) -> Result<(), BookError> {
    if tx.fee_payer == wallet {
        sheet.book(
            Asset::Sol,
            0_i128
                .checked_sub(i128::from(tx.fee.base.0))
                .ok_or(BookError::Overflow)?,
            EntryKind::NetworkFee,
        )?;
        sheet.book(
            Asset::Sol,
            0_i128
                .checked_sub(i128::from(tx.fee.priority.0))
                .ok_or(BookError::Overflow)?,
            EntryKind::PriorityFee,
        )?;
    }
    for (_, instruction) in decoded {
        if let Some((from, to, amount)) = native_transfer(instruction)
            && from == wallet
            && JITO_TIP_ACCOUNTS.contains(&to)
        {
            sheet.book(
                Asset::Sol,
                amount.checked_neg().ok_or(BookError::Overflow)?,
                EntryKind::Tip,
            )?;
        }
    }
    Ok(())
}
