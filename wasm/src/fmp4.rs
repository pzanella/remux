//! Fragmented MP4 (CMAF-style) writer — the first step toward HLS-on-fMP4
//! and, eventually, DASH output (see the project's Plan B in its design
//! notes). This module only produces bytes; the worker decides when to call
//! it and what to do with the result, the same split as `mux_segment`'s own
//! relationship to `remux.worker.ts`.
//!
//! Box layouts follow ISO/IEC 14496-12 (ISOBMFF) and 14496-14 (MP4 file
//! format) directly, cross-checked field-by-field against a real reference
//! fragmented MP4 (produced by Bento4's `mp4fragment` from one of this
//! project's own test fixtures, inspected with `mp4dump`) rather than only
//! against the spec text — the two independently confirm the same layout.

use crate::{SampleInfo, TrackData};

// ── Box-writing primitives ──────────────────────────────────────

/// Wraps `payload` in a standard `size + type + payload` ISOBMFF box. Every
/// box this module writes is small enough for the 32-bit `size` field — no
/// need for the 64-bit largesize extension.
fn make_box(box_type: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + payload.len());
    out.extend_from_slice(&(payload.len() as u32 + 8).to_be_bytes());
    out.extend_from_slice(box_type);
    out.extend_from_slice(payload);
    out
}

/// Concatenates already-built child boxes and wraps them as one box — for
/// pure container boxes (`moov`, `trak`, `mdia`, ...) whose own payload is
/// nothing but their children back to back.
fn container_box(box_type: &[u8; 4], children: &[Vec<u8>]) -> Vec<u8> {
    let mut payload = Vec::new();
    for child in children {
        payload.extend_from_slice(child);
    }
    make_box(box_type, &payload)
}

/// A "full box" (ISOBMFF 4.2): an 8-bit version and 24-bit flags field
/// ahead of `body`, used by most non-container boxes below.
fn full_box(box_type: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(4 + body.len());
    payload.push(version);
    payload.extend_from_slice(&flags.to_be_bytes()[1..4]);
    payload.extend_from_slice(body);
    make_box(box_type, &payload)
}

const IDENTITY_MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

fn push_matrix(out: &mut Vec<u8>) {
    for v in IDENTITY_MATRIX {
        out.extend_from_slice(&v.to_be_bytes());
    }
}

/// ISO-639-2/T "und" (undetermined), packed 5 bits per letter per ISOBMFF
/// 8.4.2.2 — every real packager uses this for output it can't otherwise
/// attribute a source language to, and nothing downstream of this module
/// currently tracks a real one.
const LANG_UND: u16 = 0x55C4;

// ── ftyp ─────────────────────────────────────────────────────────

/// `iso5`/`iso6` (the CMAF-adjacent fragmented-MP4 brands) plus `mp41` for
/// broad player compatibility — the same brand family real HLS-fMP4 and
/// CMAF packagers ship.
fn ftyp() -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(b"iso5"); // major_brand
    body.extend_from_slice(&0u32.to_be_bytes()); // minor_version
    for brand in [b"iso5", b"iso6", b"mp41"] {
        body.extend_from_slice(brand);
    }
    make_box(b"ftyp", &body)
}

// ── mvhd / mvex / trex ───────────────────────────────────────────

/// Movie-level header. Duration is left at 0 — a fragmented file's real
/// duration lives in its fragments and the HLS media playlist's own
/// `#EXTINF` tags, not here, and this module may be asked to build an init
/// segment before the whole job's total duration is even known yet.
fn mvhd(next_track_id: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    body.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    body.extend_from_slice(&1000u32.to_be_bytes()); // timescale (movie-level; each track keeps its own)
    body.extend_from_slice(&0u32.to_be_bytes()); // duration
    body.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // rate 1.0
    body.extend_from_slice(&0x0100u16.to_be_bytes()); // volume 1.0
    body.extend_from_slice(&0u16.to_be_bytes()); // reserved
    body.extend_from_slice(&[0u8; 8]); // reserved x2
    push_matrix(&mut body);
    body.extend_from_slice(&[0u8; 24]); // pre_defined x6
    body.extend_from_slice(&next_track_id.to_be_bytes());
    full_box(b"mvhd", 0, 0, &body)
}

fn trex(track_id: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&track_id.to_be_bytes());
    body.extend_from_slice(&1u32.to_be_bytes()); // default_sample_description_index
    body.extend_from_slice(&0u32.to_be_bytes()); // default_sample_duration
    body.extend_from_slice(&0u32.to_be_bytes()); // default_sample_size
    body.extend_from_slice(&0u32.to_be_bytes()); // default_sample_flags
    full_box(b"trex", 0, 0, &body)
}

// ── trak (shared header pieces) ──────────────────────────────────

