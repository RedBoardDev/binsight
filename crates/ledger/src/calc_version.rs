//! Versions of published financial definitions, independently of their storage registration.
//!
//! Projection registration and rebuilding belong to the engine. This module does not assert
//! that a projection has already been persisted or that an earlier definition was deployed.

/// The first positions definition: stablecoin-native valuation and independent source figures.
///
/// Change this version when the economic definition or calculated position values change.
pub const POSITIONS: u32 = 1;
