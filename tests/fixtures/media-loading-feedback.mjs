import assert from 'node:assert/strict';

export async function verifyMediaLoadingFeedback(page) {
  const result = await page.evaluate(async () => {
    const { app } = mediaFixture;
    const { setLanguage } = await import('/src/lib/language.ts');
    const { retireMediaCapsule } = await import('/src/lib/media-capsule.ts');
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const cases = [];
    const root = document.querySelector('#app');
    for (const language of ['zh-Hans', 'en', 'de', 'ar']) {
      await setLanguage(language, false);
      for (const video of [false, true]) {
        const button = document.createElement('button'); button.className = 'image-preview';
        button.style.cssText = 'position:fixed;left:20px;top:100px;width:288px;height:200px';
        button.dataset.imageState = 'loading'; root.append(button);
        app.mountChatImageLoadingFeedback(button, video);
        const capsule = button.querySelector('.media-load-capsule');
        const initial = capsule.getBoundingClientRect();
        const widths = [], heights = [];
        for (const status of [{stage:'queued'}, {stage:'download'}, {stage:'download',ratio:.01},
          {stage:'download',ratio:.99}, {stage:'decrypt',ratio:1}, {stage:'decode'}]) {
          app.renderChatImageLoadFeedback(button, video, status);
          if (button.dataset.loadStage !== status.stage) throw Error('A retired stage blocked the latest status');
          await frame();
          const box = capsule.getBoundingClientRect(); widths.push(box.width); heights.push(box.height);
          if (capsule.querySelector('.media-capsule-retiring') || capsule.getAnimations().length) throw Error('Loading shell must not queue/fade/scale stages');
        }
        if (widths.some(w=>Math.abs(w-initial.width)>.1) || heights.some(h=>Math.abs(h-24)>.1)) throw Error(`Unstable loading slot: ${language}/${video} ${widths}/${heights}`);
        // Completion must cancel even a just-painted stage in the same task.
        retireMediaCapsule(capsule, app.runtimeAbort.signal);
        if (button.querySelector('.media-load-capsule')) throw Error('Completed work still displays a progress stage');
        cases.push({language,video,width:initial.width}); button.remove();
      }
      const widths = cases.filter(c=>c.language===language).map(c=>c.width);
      if (widths[0]!==widths[1]) throw Error('Image and video must use the same slot');
    }
    await setLanguage('zh-Hans', false);
    return cases.length;
  });
  assert.equal(result, 8);
  console.log('Central media capsule: fixed image/video geometry, 4 languages, immediate latest stage and completion passed');
}
