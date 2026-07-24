/**
 * Client-side thumbnail and waveform generation for the timeline — both
 * read straight from the in-memory File the user picked, no OPFS or worker
 * involved. Neither is meant to be exhaustive/frame-accurate; they exist to
 * make timeline clips visually identifiable, the same job scrubber
 * thumbnails and waveforms do in any real editor.
 */

/** Above this size, skip waveform decoding rather than pull the whole file
 * into an AudioBuffer — decodeAudioData holds the full decoded PCM in
 * memory at once, which stops scaling gracefully long before Remux's own
 * segment-at-a-time pipeline would notice a large file. */
const WAVEFORM_MAX_BYTES = 150 * 1024 * 1024;

export async function generateThumbnails(file: File, count: number): Promise<string[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Could not load video for thumbnails'));
    });

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return [];

    const aspect = video.videoWidth > 0 ? video.videoHeight / video.videoWidth : 9 / 16;
    const w = 96;
    const h = Math.max(1, Math.round(w * aspect));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];

    const thumbs: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = (duration * (i + 0.5)) / count;
      await new Promise<void>((resolve) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = Math.min(t, Math.max(0, duration - 0.05));
      });
      ctx.drawImage(video, 0, 0, w, h);
      thumbs.push(canvas.toDataURL('image/jpeg', 0.55));
    }
    return thumbs;
  } catch {
    return [];
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function generateWaveformPeaks(file: File, samples: number): Promise<number[]> {
  if (file.size > WAVEFORM_MAX_BYTES) return [];

  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return [];

  const audioCtx = new AudioContextCtor();
  try {
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(channelData.length / samples));

    const peaks: number[] = [];
    for (let i = 0; i < samples; i++) {
      let max = 0;
      const start = i * blockSize;
      const end = Math.min(start + blockSize, channelData.length);
      for (let j = start; j < end; j++) {
        const v = Math.abs(channelData[j]);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    return peaks;
  } catch {
    return [];
  } finally {
    void audioCtx.close();
  }
}
