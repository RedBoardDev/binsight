//! The plumbing between the repositories and SQLite: the connection pools, the conversions to
//! and from column types, and (for tests) a migrated throw-away database.
//!
//! Nothing here knows a table of the application: the repositories own their SQL and use these
//! parts to run it. This module only groups them.

pub(crate) mod codec;
mod pools;
#[cfg(test)]
pub(crate) mod test_database;

pub(crate) use pools::Database;
