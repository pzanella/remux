import { describe, expect, it } from 'vitest';
import {
  AUDIO_GROUP_ID,
  SUBTITLES_GROUP_ID,
  buildAudioMediaTag,
  buildFastPathMasterM3U8,
  buildFmp4MasterM3U8,
  buildFmp4MediaPlaylist,
  buildIntermediateM3U8,
  buildMasterM3U8,
  buildSubtitleMediaTag,
  buildSubtitlePlaylist,
  computeLetterboxRect,
  computeRenditionWidth,
  concatChunks,
  cumulativeBoundaries,
  durationsFromPlaylist,
  extractPlaylistBody,
  hasEditedSegments,
  matchMainRendition,
  spliceM3U8Texts,
  subtitlePlaylistFilename,
  subtitleVttFilename,
  totalDurationFromPlaylist,
} from './hls-playlist';
import type { AbrRendition } from '../types';

function rendition(overrides: Partial<AbrRendition> = {}): AbrRendition {
  return { height: 480, label: '480p', videoBitrateKbps: 1400, audioBitrateKbps: 128, ...overrides };
}

describe('computeRenditionWidth', () => {
  it('scales from the source aspect ratio, rounded to an even number', () => {
    expect(computeRenditionWidth(1920, 1080, 480)).toBe(854); // 480 * 16/9 = 853.33 -> 854
  });

  it('falls back to the standard 16:9 width when the source dimensions are unknown', () => {
    expect(computeRenditionWidth(0, 0, 480)).toBe(854);
    expect(computeRenditionWidth(0, 0, 360)).toBe(640);
  });

  it('falls back to the target height itself for a height with no standard fallback', () => {
    expect(computeRenditionWidth(0, 0, 999)).toBe(999);
  });

  it('always returns an even width', () => {
    const w = computeRenditionWidth(1000, 777, 480);
    expect(w % 2).toBe(0);
  });
});

describe('computeLetterboxRect', () => {
  it('fills the box exactly when the aspect ratios already match', () => {
    expect(computeLetterboxRect(1920, 1080, 960, 540)).toEqual({ x: 0, y: 0, w: 960, h: 540 });
  });

  it('pillarboxes a narrower source (black bars left/right)', () => {
    const rect = computeLetterboxRect(600, 800, 800, 800); // portrait into a square box
    expect(rect.h).toBe(800);
    expect(rect.w).toBeLessThan(800);
    expect(rect.x).toBeGreaterThan(0);
    expect(rect.y).toBe(0);
  });

  it('letterboxes a wider source (black bars top/bottom)', () => {
    const rect = computeLetterboxRect(1920, 800, 800, 800); // wide into a square box
    expect(rect.w).toBe(800);
    expect(rect.h).toBeLessThan(800);
    expect(rect.y).toBeGreaterThan(0);
    expect(rect.x).toBe(0);
  });

  it('falls back to filling the whole box when the source dimensions are unknown', () => {
    expect(computeLetterboxRect(0, 0, 800, 450)).toEqual({ x: 0, y: 0, w: 800, h: 450 });
  });

  it('never produces an odd width or height', () => {
    const rect = computeLetterboxRect(999, 333, 401, 401);
    expect(rect.w % 2).toBe(0);
    expect(rect.h % 2).toBe(0);
  });
});

describe('matchMainRendition', () => {
  it('labels itself "main" at the given height', () => {
    const r = matchMainRendition(720);
    expect(r).toMatchObject({ height: 720, label: 'main' });
  });

  it('scales bitrate with height but floors it at 1200kbps', () => {
    expect(matchMainRendition(100).videoBitrateKbps).toBe(1200);
    expect(matchMainRendition(1000).videoBitrateKbps).toBe(6000);
  });
});

describe('subtitleVttFilename / subtitlePlaylistFilename', () => {
  it('key off the language code, distinct filenames per format', () => {
    expect(subtitleVttFilename('en')).toBe('subtitles_en.vtt');
    expect(subtitlePlaylistFilename('en')).toBe('subtitles_en.m3u8');
  });

  it('differ between languages, so two tracks do not collide', () => {
    expect(subtitleVttFilename('en')).not.toBe(subtitleVttFilename('es'));
    expect(subtitlePlaylistFilename('en')).not.toBe(subtitlePlaylistFilename('es'));
  });
});