fn tkhd(track_id: u32, is_video: bool, width: u16, height: u16) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    body.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    body.extend_from_slice(&track_id.to_be_bytes());
    body.extend_from_slice(&0u32.to_be_bytes()); // reserved
    body.extend_from_slice(&0u32.to_be_bytes()); // duration
    body.extend_from_slice(&[0u8; 8]); // reserved x2
    body.extend_from_slice(&0i16.to_be_bytes()); // layer
    body.extend_from_slice(&0i16.to_be_bytes()); // alternate_group
    body.extend_from_slice(&(if is_video { 0u16 } else { 0x0100u16 }).to_be_bytes()); // volume
    body.extend_from_slice(&0u16.to_be_bytes()); // reserved
    push_matrix(&mut body);
    // width/height are 16.16 fixed-point; 0 for an audio track.
    body.extend_from_slice(&((width as u32) << 16).to_be_bytes());
    body.extend_from_slice(&((height as u32) << 16).to_be_bytes());
    // flags = enabled(1) | in_movie(2) | in_preview(4) = 7
    full_box(b"tkhd", 0, 7, &body)
}

fn mdhd(timescale: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    body.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    body.extend_from_slice(&timescale.to_be_bytes());
    body.extend_from_slice(&0u32.to_be_bytes()); // duration
    body.extend_from_slice(&LANG_UND.to_be_bytes());
    body.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
    full_box(b"mdhd", 0, 0, &body)
}

fn hdlr(handler_type: &[u8; 4], name: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&0u32.to_be_bytes()); // pre_defined
    body.extend_from_slice(handler_type);
    body.extend_from_slice(&[0u8; 12]); // reserved x3
    body.extend_from_slice(name.as_bytes());
    body.push(0); // NUL terminator
    full_box(b"hdlr", 0, 0, &body)
}

fn dinf_self_contained() -> Vec<u8> {
    // A `url ` entry with flags=1 ("self-contained") carries no location
    // string — the fragment/media data is expected alongside this file,
    // never fetched from elsewhere.
    let url_box = full_box(b"url ", 0, 1, &[]);
    let mut dref_body = Vec::new();
    dref_body.extend_from_slice(&1u32.to_be_bytes()); // entry_count
    dref_body.extend_from_slice(&url_box);
    let dref = full_box(b"dref", 0, 0, &dref_body);
    container_box(b"dinf", &[dref])
}

/// The four empty sample tables every fragmented track's `stbl` still needs
/// for structural validity, even though every real sample lives in a
/// `moof`/`mdat` fragment instead — a strictly-conforming ISOBMFF reader
/// expects `stts`/`stsc`/`stsz`/`stco` to exist, just with zero entries.
fn empty_sample_tables() -> Vec<Vec<u8>> {
    vec![
        full_box(b"stts", 0, 0, &0u32.to_be_bytes()),
        full_box(b"stsc", 0, 0, &0u32.to_be_bytes()),
        full_box(b"stsz", 0, 0, &[0u8; 8]), // sample_size=0, sample_count=0
        full_box(b"stco", 0, 0, &0u32.to_be_bytes()),
    ]
}

// ── Sample entries (stsd content) ────────────────────────────────

fn avc1_sample_entry(width: u16, height: u16, avcc_payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&[0u8; 6]); // reserved
    body.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    body.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
    body.extend_from_slice(&0u16.to_be_bytes()); // reserved
    body.extend_from_slice(&[0u8; 12]); // pre_defined x3
    body.extend_from_slice(&width.to_be_bytes());
    body.extend_from_slice(&height.to_be_bytes());
    body.extend_from_slice(&0x0048_0000u32.to_be_bytes()); // horizresolution 72dpi
    body.extend_from_slice(&0x0048_0000u32.to_be_bytes()); // vertresolution 72dpi
    body.extend_from_slice(&0u32.to_be_bytes()); // reserved
    body.extend_from_slice(&1u16.to_be_bytes()); // frame_count
    body.extend_from_slice(&[0u8; 32]); // compressorname (empty Pascal string)
    body.extend_from_slice(&0x0018u16.to_be_bytes()); // depth = 24
    body.extend_from_slice(&(-1i16).to_be_bytes()); // pre_defined
    body.extend_from_slice(&make_box(b"avcC", avcc_payload));
    make_box(b"avc1", &body)
}

/// `esds` wraps an MPEG-4 ES_Descriptor around the 2-byte AudioSpecificConfig
/// this project already derives from its parsed AAC config (see
/// `audio_specific_config` in lib.rs) — every length in this descriptor
/// chain is small enough for the single-byte form of MPEG-4's expandable
/// length encoding, so there's no need for the multi-byte continuation form.
fn esds(audio_specific_config: [u8; 2]) -> Vec<u8> {
    let dsi_tag = [0x05u8, 2, audio_specific_config[0], audio_specific_config[1]];
    let decoder_config_len = 13 + dsi_tag.len();
    let mut decoder_config = vec![0x04u8, decoder_config_len as u8];
    decoder_config.push(0x40); // objectTypeIndication = AAC
    decoder_config.push(0x15); // streamType=5(audio)<<2 | upStream=0 | reserved=1
    decoder_config.extend_from_slice(&[0u8; 3]); // bufferSizeDB
    decoder_config.extend_from_slice(&0u32.to_be_bytes()); // maxBitrate
    decoder_config.extend_from_slice(&0u32.to_be_bytes()); // avgBitrate
    decoder_config.extend_from_slice(&dsi_tag);

    let sl_config = [0x06u8, 1, 0x02];

    let es_descriptor_len = 3 + decoder_config.len() + sl_config.len();
    let mut es_descriptor = vec![0x03u8, es_descriptor_len as u8];
    es_descriptor.extend_from_slice(&0u16.to_be_bytes()); // ES_ID
    es_descriptor.push(0); // flags
    es_descriptor.extend_from_slice(&decoder_config);
    es_descriptor.extend_from_slice(&sl_config);

    full_box(b"esds", 0, 0, &es_descriptor)
}

