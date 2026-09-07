//! The ffmpeg job runner — items 4, 5, 12, and the substrate for 18 and 31.
//!
//! Three decisions here shape everything above.
//!
//! **The front end never passes argv.** It passes a typed `Job` and this module
//! builds the command line. That is not paranoia about injection (the webview is
//! ours); it is that a filter graph assembled from string concatenation in
//! TypeScript is untestable, and the graph is where the bugs live. `args_for` is
//! a pure function with assertions against it, and every visual choice — what
//! order crop and rotate compose in, when audio gets dropped, when a cut can
//! avoid re-encoding — is made once, here, where it can be checked.
//!
//! **Trim tells the truth about lossless.** Cutting a video on an arbitrary
//! frame requires re-encoding, because a frame that is not a keyframe cannot be
//! decoded without the ones before it. `-c copy` is instant and lossless but
//! silently snaps the cut to the nearest keyframe, which on a screen recording
//! can be several seconds away. Both are offered; the job reports which one it
//! took, and `Copy` is only chosen when nothing else in the job forces a decode.
//!
//! **Output is staged.** ffmpeg writes to `<name>.facet-part` in the destination
//! directory and the file is renamed into place only on success. Same directory,
//! so the rename is atomic and cannot fail across volumes, and a cancelled job
//! can never leave something that looks like a finished export. The partial is
//! *left on disk* and named in the result rather than deleted — deleting the
//! user's files is not this module's call to make.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Live jobs, so `cancel` has something to kill.
fn jobs() -> &'static Mutex<HashMap<u64, Child>> {
    static JOBS: OnceLock<Mutex<HashMap<u64, Child>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// The directory the APK's native libraries were unpacked into.
///
/// Android 10 refuses to execute anything under an app's own data directory;
/// the native library directory is the one place in an app's private storage
/// that still carries the execute bit, which is why the bundled ffmpeg ships as
/// `jniLibs/arm64-v8a/libffmpeg.so` rather than as a plain file we copy out at
/// first run. That directory's real path embeds the package's install UUID, so
/// it cannot be spelled out ahead of time, and asking Android for it properly
/// means a JNI round trip to `ApplicationInfo.nativeLibraryDir` from a thread
/// that may not be attached to the VM.
///
/// This reads it off the process instead. Our own Rust library was loaded out
/// of exactly that directory, so the kernel has already written the answer into
/// `/proc/self/maps`; every mapped file there names its directory. The candidate
/// is confirmed by looking for `libffmpeg.so` beside it rather than by matching
/// our library's name, so renaming the crate cannot quietly break this.
#[cfg(target_os = "android")]
fn native_lib_dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let maps = std::fs::read_to_string("/proc/self/maps").ok()?;
        let mut seen: Vec<&Path> = Vec::new();
        for line in maps.lines() {
            // A mapping's path is the last field and is the only one that can
            // begin with a slash; anonymous mappings have no sixth field at all.
            let Some(path) = line.split_whitespace().nth(5) else { continue };
            if !path.starts_with('/') {
                continue;
            }
            let Some(dir) = Path::new(path).parent() else { continue };
            if seen.contains(&dir) {
                continue;
            }
            seen.push(dir);
            if dir.join("libffmpeg.so").is_file() {
                return Some(dir.to_path_buf());
            }
        }
        None
    })
    .as_deref()
}

/// `ffmpeg` -> the absolute path of the bundled `libffmpeg.so`.
///
/// Falls back to the bare name, which will fail to spawn: an app built without
/// the binaries packaged in should report "no such file" against the name the
/// caller asked for, not against a path invented here.
#[cfg(target_os = "android")]
fn resolve(exe: &str) -> PathBuf {
    match native_lib_dir() {
        Some(dir) => dir.join(format!("lib{exe}.so")),
        None => PathBuf::from(exe),
    }
}

fn cmd(exe: &str) -> Command {
    #[cfg(target_os = "android")]
    let mut c = Command::new(resolve(exe));
    #[cfg(not(target_os = "android"))]
    let mut c = Command::new(exe);
    // ffmpeg writes its own scratch files for two-pass and for some filters, and
    // inherits an environment in which the default temp directory does not
    // exist. Left alone it fails deep inside a job rather than at the start.
    #[cfg(target_os = "android")]
    {
        let tmp = scratch_dir();
        let _ = std::fs::create_dir_all(&tmp);
        c.env("TMPDIR", &tmp);
    }
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Whether the media tools can actually run on this build.
///
/// The phone's editor used to be told `ffmpeg: true` unconditionally, so on any
/// device the binaries were not packaged for -- there is only an `arm64-v8a`
/// directory under `src-tauri/android-binaries` -- fifteen tools were offered
/// as enabled and then failed at spawn time with a job error. `tools.ts`
/// already knows how to grey a tool out with a reason; it just needed the
/// truth. Answered once and cached: it cannot change while the app is running.
#[tauri::command]
pub fn media_ready() -> bool {
    static READY: OnceLock<bool> = OnceLock::new();
    *READY.get_or_init(|| {
        #[cfg(target_os = "android")]
        {
            // Both, not either: every tool needs ffmpeg and most of them probe
            // first, and a half-packaged build is a worse lie than no build.
            match native_lib_dir() {
                Some(dir) => dir.join("libffmpeg.so").is_file() && dir.join("libffprobe.so").is_file(),
                None => false,
            }
        }
        #[cfg(not(target_os = "android"))]
        {
            // On the desktop it is whatever is on PATH, so the only honest
            // answer is to run it. `-version` writes a few lines and exits.
            cmd("ffmpeg").arg("-version").output().is_ok()
                && cmd("ffprobe").arg("-version").output().is_ok()
        }
    })
}

// ---------------------------------------------------------------- probing

#[derive(Debug, Serialize, Clone)]
pub struct Track {
    pub index: u32,
    pub kind: String,
    pub codec: String,
    pub width: u32,
    pub height: u32,
    /// Frames per second as a decimal. `r_frame_rate` is a rational like
    /// "30000/1001"; a UI that wants to step one frame needs the number.
    pub fps: f64,
    pub channels: u32,
    pub sample_rate: u32,
    /// Degrees the container asks a player to rotate by. Phone video is almost
    /// always stored landscape with a 90 here, and a viewer that ignores it
    /// shows every clip sideways.
    pub rotation: i32,
    pub language: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct Media {
    pub duration: f64,
    pub bitrate: u64,
    pub format: String,
    pub tracks: Vec<Track>,
    /// Convenience: the first video track's dimensions *after* container
    /// rotation, which is what every UI actually wants to lay out against.
    pub width: u32,
    pub height: u32,
}

fn num(v: &serde_json::Value, key: &str) -> f64 {
    v.get(key)
        .and_then(|x| x.as_str().map(|s| s.parse().unwrap_or(0.0)).or_else(|| x.as_f64()))
        .unwrap_or(0.0)
}

/// "30000/1001" -> 29.97. Returns 0 for "0/0", which is what ffprobe reports for
/// a stream with no meaningful frame rate.
fn rational(s: &str) -> f64 {
    let mut it = s.split('/');
    let n: f64 = it.next().unwrap_or("0").parse().unwrap_or(0.0);
    let d: f64 = it.next().unwrap_or("1").parse().unwrap_or(1.0);
    if d == 0.0 {
        0.0
    } else {
        n / d
    }
}

#[tauri::command]
pub fn probe_media(path: String) -> Result<Media, String> {
    let out = cmd("ffprobe")
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(as_file(&path))
        .output()
        .map_err(|e| format!("ffprobe could not be started ({e}) — is it on PATH?"))?;
    if !out.status.success() {
        return Err(format!("{path} is not something ffprobe can read"));
    }
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe returned nothing usable: {e}"))?;

    let fmt = v.get("format").cloned().unwrap_or_default();
    let mut tracks = Vec::new();
    if let Some(streams) = v.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let kind = s
                .get("codec_type")
                .and_then(|x| x.as_str())
                .unwrap_or("data")
                .to_string();
            // Rotation lives in side data on modern mp4 and in a tag on older
            // files. Checking only one of the two is why so many tools show
            // phone video sideways.
            let mut rotation = s
                .get("tags")
                .and_then(|t| t.get("rotate"))
                .and_then(|r| r.as_str())
                .and_then(|r| r.parse::<i32>().ok())
                .unwrap_or(0);
            if let Some(list) = s.get("side_data_list").and_then(|l| l.as_array()) {
                for sd in list {
                    if let Some(r) = sd.get("rotation").and_then(|r| r.as_f64()) {
                        rotation = r as i32;
                    }
                }
            }
            tracks.push(Track {
                index: num(s, "index") as u32,
                codec: s
                    .get("codec_name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("?")
                    .to_string(),
                width: num(s, "width") as u32,
                height: num(s, "height") as u32,
                fps: rational(s.get("r_frame_rate").and_then(|x| x.as_str()).unwrap_or("0/1")),
                channels: num(s, "channels") as u32,
                sample_rate: num(s, "sample_rate") as u32,
                rotation: ((rotation % 360) + 360) % 360,
                language: s
                    .get("tags")
                    .and_then(|t| t.get("language"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                kind,
            });
        }
    }

    let vid = tracks.iter().find(|t| t.kind == "video");
    let (mut w, mut h) = vid.map(|t| (t.width, t.height)).unwrap_or((0, 0));
    if let Some(t) = vid {
        if t.rotation == 90 || t.rotation == 270 {
            std::mem::swap(&mut w, &mut h);
        }
    }

    Ok(Media {
        duration: num(&fmt, "duration"),
        bitrate: num(&fmt, "bit_rate") as u64,
        format: fmt
            .get("format_name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        width: w,
        height: h,
        tracks,
    })
}

/// Keyframe timestamps inside a window.
///
/// The editor needs these for two reasons: to draw where a lossless cut is
/// actually possible, and to snap to one when the user asks for a copy-mode
/// trim. Scoped to a window with `-read_intervals` because scanning the packet
/// list of a two-hour file to draw a ten-second ruler is absurd.
#[tauri::command]
pub fn keyframes(path: String, from: f64, to: f64) -> Result<Vec<f64>, String> {
    let out = cmd("ffprobe")
        .args([
            "-v",
            "quiet",
            "-select_streams",
            "v:0",
            "-skip_frame",
            "nokey",
            "-show_entries",
            "frame=pts_time",
            "-print_format",
            "csv=p=0",
            "-read_intervals",
        ])
        .arg(format!("{from}%{to}"))
        .arg(as_file(&path))
        .output()
        .map_err(|e| format!("ffprobe could not be started ({e})"))?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().trim_end_matches(',').parse::<f64>().ok())
        .collect())
}

// ---------------------------------------------------------------- the job

/// One kept span of the source. Everything item 4 calls "trim" and "cut" is
/// this list: a trim is one span, a cut is the two spans either side of it, and
/// removing three ad breaks is four spans. Modelling it as *what to keep* rather
/// than *what to remove* means the graph builder has one case, not three.
#[derive(Debug, Deserialize, Clone, Copy)]
pub struct Span {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Deserialize, Clone, Copy)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// One rectangle blurred for one stretch of the **source's** timeline (item 19).
///
/// Times are in source seconds and the graph applies these before any trim or
/// speed change, so a face found at 00:41 of the original stays blurred at 00:41
/// of the original no matter what the export does to the timeline afterwards.
/// Doing it the other way round — blurring the edited stream — would mean the
/// front end recomputing every timestamp through the span list and the speed
/// factor, and getting that arithmetic wrong shows up as an unblurred face
/// rather than as an error.
#[derive(Debug, Deserialize, Clone)]
pub struct BlurSpan {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub from: f64,
    pub to: f64,
    /// `gaussian` | `box` | `pixelate` | `mosaic` | `solid`. Anything else is
    /// treated as `gaussian`, because an unknown name arriving from a newer
    /// front end should degrade to a blur, never to no blur at all.
    #[serde(default)]
    pub kind: String,
    /// Strength as a fraction of the frame's short edge, matching the stills.
    #[serde(default)]
    pub amount: f64,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// One input for an export, several for a join.
    pub inputs: Vec<String>,
    pub output: String,
    /// Empty means the whole file.
    #[serde(default)]
    pub spans: Vec<Span>,
    #[serde(default)]
    pub crop: Option<Crop>,
    /// Burned-in blurs. Empty for every job that is not a face blur.
    #[serde(default)]
    pub blur: Vec<BlurSpan>,
    /// 0, 90, 180, 270 — clockwise.
    #[serde(default)]
    pub rotate: i32,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    /// 1.0 leaves timing alone. 20.0 is a timelapse (item 12); 0.5 is slow
    /// motion. Applies to audio too, up to the point where audio stops meaning
    /// anything — see `keep_audio_at`.
    #[serde(default = "one")]
    pub speed: f64,
    #[serde(default)]
    pub scale: Option<(u32, u32)>,
    #[serde(default)]
    pub mute: bool,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    /// x264 CRF. 18 is visually lossless, 23 default, 28 small.
    #[serde(default = "crf")]
    pub quality: u32,
    /// None = keep the source rate.
    #[serde(default)]
    pub fps: Option<f64>,
    /// Synthesise the in-between frames when slowing footage down.
    ///
    /// `setpts` alone does not make slow motion, it makes a slideshow: the
    /// frames that exist are simply held for longer, so a thirty-frame second
    /// played at a twentieth speed is thirty stills each lasting two thirds of
    /// a second. `minterpolate` estimates the motion between consecutive frames
    /// and draws the ones that were never shot, which is the difference between
    /// "slowed down" and "slow motion".
    ///
    /// Off by default and opt-in from the UI, because it is expensive: motion
    /// compensation is the slowest filter in this file by a wide margin, and on
    /// a phone a long clip will take many minutes. The user asked for slow
    /// motion "as slow as we can get", not for it to be free.
    #[serde(default)]
    pub smooth: bool,
    /// Force a re-encode even when a stream copy would have worked. The UI sets
    /// this when the user picks frame-exact over instant.
    #[serde(default)]
    pub precise: bool,
    /// Subtitles to burn into the picture. None for every job that isn't one.
    #[serde(default)]
    pub subtitles: Option<Subtitles>,
}

/// Subtitles to burn in, as text rather than as a path.
///
/// The front end hands over the *contents* of a SubRip file, not a filename,
/// for two reasons. It means burning does not require first writing a sidecar
/// into the user's folder — a file they did not ask for and would have to
/// tidy up — and it means the filename ffmpeg sees is one we chose, which
/// matters more than it sounds like it should: the `subtitles` filter takes
/// its filename inside a filtergraph, where a colon separates arguments, a
/// comma ends the filter, and a backslash escapes. A Windows path is all
/// three at once. We write the text to a plain ASCII name in a directory of
/// our own and run ffmpeg from inside it, so the argument is a bare
/// `sub-3f2a….srt` with nothing in it to escape.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Subtitles {
    /// SubRip text. Whatever the front end would have written to a `.srt`.
    pub text: String,
    /// Cap height as a percentage of the picture's height. 5.5 is broadcast-ish.
    #[serde(default = "sub_size")]
    pub size: f64,
    /// `RRGGBB`. Anything that isn't six hex digits is treated as white.
    #[serde(default)]
    pub color: String,
    /// Outline thickness, in the same units as `size`. 0 with `box` off is
    /// unreadable over a bright shot, so it is not the default.
    #[serde(default = "sub_outline")]
    pub outline: f64,
    /// Draw an opaque box behind the text instead of an outline.
    #[serde(default)]
    pub box_behind: bool,
    /// Gap from the bottom of the picture, as a percentage of its height.
    #[serde(default = "sub_margin")]
    pub margin: f64,
}

fn sub_size() -> f64 {
    5.5
}
fn sub_outline() -> f64 {
    0.6
}
fn sub_margin() -> f64 {
    4.0
}

/// libass measures a style against the script's own `PlayResY`, and ffmpeg
/// gives a converted SubRip file 288 — so a size in per-cent of picture height
/// becomes a font size by way of this number, whatever the video's real
/// resolution is. Working in per-cent is what makes one setting look the same
/// on a phone clip and on 4K.
const ASS_HEIGHT: f64 = 288.0;

impl Subtitles {
    /// The `force_style` argument: numbers and hex, nothing a user typed.
    ///
    /// Every field is clamped or rewritten here rather than trusted, because
    /// this string is spliced into a filtergraph. There is no escaping to get
    /// right if nothing that needs escaping can reach it.
    fn force_style(&self) -> String {
        let px = |pct: f64, lo: f64, hi: f64| (pct.clamp(lo, hi) / 100.0 * ASS_HEIGHT).round();
        let hex = if self.color.len() == 6 && self.color.chars().all(|c| c.is_ascii_hexdigit()) {
            self.color.to_uppercase()
        } else {
            "FFFFFF".to_string()
        };
        // ASS colours are &HAABBGGRR — blue first, and alpha where a web
        // developer expects red. Getting this backwards yields a plausible
        // wrong colour rather than an error, so it is worth spelling out.
        let (r, g, b) = (&hex[0..2], &hex[2..4], &hex[4..6]);

        format!(
            "FontSize={},PrimaryColour=&H00{b}{g}{r},OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle={},Outline={},Shadow=0,Alignment=2,MarginV={}",
            px(self.size, 1.0, 20.0),
            if self.box_behind { 3 } else { 1 },
            px(self.outline, 0.0, 3.0).max(if self.box_behind { 0.0 } else { 1.0 }),
            px(self.margin, 0.0, 40.0),
        )
    }

    /// Where this text lives while ffmpeg reads it.
    ///
    /// Named for a hash of the output path, so burning the same export twice
    /// reuses one file instead of leaving a trail of them, and so the name is
    /// pure ASCII no matter what the video is called.
    fn staged_at(&self, output: &str) -> PathBuf {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in output.as_bytes() {
            h ^= u64::from(*byte);
            h = h.wrapping_mul(0x100_0000_01b3);
        }
        temp_subs().join(format!("sub-{h:016x}.srt"))
    }
}

/// Our own corner of the temp directory, made if it isn't there.
///
/// On Unix the temp directory is shared with every other account on the
/// machine, and the staged file's name is a hash of the output path — which is
/// to say, guessable. Someone who guessed it could leave a symlink there and
/// have this process write the subtitle text into a file of their choosing, as
/// the user. So on those platforms the folder is named with 128 bits from the
/// kernel, created once per launch with `create_dir` so an existing name is an
/// error rather than a silent adoption, and mode 0700 so nobody else can look
/// inside it in the first place. Windows and Android already give the app a
/// private directory, so there the plain name stays.
fn temp_subs() -> PathBuf {
    #[cfg(all(unix, not(target_os = "android")))]
    {
        use std::os::unix::fs::DirBuilderExt;
        static DIR: OnceLock<PathBuf> = OnceLock::new();
        return DIR
            .get_or_init(|| {
                let mut bytes = [0u8; 16];
                if std::fs::File::open("/dev/urandom")
                    .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut bytes))
                    .is_err()
                {
                    // Never expected. A predictable name is still better than
                    // no subtitles, and 0700 remains the real defence.
                    let ns = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |d| d.as_nanos() as u64)
                        ^ u64::from(std::process::id());
                    bytes[..8].copy_from_slice(&ns.to_le_bytes());
                }
                let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                let dir = scratch_dir().join(format!("facet-subtitles-{name}"));
                let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
                dir
            })
            .clone();
    }
    #[cfg(not(all(unix, not(target_os = "android"))))]
    {
        let dir = scratch_dir().join("facet-subtitles");
        let _ = std::fs::create_dir_all(&dir);
        dir
    }
}