describe('buildSubtitleMediaTag', () => {
  it('renders a spec-shaped #EXT-X-MEDIA subtitle tag pointing at its own playlist', () => {
    const tag = buildSubtitleMediaTag({ name: 'English', language: 'en', playlist: 'subtitles_en.m3u8', isDefault: true });
    expect(tag).toContain('TYPE=SUBTITLES');
    expect(tag).toContain(`GROUP-ID="${SUBTITLES_GROUP_ID}"`);
    expect(tag).toContain('NAME="English"');
    expect(tag).toContain('LANGUAGE="en"');
    expect(tag).toContain('URI="subtitles_en.m3u8"');
  });

  it('renders DEFAULT=YES for the default track and NO otherwise', () => {
    const def = buildSubtitleMediaTag({ name: 'English', language: 'en', playlist: 'subtitles_en.m3u8', isDefault: true });
    const alt = buildSubtitleMediaTag({ name: 'Spanish', language: 'es', playlist: 'subtitles_es.m3u8', isDefault: false });
    expect(def).toContain('DEFAULT=YES');
    expect(alt).toContain('DEFAULT=NO');
  });
});

describe('buildSubtitlePlaylist', () => {
  it('wraps the given VTT filename as a one-segment VOD playlist spanning the given duration', () => {
    const playlist = buildSubtitlePlaylist(12.5, 'subtitles_en.vtt');
    expect(playlist.startsWith('#EXTM3U\n')).toBe(true);
    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(playlist).toContain('#EXTINF:12.500000,');
    expect(playlist).toContain('subtitles_en.vtt');
    expect(playlist).toContain('#EXT-X-ENDLIST');
  });

  it('rounds the target duration up and floors it at 1', () => {
    expect(buildSubtitlePlaylist(0.2, 'x.vtt')).toContain('#EXT-X-TARGETDURATION:1');
    expect(buildSubtitlePlaylist(9.1, 'x.vtt')).toContain('#EXT-X-TARGETDURATION:10');
  });
});

describe('buildAudioMediaTag', () => {
  it('renders DEFAULT=YES for the default track and NO otherwise', () => {
    const def = buildAudioMediaTag({ name: 'Original', language: 'und', playlist: 'a.m3u8', isDefault: true });
    const alt = buildAudioMediaTag({ name: 'Spanish', language: 'es', playlist: 'b.m3u8', isDefault: false });
    expect(def).toContain('DEFAULT=YES');
    expect(alt).toContain('DEFAULT=NO');
    expect(def).toContain(`GROUP-ID="${AUDIO_GROUP_ID}"`);
  });
});

describe('buildMasterM3U8', () => {
  it('lists one #EXT-X-STREAM-INF per rendition with bandwidth = (video + audio) kbps in bps', () => {
    const m = buildMasterM3U8([{ rendition: rendition({ videoBitrateKbps: 1000, audioBitrateKbps: 128 }), playlist: '480p.m3u8', width: 854 }]);
    expect(m).toContain('BANDWIDTH=1128000');
    expect(m).toContain('RESOLUTION=854x480');
    expect(m).toContain('480p.m3u8');
  });

  it('adds SUBTITLES/AUDIO attributes only when those tracks are present', () => {
    const bare = buildMasterM3U8([{ rendition: rendition(), playlist: '480p.m3u8', width: 854 }]);
    expect(bare).not.toContain('SUBTITLES=');
    expect(bare).not.toContain(',AUDIO=');

    const withBoth = buildMasterM3U8(
      [{ rendition: rendition(), playlist: '480p.m3u8', width: 854 }],
      [{ name: 'English', language: 'en', playlist: 'subtitles_en.m3u8', isDefault: true }],
      [{ name: 'Original', language: 'und', playlist: 'a.m3u8', isDefault: true }],
    );
    expect(withBoth).toContain(`SUBTITLES="${SUBTITLES_GROUP_ID}"`);
    expect(withBoth).toContain(`AUDIO="${AUDIO_GROUP_ID}"`);
  });

  it('lists one #EXT-X-MEDIA per subtitle track when there are several', () => {
    const m = buildMasterM3U8(
      [{ rendition: rendition(), playlist: '480p.m3u8', width: 854 }],
      [
        { name: 'English', language: 'en', playlist: 'subtitles_en.m3u8', isDefault: true },
        { name: 'Spanish', language: 'es', playlist: 'subtitles_es.m3u8', isDefault: false },
      ],
    );
    expect(m.match(/TYPE=SUBTITLES/g)).toHaveLength(2);
    expect(m).toContain('subtitles_en.m3u8');
    expect(m).toContain('subtitles_es.m3u8');
  });
});

