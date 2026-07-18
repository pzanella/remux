use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log(s: &str);
}

macro_rules! log {
    ($($t:tt)*) => { console_log(&format!($($t)*)) };
}

// ── Data structures ─────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SampleInfo {
    pub file_offset: u64,
    pub size: u32,
    pub pts: u64,
    pub dts: u64,
    pub duration: u32,
    pub is_keyframe: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct SegmentSamples {
    pub video: Vec<SampleInfo>,
    pub audio: Vec<SampleInfo>,
    pub start_pts_sec: f64,
    pub duration_sec: f64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct SampleMeta {
    pub size: u32,
    pub pts: u64,
    pub dts: u64,
    pub is_keyframe: bool,
}

/// One WebCodecs-encoded chunk's metadata, as reported by `VideoEncoder`/
/// `AudioEncoder`'s `output` callback. `timestamp_us` is the chunk's
/// presentation timestamp in microseconds, WebCodecs' native unit.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncodedChunkMeta {
    pub size: u32,
    pub timestamp_us: f64,
    #[serde(default)]
    pub is_keyframe: bool,
}

// ── Big-endian read helpers ─────────────────────────────────────

#[inline]
fn u16be(d: &[u8], o: usize) -> u16 {
    ((d[o] as u16) << 8) | (d[o + 1] as u16)
}

#[inline]
fn u32be(d: &[u8], o: usize) -> u32 {
    ((d[o] as u32) << 24)
        | ((d[o + 1] as u32) << 16)
        | ((d[o + 2] as u32) << 8)
        | (d[o + 3] as u32)
}

#[inline]
fn u64be(d: &[u8], o: usize) -> u64 {
    ((d[o] as u64) << 56)
        | ((d[o + 1] as u64) << 48)
        | ((d[o + 2] as u64) << 40)
        | ((d[o + 3] as u64) << 32)
        | ((d[o + 4] as u64) << 24)
        | ((d[o + 5] as u64) << 16)
        | ((d[o + 6] as u64) << 8)
        | (d[o + 7] as u64)
}

// ── MP4 box navigation ──────────────────────────────────────────

/// Returns (total_box_size, box_type_start, payload_start) relative to `off`.
fn box_header(data: &[u8], off: usize) -> Option<(u64, usize, usize)> {
    if off + 8 > data.len() {
        return None;
    }
    let raw_size = u32be(data, off) as u64;
    let type_start = off + 4;

    if raw_size == 1 {
        if off + 16 > data.len() {
            return None;
        }
        let ext = u64be(data, off + 8);
        Some((ext, type_start, off + 16))
    } else if raw_size == 0 {
        Some(((data.len() - off) as u64, type_start, off + 8))
    } else {
        Some((raw_size, type_start, off + 8))
    }
}

/// Find the first direct child box of `box_type` inside `container`.
fn find_box<'a>(container: &'a [u8], box_type: &[u8; 4]) -> Option<&'a [u8]> {
    let mut off = 0;
    while off < container.len() {
        let (size, toff, doff) = box_header(container, off)?;
        if size < 8 {
            break;
        }
        let end = off + size as usize;
        if end > container.len() {
            break;
        }
        if &container[toff..toff + 4] == box_type {
            return Some(&container[doff..end]);
        }
        off = end;
    }
    None
}

/// Find every direct child box of `box_type` inside `container`.
fn find_all_boxes<'a>(container: &'a [u8], box_type: &[u8; 4]) -> Vec<&'a [u8]> {
    let mut results = Vec::new();
    let mut off = 0;
    while off < container.len() {
        if let Some((size, toff, doff)) = box_header(container, off) {
            if size < 8 || off + size as usize > container.len() {
                break;
            }
            let end = off + size as usize;
            if &container[toff..toff + 4] == box_type {
                results.push(&container[doff..end]);
            }
            off = end;
        } else {
            break;
        }
    }
    results
}

/// Walk a dotted path, e.g. `[b"moov", b"trak"]`.
fn find_box_path<'a>(data: &'a [u8], path: &[&[u8; 4]]) -> Option<&'a [u8]> {
    if path.is_empty() {
        return Some(data);
    }
    find_box_path(find_box(data, path[0])?, &path[1..])
}

// ── Sample table parsing ────────────────────────────────────────

struct SttsEntry {
    count: u32,
    duration: u32,
}

struct CttsEntry {
    count: u32,
    offset: i32,
}

struct StscEntry {
    first_chunk: u32,
    samples_per_chunk: u32,
}

fn parse_stts(d: &[u8]) -> Vec<SttsEntry> {
    if d.len() < 8 {
        return vec![];
    }
    let n = u32be(d, 4) as usize;
    let mut v = Vec::with_capacity(n);
    let mut o = 8;
    for _ in 0..n {
        if o + 8 > d.len() {
            break;
        }
        v.push(SttsEntry { count: u32be(d, o), duration: u32be(d, o + 4) });
        o += 8;
    }
    v
}

fn parse_stss(d: &[u8]) -> std::collections::HashSet<u32> {
    if d.len() < 8 {
        return std::collections::HashSet::new();
    }
    let n = u32be(d, 4) as usize;
    let mut s = std::collections::HashSet::with_capacity(n);
    let mut o = 8;
    for _ in 0..n {
        if o + 4 > d.len() {
            break;
        }
        s.insert(u32be(d, o));
        o += 4;
    }
    s
}

fn parse_ctts(d: &[u8]) -> Vec<CttsEntry> {
    if d.len() < 8 {
        return vec![];
    }
    let n = u32be(d, 4) as usize;
    let mut v = Vec::with_capacity(n);
    let mut o = 8;
    for _ in 0..n {
        if o + 8 > d.len() {
            break;
        }
        v.push(CttsEntry { count: u32be(d, o), offset: u32be(d, o + 4) as i32 });
        o += 8;
    }
    v
}

fn parse_stsc(d: &[u8]) -> Vec<StscEntry> {
    if d.len() < 8 {
        return vec![];
    }
    let n = u32be(d, 4) as usize;
    let mut v = Vec::with_capacity(n);
    let mut o = 8;
    for _ in 0..n {
        if o + 12 > d.len() {
            break;
        }
        v.push(StscEntry { first_chunk: u32be(d, o), samples_per_chunk: u32be(d, o + 4) });
        o += 12;
    }
    v
}

fn parse_stsz(d: &[u8]) -> Vec<u32> {
    if d.len() < 12 {
        return vec![];
    }
    let default_size = u32be(d, 4);
    let n = u32be(d, 8) as usize;
    if default_size != 0 {
        return vec![default_size; n];
    }
    let mut v = Vec::with_capacity(n);
    let mut o = 12;
    for _ in 0..n {
        if o + 4 > d.len() {
            break;
        }
        v.push(u32be(d, o));
        o += 4;
    }
    v
}

fn parse_stco(d: &[u8]) -> Vec<u64> {
    if d.len() < 8 {
        return vec![];
    }
    let n = u32be(d, 4) as usize;
    let mut v = Vec::with_capacity(n);
    let mut o = 8;
    for _ in 0..n {
        if o + 4 > d.len() {
            break;
        }
        v.push(u32be(d, o) as u64);
        o += 4;
    }
    v
}