/// A directory this process may actually write to.
///
/// `std::env::temp_dir` answers `/tmp` when `TMPDIR` is unset, and on Android
/// `/tmp` does not exist and could not be created if it did. The failure was
/// invisible: the staged subtitle file simply never appeared and ffmpeg burned
/// in nothing. An app's own sandbox is the writable place on that platform, and
/// Tauri already points `HOME` at it -- the same variable `home_places` leans on.
fn scratch_dir() -> PathBuf {
    #[cfg(target_os = "android")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("cache");
        }
    }
    std::env::temp_dir()
}

/// Name a path to ffmpeg as unmistakably a file.
///
/// Bare, ffmpeg reads a leading `name:` as a protocol, so what a URL means and
/// what a filename means overlap. Every path here is absolute, which happens to
/// keep them apart today — but that is an accident of two platforms, not a rule
/// anyone wrote down, and it stops being true the moment a relative path is
/// passed. `file:` says it outright, and has the same effect on a name that
/// starts with `-`.
fn as_file(path: &str) -> String {
    format!("file:{path}")
}

fn one() -> f64 {
    1.0
}
fn crf() -> u32 {
    20
}

/// Above this, audio is dropped rather than sped up.
///
/// `atempo` will happily chain to 20×, and the result is a chipmunk shriek that
/// nobody has ever wanted over a timelapse. Under 4× — a lecture at 2×, a
/// walkthrough at 3× — speeding the audio is exactly the point.
const AUDIO_SPEED_LIMIT: f64 = 4.0;

impl Job {
    fn audible(&self) -> bool {
        !self.mute && self.speed <= AUDIO_SPEED_LIMIT && self.speed > 0.0
    }

    /// True when the job asks for nothing that requires looking at pixels.
    ///
    /// A single span with no filters can be served by `-c copy`: instant, and
    /// byte-identical quality. Anything else — a second span to concatenate, a
    /// crop, a rotation, a speed change — means decode and re-encode, and
    /// pretending otherwise produces a file that is either wrong or unplayable.
    fn copyable(&self) -> bool {
        !self.precise
            && self.inputs.len() == 1
            && self.spans.len() <= 1
            && self.blur.is_empty()
            && self.crop.is_none()
            && self.rotate == 0
            && !self.flip_h
            && !self.flip_v
            && (self.speed - 1.0).abs() < f64::EPSILON
            && self.scale.is_none()
            && self.fade_in == 0.0
            && self.fade_out == 0.0
            && self.fps.is_none()
            // Burning in is drawing on the frames. There is no such thing as
            // a stream copy with subtitles on it.
            && self.subtitles.is_none()
    }

    /// Seconds of output, for the progress bar. ffmpeg reports position, not
    /// percentage, so somebody has to know the denominator.
    fn out_seconds(&self, source: f64) -> f64 {
        let kept: f64 = if self.spans.is_empty() {
            source
        } else {
            self.spans.iter().map(|s| (s.end - s.start).max(0.0)).sum()
        };
        if self.speed > 0.0 {
            kept / self.speed
        } else {
            kept
        }
    }
}

/// `atempo` handles 0.5–2.0 cleanly; outside that it must be chained, because
/// one instance stretching 4× sounds like a broken tape.
fn atempo_chain(speed: f64) -> Vec<String> {
    let mut out = Vec::new();
    let mut left = speed;
    // `>=` rather than `>` so an exact 4× comes out as two clean doublings
    // instead of a doubling plus an `atempo=2.000000` that means the same thing
    // and reads like a rounding error.
    while left >= 2.0 {
        out.push("atempo=2.0".into());
        left /= 2.0;
    }
    while left <= 0.5 {
        out.push("atempo=0.5".into());
        left /= 0.5;
    }
    if (left - 1.0).abs() > 1e-9 {
        out.push(format!("atempo={left:.6}"));
    }
    out
}