fn mp4a_sample_entry(channels: u16, sample_rate_hz: u32, audio_specific_config: [u8; 2]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&[0u8; 6]); // reserved
    body.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    body.extend_from_slice(&[0u8; 8]); // reserved (version 0 QuickTime-compat fields)
    body.extend_from_slice(&channels.to_be_bytes());
    body.extend_from_slice(&16u16.to_be_bytes()); // samplesize
    body.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
    body.extend_from_slice(&0u16.to_be_bytes()); // reserved
    body.extend_from_slice(&(sample_rate_hz << 16).to_be_bytes()); // samplerate, 16.16 fixed
    body.extend_from_slice(&esds(audio_specific_config));
    make_box(b"mp4a", &body)
}

/// `stsd` is a full box (version+flags) wrapping `entry_count` followed by
/// the one sample entry itself — a plain `container_box` can't express the
/// version/flags prefix `stsd` needs, unlike `stbl`/`minf`/`mdia`/`trak`,
/// which really are just their children concatenated.
fn stsd(entry: Vec<u8>) -> Vec<u8> {
    let mut body = 1u32.to_be_bytes().to_vec(); // entry_count
    body.extend_from_slice(&entry);
    full_box(b"stsd", 0, 0, &body)
}

fn stbl(sample_entry: Vec<u8>) -> Vec<u8> {
    let mut children = vec![stsd(sample_entry)];
    children.extend(empty_sample_tables());
    container_box(b"stbl", &children)
}

fn video_trak(video: &TrackData, width: u16, height: u16) -> Vec<u8> {
    let minf = container_box(
        b"minf",
        &[
            full_box(b"vmhd", 0, 1, &[0u8; 8]),
            dinf_self_contained(),
            stbl(avc1_sample_entry(width, height, &video.avcc_raw)),
        ],
    );
    let mdia = container_box(b"mdia", &[mdhd(video.timescale), hdlr(b"vide", "VideoHandler"), minf]);
    container_box(b"trak", &[tkhd(1, true, width, height), mdia])
}

fn audio_trak(audio: &TrackData) -> Vec<u8> {
    let audio_specific_cfg = crate::audio_specific_config(audio.aac_config);
    let sample_rate_hz = crate::sample_rate_from_idx(audio.aac_config[1]);
    let channels = audio.aac_config[2] as u16;

    let minf = container_box(
        b"minf",
        &[
            full_box(b"smhd", 0, 0, &[0u8; 4]),
            dinf_self_contained(),
            stbl(mp4a_sample_entry(channels, sample_rate_hz, audio_specific_cfg)),
        ],
    );
    let mdia = container_box(b"mdia", &[mdhd(audio.timescale), hdlr(b"soun", "SoundHandler"), minf]);
    container_box(b"trak", &[tkhd(2, false, 0, 0), mdia])
}

fn wrap_moov(trak: Vec<u8>, track_id: u32) -> Vec<u8> {
    let mvex = container_box(b"mvex", &[trex(track_id)]);
    let moov = container_box(b"moov", &[mvhd(track_id + 1), trak, mvex]);
    let mut out = ftyp();
    out.extend_from_slice(&moov);
    out
}

// ── Fragment (moof + mdat) ───────────────────────────────────────
//
// Unlike the MPEG-TS path (`mux_segment_inner`), a sample's bytes need no
// reframing here: AVCC length-prefixed NALUs and raw (non-ADTS) AAC frames
// are exactly what fMP4 already wants, since the length-prefix size and
// AudioSpecificConfig both live in the init segment's `avcC`/`esds` instead
// of needing to be repeated per frame. A fragment's `mdat` is therefore
// just its samples' bytes copied through verbatim, in order — all the real
// work is in `trun` correctly describing them.

fn mfhd(sequence_number: u32) -> Vec<u8> {
    full_box(b"mfhd", 0, 0, &sequence_number.to_be_bytes())
}

/// `default-base-is-moof` (0x020000) only — every other `tfhd` flag is left
/// unset on purpose so nothing here relies on a `tfhd`/`trex` default; every
/// sample's duration/size/flags is spelled out explicitly in `trun` instead,
/// which needs no per-track special-casing for the fact that video sample
/// durations vary (open GOPs, frame-rate drift) while audio's don't.
fn tfhd(track_id: u32) -> Vec<u8> {
    full_box(b"tfhd", 0, 0x0002_0000, &track_id.to_be_bytes())
}

