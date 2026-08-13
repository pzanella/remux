import { test, expect } from './fixtures';
import {
  uploadSource,
  splitTimelineAt,
  addChapter,
  attachSubtitle,
  attachIntro,
  attachOutro,
  attachDubAudio,
  expandExtrasStrip,
  selectRendition,
  enableLoudnessNormalization,
  saveProjectFile,
  loadProjectFile,
  startOver,
  runExport,
  downloadZip,
  listZipEntries,
  readZipEntryText,
} from './helpers';
import { execFileSync } from 'node:child_process';

test('round-trips segments, chapters, a subtitle track, an ABR rendition, and loudness normalization through a saved project', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await splitTimelineAt(page, 0.5);
  await addChapter(page, 'Cold Open');
  await attachSubtitle(page, 'subtitle.vtt');
  await selectRendition(page, '240p');

  // Open the export review screen just far enough to set loudness
  // normalization, then close without starting — the setting is a plain
  // useTranscoder state update, not gated behind actually pressing Start.
  await page.click('.btn-export');
  await page.waitForSelector('button:has-text("Start conversion")');
  await enableLoudnessNormalization(page);
  await page.click('.export-modal-close');

  const projectPath = testInfo.outputPath('project.remuxproj');
  await saveProjectFile(page, projectPath);

  // Verify the downloaded bundle itself, independent of the browser — a
  // real ZIP with the source video and a manifest describing everything
  // just set above.
  const entries = listZipEntries(projectPath);
  expect(entries).toContain('manifest.json');
  expect(entries.some((e) => e.startsWith('source/'))).toBe(true);
  expect(entries.some((e) => e.startsWith('subtitles/'))).toBe(true);
  const manifest = JSON.parse(readZipEntryText(projectPath, 'manifest.json'));
  expect(manifest.segments).toHaveLength(2);
  expect(manifest.chapters).toEqual([{ time: expect.any(Number), title: 'Cold Open' }]);
  expect(manifest.abrHeights).toEqual([240]);
  expect(manifest.loudnessNormalization).toBe(true);

  // Simulate moving to a different session entirely: tear this one down
  // completely, then load the saved bundle back in from scratch.
  await startOver(page);
  await loadProjectFile(page, projectPath);

  // The editor comes back showing the exact same edit.
  await expect(page.locator('.timeline-clip')).toHaveCount(2);
  await expect(page.locator('.chapter-marker')).toHaveCount(1);
  await expect(page.locator('.chapter-marker')).toHaveAttribute('title', /Cold Open/);
  await expect(page.locator('.caption-track-header .extras-item-name')).toHaveText('subtitle');
  await expect(page.locator('.rendition-chips .chip', { hasText: '240p' })).toHaveClass(/active|selected|is-active/);

  const result = await runExport(page, async () => {
    await expect(page.getByLabel('Normalize loudness (EBU R128)')).toBeChecked();
  });
  expect(result).toBe('done');

  const outputZipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, outputZipPath);
  const outputEntries = listZipEntries(outputZipPath);
  expect(outputEntries).toContain('master.m3u8');
  expect(outputEntries).toContain('chapters.vtt');
  expect(outputEntries.some((e) => e.endsWith('.vtt') && e !== 'chapters.vtt')).toBe(true);
  const master = readZipEntryText(outputZipPath, 'master.m3u8');
  expect(master).toContain('TYPE=SUBTITLES');
  expect(master).toContain('240');
});

test('round-trips intro and outro clips through a saved project', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await attachIntro(page, 'intro.mp4');
  await attachOutro(page, 'outro.mp4');

  const projectPath = testInfo.outputPath('project.remuxproj');
  await saveProjectFile(page, projectPath);

  const manifest = JSON.parse(execFileSync('unzip', ['-p', projectPath, 'manifest.json'], { encoding: 'utf-8' }));
  expect(manifest.intro.fileName).toBe('intro.mp4');
  expect(manifest.outro.fileName).toBe('outro.mp4');

  await startOver(page);
  await loadProjectFile(page, projectPath);

  await expect(page.locator('.timeline-extra-card--intro')).toContainText('intro.mp4');
  await expect(page.locator('.timeline-extra-card--outro')).toContainText('outro.mp4');

  const result = await runExport(page);
  expect(result).toBe('done');

  const outputZipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, outputZipPath);
  const outputEntries = listZipEntries(outputZipPath);
  const segmentCount = outputEntries.filter((e) => e.endsWith('.ts')).length;
  expect(segmentCount).toBeGreaterThan(1); // intro + main + outro, spliced

  const playlist = readZipEntryText(outputZipPath, 'index.m3u8');
  expect(playlist).toContain('#EXT-X-ENDLIST');
});

test('round-trips a dub-audio track and a chapter through a saved project', async ({ page }, testInfo) => {
  // Dub-audio isn't supported together with intro/outro or edited segments
  // (see remux.worker.ts's own guards) — a separate, deliberately smaller
  // project than the intro/outro one above, not a gap in coverage.
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await attachDubAudio(page, 'dub-audio.m4a');
  await addChapter(page, 'Cold Open');

  const projectPath = testInfo.outputPath('project.remuxproj');
  await saveProjectFile(page, projectPath);

  const manifest = JSON.parse(execFileSync('unzip', ['-p', projectPath, 'manifest.json'], { encoding: 'utf-8' }));
  expect(manifest.dubAudioTracks).toHaveLength(1);
  expect(manifest.chapters).toEqual([{ time: expect.any(Number), title: 'Cold Open' }]);

  await startOver(page);
  await loadProjectFile(page, projectPath);
  await expandExtrasStrip(page);

  await expect(page.locator('.extras-item-name', { hasText: 'dub-audio' })).toBeVisible();
  await expect(page.locator('.chapter-marker')).toHaveCount(1);

  const result = await runExport(page);
  expect(result).toBe('done');

  const outputZipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, outputZipPath);
  const outputEntries = listZipEntries(outputZipPath);
  expect(outputEntries).toContain('chapters.vtt');
  const master = readZipEntryText(outputZipPath, 'master.m3u8');
  expect(master).toContain('TYPE=AUDIO');
});