describe('buildFastPathMasterM3U8', () => {
  it('always points at index.m3u8', () => {
    expect(buildFastPathMasterM3U8(1_000_000, undefined, undefined, undefined, undefined)).toContain('index.m3u8');
  });

  it('omits RESOLUTION when dimensions are unknown', () => {
    const m = buildFastPathMasterM3U8(1_000_000, undefined, undefined, undefined, undefined);
    expect(m).not.toContain('RESOLUTION=');
  });

  it('includes RESOLUTION when dimensions are known', () => {
    const m = buildFastPathMasterM3U8(1_000_000, 1920, 1080, undefined, undefined);
    expect(m).toContain('RESOLUTION=1920x1080');
  });
});

describe('buildIntermediateM3U8', () => {
  it('emits one #EXTINF/segment pair per duration, using the default segment_NNNN.ts naming', () => {
    const m = buildIntermediateM3U8([6, 6, 3], false);
    expect(m).toContain('#EXTINF:6.000000,\nsegment_0000.ts');
    expect(m).toContain('#EXTINF:3.000000,\nsegment_0002.ts');
    expect(m).not.toContain('#EXT-X-ENDLIST');
  });

  it('appends #EXT-X-ENDLIST only when isFinal is true', () => {
    expect(buildIntermediateM3U8([6], true)).toContain('#EXT-X-ENDLIST');
  });

  it('accepts a custom segment-naming function', () => {
    const m = buildIntermediateM3U8([6], true, (i) => `custom_${i}.ts`);
    expect(m).toContain('custom_0.ts');
  });

  it('sets TARGETDURATION from the longest segment, rounded up plus one', () => {
    expect(buildIntermediateM3U8([5.9, 2], true)).toContain('#EXT-X-TARGETDURATION:7');
  });

  it('does not throw on an empty duration list', () => {
    expect(() => buildIntermediateM3U8([], true)).not.toThrow();
  });
});

describe('buildFmp4MediaPlaylist', () => {
  it('references the init segment via #EXT-X-MAP before any #EXTINF', () => {
    const m = buildFmp4MediaPlaylist([6, 4], 'init.mp4', (i) => `frag_${i}.m4s`);
    const mapPos = m.indexOf('#EXT-X-MAP:URI="init.mp4"');
    const firstExtinfPos = m.indexOf('#EXTINF');
    expect(mapPos).toBeGreaterThan(-1);
    expect(mapPos).toBeLessThan(firstExtinfPos);
  });

  it('emits one #EXTINF/fragment pair per duration, in order', () => {
    const m = buildFmp4MediaPlaylist([6, 4], 'init.mp4', (i) => `frag_${i}.m4s`);
    expect(m).toContain('#EXTINF:6.000000,\nfrag_0.m4s');
    expect(m).toContain('#EXTINF:4.000000,\nfrag_1.m4s');
  });

  it('is version 7, unlike the MPEG-TS playlists', () => {
    expect(buildFmp4MediaPlaylist([6], 'init.mp4', (i) => `frag_${i}.m4s`)).toContain('#EXT-X-VERSION:7');
  });

  it('always ends the list — unlike buildIntermediateM3U8, there is no in-progress fMP4 output yet', () => {
    expect(buildFmp4MediaPlaylist([6], 'init.mp4', (i) => `frag_${i}.m4s`)).toContain('#EXT-X-ENDLIST');
  });
});

describe('buildFmp4MasterM3U8', () => {
  it('references the given video and audio playlists', () => {
    const m = buildFmp4MasterM3U8(1_000_000, 320, 240, 'video.m3u8', 'audio.m3u8');
    expect(m).toContain('URI="audio.m3u8"');
    expect(m).toContain('\nvideo.m3u8\n');
  });

  it('always includes the AUDIO group attribute, unlike buildFastPathMasterM3U8 where it is conditional', () => {
    const m = buildFmp4MasterM3U8(1_000_000, 320, 240, 'video.m3u8', 'audio.m3u8');
    expect(m).toContain(`AUDIO="${AUDIO_GROUP_ID}"`);
  });

  it('is version 7', () => {
    expect(buildFmp4MasterM3U8(1_000_000, 320, 240, 'video.m3u8', 'audio.m3u8')).toContain('#EXT-X-VERSION:7');
  });

  it('includes RESOLUTION when dimensions are known', () => {
    expect(buildFmp4MasterM3U8(1_000_000, 1920, 1080, 'video.m3u8', 'audio.m3u8')).toContain('RESOLUTION=1920x1080');
  });
});