/// Version 1 for a 64-bit `base_media_decode_time` — this project already
/// keeps sample timestamps as `u64` (see `SampleInfo`), so there's no real
/// upper bound on how long a source video can run before a 32-bit decode
/// time would wrap.
fn tfdt(base_media_decode_time: u64) -> Vec<u8> {
    full_box(b"tfdt", 1, 0, &base_media_decode_time.to_be_bytes())
}

/// ISO 14496-12 8.8.3.1's `sample_flags`: `sample_depends_on` = 2 ("does
/// not depend on others") with `sample_is_non_sync_sample` = 0 marks a
/// keyframe/sync sample; everything else uses `sample_depends_on` = 1 with
/// `is_non_sync_sample` = 1. Confirmed against a real reference fragmented
/// MP4 (Bento4's `mp4fragment`, inspected with `mp4dump`) rather than only
/// the spec text — its `tfhd` default and `trun` first-sample-flags used
/// these exact two values for the same two cases.
fn sample_flags(is_keyframe: bool) -> u32 {
    if is_keyframe { 0x0200_0000 } else { 0x0101_0000 }
}

/// data-offset-present | sample-duration-present | sample-size-present |
/// sample-flags-present | sample-composition-time-offset-present. No
/// first-sample-flags-present: every sample gets an explicit `sample_flags`
/// instead of relying on a tfhd default for everything after the first,
/// since that default doesn't exist here (see `tfhd`).
const TRUN_FLAGS: u32 = 0x0001 | 0x0100 | 0x0200 | 0x0400 | 0x0800;

/// Builds `trun` and returns it alongside the absolute byte offset (within
/// the returned box's own bytes) of its `data_offset` field — that field
/// can't be filled in correctly until the caller knows this fragment's
/// total `moof` size, which isn't known until every box inside it,
/// including this one, already exists. `moof` backpatches through the
/// returned offset once its own size is final, the standard two-pass
/// approach for a self-referential field like this.
fn trun(samples: &[SampleInfo]) -> (Vec<u8>, usize) {
    let mut body = Vec::new();
    body.extend_from_slice(&(samples.len() as u32).to_be_bytes()); // sample_count
    let data_offset_pos_in_body = body.len();
    body.extend_from_slice(&0i32.to_be_bytes()); // data_offset — backpatched by `moof`
    for s in samples {
        body.extend_from_slice(&s.duration.to_be_bytes());
        body.extend_from_slice(&s.size.to_be_bytes());
        body.extend_from_slice(&sample_flags(s.is_keyframe).to_be_bytes());
        // Composition offset (pts - dts) is 0 for every audio sample and
        // for video with no B-frames — always writing it costs 4 bytes per
        // sample but means a track that occasionally reorders frames
        // doesn't need a structurally different trun from one that never
        // does.
        let composition_offset = s.pts as i64 - s.dts as i64;
        body.extend_from_slice(&(composition_offset as i32).to_be_bytes());
    }
    let boxed = full_box(b"trun", 1, TRUN_FLAGS, &body);
    // 8 (box header) + 4 (version+flags) puts us at the start of `body`.
    (boxed, 8 + 4 + data_offset_pos_in_body)
}

fn traf(track_id: u32, base_media_decode_time: u64, samples: &[SampleInfo]) -> (Vec<u8>, usize) {
    let tfhd_box = tfhd(track_id);
    let tfdt_box = tfdt(base_media_decode_time);
    let (trun_box, data_offset_pos_in_trun) = trun(samples);

    let mut body = Vec::with_capacity(tfhd_box.len() + tfdt_box.len() + trun_box.len());
    body.extend_from_slice(&tfhd_box);
    body.extend_from_slice(&tfdt_box);
    let trun_start_in_body = body.len();
    body.extend_from_slice(&trun_box);

    let traf_box = make_box(b"traf", &body);
    // 8 (traf's own header) puts us at the start of `body`.
    (traf_box, 8 + trun_start_in_body + data_offset_pos_in_trun)
}

/// Builds one fragment: `moof` (with `trun`'s `data_offset` correctly
/// backpatched to point at the byte right after this `moof`, per
/// `default-base-is-moof`) followed immediately by `mdat` holding
/// `sample_data` unchanged.
fn fragment(sequence_number: u32, track_id: u32, samples: &[SampleInfo], sample_data: &[u8]) -> Vec<u8> {
    let base_media_decode_time = samples.first().map(|s| s.dts).unwrap_or(0);
    let mfhd_box = mfhd(sequence_number);
    let (traf_box, data_offset_pos_in_traf) = traf(track_id, base_media_decode_time, samples);

    let mut body = Vec::with_capacity(mfhd_box.len() + traf_box.len());
    body.extend_from_slice(&mfhd_box);
    let traf_start_in_body = body.len();
    body.extend_from_slice(&traf_box);

    let mut moof_box = make_box(b"moof", &body);
    // `mdat` starts right after moof — its own 8-byte header included.
    let data_offset = moof_box.len() as i32 + 8;
    let patch_at = 8 + traf_start_in_body + data_offset_pos_in_traf;
    moof_box[patch_at..patch_at + 4].copy_from_slice(&data_offset.to_be_bytes());

    let mut out = moof_box;
    out.extend_from_slice(&make_box(b"mdat", sample_data));
    out
}

