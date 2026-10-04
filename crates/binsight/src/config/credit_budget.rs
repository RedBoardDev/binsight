//! The RPC credit settings: the Helius plan, the credits it grants per cycle, the day the cycle
//! starts, and the optional hard daily limit.
//!
//! The plan sets the request rate and, unless the owner says otherwise, the monthly credits. The
//! cycle day says when they reset (Helius resets them on the day the subscription started), so
//! the budget spreads what is left over the right number of days. The daily limit is a guard:
//! once it is spent, binsight sends nothing until the next UTC day, so a development run or a
//! runaway loop cannot eat the month. This module reads and checks the four values; the chain
//! client enforces them.

use binsight_chain::{BillingCycleDay, HeliusPlan};
use binsight_core::credits::Credits;

use super::problems::{Setting, Source};
use super::validate::SettingReader;

/// The plan the server assumes when none is configured.
const DEFAULT_PLAN: HeliusPlan = HeliusPlan::Free;

/// How binsight may spend the provider's credits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreditBudget {
    /// The Helius plan of the API key.
    pub plan: HeliusPlan,
    /// The credits a billing cycle grants.
    pub monthly_credits: Credits,
    /// The day of the month billing cycles start on.
    pub cycle_day: BillingCycleDay,
    /// The most credits spent per UTC day, if limited.
    pub daily_credit_limit: Option<Credits>,
}

impl SettingReader<'_> {
    /// Reads the plan, the monthly credits (by default, the plan's) and the daily limit.
    pub(super) fn credit_budget(&mut self) -> Option<CreditBudget> {
        let plan = self.with_default(
            Setting::HeliusPlan,
            DEFAULT_PLAN.as_str(),
            str::parse::<HeliusPlan>,
        );
        let monthly_credits = if self.find(Setting::MonthlyCredits).is_some() {
            self.optional(Setting::MonthlyCredits, parse_credits)
        } else {
            self.origins
                .insert(Setting::MonthlyCredits, Source::Default);
            plan.map(HeliusPlan::monthly_credits)
        };
        let cycle_day = self.with_default(Setting::CreditCycleDay, "1", parse_cycle_day);
        let daily_credit_limit = self.optional(Setting::DailyCreditLimit, parse_credits);
        Some(CreditBudget {
            plan: plan?,
            monthly_credits: monthly_credits?,
            cycle_day: cycle_day?,
            daily_credit_limit,
        })
    }
}

/// A number of credits: digits only, at least 1.
fn parse_credits(text: &str) -> Result<Credits, String> {
    let is_digits = !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    match text.parse::<u64>() {
        Ok(credits) if is_digits && credits >= 1 => Ok(Credits(credits)),
        _ => Err(format!(
            "{text:?} is not a number of credits (a whole number, at least 1)"
        )),
    }
}

/// A day of the month a billing cycle can start on: digits only, from 1 to 28.
fn parse_cycle_day(text: &str) -> Result<BillingCycleDay, String> {
    let is_digits = !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    text.parse::<u8>()
        .ok()
        .filter(|_| is_digits)
        .and_then(|day| BillingCycleDay::try_from(day).ok())
        .ok_or_else(|| format!("{text:?} is not a day of the month from 1 to 28"))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::*;
    use crate::config::{ConfigFile, ConfigSources, validate};

    const PASSWORD: &str = "correct horse battery staple";
    const KEY: &str = "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d";

    fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn sources(env: &[(&str, &str)], file: Option<&[(&str, &str)]>) -> ConfigSources {
        ConfigSources {
            env: values(env),
            file: file.map(|pairs| ConfigFile {
                path: PathBuf::from("/etc/binsight/binsight.env"),
                values: values(pairs),
                is_readable_by_others: false,
            }),
        }
    }

    #[test]
    fn reads_a_whole_number_of_credits() {
        assert_eq!(parse_credits("5000"), Ok(Credits(5_000)));
    }

    #[test]
    fn refuses_zero_a_fraction_or_a_sign() {
        for text in ["0", "1.5", "-3", "+3", "five", ""] {
            assert!(parse_credits(text).is_err(), "{text}");
        }
    }

    #[test]
    fn reads_a_cycle_day_every_month_has() {
        assert_eq!(parse_cycle_day("28").map(BillingCycleDay::get), Ok(28));
        for text in ["0", "29", "+3", "1.5", ""] {
            assert!(parse_cycle_day(text).is_err(), "{text}");
        }
    }

    #[test]
    fn spends_the_free_plan_credits_without_a_daily_limit_by_default() {
        let loaded = validate(&sources(
            &[
                ("HOME", "/home/owner"),
                ("BINSIGHT_PASSWORD", PASSWORD),
                ("BINSIGHT_HELIUS_API_KEY", KEY),
            ],
            None,
        ))
        .unwrap();

        let budget = loaded.config.credit_budget;
        assert_eq!(budget.plan, HeliusPlan::Free);
        assert_eq!(budget.monthly_credits, Credits(1_000_000));
        assert_eq!(budget.cycle_day, BillingCycleDay::FIRST);
        assert_eq!(budget.daily_credit_limit, None);
        assert_eq!(
            loaded.config.origins[&Setting::MonthlyCredits],
            Source::Default
        );
    }

    #[test]
    fn reads_the_plan_its_monthly_credits_and_a_daily_limit() {
        let loaded = validate(&sources(
            &[
                ("HOME", "/home/owner"),
                ("BINSIGHT_PASSWORD", PASSWORD),
                ("BINSIGHT_HELIUS_API_KEY", KEY),
                ("BINSIGHT_HELIUS_PLAN", "developer"),
                ("BINSIGHT_CREDIT_CYCLE_DAY", "17"),
                ("BINSIGHT_DAILY_CREDIT_LIMIT", "5000"),
            ],
            Some(&[("BINSIGHT_MONTHLY_CREDITS", "2500000")]),
        ))
        .unwrap();

        let budget = loaded.config.credit_budget;
        assert_eq!(budget.plan, HeliusPlan::Developer);
        assert_eq!(budget.monthly_credits, Credits(2_500_000));
        assert_eq!(budget.cycle_day.get(), 17);
        assert_eq!(budget.daily_credit_limit, Some(Credits(5_000)));
    }

    #[test]
    fn refuses_an_unknown_plan_and_a_daily_limit_of_nothing() {
        let error = validate(&sources(
            &[
                ("HOME", "/home/owner"),
                ("BINSIGHT_PASSWORD", PASSWORD),
                ("BINSIGHT_HELIUS_API_KEY", KEY),
                ("BINSIGHT_HELIUS_PLAN", "Free"),
                ("BINSIGHT_DAILY_CREDIT_LIMIT", "0"),
            ],
            None,
        ))
        .unwrap_err();

        insta::assert_snapshot!(error.to_string(), @r#"
        the configuration is invalid:
          - BINSIGHT_HELIUS_PLAN: "Free" is not a known Helius plan (set in the environment)
          - BINSIGHT_DAILY_CREDIT_LIMIT: "0" is not a number of credits (a whole number, at least 1) (set in the environment)
        "#);
    }
}