describe('totalDurationFromPlaylist / durationsFromPlaylist', () => {
  const playlist = buildIntermediateM3U8([6, 6, 3.5], true);

  it('sums every #EXTINF value', () => {
    expect(totalDurationFromPlaylist(playlist)).toBeCloseTo(15.5, 5);
  });

  it('returns every #EXTINF value in order', () => {
    expect(durationsFromPlaylist(playlist)).toEqual([6, 6, 3.5]);
  });

  it('both return zero/empty for a playlist with no segments', () => {
    expect(totalDurationFromPlaylist('#EXTM3U\n')).toBe(0);
    expect(durationsFromPlaylist('#EXTM3U\n')).toEqual([]);
  });
});

describe('cumulativeBoundaries', () => {
  it('turns individual durations into cumulative end times', () => {
    expect(cumulativeBoundaries([6, 6, 3])).toEqual([6, 12, 15]);
  });

  it('returns an empty array for no durations', () => {
    expect(cumulativeBoundaries([])).toEqual([]);
  });
});

describe('extractPlaylistBody', () => {
  it('keeps only #EXTINF and segment-name lines, dropping header/footer tags', () => {
    const playlist = buildIntermediateM3U8([6], true);
    const body = extractPlaylistBody(playlist);
    expect(body).not.toContain('#EXTM3U');
    expect(body).not.toContain('#EXT-X-TARGETDURATION');
    expect(body).not.toContain('#EXT-X-ENDLIST');
    expect(body).toContain('#EXTINF:6.000000,');
    expect(body).toContain('segment_0000.ts');
  });
});

describe('spliceM3U8Texts', () => {
  it('joins several playlists with a discontinuity tag between each', () => {
    const intro = buildIntermediateM3U8([2], true, (i) => `intro_${i}.ts`);
    const main = buildIntermediateM3U8([6, 6], true, (i) => `main_${i}.ts`);
    const spliced = spliceM3U8Texts([intro, main]);
    expect(spliced.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1);
    expect(spliced).toContain('intro_0.ts');
    expect(spliced).toContain('main_0.ts');
    expect(spliced).toContain('main_1.ts');
    expect(spliced.trim().endsWith('#EXT-X-ENDLIST')).toBe(true);
  });

  it('uses the largest TARGETDURATION across the spliced playlists', () => {
    const a = buildIntermediateM3U8([2], true);
    const b = buildIntermediateM3U8([9], true);
    expect(spliceM3U8Texts([a, b])).toContain('#EXT-X-TARGETDURATION:10');
  });

  it('does not add a discontinuity before the first playlist', () => {
    const only = buildIntermediateM3U8([6], true);
    expect(spliceM3U8Texts([only])).not.toContain('#EXT-X-DISCONTINUITY');
  });
});

describe('concatChunks', () => {
  it('concatenates chunk data in order', () => {
    const result = concatChunks([{ data: new Uint8Array([1, 2]) }, { data: new Uint8Array([3, 4, 5]) }]);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns an empty array for no chunks', () => {
    expect(concatChunks([]).length).toBe(0);
  });
});

describe('hasEditedSegments', () => {
  it('is false when there is no segments list at all', () => {
    expect(hasEditedSegments({ segments: undefined, sourceDuration: 30 })).toBe(false);
  });

  it('is false for an empty segments list', () => {
    expect(hasEditedSegments({ segments: [], sourceDuration: 30 })).toBe(false);
  });

  it('is true for more than one segment', () => {
    expect(
      hasEditedSegments({
        segments: [
          { sourceStart: 0, sourceEnd: 15 },
          { sourceStart: 15, sourceEnd: 30 },
        ],
        sourceDuration: 30,
      }),
    ).toBe(true);
  });

  it('is false for a single segment spanning the whole known source duration', () => {
    expect(hasEditedSegments({ segments: [{ sourceStart: 0, sourceEnd: 30 }], sourceDuration: 30 })).toBe(false);
  });

  it('is true for a single trimmed segment', () => {
    expect(hasEditedSegments({ segments: [{ sourceStart: 2, sourceEnd: 30 }], sourceDuration: 30 })).toBe(true);
  });

  it('treats an unknown source duration as conservatively edited', () => {
    expect(hasEditedSegments({ segments: [{ sourceStart: 0, sourceEnd: 30 }], sourceDuration: undefined })).toBe(true);
  });
});
