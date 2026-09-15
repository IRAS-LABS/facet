//! Where pop-out windows go. Pure arithmetic, so it is tested here and not by
//! dragging windows around a real desktop.
//!
//! Everything is in **physical pixels of one monitor's work area** (the screen
//! minus the taskbar). Physical, because two monitors at different scaling have
//! no shared logical coordinate space: a window straddling a 100% and a 150%
//! screen has two logical widths at once. The caller converts the few constants
//! that are meant in logical pixels — the gap, the minimum size — with that
//! monitor's scale factor before asking.
//!
//! Each window is letterboxed to its own picture's shape inside its slot, so a
//! portrait phone video in a tile grid is a tall window in the middle of its
//! cell rather than a landscape window with black bars in it.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn right(&self) -> f64 {
        self.x + self.w
    }
    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }
    #[cfg(test)]
    pub fn overlaps(&self, o: &Rect) -> bool {
        // Touching edges are not an overlap; gaps are added by the layouts.
        self.x < o.right() - 0.5 && o.x < self.right() - 0.5 && self.y < o.bottom() - 0.5 && o.y < self.bottom() - 0.5
    }
}

/// The shape assumed for a file whose picture has not been measured yet.
pub const DEFAULT_ASPECT: f64 = 16.0 / 9.0;

#[derive(Debug, Clone, Copy)]
pub struct Metrics {
    /// Space between windows and around the edge.
    pub gap: f64,
    pub min_w: f64,
    pub min_h: f64,
}

impl Metrics {
    /// The logical-pixel constants at a given display scale.
    pub fn at_scale(scale: f64) -> Metrics {
        let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
        Metrics { gap: 8.0 * s, min_w: 160.0 * s, min_h: 90.0 * s }
    }
}

fn aspect_or_default(a: Option<&f64>) -> f64 {
    match a {
        Some(&v) if v.is_finite() && v > 0.05 && v < 20.0 => v,
        _ => DEFAULT_ASPECT,
    }
}

/// The largest `aspect`-shaped rectangle inside `cell`, centred in it — but
/// never smaller than the minimum window, which wins over the shape for a
/// panorama or a sliver of a cell.
fn fit(cell: Rect, aspect: f64, m: &Metrics) -> Rect {
    let (mut w, mut h) = if cell.w / cell.h > aspect {
        (cell.h * aspect, cell.h)
    } else {
        (cell.w, cell.w / aspect)
    };
    w = w.max(m.min_w.min(cell.w));
    h = h.max(m.min_h.min(cell.h));
    Rect { x: cell.x + (cell.w - w) / 2.0, y: cell.y + (cell.h - h) / 2.0, w: w.floor(), h: h.floor() }
}

/// A grid over the whole work area.
///
/// The column count is the one that makes each cell closest to the typical
/// picture shape: for `n` cells of shape `a` on an area `W×H`, `cols·rows ≥ n`
/// with `(W/cols) / (H/rows) ≈ a` gives `cols = √(n·(W/H)/a)`. Rounded up, and
/// then rows only as many as are needed, so six videos on a wide screen are
/// three by two and not two by three.
pub fn tile(area: Rect, aspects: &[f64], m: &Metrics) -> Vec<Rect> {
    let n = aspects.len();
    if n == 0 {
        return Vec::new();
    }
    let typical = aspects.iter().map(|a| aspect_or_default(Some(a))).sum::<f64>() / n as f64;
    let mut cols = ((n as f64 * (area.w / area.h) / typical).sqrt().ceil() as usize).clamp(1, n);
    let mut rows = n.div_ceil(cols);
    // Round-up can leave a whole empty row; take a column back if it still fits.
    while cols > 1 && (cols - 1) * rows >= n {
        cols -= 1;
    }
    rows = n.div_ceil(cols);
    let cw = (area.w - m.gap * (cols as f64 + 1.0)) / cols as f64;
    let ch = (area.h - m.gap * (rows as f64 + 1.0)) / rows as f64;
    (0..n)
        .map(|i| {
            let (c, r) = (i % cols, i / cols);
            let cell = Rect {
                x: area.x + m.gap + c as f64 * (cw + m.gap),
                y: area.y + m.gap + r as f64 * (ch + m.gap),
                w: cw,
                h: ch,
            };
            fit(cell, aspect_or_default(aspects.get(i)), m)
        })
        .collect()
}