fn parse_co64(d: &[u8]) -> Vec<u64> {
    if d.len() < 8 {
        return vec![];
    }
    let n = u32be(d, 4) as usize;
    let mut v = Vec::with_capacity(n);
    let mut o = 8;
    for _ in 0..n {
        if o + 8 > d.len() {
            break;
        }
        v.push(u64be(d, o));
        o += 8;
    }
    v
}

fn samples_per_chunk_for(stsc: &[StscEntry], chunk_1based: u32) -> u32 {
    let mut spc = 1u32;
    for e in stsc {
        if e.first_chunk <= chunk_1based {
            spc = e.samples_per_chunk;
        } else {
            break;
        }
    }
    spc
}

/// Build the full sample list (offset, size, pts/dts, keyframe flag) from a `stbl` box.
fn build_samples(stbl: &[u8], all_keyframes: bool) -> Vec<SampleInfo> {
    let sizes = parse_stsz(find_box(stbl, b"stsz").unwrap_or(&[]));
    let total = sizes.len();
    if total == 0 {
        return vec![];
    }

    let chunk_offsets = if let Some(d) = find_box(stbl, b"co64") {
        parse_co64(d)
    } else if let Some(d) = find_box(stbl, b"stco") {
        parse_stco(d)
    } else {
        return vec![];
    };

    let stsc = find_box(stbl, b"stsc").map(parse_stsc).unwrap_or_default();

    // Expand chunk offsets into a per-sample file offset.
    let mut file_offsets = Vec::with_capacity(total);
    let mut sample_idx = 0usize;
    for (chunk_idx, &chunk_offset_start) in chunk_offsets.iter().enumerate() {
        let spc = samples_per_chunk_for(&stsc, (chunk_idx + 1) as u32);
        let mut chunk_offset = chunk_offset_start;
        for _ in 0..spc {
            if sample_idx >= total {
                break;
            }
            file_offsets.push(chunk_offset);
            chunk_offset += sizes[sample_idx] as u64;
            sample_idx += 1;
        }
    }

    let stts = find_box(stbl, b"stts").map(parse_stts).unwrap_or_default();
    let mut dts_vec: Vec<u64> = Vec::with_capacity(total);
    let mut dts = 0u64;
    let mut durs: Vec<u32> = Vec::with_capacity(total);
    for e in &stts {
        for _ in 0..e.count {
            if dts_vec.len() >= total {
                break;
            }
            dts_vec.push(dts);
            durs.push(e.duration);
            dts += e.duration as u64;
        }
    }

    // pts = dts + composition-time offset (ctts), when present.
    let mut pts_vec = dts_vec.clone();
    if let Some(ctts_d) = find_box(stbl, b"ctts") {
        let ctts = parse_ctts(ctts_d);
        let mut idx = 0usize;
        for e in &ctts {
            for _ in 0..e.count {
                if idx < pts_vec.len() {
                    pts_vec[idx] = (dts_vec[idx] as i64 + e.offset as i64).max(0) as u64;
                }
                idx += 1;
            }
        }
    }

    let keyframes = find_box(stbl, b"stss").map(parse_stss).unwrap_or_default();

    let mut samples = Vec::with_capacity(total);
    for i in 0..total {
        let fo = if i < file_offsets.len() { file_offsets[i] } else { 0 };
        let dur = if i < durs.len() { durs[i] } else { 0 };
        let is_kf = all_keyframes || keyframes.contains(&((i + 1) as u32));
        samples.push(SampleInfo {
            file_offset: fo,
            size: sizes[i],
            pts: if i < pts_vec.len() { pts_vec[i] } else { 0 },
            dts: if i < dts_vec.len() { dts_vec[i] } else { 0 },
            duration: dur,
            is_keyframe: is_kf,
        });
    }
    samples
}

// ── Track info ───────────────────────────────────────────────────

#[derive(Clone)]
struct TrackData {
    timescale: u32,
    handler: [u8; 4],
    samples: Vec<SampleInfo>,
    /// SPS+PPS in Annex-B form (each prefixed with a 4-byte start code).
    annexb_header: Vec<u8>,
    nalu_len_size: u8,
    /// AAC config as [profile, sample_rate_idx, channels].
    aac_config: [u8; 3],
    /// SPS profile_idc/constraint_flags/level_idc, for building an
    /// `avc1.PPCCLL` WebCodecs codec string.
    avc1_profile: Option<[u8; 3]>,
    /// The raw `avcC` box payload, verbatim — this is what a WebCodecs
    /// `VideoDecoder` wants as `description` to decode AVCC-framed (length-
    /// prefixed) samples directly, with no Annex-B conversion needed.
    avcc_raw: Vec<u8>,
    /// Last valid sample time from this track's own edit list, in its own
    /// timescale — `None` if it has no edit list. Not applied to `samples`
    /// here; `parse_headers` combines it with the other track's before
    /// trimming either one, since both should end at the same wall-clock
    /// time and a real-world file may only carry the edit list on one of
    /// its tracks (see `parse_headers` for why).
    edit_list_end: Option<u64>,
}

/// Returns (SPS+PPS in Annex-B form, NALU length size, the first SPS's
/// profile_idc/constraint_flags/level_idc — the three bytes an `avc1.PPCCLL`
/// WebCodecs codec string is built from).
fn parse_avcc_header(avcc: &[u8]) -> (Vec<u8>, u8, Option<[u8; 3]>) {
    // avcC layout: version(1) profile(1) compat(1) level(1) nalu_len_minus1(1)
    // num_sps(1) [sps_len(2) sps...]... num_pps(1) [pps_len(2) pps...]...
    if avcc.len() < 6 {
        return (Vec::new(), 4, None);
    }
    let nalu_len = (avcc[4] & 0x03) + 1;
    let mut out = Vec::new();
    let mut sps_profile = None;
    let num_sps = (avcc[5] & 0x1F) as usize;
    let mut off = 6;
    for _ in 0..num_sps {
        if off + 2 > avcc.len() {
            break;
        }
        let len = u16be(avcc, off) as usize;
        off += 2;
        if off + len > avcc.len() {
            break;
        }
        let sps = &avcc[off..off + len];
        // sps[0] is the NAL header byte; profile_idc/constraint_flags/level_idc follow.
        if sps_profile.is_none() && sps.len() >= 4 {
            sps_profile = Some([sps[1], sps[2], sps[3]]);
        }
        out.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        out.extend_from_slice(sps);
        off += len;
    }
    if off < avcc.len() {
        let num_pps = avcc[off] as usize;
        off += 1;
        for _ in 0..num_pps {
            if off + 2 > avcc.len() {
                break;
            }
            let len = u16be(avcc, off) as usize;
            off += 2;
            if off + len > avcc.len() {
                break;
            }
            out.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
            out.extend_from_slice(&avcc[off..off + len]);
            off += len;
        }
    }
    (out, nalu_len, sps_profile)
}

/// MPEG-4 Audio sampling frequency table (index → Hz), used both to read the
/// AudioSpecificConfig and to build one for a WebCodecs-encoded rendition.
const AAC_SAMPLE_RATES: [u32; 13] = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

fn sample_rate_from_idx(idx: u8) -> u32 {
    AAC_SAMPLE_RATES.get(idx as usize).copied().unwrap_or(44100)
}

fn sample_rate_to_idx(rate: u32) -> u8 {
    AAC_SAMPLE_RATES.iter().position(|&r| r == rate).map(|i| i as u8).unwrap_or(4)
}