// ── Public API ───────────────────────────────────────────────────

/// Builds the `ftyp` + `moov` init segment for a video-only rendition.
/// Kept separate from `init_segment_audio` rather than one combined
/// video+audio init segment on purpose: this project's dub-audio work
/// already established "one shared audio-only rendition/fragment stream per
/// language, never duplicated per video quality" (see `buildAudioOnlyRenditions`
/// in remux.worker.ts) — the same split needs to carry over to fMP4 output,
/// which means video and audio need their own independent init segments
/// from the start, not a combined one to split apart later. Track ID fixed
/// at 1, matching `mux_segment`'s own PID numbering for the video track.
pub fn init_segment_video(video: &TrackData, width: u16, height: u16) -> Vec<u8> {
    wrap_moov(video_trak(video, width, height), 1)
}

/// Builds the `ftyp` + `moov` init segment for an audio-only rendition —
/// see `init_segment_video` for why this is separate. Track ID fixed at 2,
/// matching `mux_segment`'s own PID numbering for the audio track (kept
/// distinct from video's ID 1 even though each lives in its own file, so
/// the two ID spaces stay consistent with the rest of the codebase).
pub fn init_segment_audio(audio: &TrackData) -> Vec<u8> {
    wrap_moov(audio_trak(audio), 2)
}

/// Builds one video fragment (`moof` + `mdat`) — `sequence_number` is the
/// fragment's 1-based position in this rendition's own fragment stream
/// (`mfhd`'s field of the same name), `samples` describes each of
/// `sample_data`'s frames in order, and `sample_data` is those frames'
/// bytes concatenated, already in AVCC (length-prefixed) form as read
/// straight from the source — no reframing needed, see the section comment
/// above. Track ID fixed at 1, matching `init_segment_video`.
pub fn fragment_video(sequence_number: u32, samples: &[SampleInfo], sample_data: &[u8]) -> Vec<u8> {
    fragment(sequence_number, 1, samples, sample_data)
}