/// A column up from the bottom-right corner, then the next column to its left.
///
/// The width is a quarter of the screen, capped at 480 logical pixels — big
/// enough to watch, small enough to work beside.
pub fn corner(area: Rect, aspects: &[f64], m: &Metrics, scale: f64) -> Vec<Rect> {
    let w = (area.w * 0.25).min(480.0 * scale.max(0.1)).max(m.min_w);
    let mut out = Vec::with_capacity(aspects.len());
    let mut x = area.right() - m.gap - w;
    let mut bottom = area.bottom() - m.gap;
    for i in 0..aspects.len() {
        let a = aspect_or_default(aspects.get(i));
        let h = (w / a).clamp(m.min_h, area.h - 2.0 * m.gap);
        if bottom - h < area.y + m.gap && bottom < area.bottom() - m.gap {
            // Out of room: a new column to the left, back at the bottom.
            x -= w + m.gap;
            bottom = area.bottom() - m.gap;
        }
        if x < area.x + m.gap {
            // Out of columns too. Pile onto the first slot rather than off
            // screen — a window you cannot see is worse than one on top.
            x = area.right() - m.gap - w;
        }
        let r = Rect { x, y: bottom - h, w: w.floor(), h: h.floor() };
        bottom = r.y - m.gap;
        out.push(r);
    }
    out
}

/// The corner column again, for windows whose sizes are already decided (an
/// explicit `--size`, or ones already open). Each column is as wide as its
/// widest window, and every window hugs the right edge of its column, so a
/// small pop-out still sits in the corner instead of a slot's width away.
pub fn corner_sized(area: Rect, sizes: &[(f64, f64)], m: &Metrics) -> Vec<Rect> {
    let mut out = Vec::with_capacity(sizes.len());
    let mut right = area.right() - m.gap;
    let mut col_w: f64 = 0.0;
    let mut bottom = area.bottom() - m.gap;
    for &(w0, h0) in sizes {
        let w = w0.max(m.min_w).min(area.w - 2.0 * m.gap).floor();
        let h = h0.max(m.min_h).min(area.h - 2.0 * m.gap).floor();
        if bottom - h < area.y + m.gap && bottom < area.bottom() - m.gap {
            right -= col_w + m.gap;
            col_w = 0.0;
            bottom = area.bottom() - m.gap;
        }
        if right - w < area.x + m.gap {
            right = area.right() - m.gap;
            col_w = 0.0;
            bottom = area.bottom() - m.gap;
        }
        let r = Rect { x: right - w, y: bottom - h, w, h };
        col_w = col_w.max(w);
        bottom = r.y - m.gap;
        out.push(r);
    }
    out
}

/// Diagonal steps from the top-left, wrapping back to the start when the next
/// step would leave the screen.
pub fn cascade(area: Rect, aspects: &[f64], m: &Metrics, scale: f64) -> Vec<Rect> {
    let step = 32.0 * scale.max(0.1);
    let w = (area.w * 0.3).max(m.min_w).min(area.w - 2.0 * m.gap);
    let (mut x, mut y) = (area.x + m.gap, area.y + m.gap);
    aspects
        .iter()
        .map(|a| {
            let h = (w / aspect_or_default(Some(a))).clamp(m.min_h, area.h - 2.0 * m.gap);
            if x + w > area.right() - m.gap || y + h > area.bottom() - m.gap {
                x = area.x + m.gap;
                y = area.y + m.gap;
            }
            let r = Rect { x: x.floor(), y: y.floor(), w: w.floor(), h: h.floor() };
            x += step;
            y += step;
            r
        })
        .collect()
}