/// The per-stream filter chain applied after the spans are concatenated.
///
/// Order is not arbitrary and is the one thing here worth arguing about. Crop
/// runs **before** rotate so the crop rectangle is in the coordinates the user
/// drew it in — on the video as they were looking at it. Scale runs after
/// rotate, so a requested 1920×1080 is the shape of the finished frame rather
/// than of some intermediate. `setpts` is last because it touches timing, not
/// geometry, and fades are last of all so their timings are in output seconds.
fn video_chain(j: &Job, out_len: f64) -> Vec<String> {
    let mut f = Vec::new();
    if let Some(c) = j.crop {
        f.push(format!("crop={}:{}:{}:{}", c.w, c.h, c.x, c.y));
    }
    match ((j.rotate % 360) + 360) % 360 {
        90 => f.push("transpose=1".into()),
        180 => {
            f.push("transpose=1".into());
            f.push("transpose=1".into());
        }
        270 => f.push("transpose=2".into()),
        _ => {}
    }
    if j.flip_h {
        f.push("hflip".into());
    }
    if j.flip_v {
        f.push("vflip".into());
    }
    if let Some((w, h)) = j.scale {
        // Even dimensions: yuv420p chroma is subsampled 2×2 and libx264 refuses
        // an odd width outright. Rounding here beats failing at encode time.
        f.push(format!("scale={}:{}", w & !1, h & !1));
    }
    // After the geometry so the text is never rotated, squashed or scaled with
    // the picture, and before `setpts` so a cue's times are read against the
    // edited-but-not-yet-sped-up timeline — which means subtitles written for
    // a 2× timelapse ride along with it instead of drifting to the end.
    if let Some(s) = &j.subtitles {
        let name = s.staged_at(&j.output);
        let name = name.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        // Desktop libass finds a face through fontconfig. The bundled Android
        // build has no fontconfig — there is none on the platform to link
        // against — so it must be pointed at a directory, and told a family
        // that is actually in it. Left to itself it asks for the ASS default,
        // Arial, finds nothing, and burns in a rectangle of blanks: a silent
        // wrong result rather than an error, which is the worst kind.
        #[cfg(target_os = "android")]
        f.push(format!(
            "subtitles={name}:fontsdir=/system/fonts:force_style='{},FontName=Roboto'",
            s.force_style()
        ));
        #[cfg(not(target_os = "android"))]
        f.push(format!("subtitles={name}:force_style='{}'", s.force_style()));
    }
    if (j.speed - 1.0).abs() > f64::EPSILON && j.speed > 0.0 {
        f.push(format!("setpts=PTS/{:.6}", j.speed));
    }
    // Interpolation replaces the plain rate filter rather than following it:
    // `minterpolate` sets the output rate itself, and an `fps` after it would
    // immediately throw away the frames it just spent the time inventing.
    if j.smooth && j.speed > 0.0 && j.speed < 1.0 {
        let target = j.fps.filter(|r| *r > 0.0).unwrap_or(30.0).clamp(12.0, 120.0);
        f.push(format!(
            "minterpolate=fps={target:.3}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"
        ));
    } else if let Some(r) = j.fps {
        f.push(format!("fps={r}"));
    }
    if j.fade_in > 0.0 {
        f.push(format!("fade=t=in:st=0:d={:.3}", j.fade_in));
    }
    if j.fade_out > 0.0 && out_len > j.fade_out {
        f.push(format!(
            "fade=t=out:st={:.3}:d={:.3}",
            out_len - j.fade_out,
            j.fade_out
        ));
    }
    f
}

/// Blur radius as a fraction of the **face box**, not of the frame.
///
/// A face blurred by a sixth of its own width is unrecognisable whether the
/// footage is 720p or 4K, and whether the person is standing at the lens or at
/// the back of the room. Anchoring to the frame instead would leave the distant
/// face — the smaller one, the one the detector barely found — the least
/// blurred, which is exactly backwards. `amount` still arrives in the front
/// end's units (a fraction of the short edge) and is mapped here; the ×3 is the
/// ratio a face typically occupies, so the tuned default of 0.05 lands at 0.15.
///
/// The comma is escaped because this expression sits inside a filtergraph,
/// where an unescaped comma ends the filter.
fn radius_expr(b: &BlurSpan) -> String {
    let k = if b.amount > 0.0 { b.amount * 3.0 } else { 0.15 };
    format!("min(w\\,h)*{:.3}", k.clamp(0.04, 0.5))
}

/// Mosaic cell size: about twelve cells across the shorter side of the box.
fn cell_size(b: &BlurSpan) -> u32 {
    (b.w.min(b.h) / 12).max(2)
}

/// Burn the face blurs in, one rectangle at a time.
///
/// A `split` / `crop` / blur / `overlay` per span rather than one blurred copy
/// of the whole frame reused by all of them. Blurring the whole 4K frame to
/// then use four small pieces of it is most of a second per frame for nothing,
/// and cropping first means every filter after it works on a box a few hundred
/// pixels wide. The cost is that the blur samples only inside the box, so its
/// rim is very slightly sharper than its middle — invisible at these radii, and
/// the standard recipe for exactly this reason.
///
/// Chained pairwise instead of one N-way split so the graph stays readable and
/// no single filter ends up with four hundred outputs.
///
/// Returns the label carrying the result.
fn blur_graph(j: &Job, input: &str, graph: &mut String) -> String {
    let mut cur = input.to_string();
    for (n, b) in j.blur.iter().enumerate() {
        // A degenerate box is dropped rather than emitted: ffmpeg rejects a
        // zero-width crop outright, and one bad span would fail the whole
        // export — including all the faces that were found correctly.
        if b.w < 2 || b.h < 2 || b.to <= b.from {
            continue;
        }
        let enable = format!("enable='between(t\\,{:.3}\\,{:.3})'", b.from, b.to);

        if b.kind == "solid" {
            // Redaction, not blur: one linear filter, no split, no overlay.
            graph.push_str(&format!(
                "{cur}drawbox=x={}:y={}:w={}:h={}:color=black:t=fill:{enable}[fb{n}];",
                b.x, b.y, b.w, b.h
            ));
            cur = format!("[fb{n}]");
            continue;
        }

        let effect = match b.kind.as_str() {
            "box" => format!("boxblur={}:1", radius_expr(b)),
            "pixelate" | "mosaic" => {
                // Down with neighbour sampling and back up to the box's own
                // known size — the literal width and height, so the result
                // cannot come back a rounded pixel narrower than the hole it
                // has to fill.
                let k = cell_size(b);
                format!(
                    "scale=iw/{k}:ih/{k}:flags=neighbor,scale={}:{}:flags=neighbor",
                    b.w, b.h
                )
            }
            _ => format!("boxblur={}:2", radius_expr(b)),
        };

        graph.push_str(&format!("{cur}split=2[fa{n}][fs{n}];"));
        graph.push_str(&format!(
            "[fs{n}]crop={}:{}:{}:{},{effect}[fc{n}];",
            b.w, b.h, b.x, b.y
        ));
        graph.push_str(&format!(
            "[fa{n}][fc{n}]overlay={}:{}:{enable}[fb{n}];",
            b.x, b.y
        ));
        cur = format!("[fb{n}]");
    }
    cur
}

fn audio_chain(j: &Job, out_len: f64) -> Vec<String> {
    let mut f = atempo_chain(j.speed);
    if j.fade_in > 0.0 {
        f.push(format!("afade=t=in:st=0:d={:.3}", j.fade_in));
    }
    if j.fade_out > 0.0 && out_len > j.fade_out {
        f.push(format!(
            "afade=t=out:st={:.3}:d={:.3}",
            out_len - j.fade_out,
            j.fade_out
        ));
    }
    f
}

/// The whole command line, as a pure function of the job.
///
/// Separated from `run` precisely so it can be asserted on: a filter graph is
/// the kind of thing that produces a plausible file for a wrong reason, and the
/// only cheap way to know it is right is to read the string it generated.
pub fn args_for(j: &Job, source: f64, dest: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-y".into()];
    let out_len = j.out_seconds(source);

    if j.copyable() {
        // `-ss` before `-i` seeks by index rather than by decoding up to the
        // point, which is the difference between instant and a minute. It is
        // only safe here because copy mode has already accepted keyframe
        // snapping — in precise mode the seek goes after the input.
        if let Some(s) = j.spans.first() {
            a.push("-ss".into());
            a.push(format!("{:.3}", s.start));
            a.push("-to".into());
            a.push(format!("{:.3}", s.end));
        }
        a.push("-i".into());
        a.push(as_file(&j.inputs[0]));
        a.push("-c".into());
        a.push("copy".into());
        // Without this, a stream copy that starts mid-file keeps the source's
        // timestamps and the result plays as if it had a long black lead-in.
        a.push("-avoid_negative_ts".into());
        a.push("make_zero".into());
        if j.mute {
            a.push("-an".into());
        }
        a.push(dest.to_string_lossy().into_owned());
        return a;
    }

    for i in &j.inputs {
        a.push("-i".into());
        a.push(as_file(i));
    }

    let want_audio = j.audible();
    let mut graph = String::new();
    let mut labels: Vec<String> = Vec::new();

    // A join is n inputs each taken whole; an edit is one input taken in spans.
    // Both reduce to "a list of pieces to concatenate", which is why they share
    // this builder rather than being two commands.
    //
    // Face blurs go on before any of it, so `between(t,…)` means source
    // seconds — which is what the detector measured. After a trim or a speed
    // change it would mean output seconds, and the front end would have to
    // remap every timestamp through the span list and the speed factor; getting
    // that wrong shows up as an unblurred face rather than as an error, so it
    // is not a calculation worth having.
    //
    // Single input only. Blurring across a join is a real feature and a
    // different one — the boxes would have to be tagged with which file they
    // were found in, and nothing produces that yet.
    let mut vin: Vec<String> = (0..j.inputs.len()).map(|i| format!("[{i}:v]")).collect();
    if !j.blur.is_empty() && j.inputs.len() == 1 {
        vin[0] = blur_graph(j, "[0:v]", &mut graph);
    }

    let pieces: Vec<(usize, Option<Span>)> = if j.inputs.len() > 1 {
        (0..j.inputs.len()).map(|i| (i, None)).collect()
    } else if j.spans.is_empty() {
        vec![(0, None)]
    } else {
        j.spans.iter().map(|s| (0, Some(*s))).collect()
    };

    for (n, (input, span)) in pieces.iter().enumerate() {
        match span {
            Some(s) => {
                graph.push_str(&format!(
                    "{}trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS[v{n}];",
                    vin[*input], s.start, s.end
                ));
                if want_audio {
                    graph.push_str(&format!(
                        "[{input}:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS[a{n}];",
                        s.start, s.end
                    ));
                }
            }
            None => {
                graph.push_str(&format!("{}setpts=PTS-STARTPTS[v{n}];", vin[*input]));
                if want_audio {
                    graph.push_str(&format!("[{input}:a]asetpts=PTS-STARTPTS[a{n}];"));
                }
            }
        }
        labels.push(format!("[v{n}]"));
        if want_audio {
            labels.push(format!("[a{n}]"));
        }
    }

    let (mut vlab, mut alab) = ("[v0]".to_string(), "[a0]".to_string());
    if pieces.len() > 1 {
        graph.push_str(&format!(
            "{}concat=n={}:v=1:a={}[vc]{};",
            labels.concat(),
            pieces.len(),
            u8::from(want_audio),
            if want_audio { "[ac]" } else { "" }
        ));
        vlab = "[vc]".into();
        alab = "[ac]".into();
    }

    let vf = video_chain(j, out_len);
    if !vf.is_empty() {
        graph.push_str(&format!("{vlab}{}[vout];", vf.join(",")));
        vlab = "[vout]".into();
    }
    if want_audio {
        let af = audio_chain(j, out_len);
        if !af.is_empty() {
            graph.push_str(&format!("{alab}{}[aout];", af.join(",")));
            alab = "[aout]".into();
        }
    }

    a.push("-filter_complex".into());
    a.push(graph.trim_end_matches(';').to_string());
    a.push("-map".into());
    a.push(vlab);
    if want_audio {
        a.push("-map".into());
        a.push(alab);
    } else {
        a.push("-an".into());
    }

    a.push("-c:v".into());
    a.push("libx264".into());
    a.push("-crf".into());
    a.push(j.quality.to_string());
    a.push("-preset".into());
    a.push("medium".into());
    // Without this a filtered output can come out yuv444p, which is legal H.264
    // and which most hardware players and every phone refuse to open.
    a.push("-pix_fmt".into());
    a.push("yuv420p".into());
    if want_audio {
        a.push("-c:a".into());
        a.push("aac".into());
        a.push("-b:a".into());
        a.push("192k".into());
    }
    // Lets a player start before the whole file has arrived, which matters the
    // moment one of these is attached to a message.
    a.push("-movflags".into());
    a.push("+faststart".into());
    a.push(dest.to_string_lossy().into_owned());
    a
}

// ---------------------------------------------------------------- running

