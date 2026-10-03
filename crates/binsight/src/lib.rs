//! # binsight
//!
//! **Responsibility:** the composition root and the command line. It reads the configuration, wires
//! the store, the chain client, the engine and the API together, embeds the web app and offers the
//! `init`, `run` and `admin` commands.
//!
//! **May depend on:** every binsight crate.
//! **Must not be depended on:** it is the top of the dependency graph.
//! (Checked in CI by `cargo xtask layering`.)
//!
//! The binary (`main.rs`) only parses the command line and turns the outcome into an exit code;
//! everything else lives in this library, so it can be tested. **Start here:** [`commands`].

pub mod cli;
pub mod commands;
pub mod config;
pub mod data_dir;
pub mod failure;
pub mod instance_secrets;
pub mod logging;
pub mod output;
pub mod shutdown;
pub mod web_assets;