/// Keep a requested rectangle on the work area: shrink it if it is bigger than
/// the screen, then slide it back inside. Used for `--at` and `--size`, which
/// an agent can get wrong by a monitor's width.
pub fn clamp_into(r: Rect, area: Rect, m: &Metrics) -> Rect {
    let w = r.w.clamp(m.min_w.min(area.w), area.w);
    let h = r.h.clamp(m.min_h.min(area.h), area.h);
    let x = r.x.clamp(area.x, area.right() - w);
    let y = r.y.clamp(area.y, area.bottom() - h);
    Rect { x, y, w, h }
}

/// A window that has measured its picture shrinks to that shape inside the
/// rectangle it was given, keeping its centre, so a layout that did not
/// overlap before the measurement does not overlap after it.
pub fn letterbox(r: Rect, aspect: f64, m: &Metrics) -> Rect {
    fit(r, aspect_or_default(Some(&aspect)), m)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1.0;

    fn inside(r: &Rect, a: &Rect) -> bool {
        r.x >= a.x - EPS && r.y >= a.y - EPS && r.right() <= a.right() + EPS && r.bottom() <= a.bottom() + EPS
    }

    fn no_overlaps(rs: &[Rect]) -> bool {
        rs.iter().enumerate().all(|(i, a)| rs.iter().skip(i + 1).all(|b| !a.overlaps(b)))
    }

    /// 1080p minus a taskbar, a 4K at 150% below-left of it, a portrait
    /// monitor at 125% with a negative left edge.
    fn screens() -> Vec<(Rect, f64)> {
        vec![
            (Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1032.0 }, 1.0),
            (Rect { x: -3840.0, y: 1080.0, w: 3840.0, h: 2088.0 }, 1.5),
            (Rect { x: -1200.0, y: -400.0, w: 1200.0, h: 1872.0 }, 1.25),
            (Rect { x: 1920.0, y: 0.0, w: 2560.0, h: 1392.0 }, 2.0),
        ]
    }

    #[test]
    fn corner_sized_hugs_the_corner_and_stays_on_screen() {
        for (area, scale) in screens() {
            let m = Metrics::at_scale(scale);
            let small = (360.0 * scale, 220.0 * scale);
            let one = corner_sized(area, &[small], &m)[0];
            assert!((area.right() - m.gap - one.right()).abs() <= EPS, "small hugs the right edge");
            assert!((area.bottom() - m.gap - one.bottom()).abs() <= EPS, "small hugs the bottom edge");
            for n in 1..=12 {
                let mixed: Vec<(f64, f64)> =
                    (0..n).map(|i| if i % 2 == 0 { small } else { (480.0 * scale, 270.0 * scale) }).collect();
                let rs = corner_sized(area, &mixed, &m);
                assert!(rs.iter().all(|r| inside(r, &area)), "n={n} scale={scale}");
                // The portrait screen has room for one column of these, and
                // past that a window piles onto the first slot on purpose.
                assert!(n > 3 || no_overlaps(&rs), "n={n} scale={scale}");
            }
            if area.w >= 1920.0 && scale == 1.0 {
                let twelve = corner_sized(area, &vec![small; 12], &m);
                assert!(no_overlaps(&twelve), "a landscape screen holds twelve small ones, scale={scale}");
            }
            // Bigger than the screen is cut down to it, not placed off it.
            let huge = corner_sized(area, &[(1e6, 1e6)], &m)[0];
            assert!(inside(&huge, &area));
        }
    }

    #[test]
    fn tile_fits_every_count_on_every_screen_without_overlap() {
        for (area, scale) in screens() {
            let m = Metrics::at_scale(scale);
            for n in 1..=32 {
                let aspects: Vec<f64> = (0..n).map(|i| [16.0 / 9.0, 9.0 / 16.0, 1.0, 4.0 / 3.0][i % 4]).collect();
                let rs = tile(area, &aspects, &m);
                assert_eq!(rs.len(), n);
                assert!(rs.iter().all(|r| inside(r, &area)), "n={n} scale={scale}: a window left the screen");
                assert!(no_overlaps(&rs), "n={n} scale={scale}: windows overlap");
                // Up to the pop-out cap every window keeps the minimum size. Past
                // it, 32 windows at 320 physical pixels each simply do not fit on
                // a 2560-wide screen, and staying inside the cell wins.
                assert!(
                    n > 12 || rs.iter().all(|r| r.w + EPS >= m.min_w && r.h + EPS >= m.min_h),
                    "n={n} scale={scale}: a window is below the minimum size"
                );
            }
        }
    }

    #[test]
    fn tile_respects_each_pictures_shape() {
        let area = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1032.0 };
        let m = Metrics::at_scale(1.0);
        let rs = tile(area, &[16.0 / 9.0, 9.0 / 16.0], &m);
        assert!((rs[0].w / rs[0].h - 16.0 / 9.0).abs() < 0.02);
        assert!((rs[1].w / rs[1].h - 9.0 / 16.0).abs() < 0.02, "portrait stays portrait");
    }

    #[test]
    fn six_videos_on_a_wide_screen_are_three_by_two() {
        let area = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1032.0 };
        let rs = tile(area, &[DEFAULT_ASPECT; 6], &Metrics::at_scale(1.0));
        let mut xs: Vec<i64> = rs.iter().map(|r| r.x as i64).collect();
        xs.sort();
        xs.dedup();
        let mut ys: Vec<i64> = rs.iter().map(|r| r.y as i64).collect();
        ys.sort();
        ys.dedup();
        assert_eq!((xs.len(), ys.len()), (3, 2));
    }

    #[test]
    fn corner_stacks_up_from_bottom_right_and_stays_on_screen() {
        for (area, scale) in screens() {
            let m = Metrics::at_scale(scale);
            for n in 1..=12 {
                let rs = corner(area, &vec![DEFAULT_ASPECT; n], &m, scale);
                assert!(rs.iter().all(|r| inside(r, &area)), "n={n} scale={scale}");
                // Every one of these screens holds at least nine corner slots;
                // only past that may a window pile onto another.
                assert!(n > 9 || no_overlaps(&rs), "n={n} scale={scale}");
            }
            let one = corner(area, &[DEFAULT_ASPECT], &m, scale)[0];
            assert!((area.right() - m.gap - one.right()).abs() <= EPS, "hugs the right edge");
            assert!((area.bottom() - m.gap - one.bottom()).abs() <= EPS, "hugs the bottom edge");
        }
    }

    #[test]
    fn cascade_steps_and_wraps_inside_the_screen() {
        for (area, scale) in screens() {
            let m = Metrics::at_scale(scale);
            let rs = cascade(area, &vec![DEFAULT_ASPECT; 40], &m, scale);
            assert!(rs.iter().all(|r| inside(r, &area)), "scale={scale}");
            assert!(rs[1].x > rs[0].x && rs[1].y > rs[0].y);
        }
    }

    #[test]
    fn clamp_pulls_a_window_back_from_another_monitor() {
        let area = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1032.0 };
        let m = Metrics::at_scale(1.0);
        let r = clamp_into(Rect { x: 5000.0, y: -300.0, w: 3000.0, h: 50.0 }, area, &m);
        assert!(inside(&r, &area));
        assert_eq!((r.w, r.h), (1920.0, 90.0));
    }

    #[test]
    fn letterbox_keeps_the_centre_and_never_grows() {
        let m = Metrics::at_scale(1.0);
        let cell = Rect { x: 100.0, y: 100.0, w: 640.0, h: 360.0 };
        let r = letterbox(cell, 9.0 / 16.0, &m);
        assert!(inside(&r, &cell));
        assert!(((r.x + r.w / 2.0) - (cell.x + cell.w / 2.0)).abs() <= EPS);
        // Nonsense aspects fall back to the default instead of a zero-width window.
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let r = letterbox(cell, bad, &m);
            assert!(r.w >= m.min_w && r.h >= m.min_h);
        }
    }
}
