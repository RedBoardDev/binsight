//! The syntax of a `binsight.env` file: `NAME=value` lines, read literally.
//!
//! The format is the common `.env` one: blank lines and `#` comments are skipped, `export ` in
//! front of a name is allowed, a value may be single-quoted (taken as is), double-quoted (where
//! `\"`, `\\` and `\n` are escapes) or bare (ending at a space before a `#` comment), and quoted
//! parts may be joined, as in `'it'\''s'`. Unlike most `.env` readers, a `$` is just a character:
//! nothing is ever replaced by another variable, so a password typed by hand arrives intact.
//! Each value fits on one line. This module only parses text; reading the file is the caller's.

use std::collections::BTreeMap;

/// A line of the file that cannot be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("line {line}: {problem}")]
pub(crate) struct EnvFileError {
    /// The line number, from 1.
    line: usize,
    /// What is wrong with it.
    problem: &'static str,
}

/// The quoting in effect while reading a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Quoting {
    Bare,
    Single,
    Double,
}

/// The variables set by `text`, the content of an env file. A name set twice keeps its last
/// value.
pub(crate) fn parse_env_file(text: &str) -> Result<BTreeMap<String, String>, EnvFileError> {
    let mut values = BTreeMap::new();
    for (index, line) in text.lines().enumerate() {
        let parsed = parse_line(line).map_err(|problem| EnvFileError {
            line: index.saturating_add(1),
            problem,
        })?;
        if let Some((name, value)) = parsed {
            values.insert(name.to_owned(), value);
        }
    }
    Ok(values)
}

/// The name and value set by `line`, or `None` for a blank line or a comment.
fn parse_line(line: &str) -> Result<Option<(&str, String)>, &'static str> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return Ok(None);
    }
    let line = line
        .strip_prefix("export")
        .filter(|rest| rest.starts_with([' ', '\t']))
        .map_or(line, str::trim_start);
    let (name, value) = line.split_once('=').ok_or("expected NAME=value")?;
    let name = name.trim_end();
    if !is_variable_name(name) {
        return Err("a name holds letters, digits, `_` and `.`, and starts with a letter or `_`");
    }
    Ok(Some((name, parse_value(value.trim_start())?)))
}

/// Whether `name` can be the name of a variable.
fn is_variable_name(name: &str) -> bool {
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|other| other.is_ascii_alphanumeric() || other == '_' || other == '.')
}

/// The value written as `text` (everything after the `=`).
fn parse_value(text: &str) -> Result<String, &'static str> {
    if text.starts_with('#') {
        return Ok(String::new());
    }
    let mut value = String::new();
    let mut quoting = Quoting::Bare;
    let mut characters = text.chars();
    while let Some(character) = characters.next() {
        match (quoting, character) {
            (Quoting::Single, '\'') | (Quoting::Double, '"') => quoting = Quoting::Bare,
            (Quoting::Bare, '\'') => quoting = Quoting::Single,
            (Quoting::Bare, '"') => quoting = Quoting::Double,
            (Quoting::Bare | Quoting::Double, '\\') => value.push(unescape(characters.next())?),
            (Quoting::Bare, ' ' | '\t') => {
                let rest = characters.as_str().trim_start();
                return if rest.is_empty() || rest.starts_with('#') {
                    Ok(value)
                } else {
                    Err("a value with spaces must be quoted")
                };
            }
            _ => value.push(character),
        }
    }
    match quoting {
        Quoting::Bare => Ok(value),
        Quoting::Single | Quoting::Double => Err("a quote is not closed; a value fits on one line"),
    }
}

/// The character that `\<escaped>` stands for.
fn unescape(escaped: Option<char>) -> Result<char, &'static str> {
    match escaped {
        Some(character @ ('\\' | '\'' | '"' | '$' | ' ')) => Ok(character),
        Some('n') => Ok('\n'),
        _ => Err("unknown escape; quote the value with single quotes to take it as is"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value_of(line: &str) -> String {
        let values = parse_env_file(line).unwrap();
        values.get("KEY").cloned().unwrap()
    }

    #[test]
    fn keeps_a_dollar_sign_as_it_is_in_every_quoting() {
        for line in [
            r"KEY=pa$$w0rd$HOME${USER}",
            r#"KEY="pa$$w0rd$HOME${USER}""#,
            r"KEY='pa$$w0rd$HOME${USER}'",
        ] {
            assert_eq!(value_of(line), "pa$$w0rd$HOME${USER}", "{line}");
        }
    }

    #[test]
    fn reads_quotes_escapes_and_joined_parts() {
        assert_eq!(
            value_of(r#"KEY="with spaces and # hash""#),
            "with spaces and # hash"
        );
        assert_eq!(
            value_of(r#"KEY="a \"quoted\" \\ word""#),
            r#"a "quoted" \ word"#
        );
        assert_eq!(value_of(r"KEY='it'\''s'"), "it's");
        assert_eq!(value_of(r"KEY='single \ stays'"), r"single \ stays");
        assert_eq!(value_of(r"KEY=a\ b"), "a b");
    }

    #[test]
    fn skips_comments_blank_lines_and_export() {
        let values = parse_env_file(
            "# a comment\n\n  export FIRST='1'\nSECOND = 2 # trailing comment\nTHIRD=#only a comment\nexport=4\n",
        )
        .unwrap();

        assert_eq!(values["FIRST"], "1");
        assert_eq!(values["SECOND"], "2");
        assert_eq!(values["THIRD"], "");
        assert_eq!(values["export"], "4");
    }

    #[test]
    fn keeps_a_hash_inside_a_bare_value() {
        assert_eq!(value_of("KEY=a#b"), "a#b");
    }

    #[test]
    fn names_the_line_it_cannot_read() {
        for (text, line) in [
            ("OK=1\nNOT A SETTING\n", 2),
            ("KEY=two words", 1),
            ("KEY='never closed", 1),
            (r"KEY=bad\escape", 1),
            ("1KEY=x", 1),
        ] {
            assert_eq!(parse_env_file(text).unwrap_err().line, line, "{text}");
        }
    }
}
