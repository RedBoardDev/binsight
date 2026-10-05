//! The name and version under which binsight stores what this crate decodes.
//!
//! Every decoded event is stored with the name and version of the decoder that produced it. When
//! the output of [`crate::event::decode_events`] or [`crate::activity::position_activity`]
//! changes for any transaction (a new event, a corrected rule), the version goes up, and the
//! engine decodes the stored transactions again, without fetching anything.

/// The name of this decoder, which also prefixes the kind of each stored event (`dlmm.swap`).
pub const DECODER_NAME: &str = "dlmm";

/// The version of this decoder's output; it starts at 1 and only goes up.
pub const DECODER_VERSION: u32 = 2;