/// Build the 2-byte AudioSpecificConfig (ISO 14496-3) a WebCodecs
/// `AudioDecoder` needs as its `description`, from the same
/// [profile, sample_rate_idx, channels] triplet `adts_wrap` uses. This is a
/// different bit layout than an ADTS header (audioObjectType is the full 5
/// bits here, not objectType-1), so it can't reuse `adts_wrap`.
fn audio_specific_config(cfg: [u8; 3]) -> [u8; 2] {
    let [profile, sr_idx, channels] = cfg;
    [(profile << 3) | (sr_idx >> 1), (sr_idx << 7) | (channels << 3)]
}

/// Scan an `esds` box for the AudioSpecificConfig and return [profile, sample_rate_idx, channels].
fn parse_aac_config(esds: &[u8]) -> [u8; 3] {
    let mut i = 4;
    while i < esds.len().saturating_sub(2) {
        if esds[i] == 0x03 || esds[i] == 0x04 {
            let tag = esds[i];
            i += 1;
            while i < esds.len() && esds[i] == 0x80 {
                i += 1;
            }
            if i >= esds.len() {
                break;
            }
            i += 1; // length byte
            if tag == 0x03 && i + 3 <= esds.len() {
                i += 3; // ES_ID (2) + streamPriority (1)
            }
        } else if esds[i] == 0x05 {
            // DecoderSpecificInfo holds the 2-byte AudioSpecificConfig we want.
            i += 1;
            while i < esds.len() && esds[i] == 0x80 {
                i += 1;
            }
            if i >= esds.len() {
                break;
            }
            i += 1; // length byte
            if i + 2 > esds.len() {
                break;
            }
            let b0 = esds[i];
            let b1 = esds[i + 1];
            let profile = (b0 >> 3) & 0x1F;
            let sr_idx = ((b0 & 0x07) << 1) | (b1 >> 7);
            let channels = (b1 >> 3) & 0x0F;
            return [profile, sr_idx, channels];
        } else {
            i += 1;
        }
    }
    [2, 4, 2] // fallback: AAC-LC, 44100 Hz, stereo
}

/// Find `box_type` inside the first `stsd` sample entry, skipping the
/// fixed-size SampleEntry header (`header_len` bytes) that precedes it.
///
/// Those fixed fields start with several zeroed reserved bytes, which
/// `box_header` would misread as size=0 ("box extends to end of container")
/// if searched from the wrong offset — hence the explicit skip rather than
/// searching from right after the 8-byte SampleEntry tag.
fn find_box_in_stsd_entries<'a>(stbl: &'a [u8], header_len: usize, box_type: &[u8; 4]) -> Option<&'a [u8]> {
    let stsd = find_box(stbl, b"stsd")?;
    if stsd.len() <= 8 {
        return None;
    }

    let mut off = 8;
    let mut result = None;
    while off < stsd.len() {
        let Some((sz, _, doff)) = box_header(stsd, off) else { break };
        let end = off + sz as usize;
        let entry = &stsd[doff..end.min(stsd.len())];
        if entry.len() > header_len {
            if let Some(found) = find_box(&entry[header_len..], box_type) {
                result = Some(found);
            }
        }
        off = end;
    }
    result
}

/// The `mvhd` box's timescale (movie-level, distinct from each track's own
/// `mdhd` timescale) — an `elst` box's `segment_duration` field is expressed
/// in this unit, not the track's.
fn parse_mvhd_timescale(moov: &[u8]) -> Option<u32> {
    let mvhd = find_box(moov, b"mvhd")?;
    if mvhd.is_empty() {
        return None;
    }
    if mvhd[0] == 1 {
        if mvhd.len() < 24 { return None; }
        Some(u32be(mvhd, 20)) // version 1: v+flags(4) creation(8) modification(8) timescale(4)
    } else {
        if mvhd.len() < 16 { return None; }
        Some(u32be(mvhd, 12)) // version 0: v+flags(4) creation(4) modification(4) timescale(4)
    }
}

/// If `trak` has an edit list, returns the last valid sample time it
/// describes, in the track's own timescale — used to trim a track's tail
/// (e.g. a partial frame left over from when recording stopped, or a camera
/// app's own encoder writing one final access unit that was never meant to
/// be decoded standalone) without re-encoding. Samples at or after this
/// point are physically in the file but not part of the intended playback
/// range, and WebCodecs' hardware decoder tends to be far less forgiving of
/// them than a software decoder like FFmpeg is.
///
/// Walks every entry rather than assuming exactly one: a very common
/// pattern from NLE software (Final Cut, Premiere, iMovie, and others) is
/// two entries — a leading *empty* edit (media_time == -1, used to align
/// the track's start) followed by the one real entry — which a
/// single-entry-only check would reject outright and silently skip the
/// trim it exists to make. Empty entries contribute nothing and are
/// skipped; the furthest-reaching end among the rest is what's returned,
/// so this only ever widens the accepted range, never narrows it below
/// what any entry actually asks for.
fn parse_edit_list_valid_end(trak: &[u8], movie_timescale: u32, track_timescale: u32) -> Option<u64> {
    if movie_timescale == 0 || track_timescale == 0 {
        return None;
    }
    let elst = find_box_path(trak, &[b"edts", b"elst"])?;
    if elst.len() < 8 {
        return None;
    }
    let version = elst[0];
    let entry_count = u32be(elst, 4) as usize;
    let entry_size = if version == 1 { 20 } else { 12 };

    let mut off = 8;
    let mut max_end: Option<u64> = None;
    for _ in 0..entry_count {
        if off + entry_size > elst.len() {
            break;
        }
        let (segment_duration, media_time) = if version == 1 {
            (u64be(elst, off), u64be(elst, off + 8) as i64)
        } else {
            (u32be(elst, off) as u64, u32be(elst, off + 4) as i32 as i64)
        };
        off += entry_size;

        if media_time < 0 {
            continue; // empty edit — contributes no content of its own
        }
        let track_duration = (segment_duration as f64 / movie_timescale as f64 * track_timescale as f64) as u64;
        let end = media_time as u64 + track_duration;
        max_end = Some(max_end.map_or(end, |m| m.max(end)));
    }
    max_end
}

/// The tighter (earliest) of two optional edit-list end times, in seconds.
/// `None` on both sides means neither track has an edit list, so there's
/// nothing to trim; `Some` on just one side means that track's boundary
/// protects the other too (see the call site in `parse_headers` for why a
/// real file's two tracks don't always both carry one).
fn combined_edit_list_end_sec(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (Some(x), None) | (None, Some(x)) => Some(x),
        (None, None) => None,
    }
}

