//! Versions of published financial definitions, independently of their storage registration.
//!
//! Projection registration and rebuilding belong to the engine. This module does not assert
//! that a projection has already been persisted or that an earlier definition was deployed.

/// The positions definition: each position valued in its pool quote (SOL, then USDC, then USDT)
/// with independent source figures. Version 2 restored SOL as the first quote.
///
/// Change this version when the economic definition or calculated position values change.
pub const POSITIONS: u32 = 2;