#[derive(Serialize, Clone)]
struct Progress {
    id: u64,
    /// 0.0–1.0, or -1 when the length is unknown.
    fraction: f64,
    seconds: f64,
    speed: f64,
    fps: f64,
}

#[derive(Serialize, Clone)]
struct Done {
    id: u64,
    ok: bool,
    output: String,
    /// The `.facet-part` left behind by a failed or cancelled job, if any.
    /// Named rather than deleted — removing a user's file is not this module's
    /// decision, and a job that failed at 90% is sometimes worth keeping.
    leftover: String,
    error: String,
    /// Whether the job took the lossless path, so the UI can say so.
    copied: bool,
}

fn staged(output: &str) -> PathBuf {
    let p = PathBuf::from(output);
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    p.with_file_name(format!("{name}.facet-part"))
}

/// Start a job. Returns immediately with its id; everything else arrives as
/// `ffmpeg-progress` and `ffmpeg-done` events.
#[tauri::command]
pub fn run_job(app: tauri::AppHandle, job: Job) -> Result<u64, String> {
    if job.inputs.is_empty() {
        return Err("nothing to encode".into());
    }
    let source = probe_media(job.inputs[0].clone()).map(|m| m.duration).unwrap_or(0.0);
    let total = job.out_seconds(source);
    let part = staged(&job.output);
    let copied = job.copyable();

    // Written before the encoder starts, and ffmpeg run from the directory
    // holding it — see `Subtitles` for why the filename never leaves it.
    let cwd = match &job.subtitles {
        Some(s) => {
            let at = s.staged_at(&job.output);
            std::fs::write(&at, &s.text)
                .map_err(|e| format!("the subtitles could not be prepared ({e})"))?;
            Some(temp_subs())
        }
        None => None,
    };

    start(app, args_for(&job, source, &part), part, job.output, total, copied, cwd)
}

/// Spawn ffmpeg and watch it — the half of a job that has nothing to do with
/// what is being encoded.
///
/// Split out when the audio editor arrived, because staging, progress parsing,
/// stderr draining and the rename-on-success dance are identical whether the
/// output is a film or a voice memo, and a second copy of them would be a second
/// place for the leftover-file rules to drift.
fn start(
    app: tauri::AppHandle,
    args: Vec<String>,
    part: PathBuf,
    out_path: String,
    total: f64,
    copied: bool,
    // Where to run ffmpeg. Only burn-in wants a directory; everything else
    // passes absolute paths and does not care.
    cwd: Option<PathBuf>,
) -> Result<u64, String> {
    let mut spawn = cmd("ffmpeg");
    if let Some(dir) = cwd {
        spawn.current_dir(dir);
    }
    let mut child = spawn
        .args(args)
        .args(["-progress", "pipe:1", "-nostats"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg could not be started ({e}) — is it on PATH?"))?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    jobs().lock().map_err(|_| "job table poisoned")?.insert(id, child);

    // ffmpeg's diagnostics go to stderr and are the only place a real error is
    // explained. Drained on its own thread because a full pipe buffer would
    // block the encoder itself — a hang that looks exactly like a slow export.
    let errbuf = std::sync::Arc::new(Mutex::new(String::new()));
    if let Some(e) = stderr {
        let sink = errbuf.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(e).lines().map_while(Result::ok) {
                if let Ok(mut s) = sink.lock() {
                    if s.len() < 8000 {
                        s.push_str(&line);
                        s.push('\n');
                    }
                }
            }
        });
    }

    std::thread::spawn(move || {
        let mut speed = 0.0;
        let mut fps = 0.0;
        if let Some(o) = stdout {
            for line in BufReader::new(o).lines().map_while(Result::ok) {
                let Some((k, v)) = line.split_once('=') else { continue };
                let v = v.trim();
                match k {
                    "fps" => fps = v.parse().unwrap_or(0.0),
                    "speed" => speed = v.trim_end_matches('x').parse().unwrap_or(0.0),
                    // `out_time_ms` is misnamed in ffmpeg and actually carries
                    // microseconds; `out_time_us` is the one that means what it
                    // says, so prefer it and treat the other as the fallback.
                    "out_time_us" | "out_time_ms" => {
                        let secs = v.parse::<f64>().unwrap_or(0.0) / 1_000_000.0;
                        let _ = app.emit(
                            "ffmpeg-progress",
                            Progress {
                                id,
                                fraction: if total > 0.0 { (secs / total).min(1.0) } else { -1.0 },
                                seconds: secs,
                                speed,
                                fps,
                            },
                        );
                    }
                    _ => {}
                }
            }
        }

        let status = jobs()
            .lock()
            .ok()
            .and_then(|mut m| m.remove(&id))
            .and_then(|mut c| c.wait().ok());
        let ok = status.map(|s| s.success()).unwrap_or(false);

        // Rename into place only on success. Same directory, so this is atomic
        // and cannot fail for being across volumes.
        let mut leftover = String::new();
        let mut error = String::new();
        if ok {
            if let Err(e) = std::fs::rename(&part, &out_path) {
                error = format!("encoded, but could not be moved into place: {e}");
                leftover = part.to_string_lossy().into_owned();
            } else {
                crate::media::scan(std::slice::from_ref(&out_path));
            }
        } else {
            if part.exists() {
                leftover = part.to_string_lossy().into_owned();
            }
            error = errbuf
                .lock()
                .ok()
                .map(|s| {
                    s.lines()
                        .rev()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("ffmpeg failed")
                        .to_string()
                })
                .unwrap_or_else(|| "ffmpeg failed".into());
        }

        let _ = app.emit(
            "ffmpeg-done",
            Done {
                id,
                ok: ok && error.is_empty(),
                output: out_path,
                leftover,
                error,
                copied,
            },
        );
    });

    Ok(id)
}

