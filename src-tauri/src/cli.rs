//! What a command line asks FACET to do.
//!
//! Two callers hand these arguments over, and they must mean the same thing:
//! the process that starts FACET, and the single-instance plugin, which passes
//! on the arguments of a *second* launch to the copy that is already running.
//! So the grammar lives here, as a pure function over strings, and neither
//! caller gets its own idea of what `--tile` means.
//!
//! The grammar, in full:
//!
//! ```text
//! facet [<path>…]                          open in the explorer
//! facet pip open <path>… [flags]           one pop-out window per file
//! facet pip tile [--cascade|--corner] [--monitor N]
//! facet pip close <id|all>
//! facet pip list
//!
//! open flags:  --tile | --corner | --cascade    how the new windows are placed
//!              --size WxH   --at X,Y   --monitor N
//!              --mute  --loop  --paused  --start SECONDS  --opacity 0.2-1
//! any command: --req N      a number echoed into pip-state.json once handled
//! ```
//!
//! Three rules are about safety rather than convenience, because anything that
//! can start this program can reach this parser — an agent, a script, a
//! shortcut somebody downloaded:
//!
//! 1. **Only files that exist on this machine.** A URL is refused outright,
//!    not fetched: a pop-out that loads whatever a link points at is a
//!    browser with the address bar removed.
//! 2. **Only opening.** Nothing here writes, moves or runs anything.
//! 3. **An unknown flag is an error, not a shrug.** A typo such as `--mtue`
//!    that silently played the audio would be the worse outcome.

use std::path::{Component, Path, PathBuf};

/// How a batch of new pop-outs is laid out on the monitor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// A grid over the whole work area, every pop-out re-placed.
    Tile,
    /// A column stacked up from the bottom-right corner.
    Corner,
    /// Diagonal steps from the top-left.
    Cascade,
}

impl Layout {
    pub fn parse(s: &str) -> Option<Layout> {
        match s {
            "tile" | "grid" => Some(Layout::Tile),
            "corner" => Some(Layout::Corner),
            "cascade" => Some(Layout::Cascade),
            _ => None,
        }
    }
}

/// Per-window playback options. Only media windows read them.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PipOpts {
    #[serde(default)]
    pub mute: bool,
    #[serde(default, rename = "loop")]
    pub looped: bool,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub opacity: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenReq {
    pub paths: Vec<String>,
    /// None means "the default for this many files": one goes to the corner,
    /// several are tiled.
    pub layout: Option<Layout>,
    pub size: Option<(u32, u32)>,
    pub at: Option<(i32, i32)>,
    pub monitor: Option<usize>,
    pub opts: PipOpts,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CloseTarget {
    All,
    Id(u32),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// Plain `facet` with nothing to do but show the explorer.
    Nothing,
    /// `facet a.jpg b.pdf` — open in the explorer.
    Explore(Vec<String>),
    PipOpen(OpenReq),
    PipTile { layout: Layout, monitor: Option<usize> },
    PipClose(CloseTarget),
    PipList,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub command: Command,
    pub req: Option<u64>,
}

impl Request {
    /// Whether this request is about pop-outs, and so should not raise the
    /// explorer window when it is the one that starts FACET.
    pub fn is_pip(&self) -> bool {
        matches!(
            self.command,
            Command::PipOpen(_) | Command::PipTile { .. } | Command::PipClose(_) | Command::PipList
        )
    }
}

/// Parse the arguments *after* the program name.
///
/// `cwd` is the folder the launch happened in, which for a forwarded second
/// launch is that process's folder and not this one's — `facet pip open a.mp4`
/// typed in Downloads means Downloads/a.mp4 whatever folder the running copy
/// was started from.
pub fn parse(args: &[String], cwd: &Path) -> Result<Request, String> {
    // Every flag that means something only on a Tauri dev run or an old
    // shortcut is dropped before the grammar sees it.
    let args: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|a| *a != "--facet")
        .collect();

    let mut req = None;
    let mut rest = Vec::with_capacity(args.len());
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--req" {
            let v = args.get(i + 1).ok_or("--req needs a number")?;
            req = Some(v.parse::<u64>().map_err(|_| format!("--req {v}: not a number"))?);
            i += 2;
            continue;
        }
        rest.push(args[i]);
        i += 1;
    }

    let command = match rest.first().copied() {
        None => Command::Nothing,
        Some("pip") => parse_pip(&rest[1..], cwd)?,
        Some(_) => {
            let mut paths = Vec::new();
            for a in &rest {
                if a.starts_with("--") {
                    return Err(format!("{a}: unknown option"));
                }
                paths.push(resolve(a, cwd, false)?);
            }
            Command::Explore(paths)
        }
    };
    Ok(Request { command, req })
}

