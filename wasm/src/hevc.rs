//! HEVC/H.265 support for the fast (byte-copy, no re-encode) MPEG-TS path
//! only — see `wasm/src/lib.rs`'s `TrackData::is_hevc` and `parse_headers`'
//! own doc comment for the exact scope boundary. Adaptive HLS (WebCodecs)
//! and fMP4 output stay AVC-only for now: both need real codec-string/
//! decoder-description work this module deliberately doesn't do (see
//! `HlsProcessor::codec_config`, which still errors for an HEVC track on
//! purpose).
//!
//! The actual byte-level NALU reframing (`avcc_to_annexb` in lib.rs) is
//! already codec-agnostic — it only ever converts length-prefixed NALUs to
//! start-code-prefixed ones, never inspects NAL type — so this module is
//! just what's genuinely HEVC-specific: reading the `hvcC` config record's
//! own different box layout to get at the same two things `parse_avcc_header`
//! already gets from `avcC` (an Annex-B parameter-set header, and the
//! length-prefix size).

use crate::u16be;

/// Parses an `hvcC` (HEVCDecoderConfigurationRecord, ISO/IEC 14496-15
/// §8.3.3.1) box payload into (VPS+SPS+PPS in Annex-B form, NALU length
/// size) — the HEVC counterpart of `parse_avcc_header`. Unlike `avcC`,
/// which always has exactly one SPS array then one PPS array, `hvcC` holds
/// an arbitrary number of NAL-unit-type-tagged arrays (`numOfArrays`); this
/// takes every NAL unit from every array, in order, rather than picking out
/// specific types — a real decoder needs VPS+SPS+PPS all present before the
/// first keyframe it's asked to decode, and taking everything is simpler
/// and no less correct than re-deriving which array indices are "the
/// parameter sets" from `NAL_unit_type` values a decoder would already
/// enforce on its own.
pub(crate) fn parse_hvcc_header(hvcc: &[u8]) -> (Vec<u8>, u8) {
    // Fixed header up to (not including) numOfArrays: configurationVersion(1)
    // + general_profile_space/tier/idc(1) + general_profile_compatibility_flags(4)
    // + general_constraint_indicator_flags(6) + general_level_idc(1) +
    // min_spatial_segmentation_idc(2) + parallelismType(1) + chromaFormat(1) +
    // bitDepthLumaMinus8(1) + bitDepthChromaMinus8(1) + avgFrameRate(2) +
    // (constantFrameRate/numTemporalLayers/temporalIdNested/lengthSizeMinusOne)(1)
    // = 22 bytes, then numOfArrays(1) at offset 22.
    const FIXED_HEADER_LEN: usize = 22;
    if hvcc.len() <= FIXED_HEADER_LEN {
        return (Vec::new(), 4);
    }
    let nalu_len_size = (hvcc[21] & 0x03) + 1;
    let num_arrays = hvcc[FIXED_HEADER_LEN] as usize;

    let mut out = Vec::new();
    let mut off = FIXED_HEADER_LEN + 1;
    for _ in 0..num_arrays {
        // array_completeness(1) + reserved(1) + NAL_unit_type(6) = 1 byte,
        // then numNalus(2).
        if off + 3 > hvcc.len() {
            break;
        }
        let num_nalus = u16be(hvcc, off + 1) as usize;
        off += 3;
        for _ in 0..num_nalus {
            if off + 2 > hvcc.len() {
                break;
            }
            let len = u16be(hvcc, off) as usize;
            off += 2;
            if off + len > hvcc.len() {
                break;
            }
            out.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
            out.extend_from_slice(&hvcc[off..off + len]);
            off += len;
        }
    }
    (out, nalu_len_size)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal but structurally real `hvcC`: one VPS, one SPS, one PPS,
    /// each its own array (`array_completeness`/reserved bits don't matter
    /// here since this module never reads them), 4-byte NALU lengths. The
    /// NAL payloads themselves are arbitrary bytes — this is testing the
    /// container's own array/length framing, not real HEVC bitstream
    /// content (see `parse_avcc_header`'s own tests for why the project's
    /// AVC side additionally uses a real libx264 fixture — no equivalent
    /// real-encoder HEVC fixture is needed here since nothing downstream of
    /// this function inspects NALU *content*, only its framing).
    fn sample_hvcc() -> Vec<u8> {
        let mut out = vec![
            1,    // configurationVersion
            0x01, // general_profile_space(2)=0 tier(1)=0 profile_idc(5)=1
        ];
        out.extend_from_slice(&[0u8; 4]); // general_profile_compatibility_flags
        out.extend_from_slice(&[0u8; 6]); // general_constraint_indicator_flags
        out.push(93); // general_level_idc
        out.extend_from_slice(&[0xF0, 0x00]); // reserved(4)+min_spatial_segmentation_idc(12)
        out.push(0xFC); // reserved(6)+parallelismType(2)
        out.push(0xFD); // reserved(6)+chromaFormat(2)
        out.push(0xF8); // reserved(5)+bitDepthLumaMinus8(3)
        out.push(0xF8); // reserved(5)+bitDepthChromaMinus8(3)
        out.extend_from_slice(&[0x00, 0x00]); // avgFrameRate
        out.push(0x03); // constantFrameRate(2)=0 numTemporalLayers(3)=0 temporalIdNested(1)=0 lengthSizeMinusOne(2)=3 -> 4-byte lengths
        out.push(3); // numOfArrays

        let vps = [0x40, 0x01, 0xAA, 0xBB];
        let sps = [0x42, 0x01, 0xCC, 0xDD, 0xEE];
        let pps = [0x44, 0x01, 0xFF];
        for (nal_type, nalu) in [(32u8, &vps[..]), (33, &sps[..]), (34, &pps[..])] {
            out.push(0x80 | (nal_type & 0x3F)); // array_completeness=1, reserved=0, NAL_unit_type
            out.extend_from_slice(&1u16.to_be_bytes()); // numNalus
            out.extend_from_slice(&(nalu.len() as u16).to_be_bytes());
            out.extend_from_slice(nalu);
        }
        out
    }

    #[test]
    fn parse_hvcc_header_reads_4_byte_length_size_from_lengthsizeminusone() {
        let (_, nalu_len_size) = parse_hvcc_header(&sample_hvcc());
        assert_eq!(nalu_len_size, 4);
    }

    #[test]
    fn parse_hvcc_header_concatenates_every_array_as_annexb_in_order() {
        let (header, _) = parse_hvcc_header(&sample_hvcc());
        let mut expected = Vec::new();
        for nalu in [&[0x40u8, 0x01, 0xAA, 0xBB][..], &[0x42, 0x01, 0xCC, 0xDD, 0xEE], &[0x44, 0x01, 0xFF]] {
            expected.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
            expected.extend_from_slice(nalu);
        }
        assert_eq!(header, expected);
    }

    #[test]
    fn parse_hvcc_header_reads_3_byte_length_size() {
        let mut hvcc = sample_hvcc();
        // lengthSizeMinusOne=2 -> 3-byte lengths (constantFrameRate/numTemporalLayers/
        // temporalIdNested bits left as-is, only the low 2 bits change).
        hvcc[21] = (hvcc[21] & 0xFC) | 0x02;
        let (_, nalu_len_size) = parse_hvcc_header(&hvcc);
        assert_eq!(nalu_len_size, 3);
    }

    #[test]
    fn parse_hvcc_header_too_short_returns_empty() {
        let (header, nalu_len_size) = parse_hvcc_header(&[1, 2, 3]);
        assert!(header.is_empty());
        assert_eq!(nalu_len_size, 4);
    }

    #[test]
    fn parse_hvcc_header_truncated_mid_array_stops_without_panicking() {
        let mut hvcc = sample_hvcc();
        hvcc.truncate(hvcc.len() - 2); // cut off mid-way through the last NALU
        let (header, _) = parse_hvcc_header(&hvcc);
        // The first two arrays (VPS, SPS) should still have parsed fully.
        assert!(header.windows(4).any(|w| w == [0x40, 0x01, 0xAA, 0xBB]));
        assert!(header.windows(5).any(|w| w == [0x42, 0x01, 0xCC, 0xDD, 0xEE]));
    }
}
