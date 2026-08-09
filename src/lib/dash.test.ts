import { describe, expect, it } from 'vitest';
import { buildDashManifest, type DashRendition } from './dash';

const video: DashRendition = {
  id: 'video',
  mimeType: 'video/mp4',
  codecs: 'avc1.640018',
  bandwidth: 1_000_000,
  width: 320,
  height: 240,
  initFilename: 'init_video.mp4',
  segmentDurationsSec: [6, 4.08],
  mediaTemplate: 'frag_video_$Number%04d$.m4s',
};

const audio: DashRendition = {
  id: 'audio',
  mimeType: 'audio/mp4',
  codecs: 'mp4a.40.2',
  bandwidth: 128_000,
  audioSamplingRate: 44100,
  initFilename: 'init_audio.mp4',
  segmentDurationsSec: [6, 4.02],
  mediaTemplate: 'frag_audio_$Number%04d$.m4s',
};

describe('buildDashManifest', () => {
  it('is well-formed enough to open and close every element it writes', () => {
    const m = buildDashManifest(10.08, [video, audio]);
    for (const tag of ['MPD', 'Period', 'AdaptationSet', 'Representation', 'SegmentTemplate', 'SegmentTimeline']) {
      const opens = (m.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;
      const closes = (m.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
      expect(opens, `${tag} open/close count`).toBe(closes);
    }
  });

  it('is a static (VOD) manifest, not a live one', () => {
    expect(buildDashManifest(10.08, [video, audio])).toContain('type="static"');
  });

  it('sets mediaPresentationDuration from the total duration', () => {
    expect(buildDashManifest(10.08, [video, audio])).toContain('mediaPresentationDuration="PT10.08S"');
  });

  it('groups video and audio into separate AdaptationSets by mimeType', () => {
    const m = buildDashManifest(10.08, [video, audio]);
    expect(m).toContain('<AdaptationSet mimeType="video/mp4"');
    expect(m).toContain('<AdaptationSet mimeType="audio/mp4"');
    // Exactly two sets, not one merged set or four (one per representation).
    expect((m.match(/<AdaptationSet /g) ?? []).length).toBe(2);
  });

  it('includes width/height only for the video representation', () => {
    const m = buildDashManifest(10.08, [video, audio]);
    expect(m).toContain('id="video" codecs="avc1.640018" bandwidth="1000000" width="320" height="240"');
    expect(m).toContain('id="audio" codecs="mp4a.40.2" bandwidth="128000" audioSamplingRate="44100">');
  });

  it('includes audioSamplingRate only for the audio representation', () => {
    const m = buildDashManifest(10.08, [video, audio]);
    const videoRepresentation = m.slice(m.indexOf('id="video"'), m.indexOf('</Representation>'));
    expect(videoRepresentation).not.toContain('audioSamplingRate');
  });

  it('references the init segment and media template via SegmentTemplate', () => {
    const m = buildDashManifest(10.08, [video, audio]);
    expect(m).toContain('initialization="init_video.mp4" media="frag_video_$Number%04d$.m4s"');
    expect(m).toContain('initialization="init_audio.mp4" media="frag_audio_$Number%04d$.m4s"');
  });

  it('converts each segment duration to milliseconds under the 1000 timescale', () => {
    const m = buildDashManifest(10.08, [video, audio]);
    expect(m).toContain('timescale="1000"');
    expect(m).toContain('<S d="6000"/><S d="4080"/>');
    expect(m).toContain('<S d="6000"/><S d="4020"/>');
  });

  it('does not throw for a video-only rendition list', () => {
    expect(() => buildDashManifest(6, [video])).not.toThrow();
  });
});
