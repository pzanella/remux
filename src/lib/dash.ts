/**
 * DASH (MPEG-DASH) manifest generation — the counterpart of hls-playlist.ts
 * for CMAF/fMP4 output, kept in TS rather than Rust for the same reason
 * buildMasterM3U8 already is: manifest text is a formatting problem, not a
 * binary-format one, and stays easy to unit-test without a wasm boundary.
 *
 * A DASH `Representation` addresses the exact same init segment + `.m4s`
 * fragments an HLS-on-fMP4 media playlist (`buildFmp4MediaPlaylist`) already
 * references — this only ever needs to be one more manifest describing
 * files that already exist, not a second encode.
 */

export interface DashRendition {
  id: string;
  mimeType: 'video/mp4' | 'audio/mp4';
  codecs: string;
  bandwidth: number;
  width?: number;
  height?: number;
  audioSamplingRate?: number;
  initFilename: string;
  /** Segment durations in seconds, in order — the same array
   * `buildFmp4MediaPlaylist` receives for this rendition's `.m4s` files. */
  segmentDurationsSec: number[];
  /** Same convention as `buildFmp4MediaPlaylist`'s `fragmentName`, but
   * expressed as a DASH `$Number%0Nd$` template rather than resolved per
   * index — one `SegmentTemplate` describes every fragment at once. */
  mediaTemplate: string;
}

/** `PT12.5S`-style ISO 8601 duration — the only piece of the format DASH
 * manifests need, so this doesn't attempt years/months/days. */
function isoDuration(seconds: number): string {
  return `PT${seconds.toFixed(3).replace(/\.?0+$/, '')}S`;
}

/** One `<S d="...">` per segment, no `r` (repeat-count) compaction — this
 * project's segments are already an exact, known list (never more than a
 * few hundred for realistic content), and always-correct explicit entries
 * cost nothing meaningful over compacting runs of equal duration, which
 * VOD output rarely has anyway (the last segment is almost always
 * shorter). `timescale` converts seconds to the template's integer units
 * (see `buildDashManifest`). */
function segmentTimeline(durationsSec: number[], timescale: number): string {
  const entries = durationsSec.map((d) => `<S d="${Math.round(d * timescale)}"/>`).join('');
  return `<SegmentTimeline>${entries}</SegmentTimeline>`;
}

function representation(r: DashRendition, timescale: number): string {
  const dims = r.width && r.height ? ` width="${r.width}" height="${r.height}"` : '';
  const sampleRate = r.audioSamplingRate ? ` audioSamplingRate="${r.audioSamplingRate}"` : '';
  return (
    `<Representation id="${r.id}" codecs="${r.codecs}" bandwidth="${r.bandwidth}"${dims}${sampleRate}>` +
    `<SegmentTemplate initialization="${r.initFilename}" media="${r.mediaTemplate}" startNumber="0" timescale="${timescale}">` +
    segmentTimeline(r.segmentDurationsSec, timescale) +
    '</SegmentTemplate>' +
    '</Representation>'
  );
}

/** One `AdaptationSet` per distinct `mimeType` among `renditions` — video
 * and audio always split this way (never mixed into one set), matching
 * how this project's HLS-fMP4 output already keeps them as separate
 * fragment streams (see fmp4.rs's `init_segment_video`/`_audio`). Multiple
 * video renditions (once adaptive fMP4 exists — see roadmap B5) would
 * share one `AdaptationSet` here; today there's always exactly one per
 * mimeType. */
function adaptationSets(renditions: DashRendition[], timescale: number): string {
  const byMimeType = new Map<string, DashRendition[]>();
  for (const r of renditions) {
    const list = byMimeType.get(r.mimeType) ?? [];
    list.push(r);
    byMimeType.set(r.mimeType, list);
  }
  let out = '';
  for (const [mimeType, list] of byMimeType) {
    out += `<AdaptationSet mimeType="${mimeType}" segmentAlignment="true">`;
    out += list.map((r) => representation(r, timescale)).join('');
    out += '</AdaptationSet>';
  }
  return out;
}

/** A `static` (VOD) MPD — this project has no live/in-progress DASH output
 * yet, unlike `buildIntermediateM3U8`'s HLS counterpart, so there's no
 * `dynamic` variant to choose between. `timescale` is DASH's own per-track
 * unit for `SegmentTemplate`'s `d`/`t` attributes (1000 — milliseconds —
 * is precise enough for this project's segment durations without needing
 * a track's real media timescale threaded through here too). */
export function buildDashManifest(totalDurationSec: number, renditions: DashRendition[]): string {
  const timescale = 1000;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ' +
    'profiles="urn:mpeg:dash:profile:isoff-live:2011" ' +
    'type="static" ' +
    `mediaPresentationDuration="${isoDuration(totalDurationSec)}" ` +
    'minBufferTime="PT2S">' +
    '<Period>' +
    adaptationSets(renditions, timescale) +
    '</Period>' +
    '</MPD>'
  );
}
