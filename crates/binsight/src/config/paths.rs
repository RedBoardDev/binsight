//! The default locations of the data folder and of the configuration file.
//!
//! They follow the XDG conventions: `$XDG_DATA_HOME/binsight` (else `~/.local/share/binsight`)
//! for data (`binsight-demo` in demo mode), `$XDG_CONFIG_HOME/binsight/binsight.env` (else `~/.config/binsight/binsight.env`) for
//! the configuration. A leading `~/` in a configured path means the home folder. These functions
//! only compute paths; they never touch the disk.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The default data folder, if the environment says where the home or data folder is.
pub(crate) fn default_data_dir(env: &BTreeMap<String, String>) -> Option<PathBuf> {
    folder_from(env, "XDG_DATA_HOME", ".local/share").map(|base| base.join("binsight"))
}

/// The default data folder of demo mode, next to the real one so the two never mix.
pub(crate) fn default_demo_data_dir(env: &BTreeMap<String, String>) -> Option<PathBuf> {
    folder_from(env, "XDG_DATA_HOME", ".local/share").map(|base| base.join("binsight-demo"))
}

/// The default configuration file, if the environment says where the home or config folder is.
pub(crate) fn default_config_file(env: &BTreeMap<String, String>) -> Option<PathBuf> {
    folder_from(env, "XDG_CONFIG_HOME", ".config").map(|base| base.join("binsight/binsight.env"))
}

/// Replaces a leading `~/` (or a lone `~`) with the home folder.
pub(crate) fn expand_home(text: &str, env: &BTreeMap<String, String>) -> PathBuf {
    let home = env.get("HOME").filter(|home| !home.is_empty());
    match (text.strip_prefix('~'), home) {
        (Some(""), Some(home)) => PathBuf::from(home),
        (Some(rest), Some(home)) if rest.starts_with('/') => {
            Path::new(home).join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(text),
    }
}

/// `$<variable>` if it is an absolute path, else `$HOME/<home_relative>`.
fn folder_from(
    env: &BTreeMap<String, String>,
    variable: &str,
    home_relative: &str,
) -> Option<PathBuf> {
    let explicit = env
        .get(variable)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    explicit.or_else(|| {
        env.get("HOME")
            .filter(|home| !home.is_empty())
            .map(|home| Path::new(home).join(home_relative))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn prefers_the_xdg_folders() {
        let env = env(&[
            ("HOME", "/home/owner"),
            ("XDG_DATA_HOME", "/data"),
            ("XDG_CONFIG_HOME", "/conf"),
        ]);
        assert_eq!(
            default_data_dir(&env),
            Some(PathBuf::from("/data/binsight"))
        );
        assert_eq!(
            default_config_file(&env),
            Some(PathBuf::from("/conf/binsight/binsight.env"))
        );
    }

    #[test]
    fn falls_back_to_the_home_folder() {
        let env = env(&[
            ("HOME", "/home/owner"),
            ("XDG_DATA_HOME", "relative/ignored"),
        ]);
        assert_eq!(
            default_data_dir(&env),
            Some(PathBuf::from("/home/owner/.local/share/binsight"))
        );
        assert_eq!(
            default_config_file(&env),
            Some(PathBuf::from("/home/owner/.config/binsight/binsight.env"))
        );
    }

    #[test]
    fn has_no_default_without_a_home_folder() {
        assert_eq!(default_data_dir(&env(&[])), None);
    }

    #[test]
    fn expands_a_leading_tilde_only() {
        let env = env(&[("HOME", "/home/owner")]);
        assert_eq!(
            expand_home("~/data", &env),
            PathBuf::from("/home/owner/data")
        );
        assert_eq!(expand_home("~", &env), PathBuf::from("/home/owner"));
        assert_eq!(expand_home("/srv/~data", &env), PathBuf::from("/srv/~data"));
        assert_eq!(
            expand_home("~other/data", &env),
            PathBuf::from("~other/data")
        );
    }
}