#[tauri::command]
pub fn cancel_job(id: u64) -> Result<(), String> {
    let mut m = jobs().lock().map_err(|_| "job table poisoned")?;
    if let Some(c) = m.get_mut(&id) {
        c.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A single frame as PNG bytes, for the editor's scrubbing filmstrip.
///
/// `-ss` before `-i` again: a filmstrip asks for thirty of these at once and
/// decoding from zero each time would take longer than the video runs.
/// Raw bytes over the IPC, not a JSON array of numbers.
///
/// `Result<Vec<u8>, _>` is serialized as `[255,216,255,...]`: a 22 KB poster
/// crosses the bridge as ~90 KB of text that the webview then has to parse.
/// `thumb_cached` already avoids that; this is the same fix for the video path,
/// which is the one that actually shows up as a slow tile. The `Err` arm is
/// kept because the caller latches ffmpeg off on the "could not be started"
/// message.
#[tauri::command]
pub fn frame_at(path: String, at: f64, width: u32) -> Result<tauri::ipc::Response, String> {
    frame_bytes(path, at, width).map(tauri::ipc::Response::new)
}

pub fn frame_bytes(path: String, at: f64, width: u32) -> Result<Vec<u8>, String> {
    // ffmpeg's mjpeg decoder ignores EXIF orientation, so a still pulled from a
    // portrait photograph comes out sideways unless the turn is spelled out.
    // Videos are untouched: their rotation lives in a display matrix that
    // ffmpeg's autorotation already honours.
    let lower = path.to_ascii_lowercase();
    let upright: &str = if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        match crate::thumbs::jpeg_orientation(&path) {
            2 => "hflip,",
            3 => "hflip,vflip,",
            4 => "vflip,",
            5 => "transpose=0,",
            6 => "transpose=1,",
            7 => "transpose=3,",
            8 => "transpose=2,",
            _ => "",
        }
    } else {
        ""
    };
    let out = cmd("ffmpeg")
        .args(["-hide_banner", "-v", "quiet", "-ss"])
        .arg(format!("{at:.3}"))
        .args(["-i"])
        .arg(as_file(&path))
        .args([
            // Nothing but one video frame is wanted. Without these ffmpeg still
            // sets up the audio and subtitle streams it is about to discard.
            "-an",
            "-sn",
            "-frames:v",
            "1",
            "-vf",
            &format!("{upright}scale={}:-1", width & !1),
            "-an",
            "-f",
            "image2pipe",
            "-c:v",
            "mjpeg",
            "-q:v",
            "4",
            "pipe:1",
        ])
        .output()
        .map_err(|e| format!("ffmpeg could not be started ({e})"))?;
    if out.stdout.is_empty() {
        // The poster path asks for the frame at 1s without knowing the
        // duration, so a clip shorter than that seeks past its own end and
        // gets nothing — its tile then falls back to the webview decoder,
        // which fails the same way, and the grid shows a chip forever. The
        // first frame always exists; one retry turns "no poster for short
        // clips, ever" into one extra ffmpeg spawn for exactly that class.
        if at > 0.0 {
            return frame_bytes(path, 0.0, width);
        }
        return Err(format!("no frame at {at:.2}s"));
    }
    Ok(out.stdout)
}

// ------------------------------------------------------------------- audio
//
// Item 5. The same shape as the video side and deliberately so: spans to keep,
// a typed job, one pure builder, the shared runner above. What differs is what
// the numbers mean — an audio editor's whole job is level, and level is the one
// thing you cannot see, so the rules about it are written down here rather than
// left to whoever reads the filter chain later.

/// Anything past this and `atempo` starts to sound like a machine; the video
/// side drops the audio entirely up there, but an audio editor has nothing left
/// to show if it does that, so this is a hard ceiling instead.
const AUDIO_MAX_SPEED: f64 = 4.0;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioJob {
    pub inputs: Vec<String>,
    pub output: String,
    #[serde(default)]
    pub spans: Vec<Span>,
    /// Plain offset in dB. 0 means untouched.
    #[serde(default)]
    pub gain_db: f64,
    /// EBU R128 loudness normalisation, one pass.
    #[serde(default)]
    pub normalize: bool,
    #[serde(default = "one")]
    pub speed: f64,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    #[serde(default)]
    pub mono: bool,
    /// kbps, for the formats that have a bitrate at all.
    #[serde(default = "default_bitrate")]
    pub bitrate: u32,
    #[serde(default)]
    pub sample_rate: Option<u32>,
    /// Noise removal preset — item 18. See `noise_filters`.
    #[serde(default)]
    pub denoise: String,
}

fn default_bitrate() -> u32 {
    192
}

fn ext_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

impl AudioJob {
    /// Whether this can be a stream copy — same container, nothing touched.
    ///
    /// Worth as much here as it is for video, and for a reason people feel: a
    /// podcast trimmed with `-c copy` keeps the exact bytes it was published
    /// with, and re-encoding an mp3 to trim a cough off the front throws away
    /// quality that no setting gets back.
    pub fn copyable(&self) -> bool {
        self.inputs.len() == 1
            && self.spans.len() <= 1
            && self.gain_db == 0.0
            && !self.normalize
            && self.speed == 1.0
            && self.fade_in == 0.0
            && self.fade_out == 0.0
            && !self.mono
            && self.sample_rate.is_none()
            && noise_filters(&self.denoise).is_empty()
            && ext_of(&self.inputs[0]) == ext_of(&self.output)
    }

    pub fn out_seconds(&self, source: f64) -> f64 {
        let kept = if self.spans.is_empty() {
            source
        } else {
            self.spans.iter().map(|s| (s.end - s.start).max(0.0)).sum()
        };
        if self.speed > 0.0 { kept / self.speed } else { kept }
    }
}

/// Codec, and the options that go with it, for an output extension.
///
/// Chosen from the extension the user typed rather than from a format dropdown,
/// because that is the thing they can see in the folder afterwards. An unknown
/// extension falls back to AAC in an mp4 container, which is the one thing every
/// phone and browser on the planet will open.
fn audio_codec(ext: &str, bitrate: u32) -> Vec<String> {
    let kbps = format!("{bitrate}k");
    match ext {
        "wav" => vec!["-c:a".into(), "pcm_s16le".into()],
        "flac" => vec!["-c:a".into(), "flac".into()],
        // Vorbis takes a quality scale, but a bitrate is what the UI offers and
        // libvorbis honours `-b:a` perfectly well in managed mode.
        "ogg" => vec!["-c:a".into(), "libvorbis".into(), "-b:a".into(), kbps],
        "opus" => vec!["-c:a".into(), "libopus".into(), "-b:a".into(), kbps],
        "mp3" => vec!["-c:a".into(), "libmp3lame".into(), "-b:a".into(), kbps],
        _ => vec!["-c:a".into(), "aac".into(), "-b:a".into(), kbps],
    }
}

/// Noise removal — item 18.
///
/// Four presets rather than a wall of sliders, because the useful question is
/// "what is wrong with this recording" and not "what should `nf` be". The names
/// are the situations: a room that hisses, a street outside, a voice you want to
/// rescue, and everything-you-have for a recording that is already ruined.
///
/// **Continuous noise only, and the UI says so.** `afftdn` learns the noise
/// floor and subtracts it, which works beautifully on hiss, hum, fans, rain and
/// distant traffic — all things that are *always there*. A car horn is none of
/// those: it is loud, brief, and lives in the same band as a voice, so no
/// broadband denoiser removes it without removing the person too. The tool for a
/// horn is the one the editor already has — cut it out — and pretending
/// otherwise would be the kind of promise that makes people distrust every other
/// setting in the panel.
///
/// **No `tn=1`.** Noise *tracking* is the obvious thing to reach for — it lets
/// the denoiser follow a floor that moves instead of assuming the first frames
/// are representative, which they never are. It was in every preset here until
/// the presets were measured, and in this ffmpeg build it turns `afftdn` into
/// very nearly a no-op: on a fixture of speech over a −35 dBFS floor, `nr=20`
/// takes the floor down 24 dB without it and **1 dB** with it. A tracked assumed
/// floor that is roughly right beats a self-adjusting one that does nothing, so
/// these are fixed. `noise_tracking_is_not_quietly_reintroduced` guards it.
///
/// Runs **first**, before loudnorm: normalising a noisy recording measures the
/// noise as part of the programme and then amplifies it. Clean, then level.
///
/// The ladder is calibrated, not guessed. Against that same fixture, measured on
/// the gaps between phrases: room −5 dB, traffic −18, voice −24, strong −56,
/// with the speech itself losing under 1 dB in every case. The cost only shows
/// up when the voice is *in* the noise rather than above it — with a talker at
/// the same level as the floor, `strong` takes 29 dB of the talker with it. That
/// is what the UI note about quiet voices is describing.
fn noise_filters(preset: &str) -> Vec<String> {
    match preset {
        // Hiss, hum, fans, air conditioning — the sound of a room being a room.
        "room" => vec!["afftdn=nr=12:nf=-40".into()],
        // Traffic is mostly low: engines, tyres, wind against a window. The
        // high-pass does more of the work here than the denoiser does, and 110 Hz
        // is under a male speaking fundamental with room to spare.
        "traffic" => vec!["highpass=f=110".into(), "afftdn=nr=18:nf=-30".into()],
        // Band-limited around speech, then denoised inside that band. The
        // low-pass is what makes it sound "clean" rather than merely quieter —
        // most of what is left after a denoiser is up where nobody speaks.
        "voice" => vec![
            "highpass=f=90".into(),
            "afftdn=nr=20:nf=-25".into(),
            "lowpass=f=8500".into(),
        ],
        // For a recording that is already lost. `anlmdn` is slow and can smear
        // consonants, which is exactly the trade you want when the alternative is
        // an unusable file — and never the trade you want by default. `nf=-20` is
        // the top of the filter's own range; there is nothing louder to ask for.
        "strong" => vec![
            "highpass=f=90".into(),
            "afftdn=nr=30:nf=-20".into(),
            "anlmdn=s=0.0001:p=0.008".into(),
        ],
        _ => Vec::new(),
    }
}

/// The audio filter chain, in the one order that is correct.
///
/// Noise removal first — see `noise_filters`. Then loudness, then the user's own
/// gain, so "normalise and then bring it up
/// 2 dB" means what it says instead of being silently undone. Speed next,
/// because everything after it is timed in *output* seconds. Fades last, for the
/// same reason — a one-second fade-out on a clip played at 2× is one second of
/// what you will hear, not half of one.
fn audio_filters(j: &AudioJob, out_len: f64) -> Vec<String> {
    let mut f: Vec<String> = noise_filters(&j.denoise);
    if j.normalize {
        // One pass. Two passes measure first and correct exactly, but that means
        // decoding the whole file before encoding starts, and for an editor that
        // doubles every export to buy an accuracy nobody can hear.
        f.push("loudnorm=I=-16:TP=-1.5:LRA=11".into());
    }
    if j.gain_db != 0.0 {
        f.push(format!("volume={:.2}dB", j.gain_db));
    }
    if j.speed != 1.0 {
        f.extend(atempo_chain(j.speed.clamp(0.5, AUDIO_MAX_SPEED)));
    }
    if let Some(r) = j.sample_rate {
        f.push(format!("aresample={r}"));
    }
    if j.fade_in > 0.0 {
        f.push(format!("afade=t=in:st=0:d={:.3}", j.fade_in));
    }
    if j.fade_out > 0.0 && out_len > j.fade_out {
        f.push(format!("afade=t=out:st={:.3}:d={:.3}", out_len - j.fade_out, j.fade_out));
    }
    f
}

/// Pure, and asserted against — same contract as `args_for`.
pub fn audio_args_for(j: &AudioJob, source: f64, dest: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-y".into()];

    if j.copyable() {
        if let Some(s) = j.spans.first() {
            a.push("-ss".into());
            a.push(format!("{:.3}", s.start));
            a.push("-to".into());
            a.push(format!("{:.3}", s.end));
        }
        a.push("-i".into());
        a.push(as_file(&j.inputs[0]));
        a.push("-c".into());
        a.push("copy".into());
        // Cover art and tags are part of the file people think they own; a copy
        // that quietly drops the album picture is not the same file back.
        a.push("-map".into());
        a.push("0".into());
        a.push(dest.to_string_lossy().into_owned());
        return a;
    }

    for input in &j.inputs {
        a.push("-i".into());
        a.push(as_file(input));
    }

    let pieces: Vec<(usize, Option<Span>)> = if j.inputs.len() > 1 {
        (0..j.inputs.len()).map(|i| (i, None)).collect()
    } else if j.spans.is_empty() {
        vec![(0, None)]
    } else {
        j.spans.iter().map(|s| (0, Some(*s))).collect()
    };

    let mut graph: Vec<String> = Vec::new();
    let mut labels: Vec<String> = Vec::new();
    for (n, (input, span)) in pieces.iter().enumerate() {
        let mut steps: Vec<String> = Vec::new();
        if let Some(s) = span {
            steps.push(format!("atrim=start={:.3}:end={:.3}", s.start, s.end));
        }
        // Every piece is rebased to zero or the concat lands them end to end at
        // their original timestamps, which sounds like silence with the audio
        // hiding somewhere down the timeline.
        steps.push("asetpts=PTS-STARTPTS".into());
        graph.push(format!("[{input}:a]{}[a{n}]", steps.join(",")));
        labels.push(format!("[a{n}]"));
    }

    let mut last = labels[0].clone();
    if labels.len() > 1 {
        graph.push(format!("{}concat=n={}:v=0:a=1[ac]", labels.join(""), labels.len()));
        last = "[ac]".into();
    }

    let out_len = j.out_seconds(source);
    let filters = audio_filters(j, out_len);
    if !filters.is_empty() {
        graph.push(format!("{last}{}[out]", filters.join(",")));
        last = "[out]".into();
    }

    a.push("-filter_complex".into());
    a.push(graph.join(";"));
    a.push("-map".into());
    a.push(last);
    if j.mono {
        a.push("-ac".into());
        a.push("1".into());
    }
    a.extend(audio_codec(&ext_of(&j.output), j.bitrate));
    a.push(dest.to_string_lossy().into_owned());
    a
}

#[tauri::command]
pub fn run_audio_job(app: tauri::AppHandle, job: AudioJob) -> Result<u64, String> {
    if job.inputs.is_empty() {
        return Err("nothing to encode".into());
    }
    let source = probe_media(job.inputs[0].clone()).map(|m| m.duration).unwrap_or(0.0);
    let total = job.out_seconds(source);
    let part = staged(&job.output);
    let copied = job.copyable();
    start(app, audio_args_for(&job, source, &part), part, job.output, total, copied, None)
}

/// One magnitude per bucket, for drawing a waveform.
///
/// Done here rather than in the browser on purpose. The player's waveform runs
/// `decodeAudioData` on the whole file, which is fine for a three-minute song
/// and impossible for a two-hour meeting recording — 8 kHz mono s16 streamed
/// through a pipe is 16 KB per second of audio and never lands in memory at all.
/// It also means the editor can draw anything ffmpeg can open, rather than
/// anything the WebView happens to decode.
#[tauri::command]
pub fn peaks(path: String, buckets: u32) -> Result<Vec<f32>, String> {
    const RATE: f64 = 8000.0;
    let n = buckets.clamp(16, 8192) as usize;
    let duration = probe_media(path.clone()).map(|m| m.duration).unwrap_or(0.0);
    if duration <= 0.0 {
        return Err("no audio to scan".into());
    }

    let mut child = cmd("ffmpeg")
        .args(["-hide_banner", "-v", "quiet", "-i"])
        .arg(as_file(&path))
        .args(["-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("ffmpeg could not be started ({e})"))?;

    let mut out = vec![0f32; n];
    if let Some(o) = child.stdout.take() {
        let mut r = BufReader::new(o);
        let mut buf = [0u8; 8192];
        let expected = (duration * RATE).max(1.0);
        let mut index = 0f64;
        loop {
            let got = match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(k) => k,
            };
            // An odd byte count means a sample was split across two reads; the
            // tail byte is dropped, which is a 125-microsecond error in a
            // picture that is 1400 pixels wide.
            for pair in buf[..got].chunks_exact(2) {
                let v = i16::from_le_bytes([pair[0], pair[1]]).abs() as f32 / 32768.0;
                let b = ((index / expected) * n as f64) as usize;
                if let Some(slot) = out.get_mut(b.min(n - 1)) {
                    if v > *slot {
                        *slot = v;
                    }
                }
                index += 1.0;
            }
        }
    }
    let _ = child.wait();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(inputs: &[&str]) -> Job {
        Job {
            inputs: inputs.iter().map(|s| (*s).to_string()).collect(),
            output: "out.mp4".into(),
            spans: vec![],
            crop: None,
            blur: vec![],
            rotate: 0,
            flip_h: false,
            flip_v: false,
            speed: 1.0,
            scale: None,
            mute: false,
            fade_in: 0.0,
            fade_out: 0.0,
            quality: 20,
            fps: None,
            precise: false,
            smooth: false,
            subtitles: None,
        }
    }

    fn line(j: &Job, source: f64) -> String {
        args_for(j, source, Path::new("out.mp4.facet-part")).join(" ")
    }

    #[test]
    fn a_plain_trim_costs_nothing() {
        let mut j = job(&["in.mp4"]);
        j.spans = vec![Span { start: 3.0, end: 9.0 }];
        let s = line(&j, 60.0);
        assert!(s.contains("-c copy"), "{s}");
        // Seek before -i, or it decodes everything up to the cut.
        assert!(s.find("-ss").unwrap() < s.find("-i").unwrap(), "{s}");
        assert!(s.contains("-avoid_negative_ts make_zero"), "{s}");
        assert!(!s.contains("libx264"), "{s}");
    }

    fn span(x: u32, y: u32, w: u32, h: u32, from: f64, to: f64) -> BlurSpan {
        BlurSpan { x, y, w, h, from, to, kind: "gaussian".into(), amount: 0.05 }
    }

    #[test]
    fn a_face_blur_is_never_a_stream_copy() {
        // The one thing that must not happen: a job that was asked to remove a
        // face from a video finishing instantly, having copied it verbatim.
        let mut j = job(&["in.mp4"]);
        j.spans = vec![Span { start: 3.0, end: 9.0 }];
        j.blur = vec![span(10, 20, 100, 120, 1.0, 4.0)];
        let s = line(&j, 60.0);
        assert!(!s.contains("-c copy"), "{s}");
        assert!(s.contains("libx264"), "{s}");
    }

    #[test]
    fn a_blur_crops_blurs_and_overlays_in_source_time() {
        let mut j = job(&["in.mp4"]);
        j.blur = vec![span(10, 20, 100, 120, 1.5, 4.25)];
        let s = line(&j, 60.0);
        assert!(s.contains("[0:v]split=2[fa0][fs0]"), "{s}");
        // crop is w:h:x:y — transposing these is the classic way to produce a
        // blur that lands somewhere else entirely.
        assert!(s.contains("[fs0]crop=100:120:10:20,boxblur="), "{s}");
        assert!(s.contains("[fa0][fc0]overlay=10:20:"), "{s}");
        assert!(s.contains("between(t\\,1.500\\,4.250)"), "{s}");
    }

    #[test]
    fn the_blur_goes_on_before_the_trim() {
        // Times come from the detector, which measured the source. If the blur
        // were applied after the trim, this face would be blurred at 1.5s of
        // the *export* — several seconds off, and off by a different amount for
        // every span the user cut.
        let mut j = job(&["in.mp4"]);
        j.spans = vec![Span { start: 10.0, end: 20.0 }];
        j.blur = vec![span(0, 0, 40, 40, 1.5, 4.0)];
        let s = line(&j, 60.0);
        let blur = s.find("overlay=0:0").expect("overlay");
        let trim = s.find("trim=start=10.000").expect("trim");
        assert!(blur < trim, "blur must precede the trim: {s}");
        assert!(s.contains("[fb0]trim=start=10.000"), "{s}");
    }

    #[test]
    fn blurs_chain_one_into_the_next() {
        let mut j = job(&["in.mp4"]);
        j.blur = vec![span(0, 0, 40, 40, 0.0, 1.0), span(50, 50, 40, 40, 1.0, 2.0)];
        let s = line(&j, 60.0);
        // The second split reads the first overlay's output, not the input —
        // otherwise the second blur silently discards the first.
        assert!(s.contains("[fb0]split=2[fa1][fs1]"), "{s}");
        assert!(s.contains("[fb1]setpts=PTS-STARTPTS"), "{s}");
    }

    #[test]
    fn a_degenerate_span_is_dropped_not_emitted() {
        // ffmpeg rejects a zero-width crop and fails the whole export. One bad
        // box must not cost the user the faces that were found correctly.
        let mut j = job(&["in.mp4"]);
        j.blur = vec![
            span(0, 0, 0, 40, 0.0, 1.0),
            span(5, 5, 40, 40, 1.0, 2.0),
            span(9, 9, 40, 40, 3.0, 3.0),
        ];
        let s = line(&j, 60.0);
        assert!(!s.contains("crop=0:"), "{s}");
        assert_eq!(s.matches("overlay=").count(), 1, "{s}");
        assert!(s.contains("overlay=5:5"), "{s}");
    }

    #[test]
    fn redaction_is_a_drawbox_not_a_blur() {
        let mut j = job(&["in.mp4"]);
        let mut b = span(4, 6, 40, 40, 0.0, 2.0);
        b.kind = "solid".into();
        j.blur = vec![b];
        let s = line(&j, 60.0);
        assert!(s.contains("drawbox=x=4:y=6:w=40:h=40:color=black:t=fill"), "{s}");
        assert!(!s.contains("split=2"), "{s}");
    }

    #[test]
    fn a_mosaic_scales_back_to_the_boxs_exact_size() {
        // Rounding back to iw*k could land a pixel short, and an overlay
        // smaller than the box leaves a sliver of sharp face down one edge.
        let mut j = job(&["in.mp4"]);
        let mut b = span(0, 0, 121, 97, 0.0, 2.0);
        b.kind = "pixelate".into();
        j.blur = vec![b];
        let s = line(&j, 60.0);
        assert!(s.contains("scale=121:97:flags=neighbor"), "{s}");
    }

    #[test]
    fn the_blur_radius_scales_with_the_face_not_the_frame() {
        // Anchored to the frame, the distant face — the small one — would come
        // out the least blurred.
        let mut j = job(&["in.mp4"]);
        j.blur = vec![span(0, 0, 40, 40, 0.0, 1.0)];
        let s = line(&j, 60.0);
        assert!(s.contains("boxblur=min(w\\,h)*0.150:2"), "{s}");
    }

    #[test]
    fn asking_for_frame_exact_gives_up_the_stream_copy() {
        let mut j = job(&["in.mp4"]);
        j.spans = vec![Span { start: 3.0, end: 9.0 }];
        j.precise = true;
        let s = line(&j, 60.0);
        assert!(!s.contains("-c copy"), "{s}");
        assert!(s.contains("trim=start=3.000:end=9.000"), "{s}");
    }

    #[test]
    fn cutting_a_middle_out_keeps_both_sides_and_joins_them() {
        let mut j = job(&["in.mp4"]);
        j.spans = vec![Span { start: 0.0, end: 5.0 }, Span { start: 12.0, end: 20.0 }];
        let s = line(&j, 30.0);
        assert!(s.contains("concat=n=2:v=1:a=1"), "{s}");
        assert!(s.contains("atrim=start=12.000:end=20.000"), "{s}");
        // Every piece must be re-based to zero or the concat leaves a gap the
        // length of the removed section. Four, not two: the audio half is
        // `asetpts`, which contains `setpts` — and the audio needs rebasing
        // just as much, or the sound drifts out of step after the join.
        assert_eq!(s.matches("setpts=PTS-STARTPTS").count(), 4, "{s}");
    }

    #[test]
    fn joining_files_uses_each_whole() {
        let j = job(&["a.mp4", "b.mp4", "c.mp4"]);
        let s = line(&j, 10.0);
        assert!(s.contains("concat=n=3"), "{s}");
        assert!(s.contains("[1:v]") && s.contains("[2:v]"), "{s}");
        assert!(!s.contains("trim=start"), "{s}");
    }

    #[test]
    fn crop_is_applied_in_the_coordinates_the_user_drew_it_in() {
        let mut j = job(&["in.mp4"]);
        j.crop = Some(Crop { x: 10, y: 20, w: 640, h: 480 });
        j.rotate = 90;
        let s = line(&j, 10.0);
        let c = s.find("crop=640:480:10:20").expect(&s);
        let t = s.find("transpose=1").expect(&s);
        assert!(c < t, "crop must precede rotate: {s}");
    }

    #[test]
    fn scale_lands_after_rotation_so_the_numbers_describe_the_finished_frame() {
        let mut j = job(&["in.mp4"]);
        j.rotate = 270;
        j.scale = Some((1281, 721));
        let s = line(&j, 10.0);
        assert!(s.find("transpose=2").unwrap() < s.find("scale=").unwrap(), "{s}");
        // Odd dimensions are rounded down; libx264 rejects them outright.
        assert!(s.contains("scale=1280:720"), "{s}");
    }

    #[test]
    fn a_timelapse_drops_the_audio_instead_of_shrieking() {
        let mut j = job(&["in.mp4"]);
        j.speed = 20.0;
        let s = line(&j, 100.0);
        assert!(s.contains("setpts=PTS/20"), "{s}");
        assert!(s.contains("-an"), "{s}");
        assert!(!s.contains("atempo"), "{s}");
    }

    #[test]
    fn a_lecture_at_double_speed_keeps_its_audio() {
        let mut j = job(&["in.mp4"]);
        j.speed = 2.0;
        let s = line(&j, 100.0);
        assert!(s.contains("atempo=2.0"), "{s}");
        assert!(!s.contains("-an"), "{s}");
    }

    #[test]
    fn extreme_tempo_is_chained_rather_than_asked_of_one_filter() {
        assert_eq!(atempo_chain(4.0), vec!["atempo=2.0", "atempo=2.0"]);
        assert_eq!(atempo_chain(1.0), Vec::<String>::new());
        let quarter = atempo_chain(0.25);
        assert_eq!(quarter.len(), 2, "{quarter:?}");
        assert!(quarter.iter().all(|f| f == "atempo=0.5"), "{quarter:?}");
    }

    #[test]
    fn fades_are_timed_against_the_output_not_the_source() {
        let mut j = job(&["in.mp4"]);
        j.spans = vec![Span { start: 10.0, end: 20.0 }];
        j.speed = 2.0;
        j.fade_out = 1.0;
        // 10 s kept at 2× = 5 s out, so the fade starts at 4.
        let s = line(&j, 600.0);
        assert!(s.contains("fade=t=out:st=4.000"), "{s}");
        assert!(s.contains("afade=t=out:st=4.000"), "{s}");
    }

    #[test]
    fn a_fade_longer_than_the_clip_is_dropped_rather_than_encoded_negative() {
        let mut j = job(&["in.mp4"]);
        j.spans = vec![Span { start: 0.0, end: 2.0 }];
        j.fade_out = 5.0;
        j.precise = true;
        let s = line(&j, 60.0);
        assert!(!s.contains("fade=t=out"), "{s}");
    }

    #[test]
    fn every_re_encode_lands_somewhere_a_phone_can_open() {
        let mut j = job(&["in.mp4"]);
        j.rotate = 180;
        let s = line(&j, 10.0);
        assert!(s.contains("-pix_fmt yuv420p"), "{s}");
        assert!(s.contains("-movflags +faststart"), "{s}");
        assert_eq!(s.matches("transpose=1").count(), 2, "180 is two turns: {s}");
    }

    #[test]
    fn output_is_staged_beside_its_destination() {
        let p = staged("D:/clips/holiday.mp4");
        assert_eq!(p.file_name().unwrap(), "holiday.mp4.facet-part");
        // Same directory, so the rename into place is atomic.
        assert_eq!(p.parent(), Path::new("D:/clips/holiday.mp4").parent());
    }

    /// Ten seconds of colour bars and a 440 Hz tone, built once per run.
    ///
    /// Synthesised rather than checked in or borrowed from the user's Videos
    /// folder: the tests have to mean the same thing on a machine that has
    /// neither.
    fn fixture() -> PathBuf {
        let p = std::env::temp_dir().join("facet-ffmpeg-fixture.mp4");
        if p.exists() {
            return p;
        }
        let st = cmd("ffmpeg")
            .args([
                "-hide_banner", "-v", "error", "-y",
                "-f", "lavfi", "-i", "testsrc=duration=10:size=320x240:rate=30",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
            ])
            .arg(&p)
            .status()
            .expect("ffmpeg on PATH");
        assert!(st.success(), "could not build the fixture");
        p
    }

    fn encode(j: &Job) -> Media {
        let src = fixture();
        let dest = std::env::temp_dir().join(format!("facet-out-{}.mp4", j.output));
        let mut j = j.clone();
        j.inputs = vec![src.to_string_lossy().into_owned()];
        let out = cmd("ffmpeg")
            .args(args_for(&j, 10.0, &dest))
            .output()
            .expect("ffmpeg on PATH");
        assert!(
            out.status.success(),
            "ffmpeg rejected the graph:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
        probe_media(dest.to_string_lossy().into_owned()).expect("the output is readable")
    }

    /// The one that matters. Every assertion above checks a string; this checks
    /// that ffmpeg accepts it and that the file which comes out is the length,
    /// shape and content the job asked for. A graph can read perfectly and
    /// still be refused, or produce ten seconds of black.
    #[test]
    fn the_graphs_survive_contact_with_ffmpeg() {
        let base = job(&["x"]);

        let mut trim = base.clone();
        trim.output = "trim".into();
        trim.spans = vec![Span { start: 2.0, end: 6.0 }];
        trim.precise = true;
        let m = encode(&trim);
        assert!((m.duration - 4.0).abs() < 0.3, "trim came out {}s", m.duration);

        let mut cut = base.clone();
        cut.output = "cut".into();
        cut.spans = vec![Span { start: 0.0, end: 2.0 }, Span { start: 8.0, end: 10.0 }];
        let m = encode(&cut);
        assert!((m.duration - 4.0).abs() < 0.4, "two 2s spans made {}s", m.duration);
        assert!(m.tracks.iter().any(|t| t.kind == "audio"), "the join lost its audio");

        let mut turn = base.clone();
        turn.output = "turn".into();
        turn.rotate = 90;
        turn.crop = Some(Crop { x: 0, y: 0, w: 160, h: 240 });
        let m = encode(&turn);
        // Cropped to 160×240, then turned a quarter — so the frame is 240×160.
        assert_eq!((m.width, m.height), (240, 160), "crop-then-rotate came out wrong");

        let mut lapse = base.clone();
        lapse.output = "lapse".into();
        lapse.speed = 10.0;
        let m = encode(&lapse);
        assert!((m.duration - 1.0).abs() < 0.3, "10x of 10s made {}s", m.duration);
        assert!(!m.tracks.iter().any(|t| t.kind == "audio"), "a timelapse kept its audio");

        let mut half = base.clone();
        half.output = "half".into();
        half.speed = 0.5;
        half.fade_in = 1.0;
        half.fade_out = 1.0;
        let m = encode(&half);
        assert!((m.duration - 20.0).abs() < 0.5, "0.5x of 10s made {}s", m.duration);
        assert!(m.tracks.iter().any(|t| t.kind == "audio"), "slow motion should keep audio");

        // Two overlapping face blurs of different kinds, chained. The mosaic
        // path scales down and back up, so the assertion that matters is that
        // the finished frame is still the size it started — a rounding error
        // there would resize the whole video rather than one rectangle.
        let mut faces = base.clone();
        faces.output = "faces".into();
        faces.blur = vec![
            BlurSpan { x: 20, y: 20, w: 80, h: 90, from: 1.0, to: 3.0,
                       kind: "gaussian".into(), amount: 0.05 },
            BlurSpan { x: 150, y: 40, w: 61, h: 71, from: 2.0, to: 5.0,
                       kind: "pixelate".into(), amount: 0.05 },
        ];
        let m = encode(&faces);
        assert!((m.duration - 10.0).abs() < 0.3, "face blur changed the length: {}s", m.duration);
        assert_eq!((m.width, m.height), (320, 240), "a face blur resized the frame");
    }

    /// Average luma of one frame, straight out of ffmpeg's own analyser.
    ///
    /// Every other assertion in this file reads a command line. This reads
    /// pixels, which is the only way to know that a burned-in blur was in fact
    /// burned in — a graph ffmpeg accepts and a graph that changes the picture
    /// are different claims, and the gap between them is where a privacy
    /// feature quietly does nothing.
    fn yavg(path: &Path, at: f64) -> f64 {
        let out = cmd("ffmpeg")
            .args(["-hide_banner", "-v", "error", "-ss"])
            .arg(format!("{at:.3}"))
            .arg("-i")
            .arg(path)
            .args([
                "-frames:v", "1",
                "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
                "-f", "null", "-",
            ])
            .output()
            .expect("ffmpeg on PATH");
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        text.lines()
            .find_map(|l| l.rsplit_once('=').map(|(_, v)| v.trim().parse::<f64>()))
            .and_then(|r| r.ok())
            .unwrap_or_else(|| panic!("no YAVG in:\n{text}\n{}", String::from_utf8_lossy(&out.stderr)))
    }

    /// The blur has to reach the pixels, and only between the times it was told.
    ///
    /// A full-frame redaction is used rather than a face-sized one because it
    /// makes the measurement unambiguous: the whole frame goes black or it does
    /// not. The geometry is checked by the string assertions above; what needs
    /// proving here is that `enable='between(t,…)'` gates anything at all — an
    /// escaping mistake in that expression is accepted by ffmpeg and silently
    /// blurs every frame, or none.
    #[test]
    fn a_burned_in_blur_reaches_the_pixels_and_respects_its_window() {
        let mut j = job(&["x"]);
        j.output = "redact".into();
        j.precise = true;
        j.blur = vec![BlurSpan {
            x: 0, y: 0, w: 320, h: 240,
            from: 2.0, to: 4.0,
            kind: "solid".into(),
            amount: 0.0,
        }];
        encode(&j);
        let dest = std::env::temp_dir().join("facet-out-redact.mp4");

        let inside = yavg(&dest, 3.0);
        let before = yavg(&dest, 0.5);
        let after = yavg(&dest, 6.0);
        assert!(inside < 25.0, "the covered second is not black: YAVG {inside}");
        assert!(before > 60.0, "the blur leaked before its window: YAVG {before}");
        assert!(after > 60.0, "the blur leaked after its window: YAVG {after}");
    }

    /// Copy mode is the claim most likely to be quietly false — it either
    /// produces a file with the source's own timestamps and a long black
    /// lead-in, or it does not stream-copy at all.
    #[test]
    fn the_lossless_path_really_is_lossless() {
        let src = fixture();
        let dest = std::env::temp_dir().join("facet-out-copy.mp4");
        let mut j = job(&[&src.to_string_lossy()]);
        j.spans = vec![Span { start: 2.0, end: 8.0 }];
        assert!(j.copyable());
        let out = cmd("ffmpeg").args(args_for(&j, 10.0, &dest)).output().expect("ffmpeg");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        let before = probe_media(src.to_string_lossy().into_owned()).unwrap();
        let after = probe_media(dest.to_string_lossy().into_owned()).unwrap();
        let vc = |m: &Media| m.tracks.iter().find(|t| t.kind == "video").unwrap().codec.clone();
        assert_eq!(vc(&before), vc(&after), "a stream copy re-encoded");
        // Keyframe snapping means the cut is not exact — that is the trade, and
        // it is why `precise` exists. It must still be in the neighbourhood.
        assert!((after.duration - 6.0).abs() < 2.5, "copy trim made {}s", after.duration);
    }

    #[test]
    fn a_frame_can_be_pulled_out_for_the_filmstrip() {
        let png = frame_bytes(fixture().to_string_lossy().into_owned(), 5.0, 160)
            .expect("a frame at 5s");
        // The frame comes out as MJPEG (cheaper than PNG for a filmstrip and
        // for the tracker), so the check is the JPEG start-of-image marker.
        assert_eq!(&png[0..3], &[0xFF, 0xD8, 0xFF], "that is not a JPEG");
        assert!(png.len() > 500, "a 160px frame should not be {} bytes", png.len());
    }

    #[test]
    fn keyframes_come_back_in_range() {
        let ks = keyframes(fixture().to_string_lossy().into_owned(), 0.0, 10.0).unwrap();
        assert!(!ks.is_empty(), "a 10s h264 file has keyframes");
        assert!(ks.iter().all(|k| (0.0..=10.5).contains(k)), "{ks:?}");
    }

    #[test]
    fn rotation_is_read_from_side_data_not_only_from_the_old_tag() {
        // Phone video carries its 90 in the display matrix, and a probe that
        // only reads `tags.rotate` reports every clip as landscape.
        let src = fixture();
        let dest = std::env::temp_dir().join("facet-out-rot.mp4");
        // `-display_rotation` is an *input* option — it describes how the file
        // should be presented, so it has to precede `-i`. Putting it after
        // makes ffmpeg reject the command, which is how this test first passed
        // while asserting nothing at all.
        let out = cmd("ffmpeg")
            .args(["-hide_banner", "-v", "error", "-y", "-display_rotation", "90", "-i"])
            .arg(&src)
            .args(["-c", "copy"])
            .arg(&dest)
            .output()
            .expect("ffmpeg");
        assert!(
            out.status.success(),
            "could not stage a rotated file:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let m = probe_media(dest.to_string_lossy().into_owned()).unwrap();
        let v = m.tracks.iter().find(|t| t.kind == "video").unwrap();
        assert_ne!(v.rotation, 0, "the display matrix was ignored");
        // 320x240 stored, presented as 240x320.
        assert_eq!((m.width, m.height), (240, 320));
    }

    #[test]
    fn rational_frame_rates_survive_the_trip() {
        assert!((rational("30000/1001") - 29.97).abs() < 0.01);
        assert_eq!(rational("0/0"), 0.0);
        assert_eq!(rational("25/1"), 25.0);
    }

    // ── Audio (item 5) ────────────────────────────────────────────────────

    fn ajob(input: &str, output: &str) -> AudioJob {
        AudioJob {
            inputs: vec![input.into()],
            output: output.into(),
            spans: vec![],
            gain_db: 0.0,
            normalize: false,
            speed: 1.0,
            fade_in: 0.0,
            fade_out: 0.0,
            mono: false,
            bitrate: 192,
            sample_rate: None,
            denoise: String::new(),
        }
    }

    fn aline(j: &AudioJob, source: f64) -> String {
        audio_args_for(j, source, Path::new("out.facet-part")).join(" ")
    }

    #[test]
    fn trimming_a_podcast_in_place_does_not_re_encode_it() {
        let mut j = ajob("show.mp3", "show-edit.mp3");
        j.spans = vec![Span { start: 12.0, end: 300.0 }];
        let s = aline(&j, 3600.0);
        assert!(s.contains("-c copy"), "{s}");
        assert!(s.find("-ss").unwrap() < s.find("-i").unwrap(), "{s}");
        // The cover art and the tags are part of the file people think they own.
        assert!(s.contains("-map 0"), "{s}");
        assert!(!s.contains("libmp3lame"), "{s}");
    }

    #[test]
    fn changing_the_container_gives_up_the_copy() {
        let mut j = ajob("show.mp3", "show.wav");
        j.spans = vec![Span { start: 0.0, end: 30.0 }];
        assert!(!j.copyable());
        let s = aline(&j, 60.0);
        assert!(s.contains("pcm_s16le"), "{s}");
        assert!(!s.contains("-b:a"), "a wav has no bitrate to set: {s}");
    }

    #[test]
    fn each_output_format_reaches_its_own_encoder() {
        for (ext, codec) in [
            ("mp3", "libmp3lame"),
            ("m4a", "aac"),
            ("flac", "flac"),
            ("opus", "libopus"),
            ("ogg", "libvorbis"),
            ("wav", "pcm_s16le"),
            // Anything unrecognised lands on the codec every device can open
            // rather than failing at the end of a long encode.
            ("bespoke", "aac"),
        ] {
            let mut j = ajob("in.wav", &format!("out.{ext}"));
            j.gain_db = 3.0;
            assert!(aline(&j, 10.0).contains(codec), "{ext} should encode with {codec}");
        }
    }

    #[test]
    fn normalising_then_lifting_it_does_both_in_that_order() {
        let mut j = ajob("in.wav", "out.wav");
        j.normalize = true;
        j.gain_db = 2.0;
        let s = aline(&j, 10.0);
        let norm = s.find("loudnorm").expect("loudnorm");
        let vol = s.find("volume=2.00dB").expect("the user's own gain");
        // The other way round, normalisation silently undoes the gain that was
        // just asked for, and the user is left turning a knob that does nothing.
        assert!(norm < vol, "{s}");
    }

    #[test]
    fn a_fade_is_timed_against_what_you_will_hear() {
        let mut j = ajob("in.wav", "out.wav");
        j.spans = vec![Span { start: 0.0, end: 40.0 }];
        j.speed = 2.0;
        j.fade_out = 1.0;
        // 40 seconds at 2× is 20 out, so the fade starts at 19 — not at 39.
        assert!(aline(&j, 60.0).contains("afade=t=out:st=19.000:d=1.000"), "{}", aline(&j, 60.0));
    }

    #[test]
    fn joining_recordings_concatenates_the_audio_only() {
        let mut j = ajob("a.wav", "out.wav");
        j.inputs.push("b.wav".into());
        let s = aline(&j, 10.0);
        assert!(s.contains("concat=n=2:v=0:a=1"), "{s}");
        // Rebasing matters more here than anywhere: two recordings joined at
        // their own timestamps play as one long silence.
        assert_eq!(s.matches("asetpts=PTS-STARTPTS").count(), 2, "{s}");
    }

    /// Ten seconds of a 440 Hz tone, well below full scale so a gain change has
    /// somewhere to go.
    fn audio_fixture() -> PathBuf {
        let p = std::env::temp_dir().join("facet-audio-fixture.wav");
        if p.exists() {
            return p;
        }
        let st = cmd("ffmpeg")
            .args([
                "-hide_banner", "-v", "error", "-y", "-f", "lavfi",
                "-i", "sine=frequency=440:duration=10",
                "-af", "volume=-12dB", "-c:a", "pcm_s16le",
            ])
            .arg(&p)
            .status()
            .expect("ffmpeg on PATH");
        assert!(st.success(), "could not build the audio fixture");
        p
    }

    #[test]
    fn the_audio_graphs_survive_contact_with_ffmpeg() {
        let src = audio_fixture().to_string_lossy().into_owned();

        let mut cut = ajob(&src, "cut.mp3");
        cut.spans = vec![Span { start: 0.0, end: 2.0 }, Span { start: 8.0, end: 10.0 }];
        cut.normalize = true;
        cut.fade_in = 0.5;
        cut.fade_out = 0.5;
        let dest = std::env::temp_dir().join("facet-aout-cut.mp3");
        let out = cmd("ffmpeg").args(audio_args_for(&cut, 10.0, &dest)).output().expect("ffmpeg");
        assert!(
            out.status.success(),
            "ffmpeg rejected the audio graph:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let m = probe_media(dest.to_string_lossy().into_owned()).unwrap();
        assert!((m.duration - 4.0).abs() < 0.35, "two 2s spans made {}s", m.duration);
        assert!(m.tracks.iter().any(|t| t.codec == "mp3"), "{:?}", m.tracks);

        let mut fast = ajob(&src, "fast.m4a");
        fast.speed = 2.0;
        fast.mono = true;
        let dest = std::env::temp_dir().join("facet-aout-fast.m4a");
        let out = cmd("ffmpeg").args(audio_args_for(&fast, 10.0, &dest)).output().expect("ffmpeg");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let m = probe_media(dest.to_string_lossy().into_owned()).unwrap();
        assert!((m.duration - 5.0).abs() < 0.35, "2x of 10s made {}s", m.duration);
        assert_eq!(m.tracks.iter().find(|t| t.kind == "audio").unwrap().channels, 1);
    }

    // ── Noise filtering (item 18) ────────────────────────────────────────────

    #[test]
    fn asking_for_no_noise_removal_adds_no_filters() {
        let j = ajob("show.mp3", "show-edit.mp3");
        assert!(noise_filters(&j.denoise).is_empty());
        // And an unknown preset is silence rather than a guess — a typo from a
        // future caller must not quietly apply the strongest thing here.
        assert!(noise_filters("banana").is_empty());
    }

    #[test]
    fn every_noise_preset_is_a_different_recording_problem() {
        // Traffic leans on the high-pass; a room does not have one, because
        // rolling off 110 Hz to fix hiss would thin every voice for nothing.
        assert!(noise_filters("traffic").iter().any(|f| f.starts_with("highpass")));
        assert!(!noise_filters("room").iter().any(|f| f.starts_with("highpass")));
        // Voice is band-limited at both ends; that is what makes it sound clean
        // rather than merely quieter.
        assert!(noise_filters("voice").iter().any(|f| f.starts_with("lowpass")));
        // Strong is the only one that pays for the slow filter.
        assert!(noise_filters("strong").iter().any(|f| f.starts_with("anlmdn")));
        assert!(!noise_filters("voice").iter().any(|f| f.starts_with("anlmdn")));
        // Every one of them is an FFT denoiser at heart; the rest is framing.
        for p in ["room", "traffic", "voice", "strong"] {
            assert!(
                noise_filters(p).iter().any(|f| f.starts_with("afftdn")),
                "{p} does not actually denoise anything"
            );
        }
    }

    #[test]
    fn noise_tracking_is_not_quietly_reintroduced() {
        // `tn=1` reads like the right answer and measures like a no-op in this
        // build — 1 dB of noise removed instead of 24. See `noise_filters`. This
        // test exists so nobody adds it back on the strength of the docs.
        for p in ["room", "traffic", "voice", "strong"] {
            assert!(
                !noise_filters(p).iter().any(|f| f.contains("tn=1")),
                "{p} turned noise tracking back on"
            );
        }
    }

    #[test]
    fn cleaning_a_recording_means_re_encoding_it() {
        let mut j = ajob("meeting.m4a", "meeting-edit.m4a");
        j.spans = vec![Span { start: 0.0, end: 60.0 }];
        assert!(j.copyable(), "a plain trim should still be a copy");
        j.denoise = "voice".into();
        assert!(!j.copyable(), "there is no such thing as denoising by copying");
    }

    #[test]
    fn noise_comes_out_before_the_level_is_measured() {
        let mut j = ajob("meeting.m4a", "meeting-edit.m4a");
        j.denoise = "room".into();
        j.normalize = true;
        let f = audio_filters(&j, 60.0).join(",");
        assert!(
            f.find("afftdn").unwrap() < f.find("loudnorm").unwrap(),
            "normalising first measures the noise as programme and then amplifies it: {f}"
        );
    }

    /// Nine seconds shaped like a recording of somebody talking: a continuous
    /// white-noise floor with two bursts of tone over it, at 2–4 s and 6–8 s.
    ///
    /// Pure noise is the wrong fixture. A denoiser given nothing but noise can
    /// pass by turning the file down, which is precisely the failure this is
    /// supposed to catch. With gaps and speech you can measure both halves of
    /// the promise separately: the floor between phrases has to fall, and the
    /// speech has to stay where it was.
    fn speech_over_noise_fixture() -> PathBuf {
        let p = std::env::temp_dir().join("facet-speech-noise-fixture.wav");
        if p.exists() {
            return p;
        }
        let bursts = "between(t,2,4)+between(t,6,8)";
        let st = cmd("ffmpeg")
            .args([
                "-hide_banner", "-v", "error", "-y",
                "-f", "lavfi", "-i",
                "anoisesrc=color=white:amplitude=0.03:duration=9:sample_rate=44100",
                "-f", "lavfi", "-i", "sine=frequency=300:duration=9:sample_rate=44100",
                "-filter_complex",
                &format!(
                    "[1:a]volume=enable='{bursts}':volume=0.5,\
                     volume=enable='not({bursts})':volume=0[v];\
                     [0:a][v]amix=inputs=2:normalize=0[a]"
                ),
                "-map", "[a]", "-c:a", "pcm_s16le",
            ])
            .arg(&p)
            .status()
            .expect("ffmpeg on PATH");
        assert!(st.success(), "could not build the speech-over-noise fixture");
        p
    }

    /// Average level of one window of a file, per ffmpeg. Mean rather than peak
    /// because a noise floor is everywhere and a peak describes one sample.
    fn mean_dbfs_between(path: &Path, from: f64, to: f64) -> f64 {
        let out = cmd("ffmpeg")
            .args(["-hide_banner", "-i"])
            .arg(path)
            .args(["-af", &format!("atrim={from}:{to},volumedetect"), "-f", "null", "-"])
            .output()
            .expect("ffmpeg on PATH");
        let text = String::from_utf8_lossy(&out.stderr);
        text.lines()
            .find_map(|l| l.split("mean_volume:").nth(1))
            .and_then(|v| v.trim().trim_end_matches(" dB").parse::<f64>().ok())
            .expect("volumedetect reports a mean")
    }

    /// The floor between phrases, and the phrase itself.
    fn gap_and_speech(path: &Path) -> (f64, f64) {
        (mean_dbfs_between(path, 0.0, 1.8), mean_dbfs_between(path, 2.5, 3.5))
    }

    #[test]
    fn the_denoiser_actually_removes_noise_and_leaves_the_voice() {
        let src = speech_over_noise_fixture();
        let (gap0, voice0) = gap_and_speech(&src);

        let mut j = ajob(&src.to_string_lossy(), "clean.wav");
        j.denoise = "voice".into();
        let dest = std::env::temp_dir().join("facet-aout-denoised.wav");
        let out = cmd("ffmpeg").args(audio_args_for(&j, 9.0, &dest)).output().expect("ffmpeg");
        assert!(
            out.status.success(),
            "ffmpeg rejected the noise graph:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let (gap1, voice1) = gap_and_speech(&dest);

        // Both halves, measured by ffmpeg rather than asserted against a number
        // this code picked. 15 dB is a floor under the ~24 dB the preset really
        // manages, so the test fails on a broken filter and not on a tweak.
        assert!(gap1 < gap0 - 15.0, "the noise floor barely moved: {gap0} -> {gap1} dBFS");
        assert!(
            voice1 > voice0 - 3.0,
            "the denoiser took the voice with it: {voice0} -> {voice1} dBFS"
        );
    }

    #[test]
    fn the_noise_presets_get_stronger_in_the_order_they_are_offered() {
        // A ladder whose rungs are not in order is worse than no ladder: people
        // reach for the next one down when the last was too much.
        let src = speech_over_noise_fixture();
        let mut floors = vec![];
        for preset in ["", "room", "traffic", "voice", "strong"] {
            let mut j = ajob(&src.to_string_lossy(), "clean.wav");
            j.denoise = preset.into();
            j.mono = true; // keeps "off" on the filter path too, so it is a fair row
            let dest = std::env::temp_dir().join(format!("facet-aout-nr-{preset}.wav"));
            let out = cmd("ffmpeg").args(audio_args_for(&j, 9.0, &dest)).output().expect("ffmpeg");
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            floors.push((preset, mean_dbfs_between(&dest, 0.0, 1.8)));
        }
        for pair in floors.windows(2) {
            let ((pa, a), (pb, b)) = (pair[0], pair[1]);
            assert!(b < a - 2.0, "{pb} ({b} dBFS) is not meaningfully quieter than {pa} ({a} dBFS)");
        }
    }

    /// What ffmpeg itself says the loudest sample in a file is, in dBFS.
    ///
    /// Used as the reference the peak scan is checked against, because a scan
    /// that is wrong by a constant factor still looks like a perfectly good
    /// waveform — it is only wrong when you compare it to something that is not
    /// my own code. (This is how the first version of the test was caught: it
    /// asserted the fixture was at -12 dBFS, and the fixture is at -30, because
    /// ffmpeg's `sine` does not start at full scale.)
    fn max_dbfs(path: &Path) -> f64 {
        let out = cmd("ffmpeg")
            .args(["-hide_banner", "-i"])
            .arg(path)
            .args(["-af", "volumedetect", "-f", "null", "-"])
            .output()
            .expect("ffmpeg on PATH");
        let text = String::from_utf8_lossy(&out.stderr);
        text.lines()
            .find_map(|l| l.split("max_volume:").nth(1))
            .and_then(|v| v.trim().trim_end_matches(" dB").parse::<f64>().ok())
            .expect("volumedetect reports a max")
    }

    #[test]
    fn the_waveform_is_a_shape_and_not_a_flat_line() {
        let p = audio_fixture();
        let w = peaks(p.to_string_lossy().into_owned(), 200).expect("peaks from a 10s tone");
        assert_eq!(w.len(), 200);

        // A continuous tone should read the same in every bucket. Zeros mean the
        // stream was never read; scatter means the samples are being taken
        // misaligned, which is the classic s16le bug and does not look obviously
        // wrong on screen.
        let top = w.iter().cloned().fold(0f32, f32::max);
        let steady = w.iter().filter(|v| (**v - top).abs() < top * 0.1).count();
        assert!(steady > 190, "only {steady}/200 buckets hold the tone: {:?}", &w[..8]);

        let measured = 20.0 * (top as f64).log10();
        let reference = max_dbfs(&p);
        assert!(
            (measured - reference).abs() < 1.0,
            "the scan reads {measured:.1} dBFS where ffmpeg measures {reference:.1}",
        );
    }

    #[test]
    fn a_gain_change_actually_moves_the_level() {
        let src = audio_fixture().to_string_lossy().into_owned();
        let mut up = ajob(&src, "loud.wav");
        up.gain_db = 6.0;
        let dest = std::env::temp_dir().join("facet-aout-loud.wav");
        let out = cmd("ffmpeg").args(audio_args_for(&up, 10.0, &dest)).output().expect("ffmpeg");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        let before = peaks(src, 64).unwrap();
        let after = peaks(dest.to_string_lossy().into_owned(), 64).unwrap();
        let peak = |v: &[f32]| v.iter().cloned().fold(0f32, f32::max);
        let ratio = peak(&after) / peak(&before);
        // +6 dB is a doubling. Read back through a real decode, not from the
        // command line that asked for it.
        assert!((ratio - 2.0).abs() < 0.2, "6 dB moved the peak by {ratio}x");
    }
}
