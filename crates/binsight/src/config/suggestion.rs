//! Suggests the variable a misspelt `BINSIGHT_` name probably meant.
//!
//! The suggestion is the known variable at the smallest edit distance, if that distance is small
//! enough to be a typo. This module only compares names.

use super::problems::Setting;

/// The largest number of single-character edits still considered a typo.
const MAX_TYPO_DISTANCE: usize = 3;

/// The known variable closest to `name`, if `name` looks like a typo of it.
pub(crate) fn closest_variable(name: &str) -> Option<&'static str> {
    Setting::ALL
        .iter()
        .map(|setting| setting.variable())
        .map(|known| (edit_distance(name, known), known))
        .filter(|(distance, _)| *distance <= MAX_TYPO_DISTANCE)
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, known)| known)
}

/// The Levenshtein distance between two strings, counted in characters.
fn edit_distance(first: &str, second: &str) -> usize {
    let second: Vec<char> = second.chars().collect();
    let mut previous: Vec<usize> = (0..=second.len()).collect();
    for (row, first_char) in first.chars().enumerate() {
        let mut current = vec![row.saturating_add(1)];
        for (column, second_char) in second.iter().enumerate() {
            let substitution = previous.get(column).map_or(usize::MAX, |cost| {
                cost.saturating_add(usize::from(first_char != *second_char))
            });
            let deletion = previous
                .get(column.saturating_add(1))
                .map_or(usize::MAX, |cost| cost.saturating_add(1));
            let insertion = current
                .last()
                .map_or(usize::MAX, |cost| cost.saturating_add(1));
            current.push(substitution.min(deletion).min(insertion));
        }
        previous = current;
    }
    previous.last().copied().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_single_character_edits() {
        assert_eq!(edit_distance("kitten", "sitting"), 3);
        assert_eq!(edit_distance("", "abc"), 3);
        assert_eq!(edit_distance("same", "same"), 0);
    }

    #[test]
    fn suggests_the_variable_a_typo_meant() {
        assert_eq!(
            closest_variable("BINSIGHT_PASWORD"),
            Some("BINSIGHT_PASSWORD")
        );
        assert_eq!(
            closest_variable("BINSIGHT_DATADIR"),
            Some("BINSIGHT_DATA_DIR")
        );
    }

    #[test]
    fn suggests_nothing_for_an_unrelated_name() {
        assert_eq!(closest_variable("BINSIGHT_SOMETHING_ELSE"), None);
    }
}
