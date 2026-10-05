//! Union lookup agrees with individual lifetimes at opening, closing and gap boundaries.

use super::*;
use proptest::prelude::*;

fn lifetime(opened: i64, closed: Option<i64>) -> PositionLifetime {
    PositionLifetime {
        opened_at: Timestamp::from_second(opened).unwrap(),
        closed_at: closed.map(|closed| Timestamp::from_second(closed).unwrap()),
    }
}

#[test]
fn merges_overlapping_and_touching_lifetimes_but_preserves_real_gaps() {
    let exposure = OpenExposure::from_lifetimes(vec![
        lifetime(30, None),
        lifetime(5, Some(15)),
        lifetime(0, Some(10)),
        lifetime(15, Some(20)),
    ]);
    assert_eq!(exposure.intervals.len(), 2);
    for (instant, is_open) in [
        (0, true),
        (19, true),
        (20, false),
        (29, false),
        (30, true),
        (90, true),
    ] {
        assert_eq!(
            exposure.is_open_at(Timestamp::from_second(instant).unwrap()),
            is_open
        );
    }
}

#[test]
fn keeps_an_instantaneous_shell_as_activity_without_open_exposure() {
    let exposure = OpenExposure::from_lifetimes(vec![lifetime(10, Some(10))]);
    assert_eq!(
        exposure.first_activity(),
        Some(Timestamp::from_second(10).unwrap())
    );
    assert_eq!(exposure.intervals, Vec::<PositionLifetime>::new());
    assert!(!exposure.is_open_at(Timestamp::from_second(10).unwrap()));
}

proptest! {
    #[test]
    fn the_union_preserves_whether_any_lifetime_is_open(
        spans in prop::collection::vec((0_i64..100, prop::option::of(0_i64..100)), 0..50),
        instant in 0_i64..150,
    ) {
        let lifetimes: Vec<_> = spans.into_iter().map(|(opened, closed)| {
            lifetime(opened, closed.map(|closed| closed.max(opened)))
        }).collect();
        let at = Timestamp::from_second(instant).unwrap();
        let expected = lifetimes.iter().any(|life| {
            life.opened_at <= at && life.closed_at.is_none_or(|closed| at < closed)
        });
        let exposure = OpenExposure::from_lifetimes(lifetimes);
        prop_assert_eq!(exposure.is_open_at(at), expected);
    }
}