fn parse_pip(args: &[&str], cwd: &Path) -> Result<Command, String> {
    let Some((&verb, args)) = args.split_first() else {
        return Err("pip: say open, tile, close or list".into());
    };
    match verb {
        "open" => parse_open(args, cwd).map(Command::PipOpen),
        "list" => {
            if let Some(a) = args.first() {
                return Err(format!("pip list: unexpected {a}"));
            }
            Ok(Command::PipList)
        }
        "close" => match args {
            [] => Err("pip close: say which — an id, or all".into()),
            ["all"] => Ok(Command::PipClose(CloseTarget::All)),
            [id] => id
                .parse::<u32>()
                .map(|n| Command::PipClose(CloseTarget::Id(n)))
                .map_err(|_| format!("pip close {id}: not an id (try pip list)")),
            _ => Err("pip close: one id at a time, or all".into()),
        },
        "tile" => {
            let mut layout = Layout::Tile;
            let mut monitor = None;
            let mut i = 0;
            while i < args.len() {
                match args[i] {
                    "--tile" => layout = Layout::Tile,
                    "--corner" => layout = Layout::Corner,
                    "--cascade" => layout = Layout::Cascade,
                    "--monitor" => {
                        monitor = Some(num::<usize>(args.get(i + 1), "--monitor")?);
                        i += 1;
                    }
                    other => return Err(format!("pip tile: {other}: unknown option")),
                }
                i += 1;
            }
            Ok(Command::PipTile { layout, monitor })
        }
        other => Err(format!("pip {other}: say open, tile, close or list")),
    }
}

fn parse_open(args: &[&str], cwd: &Path) -> Result<OpenReq, String> {
    let mut out = OpenReq {
        paths: Vec::new(),
        layout: None,
        size: None,
        at: None,
        monitor: None,
        opts: PipOpts::default(),
    };
    let mut i = 0;
    while i < args.len() {
        let a = args[i];
        let val = args.get(i + 1);
        match a {
            "--tile" => out.layout = Some(Layout::Tile),
            "--corner" => out.layout = Some(Layout::Corner),
            "--cascade" => out.layout = Some(Layout::Cascade),
            "--mute" => out.opts.mute = true,
            "--loop" => out.opts.looped = true,
            "--paused" => out.opts.paused = true,
            "--size" => {
                out.size = Some(pair::<u32>(val, 'x', "--size WxH")?);
                i += 1;
            }
            "--at" => {
                out.at = Some(pair::<i32>(val, ',', "--at X,Y")?);
                i += 1;
            }
            "--monitor" => {
                out.monitor = Some(num::<usize>(val, "--monitor")?);
                i += 1;
            }
            "--start" => {
                let s = num::<f64>(val, "--start")?;
                if !s.is_finite() || s < 0.0 {
                    return Err("--start: seconds from the beginning, 0 or more".into());
                }
                out.opts.start = Some(s);
                i += 1;
            }
            "--opacity" => {
                let o = num::<f64>(val, "--opacity")?;
                // Below a fifth the window is a smudge nobody can find again.
                if !(0.2..=1.0).contains(&o) {
                    return Err("--opacity: between 0.2 and 1".into());
                }
                out.opts.opacity = Some(o);
                i += 1;
            }
            _ if a.starts_with("--") => return Err(format!("pip open: {a}: unknown option")),
            _ => out.paths.push(resolve(a, cwd, true)?),
        }
        i += 1;
    }
    if out.paths.is_empty() {
        return Err("pip open: which file?".into());
    }
    if let Some((w, h)) = out.size {
        if w < 160 || h < 90 {
            return Err("--size: at least 160x90".into());
        }
    }
    Ok(out)
}

fn num<T: std::str::FromStr>(v: Option<&&str>, flag: &str) -> Result<T, String> {
    let v = v.ok_or_else(|| format!("{flag} needs a value"))?;
    v.parse::<T>().map_err(|_| format!("{flag} {v}: not a number"))
}

fn pair<T: std::str::FromStr>(v: Option<&&str>, sep: char, what: &str) -> Result<(T, T), String> {
    let v = v.ok_or_else(|| format!("{what}: missing"))?;
    let (a, b) = v
        .split_once(sep)
        .or_else(|| if sep == 'x' { v.split_once('X') } else { None })
        .ok_or_else(|| format!("{what}: got {v}"))?;
    match (a.trim().parse::<T>(), b.trim().parse::<T>()) {
        (Ok(a), Ok(b)) => Ok((a, b)),
        _ => Err(format!("{what}: got {v}")),
    }
}

/// A command-line word into an absolute, forward-slashed path to a real file.
///
/// Lexical, not `canonicalize`: on Windows that returns `\\?\C:\…`, which is
/// not the path the explorer shows or the one the rest of FACET compares
/// against, and it would resolve a junction into somewhere the person did not
/// type.
fn resolve(word: &str, cwd: &Path, must_be_file: bool) -> Result<String, String> {
    if word.contains("://") || word.starts_with("data:") || word.starts_with("javascript:") {
        return Err(format!("{word}: only files on this computer, not links"));
    }
    let p = Path::new(word);
    let joined = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    let clean = lexical(&joined);
    let meta = std::fs::metadata(&clean).map_err(|_| format!("{word}: no such file"))?;
    if must_be_file && !meta.is_file() {
        return Err(format!("{word}: a folder cannot be popped out — name a file"));
    }
    Ok(clean.to_string_lossy().replace('\\', "/"))
}

fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                // Never above the root: `C:/..` is `C:/`.
                if !matches!(out.components().next_back(), Some(Component::RootDir | Component::Prefix(_)) | None) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch folder with two real files in it, unique per test.
    fn sandbox(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("facet-cli-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("a.mp4"), b"x").unwrap();
        std::fs::write(d.join("sub").join("b c.png"), b"x").unwrap();
        d
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn slashed(p: &Path) -> String {
        p.to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn nothing_is_nothing_and_the_old_flag_is_ignored() {
        let d = sandbox("none");
        assert_eq!(parse(&s(&[]), &d).unwrap().command, Command::Nothing);
        assert_eq!(parse(&s(&["--facet"]), &d).unwrap().command, Command::Nothing);
    }

    #[test]
    fn relative_paths_resolve_against_the_launch_folder() {
        let d = sandbox("rel");
        let r = parse(&s(&["pip", "open", "a.mp4", "./sub/../sub/b c.png"]), &d).unwrap();
        let Command::PipOpen(o) = r.command else { panic!("not an open") };
        assert_eq!(o.paths, vec![slashed(&d.join("a.mp4")), slashed(&d.join("sub").join("b c.png"))]);
        assert!(!o.paths.iter().any(|p| p.contains('\\')), "paths are forward-slashed");
    }

    #[test]
    fn every_open_flag_is_read() {
        let d = sandbox("flags");
        let r = parse(
            &s(&[
                "pip", "open", "a.mp4", "--cascade", "--size", "640x360", "--at", "-1900,40",
                "--monitor", "1", "--mute", "--loop", "--paused", "--start", "9.5", "--opacity",
                "0.8", "--req", "42",
            ]),
            &d,
        )
        .unwrap();
        assert_eq!(r.req, Some(42));
        assert!(r.is_pip());
        let Command::PipOpen(o) = r.command else { panic!() };
        assert_eq!(o.layout, Some(Layout::Cascade));
        assert_eq!(o.size, Some((640, 360)));
        assert_eq!(o.at, Some((-1900, 40)), "a monitor left of the primary has negative x");
        assert_eq!(o.monitor, Some(1));
        assert_eq!(
            o.opts,
            PipOpts { mute: true, looped: true, paused: true, start: Some(9.5), opacity: Some(0.8) }
        );
    }

    #[test]
    fn links_and_missing_files_are_refused() {
        let d = sandbox("refuse");
        for bad in ["https://example.com/x.mp4", "file:///C:/x.png", "data:text/html,hi", "nope.mp4"] {
            assert!(parse(&s(&["pip", "open", bad]), &d).is_err(), "{bad} must be refused");
        }
        assert!(parse(&s(&["pip", "open", "sub"]), &d).is_err(), "a folder is not a pop-out");
        assert!(parse(&s(&["pip", "open"]), &d).is_err());
    }

    #[test]
    fn unknown_or_malformed_flags_are_errors() {
        let d = sandbox("bad");
        for bad in [
            vec!["pip", "open", "a.mp4", "--mtue"],
            vec!["pip", "open", "a.mp4", "--size", "big"],
            vec!["pip", "open", "a.mp4", "--size", "100x50"],
            vec!["pip", "open", "a.mp4", "--opacity", "0.05"],
            vec!["pip", "open", "a.mp4", "--start", "-3"],
            vec!["pip", "open", "a.mp4", "--at"],
            vec!["pip", "tile", "--sideways"],
            vec!["pip", "close", "x"],
            vec!["pip", "close"],
            vec!["pip", "list", "extra"],
            vec!["pip", "dance"],
            vec!["pip"],
            vec!["a.mp4", "--tile"],
            vec!["--req", "soon"],
        ] {
            assert!(parse(&s(&bad), &d).is_err(), "{bad:?} must be an error");
        }
    }

    #[test]
    fn tile_close_list() {
        let d = sandbox("verbs");
        assert_eq!(
            parse(&s(&["pip", "tile", "--corner", "--monitor", "2"]), &d).unwrap().command,
            Command::PipTile { layout: Layout::Corner, monitor: Some(2) }
        );
        assert_eq!(
            parse(&s(&["pip", "close", "all"]), &d).unwrap().command,
            Command::PipClose(CloseTarget::All)
        );
        assert_eq!(
            parse(&s(&["pip", "close", "7", "--req", "3"]), &d).unwrap(),
            Request { command: Command::PipClose(CloseTarget::Id(7)), req: Some(3) }
        );
        assert_eq!(parse(&s(&["pip", "list"]), &d).unwrap().command, Command::PipList);
    }

    #[test]
    fn plain_paths_open_in_the_explorer_folders_included() {
        let d = sandbox("explore");
        let r = parse(&s(&["a.mp4", "sub"]), &d).unwrap();
        assert!(!r.is_pip());
        assert_eq!(r.command, Command::Explore(vec![slashed(&d.join("a.mp4")), slashed(&d.join("sub"))]));
    }

    #[test]
    fn parent_steps_never_climb_above_the_root() {
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        let p = lexical(&Path::new(root).join("..").join("..").join("x"));
        assert_eq!(p, Path::new(root).join("x"));
    }
}
