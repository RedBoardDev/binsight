//! `binsight init`: writes a configuration file with the two required secrets.
//!
//! It is interactive on purpose: secrets are typed without echo instead of passed as arguments
//! (which would land in the shell history). Without a terminal it refuses and points to the
//! environment variables instead. It never overwrites an existing file unless `--force` is given.

mod env_file;
mod prompts;

use std::io::IsTerminal;
use std::path::Path;

use crate::config::config_file_path;
use crate::failure::Failure;
use crate::output::print_line;
use env_file::{render_env_file, write_private_file};
use prompts::{ask_helius_api_key, ask_password};

/// Asks for the secrets and writes the configuration file.
pub(super) fn execute(config_file: Option<&Path>, overwrite: bool) -> Result<(), Failure> {
    let Some(path) = config_file_path(config_file) else {
        return Err(Failure::Usage(
            "HOME is not set, so there is no default configuration file; pass --config-file"
                .to_owned(),
        ));
    };
    if path.exists() && !overwrite {
        return Err(Failure::Usage(format!(
            "{} already exists; edit it, or run `binsight init --force` to replace it",
            path.display()
        )));
    }
    if !std::io::stdin().is_terminal() {
        return Err(Failure::Usage(
            "`binsight init` asks questions and needs a terminal; without one, set \
             BINSIGHT_PASSWORD and BINSIGHT_HELIUS_API_KEY in the environment instead"
                .to_owned(),
        ));
    }
    let helius_api_key = ask_helius_api_key()?;
    let password = ask_password()?;
    write_private_file(&path, &render_env_file(&helius_api_key, &password))
        .map_err(|error| Failure::io(format!("write {}", path.display()), error))?;
    print_line(&format!("Configuration written to {}", path.display()));
    print_line("Start binsight with: binsight run");
    Ok(())
}