fn parse_track(trak: &[u8], movie_timescale: u32) -> Option<TrackData> {
    let hdlr = find_box_path(trak, &[b"mdia", b"hdlr"])?;
    if hdlr.len() < 12 {
        return None;
    }
    let handler: [u8; 4] = hdlr[8..12].try_into().ok()?;

    let mdhd = find_box_path(trak, &[b"mdia", b"mdhd"])?;
    let timescale = if !mdhd.is_empty() && mdhd[0] == 1 {
        if mdhd.len() < 24 { return None; }
        u32be(mdhd, 20) // version 1: creation(8) modification(8) timescale(4)
    } else {
        if mdhd.len() < 16 { return None; }
        u32be(mdhd, 12) // version 0: creation(4) modification(4) timescale(4)
    };

    let stbl = find_box_path(trak, &[b"mdia", b"minf", b"stbl"])?;
    let all_keyframes = find_box(stbl, b"stss").is_none();
    let samples = build_samples(stbl, all_keyframes);
    let edit_list_end = parse_edit_list_valid_end(trak, movie_timescale, timescale);

    let mut annexb_header = Vec::new();
    let mut nalu_len_size = 4u8;
    let mut aac_config = [2u8, 4, 2];
    let mut avc1_profile = None;
    let mut avcc_raw = Vec::new();

    if &handler == b"vide" {
        // 8-byte SampleEntry + 70-byte VisualSampleEntry fixed header.
        if let Some(avcc) = find_box_in_stsd_entries(stbl, 78, b"avcC") {
            let (hdr, nls, profile) = parse_avcc_header(avcc);
            annexb_header = hdr;
            nalu_len_size = nls;
            avc1_profile = profile;
            avcc_raw = avcc.to_vec();
        }
    } else if &handler == b"soun" {
        // 8-byte SampleEntry + 20-byte AudioSampleEntry v0 fixed header.
        if let Some(esds) = find_box_in_stsd_entries(stbl, 28, b"esds") {
            aac_config = parse_aac_config(esds);
        }
    }

    Some(TrackData { timescale, handler, samples, annexb_header, nalu_len_size, aac_config, avc1_profile, avcc_raw, edit_list_end })
}

// ── Segmentation ────────────────────────────────────────────────

fn compute_segments(
    video: &[SampleInfo],
    audio: &[SampleInfo],
    video_timescale: u32,
    audio_timescale: u32,
    target_sec: f64,
) -> Vec<SegmentSamples> {
    if video.is_empty() {
        return vec![];
    }
    let mut segments: Vec<SegmentSamples> = Vec::new();
    let mut seg_video_start = 0usize;
    let mut audio_cursor = 0usize;

    let target_ts = (target_sec * video_timescale as f64) as u64;
    let seg_start_dts = video[0].dts;

    let mut i = 1;
    while i <= video.len() {
        let is_last = i == video.len();
        let is_boundary = if is_last {
            true
        } else {
            video[i].is_keyframe
                && (video[i].dts - video[seg_video_start].dts) >= target_ts
        };

        if is_boundary {
            let vs = &video[seg_video_start..i];
            let seg_start_pts = vs[0].dts;
            let seg_end_dts = if is_last {
                vs.last().map(|s| s.dts + s.duration as u64).unwrap_or(seg_start_pts)
            } else {
                video[i].dts
            };

            let audio_start = audio_cursor;
            let seg_end_pts_audio = (seg_end_dts as f64 / video_timescale as f64
                * audio_timescale as f64) as u64;
            while audio_cursor < audio.len() && audio[audio_cursor].dts < seg_end_pts_audio {
                audio_cursor += 1;
            }

            let start_pts_sec = (seg_start_pts - seg_start_dts) as f64 / video_timescale as f64;
            let duration_sec = (seg_end_dts - seg_start_pts) as f64 / video_timescale as f64;

            segments.push(SegmentSamples {
                video: vs.to_vec(),
                audio: audio[audio_start..audio_cursor].to_vec(),
                start_pts_sec,
                duration_sec,
            });

            seg_video_start = i;
        }
        i += 1;
    }

    segments
}

// ── MPEG-TS CRC-32 ───────────────────────────────────────────────

