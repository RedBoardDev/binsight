//! Every byte sequence a JSON answer can hide an address in.
//!
//! A node writes binary data in several ways: base64 (the transaction, account data, `Program
//! data:` log lines), base58 (instruction data, addresses), hexadecimal and decimal byte lists
//! (`[12, 34, …]`, in program logs or as JSON number arrays). This module decodes each of them
//! into bytes so the privacy guard can search them; it does not decide what is private.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

/// The shortest byte sequence worth decoding from hexadecimal or decimal: one address.
const MIN_BYTES: usize = 32;

/// Every byte sequence `value` holds, in any of the forms a node writes binary data in.
pub(crate) fn binary_forms(value: &Value) -> Vec<Vec<u8>> {
    let mut forms = Vec::new();
    collect(value, &mut forms);
    forms
}

fn collect(value: &Value, forms: &mut Vec<Vec<u8>>) {
    match value {
        Value::String(text) => forms.extend(text_forms(text)),
        Value::Array(items) => {
            forms.extend(number_array(items));
            for item in items {
                collect(item, forms);
            }
        }
        Value::Object(fields) => {
            for item in fields.values() {
                collect(item, forms);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// The bytes `text` stands for: each word as base64 and base58, every hexadecimal run and every
/// decimal byte list.
fn text_forms(text: &str) -> Vec<Vec<u8>> {
    let words = text.split_whitespace().flat_map(|word| {
        [
            STANDARD.decode(word).ok(),
            bs58::decode(word).into_vec().ok(),
        ]
    });
    let mut forms: Vec<Vec<u8>> = words.flatten().collect();
    forms.extend(hexadecimal_runs(text));
    forms.extend(decimal_byte_lists(text));
    forms
}

/// A JSON array of numbers that are all bytes, such as `[12, 34, …]`.
fn number_array(items: &[Value]) -> Option<Vec<u8>> {
    if items.len() < MIN_BYTES {
        return None;
    }
    items
        .iter()
        .map(|item| item.as_u64().and_then(|number| u8::try_from(number).ok()))
        .collect()
}

/// The bytes of every run of hexadecimal digits long enough to hold an address, read from both
/// digit alignments (an address may start at an odd digit of a longer run).
fn hexadecimal_runs(text: &str) -> Vec<Vec<u8>> {
    let mut forms = Vec::new();
    for run in text
        .split(|character: char| !character.is_ascii_hexdigit())
        .filter(|run| run.len() >= 2 * MIN_BYTES)
    {
        for alignment in [0, 1] {
            let digits = run.get(alignment..).unwrap_or_default();
            forms.push(hexadecimal_pairs(digits));
        }
    }
    forms
}

/// The bytes of `digits` read two by two, ignoring a last odd digit.
fn hexadecimal_pairs(digits: &str) -> Vec<u8> {
    digits
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .filter_map(|pair| {
            let pair = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(pair, 16).ok()
        })
        .collect()
}

/// The bytes of every list of decimal numbers below 256 separated by commas or spaces, such as
/// the `[12, 34, …]` a program logs.
fn decimal_byte_lists(text: &str) -> Vec<Vec<u8>> {
    let mut forms = Vec::new();
    let mut current = Vec::new();
    let is_separator = |character: char| character == ',' || character.is_whitespace();
    for piece in
        text.split(|character: char| !character.is_ascii_digit() && !is_separator(character))
    {
        for number in piece
            .split(is_separator)
            .filter(|number| !number.is_empty())
        {
            match number.parse::<u8>() {
                Ok(byte) => current.push(byte),
                Err(_) => flush(&mut current, &mut forms),
            }
        }
        flush(&mut current, &mut forms);
    }
    forms
}

/// Keeps the list `current` if it is long enough to hold an address, and starts a new one.
fn flush(current: &mut Vec<u8>, forms: &mut Vec<Vec<u8>>) {
    let list = std::mem::take(current);
    if list.len() >= MIN_BYTES {
        forms.push(list);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADDRESS: [u8; 32] = [
        200, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
        25, 26, 27, 28, 29, 30, 255,
    ];

    fn holds_the_address(value: &Value) -> bool {
        binary_forms(value)
            .iter()
            .any(|form| form.windows(ADDRESS.len()).any(|window| window == ADDRESS))
    }

    fn hexadecimal(bytes: &[u8]) -> String {
        let pairs: Vec<String> = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        pairs.concat()
    }

    #[test]
    fn finds_an_address_written_in_hexadecimal_at_any_digit() {
        let even = format!("Program log: 0x{}", hexadecimal(&ADDRESS));
        let odd = format!("Program log: f{}", hexadecimal(&ADDRESS));
        assert!(holds_the_address(&Value::String(even)));
        assert!(holds_the_address(&Value::String(odd)));
    }

    #[test]
    fn finds_an_address_written_as_a_decimal_byte_list() {
        let list: Vec<String> = ADDRESS.iter().map(ToString::to_string).collect();
        let log = format!("Program log: owner: [{}]", list.join(", "));
        assert!(holds_the_address(&Value::String(log)));
    }

    #[test]
    fn finds_an_address_written_as_a_json_number_array() {
        let array = Value::Array(ADDRESS.iter().map(|&byte| byte.into()).collect());
        assert!(holds_the_address(&serde_json::json!({ "data": array })));
    }

    #[test]
    fn finds_an_address_in_base64_and_base58_words() {
        let base64 = format!("Program data: {}", STANDARD.encode(ADDRESS));
        let base58 = bs58::encode(ADDRESS).into_string();
        assert!(holds_the_address(&Value::String(base64)));
        assert!(holds_the_address(&Value::String(base58)));
    }

    #[test]
    fn breaks_a_decimal_list_at_a_number_that_is_not_a_byte() {
        let mut numbers: Vec<String> = ADDRESS.iter().map(ToString::to_string).collect();
        numbers.insert(16, "256".to_owned());
        let log = Value::String(numbers.join(","));
        assert!(!holds_the_address(&log));
    }
}