/// Builds one audio fragment — see `fragment_video`. `sample_data` is raw
/// AAC frames with no ADTS framing (the AudioSpecificConfig lives in the
/// init segment's `esds` instead). Track ID fixed at 2, matching
/// `init_segment_audio`.
pub fn fragment_audio(sequence_number: u32, samples: &[SampleInfo], sample_data: &[u8]) -> Vec<u8> {
    fragment(sequence_number, 2, samples, sample_data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{find_all_boxes, find_box, find_box_in_stsd_entries, find_box_path, u16be, u32be, u64be};

    // avc1's SampleEntry+VisualSampleEntry fixed header (78 bytes) and
    // mp4a's SampleEntry+AudioSampleEntry fixed header (28 bytes) — the
    // same "how far to skip before this entry's own child boxes start"
    // this project's own stsd *parser* already needed (see
    // `find_box_in_stsd_entries`'s doc comment on the reader side), now
    // needed again on the writer side to fetch avcC/esds back out for
    // testing.
    const AVC1_HEADER_LEN: usize = 78;
    const MP4A_HEADER_LEN: usize = 28;

    /// The first (only) sample entry's own payload inside a `stsd` — for
    /// reading fields declared directly on the entry itself (e.g. mp4a's
    /// channel count), as opposed to `find_box_in_stsd_entries`, which
    /// reads a box nested *inside* the entry (e.g. avcC/esds).
    fn first_stsd_entry_payload(stbl: &[u8]) -> &[u8] {
        let stsd = find_box(stbl, b"stsd").expect("stsd");
        let (size, _, payload_start) = crate::box_header(stsd, 8).expect("stsd entry header");
        &stsd[payload_start..(8 + size as usize).min(stsd.len())]
    }

    fn synthetic_track(handler: &[u8; 4], timescale: u32, avcc_raw: Vec<u8>, aac_config: [u8; 3]) -> TrackData {
        TrackData {
            timescale,
            handler: *handler,
            samples: vec![],
            annexb_header: vec![],
            nalu_len_size: 4,
            aac_config,
            avc1_profile: Some([0x64, 0x00, 0x1e]),
            avcc_raw,
            edit_list_end: None,
            video_codec_fourcc: Some(*b"avc1"),
        }
    }

    fn video_track() -> TrackData {
        // Real avcC payload bytes (from an actual libx264-encoded fixture,
        // captured via mp4dump against this project's own test video) —
        // not synthetic, so a subtly wrong avcC passthrough would show up
        // as a byte mismatch below, not just "some bytes present".
        let avcc = vec![
            0x01, 0x64, 0x00, 0x0d, 0xff, 0xe1, 0x00, 0x19, 0x67, 0x64, 0x00, 0x0d, 0xac, 0xd9, 0x41, 0x41, 0xfb, 0x01,
            0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03, 0x03, 0x20, 0xf1, 0x42, 0x99, 0x60, 0x01, 0x00, 0x06,
            0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0,
        ];
        synthetic_track(b"vide", 12800, avcc, [2, 4, 2])
    }

    fn audio_track() -> TrackData {
        synthetic_track(b"soun", 44100, vec![], [2, 4, 2]) // AAC-LC, 44100 Hz, stereo
    }

    /// Every box this module writes should be internally consistent: each
    /// box's declared size should exactly account for the bytes that follow
    /// it, all the way down. `find_box`/`find_box_path` walking cleanly to
    /// the deepest boxes (rather than panicking or running past the end) is
    /// itself already most of that guarantee.
    #[test]
    fn video_init_segment_parses_box_by_box_with_no_leftover_bytes() {
        let seg = init_segment_video(&video_track(), 320, 240);
        assert_eq!(&seg[4..8], b"ftyp");
        let moov = find_box(&seg, b"moov").expect("moov");
        // moov's own box ends exactly at the init segment's end — no
        // trailing bytes after the last top-level box.
        let ftyp_len = u32be(&seg, 0) as usize;
        assert_eq!(ftyp_len + 8 + moov.len(), seg.len());
        find_box_path(&seg, &[b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd"]).expect("stsd");
    }

    #[test]
    fn video_init_segment_ftyp_brand_is_iso5() {
        let seg = init_segment_video(&video_track(), 320, 240);
        assert_eq!(&seg[8..12], b"iso5"); // major_brand, right after size+type
    }

    #[test]
    fn video_init_segment_tkhd_has_track_id_1_and_correct_dimensions() {
        let seg = init_segment_video(&video_track(), 320, 240);
        let tkhd = find_box_path(&seg, &[b"moov", b"trak", b"tkhd"]).expect("tkhd");
        let track_id = u32be(tkhd, 4 + 8); // skip version+flags(4), creation+modification(8)
        assert_eq!(track_id, 1);
        // width/height are unconditionally the last two 4-byte (16.16
        // fixed-point) fields in tkhd, regardless of how many fields
        // precede them — reading from the end is robust to that layout
        // rather than hand-counting every field ahead of them.
        let width = u32be(tkhd, tkhd.len() - 8) >> 16;
        let height = u32be(tkhd, tkhd.len() - 4) >> 16;
        assert_eq!((width, height), (320, 240));
    }

    #[test]
    fn video_init_segment_mdhd_timescale_matches_track() {
        let seg = init_segment_video(&video_track(), 320, 240);
        let mdhd = find_box_path(&seg, &[b"moov", b"trak", b"mdia", b"mdhd"]).expect("mdhd");
        let timescale = u32be(mdhd, 4 + 8); // skip version+flags(4), creation+modification(8)
        assert_eq!(timescale, 12800);
    }

    #[test]
    fn video_init_segment_avcc_bytes_pass_through_unchanged() {
        let track = video_track();
        let seg = init_segment_video(&track, 320, 240);
        let stbl = find_box_path(&seg, &[b"moov", b"trak", b"mdia", b"minf", b"stbl"]).expect("stbl");
        let avcc = find_box_in_stsd_entries(stbl, AVC1_HEADER_LEN, b"avcC").expect("avcC");
        assert_eq!(avcc, track.avcc_raw.as_slice());
    }

    #[test]
    fn video_init_segment_sample_tables_are_present_but_empty() {
        let seg = init_segment_video(&video_track(), 320, 240);
        let stbl = find_box_path(&seg, &[b"moov", b"trak", b"mdia", b"minf", b"stbl"]).expect("stbl");
        for box_type in [b"stts", b"stsc", b"stco"] {
            let b = find_box(stbl, box_type).unwrap_or_else(|| panic!("missing {:?}", box_type));
            assert_eq!(u32be(b, 4), 0, "{:?} entry_count should be 0", box_type); // skip version+flags
        }
        let stsz = find_box(stbl, b"stsz").expect("stsz");
        assert_eq!(u32be(stsz, 8), 0, "stsz sample_count should be 0"); // skip version+flags(4)+sample_size(4)
    }

    #[test]
    fn video_init_segment_mvex_trex_targets_track_1_with_zeroed_defaults() {
        let seg = init_segment_video(&video_track(), 320, 240);
        let trex = find_box_path(&seg, &[b"moov", b"mvex", b"trex"]).expect("trex");
        assert_eq!(u32be(trex, 4), 1); // track_id, right after version+flags
        assert_eq!(u32be(trex, 8), 1); // default_sample_description_index
        assert_eq!(u32be(trex, 12), 0); // default_sample_duration
    }

    #[test]
    fn audio_init_segment_mdhd_timescale_matches_sample_rate() {
        let seg = init_segment_audio(&audio_track());
        let mdhd = find_box_path(&seg, &[b"moov", b"trak", b"mdia", b"mdhd"]).expect("mdhd");
        assert_eq!(u32be(mdhd, 4 + 8), 44100);
    }

    #[test]
    fn audio_init_segment_mp4a_channel_count_and_sample_rate() {
        let seg = init_segment_audio(&audio_track());
        let stbl = find_box_path(&seg, &[b"moov", b"trak", b"mdia", b"minf", b"stbl"]).expect("stbl");
        let mp4a = first_stsd_entry_payload(stbl);
        // SampleEntry(6+2) + reserved(8) = 16 bytes in, then channelcount(2), samplesize(2),
        // pre_defined(2), reserved(2), samplerate(4, 16.16 fixed).
        let channel_count = u16be(mp4a, 16);
        let sample_rate = u32be(mp4a, 16 + 2 + 2 + 2 + 2) >> 16;
        assert_eq!(channel_count, 2);
        assert_eq!(sample_rate, 44100);
    }

    #[test]
    fn audio_init_segment_esds_carries_the_project_own_audio_specific_config() {
        let track = audio_track();
        let seg = init_segment_audio(&track);
        let stbl = find_box_path(&seg, &[b"moov", b"trak", b"mdia", b"minf", b"stbl"]).expect("stbl");
        let esds = find_box_in_stsd_entries(stbl, MP4A_HEADER_LEN, b"esds").expect("esds");
        let expected = crate::audio_specific_config(track.aac_config);
        // The DecoderSpecificInfo tag (0x05) + length(1 byte, always 2 for
        // plain AAC-LC here) + the 2 config bytes are the descriptor
        // chain's own tail — searching for the tag byte is more robust
        // than hand-counting every preceding descriptor's length, and this
        // project's AudioSpecificConfig is never long enough for the tag
        // byte (0x05) to also appear as a coincidental data byte earlier.
        let tag_pos = esds.iter().position(|&b| b == 0x05).expect("DecoderSpecificInfo tag");
        assert_eq!(&esds[tag_pos + 2..tag_pos + 4], &expected);
    }

    #[test]
    fn audio_init_segment_mvex_trex_targets_track_2() {
        let seg = init_segment_audio(&audio_track());
        let trex = find_box_path(&seg, &[b"moov", b"mvex", b"trex"]).expect("trex");
        assert_eq!(u32be(trex, 4), 2);
    }

    #[test]
    fn video_and_audio_init_segments_each_declare_exactly_one_trak() {
        let vseg = init_segment_video(&video_track(), 320, 240);
        let aseg = init_segment_audio(&audio_track());
        let vmoov = find_box(&vseg, b"moov").unwrap();
        let amoov = find_box(&aseg, b"moov").unwrap();
        assert_eq!(find_all_boxes(vmoov, b"trak").len(), 1);
        assert_eq!(find_all_boxes(amoov, b"trak").len(), 1);
    }

    fn sample(pts: u64, dts: u64, duration: u32, size: u32, is_keyframe: bool) -> SampleInfo {
        SampleInfo { file_offset: 0, size, pts, dts, duration, is_keyframe }
    }

    /// One keyframe followed by two B-frames whose presentation order
    /// doesn't match decode order (pts != dts) — the case that actually
    /// exercises `trun`'s composition-time-offset field, as opposed to a
    /// GOP with no B-frames where it would always be 0 and a bug there
    /// could hide.
    fn gop_with_b_frames() -> Vec<SampleInfo> {
        vec![
            sample(0, 0, 512, 1000, true),
            sample(1536, 512, 512, 200, false),
            sample(1024, 1024, 512, 180, false),
        ]
    }

    #[test]
    fn fragment_video_starts_with_moof_then_mdat_containing_exact_bytes() {
        let samples = gop_with_b_frames();
        let sample_data: Vec<u8> = (0..(1000 + 200 + 180)).map(|i| (i % 256) as u8).collect();
        let frag = fragment_video(7, &samples, &sample_data);
        assert_eq!(&frag[4..8], b"moof");
        let mdat = find_box(&frag, b"mdat").expect("mdat");
        assert_eq!(mdat, sample_data.as_slice());
    }

    #[test]
    fn fragment_video_mfhd_sequence_number_matches_argument() {
        let samples = gop_with_b_frames();
        let data = vec![0u8; 1380];
        let frag = fragment_video(7, &samples, &data);
        let mfhd = find_box_path(&frag, &[b"moof", b"mfhd"]).expect("mfhd");
        assert_eq!(u32be(mfhd, 4), 7); // skip version+flags
    }

    #[test]
    fn fragment_video_tfhd_track_id_is_1_with_default_base_is_moof_flag() {
        let samples = gop_with_b_frames();
        let data = vec![0u8; 1380];
        let frag = fragment_video(7, &samples, &data);
        let traf = find_box_path(&frag, &[b"moof", b"traf"]).expect("traf");
        let tfhd = find_box(traf, b"tfhd").expect("tfhd");
        assert_eq!(&tfhd[1..4], &[0x02, 0x00, 0x00]); // flags = default-base-is-moof (0x020000), 24-bit big-endian
        assert_eq!(u32be(tfhd, 4), 1); // track_id
    }

    #[test]
    fn fragment_audio_tfhd_track_id_is_2() {
        let samples = vec![sample(0, 0, 1024, 200, true)];
        let data = vec![0u8; 200];
        let frag = fragment_audio(1, &samples, &data);
        let traf = find_box_path(&frag, &[b"moof", b"traf"]).expect("traf");
        let tfhd = find_box(traf, b"tfhd").expect("tfhd");
        assert_eq!(u32be(tfhd, 4), 2);
    }

    #[test]
    fn fragment_video_tfdt_base_media_decode_time_is_first_sample_dts() {
        let mut samples = gop_with_b_frames();
        samples.iter_mut().for_each(|s| s.dts += 90_000); // simulate a later fragment, not starting at 0
        let data = vec![0u8; 1380];
        let frag = fragment_video(2, &samples, &data);
        let tfdt = find_box_path(&frag, &[b"moof", b"traf", b"tfdt"]).expect("tfdt");
        assert_eq!(tfdt[0], 1); // version 1 -> 64-bit base_media_decode_time
        assert_eq!(u64be(tfdt, 4), samples[0].dts);
    }

    #[test]
    fn fragment_video_trun_sample_count_and_data_offset_point_exactly_at_mdat_payload() {
        let samples = gop_with_b_frames();
        let data = vec![0u8; 1380];
        let frag = fragment_video(1, &samples, &data);
        let trun = find_box_path(&frag, &[b"moof", b"traf", b"trun"]).expect("trun");
        assert_eq!(u32be(trun, 4), samples.len() as u32); // sample_count, right after version+flags
        let data_offset = u32be(trun, 8) as usize; // data_offset, right after sample_count

        // `default-base-is-moof` makes data_offset relative to moof's own
        // start (byte 0 of `frag`) — it should land exactly on mdat's
        // payload, not its header, and not drift if trun's own size
        // changes (e.g. more samples).
        let moof_len = u32be(&frag, 0) as usize;
        assert_eq!(data_offset, moof_len + 8);
        assert_eq!(&frag[data_offset..], data.as_slice());
    }

    #[test]
    fn fragment_video_trun_per_sample_duration_and_size_match_input() {
        let samples = gop_with_b_frames();
        let data = vec![0u8; 1380];
        let frag = fragment_video(1, &samples, &data);
        let trun = find_box_path(&frag, &[b"moof", b"traf", b"trun"]).expect("trun");
        // version+flags(4) + sample_count(4) + data_offset(4) = 12, then
        // 16 bytes per sample (duration, size, flags, composition_offset).
        for (i, s) in samples.iter().enumerate() {
            let off = 12 + i * 16;
            assert_eq!(u32be(trun, off), s.duration, "sample {i} duration");
            assert_eq!(u32be(trun, off + 4), s.size, "sample {i} size");
        }
    }

    #[test]
    fn fragment_video_trun_keyframe_and_non_keyframe_sample_flags() {
        let samples = gop_with_b_frames(); // [keyframe, non-key, non-key]
        let data = vec![0u8; 1380];
        let frag = fragment_video(1, &samples, &data);
        let trun = find_box_path(&frag, &[b"moof", b"traf", b"trun"]).expect("trun");
        let flags_at = |i: usize| u32be(trun, 12 + i * 16 + 8);
        assert_eq!(flags_at(0), 0x0200_0000, "keyframe");
        assert_eq!(flags_at(1), 0x0101_0000, "non-keyframe");
        assert_eq!(flags_at(2), 0x0101_0000, "non-keyframe");
    }

    #[test]
    fn fragment_video_trun_composition_offset_is_pts_minus_dts() {
        let samples = gop_with_b_frames();
        let data = vec![0u8; 1380];
        let frag = fragment_video(1, &samples, &data);
        let trun = find_box_path(&frag, &[b"moof", b"traf", b"trun"]).expect("trun");
        for (i, s) in samples.iter().enumerate() {
            let off = 12 + i * 16 + 12;
            let cto = u32be(trun, off) as i32;
            assert_eq!(cto as i64, s.pts as i64 - s.dts as i64, "sample {i} composition offset");
        }
    }

    #[test]
    fn fragment_with_no_samples_still_produces_a_parseable_empty_fragment() {
        let frag = fragment_video(1, &[], &[]);
        let trun = find_box_path(&frag, &[b"moof", b"traf", b"trun"]).expect("trun");
        assert_eq!(u32be(trun, 4), 0);
        let mdat = find_box(&frag, b"mdat").expect("mdat");
        assert!(mdat.is_empty());
    }
}