fn crc32_mpeg(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= (b as u32) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 {
                (crc << 1) ^ 0x04C1_1DB7
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn append_crc(sec: &mut Vec<u8>) {
    let crc = crc32_mpeg(&sec[1..]); // skip pointer_field
    sec.push(((crc >> 24) & 0xFF) as u8);
    sec.push(((crc >> 16) & 0xFF) as u8);
    sec.push(((crc >> 8) & 0xFF) as u8);
    sec.push((crc & 0xFF) as u8);
}

// ── MPEG-TS constants ────────────────────────────────────────────

const TS_SIZE: usize = 188;
const PAT_PID: u16 = 0x0000;
const PMT_PID: u16 = 0x1000;
const VID_PID: u16 = 0x0100;
const AUD_PID: u16 = 0x0101;

fn build_pat(cc: &mut u8) -> Vec<u8> {
    let mut sec: Vec<u8> = Vec::with_capacity(30);
    sec.push(0x00); // pointer_field
    sec.push(0x00); // table_id PAT
    sec.extend_from_slice(&[0xB0, 0x0D]); // section_length = 13
    sec.extend_from_slice(&[0x00, 0x01]); // ts_id
    sec.push(0xC1); // version=0, current
    sec.push(0x00); // section_number
    sec.push(0x00); // last_section_number
    sec.extend_from_slice(&[0x00, 0x01]); // program_number = 1
    sec.push(0xE0 | ((PMT_PID >> 8) as u8 & 0x1F));
    sec.push((PMT_PID & 0xFF) as u8);
    append_crc(&mut sec);
    sec.resize(184, 0xFF);

    let mut pkt = [0xFFu8; TS_SIZE];
    pkt[0] = 0x47;
    pkt[1] = 0x40 | ((PAT_PID >> 8) as u8 & 0x1F);
    pkt[2] = (PAT_PID & 0xFF) as u8;
    pkt[3] = 0x10 | (*cc & 0x0F);
    *cc = (*cc + 1) & 0x0F;
    pkt[4..188].copy_from_slice(&sec[..184]);
    pkt.to_vec()
}

fn build_pmt(cc: &mut u8, has_audio: bool) -> Vec<u8> {
    let num_streams = if has_audio { 2 } else { 1 };
    let sec_len = 9 + num_streams * 5 + 4; // pmt header + streams + crc

    let mut sec: Vec<u8> = Vec::with_capacity(30);
    sec.push(0x00); // pointer_field
    sec.push(0x02); // table_id PMT
    sec.push(0xB0 | ((sec_len >> 8) as u8 & 0x0F));
    sec.push((sec_len & 0xFF) as u8);
    sec.extend_from_slice(&[0x00, 0x01]); // program_number
    sec.push(0xC1);
    sec.push(0x00);
    sec.push(0x00);
    sec.push(0xE0 | ((VID_PID >> 8) as u8 & 0x1F)); // PCR PID = video PID
    sec.push((VID_PID & 0xFF) as u8);
    sec.extend_from_slice(&[0xF0, 0x00]); // no program info

    sec.push(0x1B); // H.264 video stream
    sec.push(0xE0 | ((VID_PID >> 8) as u8 & 0x1F));
    sec.push((VID_PID & 0xFF) as u8);
    sec.extend_from_slice(&[0xF0, 0x00]);

    if has_audio {
        sec.push(0x0F); // AAC/ADTS audio stream
        sec.push(0xE0 | ((AUD_PID >> 8) as u8 & 0x1F));
        sec.push((AUD_PID & 0xFF) as u8);
        sec.extend_from_slice(&[0xF0, 0x00]);
    }

    append_crc(&mut sec);
    sec.resize(184, 0xFF);

    let mut pkt = [0xFFu8; TS_SIZE];
    pkt[0] = 0x47;
    pkt[1] = 0x40 | ((PMT_PID >> 8) as u8 & 0x1F);
    pkt[2] = (PMT_PID & 0xFF) as u8;
    pkt[3] = 0x10 | (*cc & 0x0F);
    *cc = (*cc + 1) & 0x0F;
    pkt[4..188].copy_from_slice(&sec[..184]);
    pkt.to_vec()
}

/// Build a 7-byte adaptation-field payload carrying the PCR.
/// `pcr_90` must be the DTS of the first frame of THIS segment, not of the whole
/// file — using the file's frame-0 DTS makes segment N look like it needs an
/// N-times-longer pre-buffer, so players stall or drop the video track.
fn pcr_af_bytes(pcr_90: u64, random_access: bool) -> Vec<u8> {
    // flags: random_access_indicator (0x40, required so players can seek to this
    // packet) | PCR_flag (0x10)
    let flags = if random_access { 0x50u8 } else { 0x10u8 };
    let base = pcr_90;
    let ext = 0u16;
    vec![
        flags,
        ((base >> 25) & 0xFF) as u8,
        ((base >> 17) & 0xFF) as u8,
        ((base >> 9) & 0xFF) as u8,
        ((base >> 1) & 0xFF) as u8,
        (((base & 1) << 7) | 0x7E | (((ext >> 8) & 0x01) as u64)) as u8,
        (ext & 0xFF) as u8,
    ]
}

fn encode_pts(ts: u64, marker_high: u8) -> [u8; 5] {
    [
        marker_high | (((ts >> 30) & 0x07) as u8) << 1 | 0x01,
        ((ts >> 22) & 0xFF) as u8,
        (((ts >> 15) & 0x7F) as u8 * 2) | 0x01,
        ((ts >> 7) & 0xFF) as u8,
        (((ts & 0x7F) as u8) * 2) | 0x01,
    ]
}

/// PES_packet_length is always written as 0 ("unbounded"), which the spec
/// permits so a segment's whole payload can span many TS packets without the
/// muxer knowing the final length up front.
fn pes_header(stream_id: u8, pts: u64, dts: Option<u64>) -> Vec<u8> {
    let with_dts = dts.is_some();
    let pts_dts_len: usize = if with_dts { 10 } else { 5 };
    let header_data_len = pts_dts_len as u8;

    let mut h = Vec::with_capacity(9 + pts_dts_len);
    h.extend_from_slice(&[0x00, 0x00, 0x01, stream_id]);
    h.push(0x00); // PES_packet_length high byte
    h.push(0x00); // PES_packet_length low byte
    h.push(0x80); // marker=10, no scrambling
    h.push(if with_dts { 0xC0 } else { 0x80 }); // PTS+DTS or PTS only
    h.push(header_data_len);
    let pts_marker = if with_dts { 0x30u8 } else { 0x20u8 };
    h.extend_from_slice(&encode_pts(pts, pts_marker));
    if let Some(dts_val) = dts {
        h.extend_from_slice(&encode_pts(dts_val, 0x10));
    }
    h
}

/// Split PES bytes into 188-byte TS packets, adding a PCR + random-access
/// adaptation field on the first packet when `pcr` is set.
fn packetise(pid: u16, payload: &[u8], pcr: Option<u64>, cc: &mut u8) -> Vec<u8> {
    let mut out = Vec::new();
    let mut offset = 0;
    let mut first = true;

    while offset < payload.len() {
        let mut pkt = vec![0xFFu8; TS_SIZE];
        pkt[0] = 0x47;
        let pusi = if first { 0x40u8 } else { 0x00u8 };
        pkt[1] = pusi | ((pid >> 8) as u8 & 0x1F);
        pkt[2] = (pid & 0xFF) as u8;

        let remaining = &payload[offset..];
        let needs_pcr = first && pcr.is_some();

        if needs_pcr {
            let af_data = pcr_af_bytes(pcr.unwrap(), true);
            let af_total = 1 + af_data.len();
            let payload_space = TS_SIZE - 4 - af_total;
            let copy = remaining.len().min(payload_space);

            pkt[3] = 0x30 | (*cc & 0x0F);
            *cc = (*cc + 1) & 0x0F;
            pkt[4] = af_data.len() as u8;
            pkt[5..5 + af_data.len()].copy_from_slice(&af_data);
            let d_start = 4 + af_total;
            pkt[d_start..d_start + copy].copy_from_slice(&remaining[..copy]);
            offset += copy;
        } else {
            let payload_space = TS_SIZE - 4;
            let copy = remaining.len().min(payload_space);
            let stuff = payload_space - copy;

            if stuff == 0 {
                pkt[3] = 0x10 | (*cc & 0x0F);
                *cc = (*cc + 1) & 0x0F;
                pkt[4..4 + copy].copy_from_slice(&remaining[..copy]);
            } else {
                pkt[3] = 0x30 | (*cc & 0x0F);
                *cc = (*cc + 1) & 0x0F;
                if stuff == 1 {
                    pkt[4] = 0x00;
                    pkt[5..5 + copy].copy_from_slice(&remaining[..copy]);
                } else {
                    pkt[4] = (stuff - 1) as u8;
                    pkt[5] = 0x00;
                    pkt[4 + stuff..4 + stuff + copy].copy_from_slice(&remaining[..copy]);
                }
            }
            offset += copy;
        }
        out.extend_from_slice(&pkt);
        first = false;
    }
    out
}

fn avcc_to_annexb(data: &[u8], nls: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 16);
    let mut off = 0;
    let nls = nls as usize;
    while off + nls <= data.len() {
        let nalu_len = match nls {
            1 => data[off] as usize,
            2 => u16be(data, off) as usize,
            4 => u32be(data, off) as usize,
            _ => break,
        };
        off += nls;
        if off + nalu_len > data.len() {
            break;
        }
        out.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        out.extend_from_slice(&data[off..off + nalu_len]);
        off += nalu_len;
    }
    out
}

/// Convert one AVCC-framed sample into a decodable Annex-B access unit: an
/// Access Unit Delimiter, SPS/PPS on keyframes, then the sample's NAL units.
/// Used by the fast-path TS muxer.
fn sample_to_annexb(raw: &[u8], nalu_len_size: u8, is_keyframe: bool, annexb_header: &[u8]) -> Vec<u8> {
    let nalus = avcc_to_annexb(raw, nalu_len_size);
    let mut out = vec![0x00, 0x00, 0x00, 0x01, 0x09, 0xF0];
    if is_keyframe && !annexb_header.is_empty() {
        out.extend_from_slice(annexb_header);
    }
    out.extend_from_slice(&nalus);
    out
}

fn adts_wrap(raw_aac: &[u8], cfg: [u8; 3]) -> Vec<u8> {
    let [profile, sr_idx, channels] = cfg;
    let frame_len = raw_aac.len() + 7;
    let mut h = [0u8; 7];
    h[0] = 0xFF;
    h[1] = 0xF1; // MPEG-4, Layer=00, no CRC
    h[2] = ((profile - 1) << 6) | (sr_idx << 2) | (channels >> 2);
    h[3] = ((channels & 0x03) << 6) | (((frame_len >> 11) & 0x03) as u8);
    h[4] = ((frame_len >> 3) & 0xFF) as u8;
    h[5] = (((frame_len & 0x07) as u8) << 5) | 0x1F;
    h[6] = 0xFC;
    let mut out = Vec::with_capacity(frame_len);
    out.extend_from_slice(&h);
    out.extend_from_slice(raw_aac);
    out
}

/// Every argument is a distinct piece of per-segment/per-track state pulled
/// straight from `HlsProcessor`; grouping them into a struct would just move
/// the same fields one layer up without reducing what the caller has to track.
#[allow(clippy::too_many_arguments)]
fn mux_segment_inner(
    video_samples: &[SampleMeta],
    video_data: &[u8],
    audio_samples: &[SampleMeta],
    audio_data: &[u8],
    annexb_header: &[u8],
    nalu_len_size: u8,
    aac_config: [u8; 3],
    video_timescale: u32,
    audio_timescale: u32,
) -> Vec<u8> {
    let mut out = Vec::new();

    let mut pat_cc = 0u8;
    let mut pmt_cc = 0u8;
    let mut vid_cc = 0u8;
    let mut aud_cc = 0u8;

    let has_audio = !audio_samples.is_empty() && !audio_data.is_empty();

    out.extend_from_slice(&build_pat(&mut pat_cc));
    out.extend_from_slice(&build_pmt(&mut pmt_cc, has_audio));

    let mut v_offset = 0usize;
    let mut is_first_vid = true;
    for sm in video_samples {
        let end = v_offset + sm.size as usize;
        if end > video_data.len() {
            break;
        }
        let raw = &video_data[v_offset..end];
        v_offset = end;

        let annexb = sample_to_annexb(raw, nalu_len_size, sm.is_keyframe, annexb_header);

        let dts_90 = sm.dts * 90000 / video_timescale as u64;
        let pts_90 = sm.pts * 90000 / video_timescale as u64;

        // PCR must anchor to this segment's own first frame (see pcr_af_bytes).
        let pcr = if is_first_vid { Some(dts_90) } else { None };

        let header = pes_header(0xE0, pts_90, if sm.pts != sm.dts { Some(dts_90) } else { None });
        let mut pes_payload = Vec::with_capacity(header.len() + annexb.len());
        pes_payload.extend_from_slice(&header);
        pes_payload.extend_from_slice(&annexb);

        out.extend_from_slice(&packetise(VID_PID, &pes_payload, pcr, &mut vid_cc));
        is_first_vid = false;
    }

    if has_audio {
        let mut a_offset = 0usize;
        for sm in audio_samples {
            let end = a_offset + sm.size as usize;
            if end > audio_data.len() {
                break;
            }
            let raw = &audio_data[a_offset..end];
            a_offset = end;

            let wrapped = adts_wrap(raw, aac_config);
            let pts_90 = sm.pts * 90000 / audio_timescale as u64;

            let header = pes_header(0xC0, pts_90, None);
            let mut pes_payload = Vec::with_capacity(header.len() + wrapped.len());
            pes_payload.extend_from_slice(&header);
            pes_payload.extend_from_slice(&wrapped);

            out.extend_from_slice(&packetise(AUD_PID, &pes_payload, None, &mut aud_cc));
        }
    }

    out
}

/// Mux one rendition's segment from WebCodecs-encoded output into MPEG-TS.
///
/// Unlike `mux_segment_inner` (which reads AVCC samples straight from the
/// source file and converts them), `video_meta`'s bytes are already Annex-B:
/// the `VideoEncoder` that produced them is configured with
/// `avc: { format: 'annexb' }`, which per spec also means the browser
/// inlines a fresh SPS/PPS into every keyframe's access unit itself — so
/// there's no separate parameter-set header to prepend here, only the AUD.
/// `audio_meta`'s bytes are raw AAC (not yet ADTS-framed); `adts_wrap` still
/// applies, using the rendition's *own* sample rate/channel count rather
/// than the source's, since an encoder is free to encode audio differently
/// per rendition.
///
/// Encoder output is treated as PTS == DTS (no B-frames) — true for the
/// default, non-latency-tuned WebCodecs H.264 configs this project uses.
#[allow(clippy::too_many_arguments)]
fn mux_encoded_segment_inner(
    video_data: &[u8],
    video_meta: &[EncodedChunkMeta],
    audio_data: &[u8],
    audio_meta: &[EncodedChunkMeta],
    audio_sample_rate: u32,
    audio_channels: u8,
) -> Vec<u8> {
    let mut out = Vec::new();

    let mut pat_cc = 0u8;
    let mut pmt_cc = 0u8;
    let mut vid_cc = 0u8;
    let mut aud_cc = 0u8;

    let has_audio = !audio_meta.is_empty() && !audio_data.is_empty();
    let aac_config = [2u8, sample_rate_to_idx(audio_sample_rate), audio_channels]; // AAC-LC

    out.extend_from_slice(&build_pat(&mut pat_cc));
    out.extend_from_slice(&build_pmt(&mut pmt_cc, has_audio));

    let mut v_offset = 0usize;
    let mut is_first_vid = true;
    for sm in video_meta {
        let end = v_offset + sm.size as usize;
        if end > video_data.len() {
            break;
        }
        let raw = &video_data[v_offset..end];
        v_offset = end;

        let mut annexb = vec![0x00, 0x00, 0x00, 0x01, 0x09, 0xF0];
        annexb.extend_from_slice(raw);

        let pts_90 = (sm.timestamp_us / 1_000_000.0 * 90000.0).round() as u64;
        let pcr = if is_first_vid { Some(pts_90) } else { None };

        let header = pes_header(0xE0, pts_90, None);
        let mut pes_payload = Vec::with_capacity(header.len() + annexb.len());
        pes_payload.extend_from_slice(&header);
        pes_payload.extend_from_slice(&annexb);

        out.extend_from_slice(&packetise(VID_PID, &pes_payload, pcr, &mut vid_cc));
        is_first_vid = false;
    }

    if has_audio {
        let mut a_offset = 0usize;
        for sm in audio_meta {
            let end = a_offset + sm.size as usize;
            if end > audio_data.len() {
                break;
            }
            let raw = &audio_data[a_offset..end];
            a_offset = end;

            let wrapped = adts_wrap(raw, aac_config);
            let pts_90 = (sm.timestamp_us / 1_000_000.0 * 90000.0).round() as u64;

            let header = pes_header(0xC0, pts_90, None);
            let mut pes_payload = Vec::with_capacity(header.len() + wrapped.len());
            pes_payload.extend_from_slice(&header);
            pes_payload.extend_from_slice(&wrapped);

            out.extend_from_slice(&packetise(AUD_PID, &pes_payload, None, &mut aud_cc));
        }
    }

    out
}

// ── Public Wasm API ──────────────────────────────────────────────

#[wasm_bindgen]
pub struct HlsProcessor {
    video: Option<TrackData>,
    audio: Option<TrackData>,
    segments: Vec<SegmentSamples>,
    target_duration: f64,
}

impl Default for HlsProcessor {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl HlsProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> HlsProcessor {
        HlsProcessor { video: None, audio: None, segments: vec![], target_duration: 6.0 }
    }

    /// Set target segment duration in seconds (default 6).
    pub fn set_target_duration(&mut self, secs: f64) {
        self.target_duration = secs;
    }

    /// Parse the `moov` box and compute keyframe-aligned segment boundaries.
    /// `data` must contain the full `moov` box (pass the file's head, or its
    /// tail if `moov` was written after `mdat`).
    pub fn parse_headers(&mut self, data: &[u8]) -> Result<JsValue, JsValue> {
        let moov = find_box(data, b"moov")
            .ok_or_else(|| JsValue::from_str("moov box not found in data"))?;

        let traks = find_all_boxes(moov, b"trak");
        log!("[wasm] found {} trak boxes", traks.len());
        let movie_timescale = parse_mvhd_timescale(moov).unwrap_or(0);

        let mut video: Option<TrackData> = None;
        let mut audio: Option<TrackData> = None;

        for trak in traks {
            if let Some(td) = parse_track(trak, movie_timescale) {
                if &td.handler == b"vide" && video.is_none() {
                    video = Some(td);
                } else if &td.handler == b"soun" && audio.is_none() {
                    audio = Some(td);
                }
            }
        }

        let mut vid = video.ok_or_else(|| JsValue::from_str("No video track found"))?;
        let mut aud = audio.unwrap_or_else(|| TrackData {
            timescale: 44100,
            handler: *b"soun",
            samples: vec![],
            annexb_header: vec![],
            nalu_len_size: 4,
            aac_config: [2, 4, 2],
            avc1_profile: None,
            avcc_raw: vec![],
            edit_list_end: None,
        });

        // Trim both tracks to whichever edit list gives the tighter (i.e.
        // earliest) end time, converted to a common unit (seconds) since
        // video and audio timescales differ. A real file may only carry an
        // edit list on one of its two tracks — camera/editing software
        // isn't required to write matching ones on both — but the intended
        // playback range is still the same wall-clock moment for each, so
        // whichever track states it protects the other from decoding
        // trailing content (a partial frame, an encoder's own flush
        // artifact) that was never meant to be played.
        let vid_end_sec = vid.edit_list_end.map(|t| t as f64 / vid.timescale as f64);
        let aud_end_sec = aud.edit_list_end.map(|t| t as f64 / aud.timescale as f64);
        if let Some(end_sec) = combined_edit_list_end_sec(vid_end_sec, aud_end_sec) {
            let vid_cutoff = (end_sec * vid.timescale as f64) as u64;
            let aud_cutoff = (end_sec * aud.timescale as f64) as u64;
            let vid_before = vid.samples.len();
            let aud_before = aud.samples.len();
            vid.samples.retain(|s| s.dts < vid_cutoff);
            aud.samples.retain(|s| s.dts < aud_cutoff);
            let trimmed = (vid_before - vid.samples.len()) + (aud_before - aud.samples.len());
            if trimmed > 0 {
                log!("[wasm] edit list trimmed {} trailing sample(s) not meant for playback", trimmed);
            }
        }

        let segments = compute_segments(
            &vid.samples,
            &aud.samples,
            vid.timescale,
            aud.timescale,
            self.target_duration,
        );

        log!("[wasm] computed {} segments", segments.len());

        let total = segments.len();
        let seg_json: Vec<serde_json::Value> = segments
            .iter()
            .map(|s| {
                serde_json::json!({
                    "startPtsSec": s.start_pts_sec,
                    "durationSec": s.duration_sec,
                    "videoSamples": s.video.iter().map(|sm| serde_json::json!({
                        "fileOffset": sm.file_offset,
                        "size": sm.size,
                        "pts": sm.pts,
                        "dts": sm.dts,
                        "duration": sm.duration,
                        "isKeyframe": sm.is_keyframe,
                    })).collect::<Vec<_>>(),
                    "audioSamples": s.audio.iter().map(|sm| serde_json::json!({
                        "fileOffset": sm.file_offset,
                        "size": sm.size,
                        "pts": sm.pts,
                        "dts": sm.dts,
                        "duration": sm.duration,
                        "isKeyframe": sm.is_keyframe,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();

        let result = serde_json::json!({
            "segmentCount": total,
            "videoTimescale": vid.timescale,
            "audioTimescale": aud.timescale,
            "targetDuration": self.target_duration,
            "segments": seg_json,
        });

        self.segments = segments;
        self.video = Some(vid);
        self.audio = Some(aud);

        // Return a JSON string, not a JsValue object: serde_wasm_bindgen turns a
        // serde_json::Map into a JS Map, so `result.segmentCount` would read as
        // undefined. JSON.parse() on the JS side always gives a plain object.
        let json_str = serde_json::to_string(&result)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(JsValue::from_str(&json_str))
    }

    pub fn get_segment_count(&self) -> u32 {
        self.segments.len() as u32
    }

    /// Codec strings + config for configuring a WebCodecs
    /// `VideoDecoder`/`AudioDecoder` against the parsed source track. Call
    /// after `parse_headers`.
    ///
    /// The video codec uses the `avc1` (AVCC, out-of-band parameter sets)
    /// prefix deliberately, with `videoDescriptionBytes` set to the raw
    /// `avcC` box: this lets the decoder take source samples completely
    /// unmodified — the same length-prefixed bytes `mux_segment` already
    /// reads from the file — with no Annex-B conversion needed. `avc3`
    /// (in-band Annex-B, no description) throws "a key frame is required"
    /// on some real-world H.264 streams, so don't switch to it.
    pub fn codec_config(&self) -> Result<JsValue, JsValue> {
        let vid = self.video.as_ref().ok_or_else(|| JsValue::from_str("Not initialised"))?;
        let aud = self.audio.as_ref().ok_or_else(|| JsValue::from_str("Not initialised"))?;

        let video_codec = match vid.avc1_profile {
            Some([p, c, l]) => format!("avc1.{:02x}{:02x}{:02x}", p, c, l),
            None => "avc1.42001e".to_string(), // fallback: Baseline profile, level 3.0
        };
        let audio_description = audio_specific_config(aud.aac_config);

        let result = serde_json::json!({
            "videoCodec": video_codec,
            "videoDescriptionBytes": vid.avcc_raw,
            "audioCodec": format!("mp4a.40.{}", aud.aac_config[0].max(1)),
            "audioSampleRate": sample_rate_from_idx(aud.aac_config[1]),
            "audioChannels": aud.aac_config[2],
            "audioDescriptionBytes": audio_description,
        });
        let json_str = serde_json::to_string(&result).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(JsValue::from_str(&json_str))
    }

    /// Mux one Adaptive HLS rendition's segment from WebCodecs-encoded
    /// output into MPEG-TS. `video_data`/`audio_data` are the concatenated
    /// encoded bytes for this segment, in encode order; `*_meta_json` is a
    /// JSON array of `{ size, timestampUs, isKeyframe }` (`isKeyframe` is
    /// ignored for audio) describing them in the same order. Video chunks
    /// must be Annex-B (`VideoEncoder` configured with
    /// `avc: { format: 'annexb' }`); audio chunks must be raw AAC, not yet
    /// ADTS-wrapped — see `mux_encoded_segment_inner` for why this doesn't
    /// need the source track's codec config.
    #[allow(clippy::too_many_arguments)]
    pub fn mux_encoded_segment(
        &self,
        video_data: &[u8],
        video_meta_json: &str,
        audio_data: &[u8],
        audio_meta_json: &str,
        audio_sample_rate: u32,
        audio_channels: u8,
    ) -> Result<Box<[u8]>, JsValue> {
        let video_meta: Vec<EncodedChunkMeta> = serde_json::from_str(video_meta_json)
            .map_err(|e| JsValue::from_str(&format!("bad video_meta_json: {e}")))?;
        let audio_meta: Vec<EncodedChunkMeta> = serde_json::from_str(audio_meta_json)
            .map_err(|e| JsValue::from_str(&format!("bad audio_meta_json: {e}")))?;

        let ts_bytes = mux_encoded_segment_inner(
            video_data,
            &video_meta,
            audio_data,
            &audio_meta,
            audio_sample_rate,
            audio_channels,
        );
        Ok(ts_bytes.into_boxed_slice())
    }

    /// Mux one segment into MPEG-TS bytes.
    /// `video_data`/`audio_data` are the concatenated raw sample bytes read
    /// from the file at the offsets `parse_headers` returned.
    pub fn mux_segment(
        &self,
        video_data: &[u8],
        audio_data: &[u8],
        segment_index: u32,
    ) -> Result<Box<[u8]>, JsValue> {
        let vid = self.video.as_ref().ok_or_else(|| JsValue::from_str("Not initialised"))?;
        let aud = self.audio.as_ref().ok_or_else(|| JsValue::from_str("Not initialised"))?;
        let seg = self
            .segments
            .get(segment_index as usize)
            .ok_or_else(|| JsValue::from_str("Segment index out of range"))?;

        let vmeta: Vec<SampleMeta> = seg
            .video
            .iter()
            .map(|s| SampleMeta { size: s.size, pts: s.pts, dts: s.dts, is_keyframe: s.is_keyframe })
            .collect();
        let ameta: Vec<SampleMeta> = seg
            .audio
            .iter()
            .map(|s| SampleMeta { size: s.size, pts: s.pts, dts: s.dts, is_keyframe: s.is_keyframe })
            .collect();

        let ts_bytes = mux_segment_inner(
            &vmeta,
            video_data,
            &ameta,
            audio_data,
            &vid.annexb_header,
            vid.nalu_len_size,
            aud.aac_config,
            vid.timescale,
            aud.timescale,
        );

        Ok(ts_bytes.into_boxed_slice())
    }

    /// Build the final M3U8 playlist (with #EXT-X-ENDLIST) from actual segment durations.
    pub fn generate_m3u8(&self, segment_durations_json: &str) -> String {
        let durations: Vec<f64> = serde_json::from_str(segment_durations_json).unwrap_or_default();
        let max_dur = durations.iter().cloned().fold(0.0f64, f64::max).ceil();

        let mut m3u8 = String::new();
        m3u8.push_str("#EXTM3U\n");
        m3u8.push_str("#EXT-X-VERSION:3\n");
        m3u8.push_str(&format!("#EXT-X-TARGETDURATION:{}\n", max_dur as u32 + 1));
        m3u8.push_str("#EXT-X-MEDIA-SEQUENCE:0\n");
        for (i, dur) in durations.iter().enumerate() {
            m3u8.push_str(&format!("#EXTINF:{:.6},\n", dur));
            m3u8.push_str(&format!("segment_{:04}.ts\n", i));
        }
        m3u8.push_str("#EXT-X-ENDLIST\n");
        m3u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_box(box_type: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let size = (8 + payload.len()) as u32;
        let mut out = Vec::with_capacity(8 + payload.len());
        out.extend_from_slice(&size.to_be_bytes());
        out.extend_from_slice(box_type);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn mvhd_timescale_v0() {
        let mut payload = vec![0u8; 20]; // v+flags(4) creation(4) modification(4) timescale(4) duration(4)
        payload[12..16].copy_from_slice(&1000u32.to_be_bytes());
        let moov = make_box(b"mvhd", &payload);
        assert_eq!(parse_mvhd_timescale(&moov), Some(1000));
    }

    #[test]
    fn mvhd_timescale_v1() {
        let mut payload = vec![0u8; 32];
        payload[0] = 1;
        payload[20..24].copy_from_slice(&1000u32.to_be_bytes());
        let moov = make_box(b"mvhd", &payload);
        assert_eq!(parse_mvhd_timescale(&moov), Some(1000));
    }

    #[test]
    fn edit_list_v0_single_entry_computes_valid_end() {
        let mut payload = vec![0u8; 20]; // v+flags(4) entry_count(4) duration(4) media_time(4) rate(4)
        payload[4..8].copy_from_slice(&1u32.to_be_bytes());
        payload[8..12].copy_from_slice(&2000u32.to_be_bytes()); // 2s at movie timescale 1000
        payload[12..16].copy_from_slice(&0i32.to_be_bytes());
        let edts = make_box(b"edts", &make_box(b"elst", &payload));
        // 2s at a 30000 track timescale = 60000 ticks.
        assert_eq!(parse_edit_list_valid_end(&edts, 1000, 30000), Some(60000));
    }

    #[test]
    fn edit_list_v1_single_entry_computes_valid_end() {
        let mut payload = vec![0u8; 28];
        payload[0] = 1;
        payload[4..8].copy_from_slice(&1u32.to_be_bytes());
        payload[8..16].copy_from_slice(&2000u64.to_be_bytes());
        payload[16..24].copy_from_slice(&0i64.to_be_bytes());
        let edts = make_box(b"edts", &make_box(b"elst", &payload));
        assert_eq!(parse_edit_list_valid_end(&edts, 1000, 30000), Some(60000));
    }

    #[test]
    fn edit_list_with_leading_empty_edit_then_real_entry_computes_valid_end() {
        // The common NLE pattern (Final Cut/Premiere/iMovie and others): an
        // empty edit to align the start, then the one real entry. Must NOT
        // be treated as "too complex, leave untrimmed".
        let mut payload = vec![0u8; 32]; // v+flags(4) entry_count(4) + 2×12-byte entries
        payload[4..8].copy_from_slice(&2u32.to_be_bytes());
        // Entry 1: empty edit (media_time = -1), duration irrelevant.
        payload[8..12].copy_from_slice(&500u32.to_be_bytes());
        payload[12..16].copy_from_slice(&(-1i32).to_be_bytes());
        // Entry 2: real content, media_time = 0, duration = 2000 movie ticks.
        payload[20..24].copy_from_slice(&2000u32.to_be_bytes());
        payload[24..28].copy_from_slice(&0i32.to_be_bytes());
        let edts = make_box(b"edts", &make_box(b"elst", &payload));
        assert_eq!(parse_edit_list_valid_end(&edts, 1000, 30000), Some(60000));
    }

    #[test]
    fn edit_list_with_only_an_empty_edit_returns_none() {
        let mut payload = vec![0u8; 20];
        payload[4..8].copy_from_slice(&1u32.to_be_bytes());
        payload[8..12].copy_from_slice(&2000u32.to_be_bytes());
        payload[12..16].copy_from_slice(&(-1i32).to_be_bytes());
        let edts = make_box(b"edts", &make_box(b"elst", &payload));
        assert_eq!(parse_edit_list_valid_end(&edts, 1000, 30000), None);
    }

    #[test]
    fn no_edit_list_box_returns_none() {
        let trak = make_box(b"mdia", &[]);
        assert_eq!(parse_edit_list_valid_end(&trak, 1000, 30000), None);
    }

    #[test]
    fn combined_edit_list_end_picks_the_tighter_of_two() {
        assert_eq!(combined_edit_list_end_sec(Some(10.0), Some(8.0)), Some(8.0));
        assert_eq!(combined_edit_list_end_sec(Some(8.0), Some(10.0)), Some(8.0));
    }

    #[test]
    fn combined_edit_list_end_uses_whichever_track_has_one() {
        assert_eq!(combined_edit_list_end_sec(Some(5.0), None), Some(5.0));
        assert_eq!(combined_edit_list_end_sec(None, Some(5.0)), Some(5.0));
    }

    #[test]
    fn combined_edit_list_end_is_none_when_neither_track_has_one() {
        assert_eq!(combined_edit_list_end_sec(None, None), None);
    }
}
