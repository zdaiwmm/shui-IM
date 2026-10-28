import { uiLiteral, uiTemplate, t } from './language';
import {uiNotice} from './ui-notice';
import { animatePageReplacement } from './motion';
import { createElement, ArrowLeft, Smile, Image, ChevronRight, Check, Minus, Plus } from 'lucide';
import { mountDialog } from './dialog';
import { fitViewport } from './space-drawer';
import { bindHalfSheetHandle } from './half-sheet';
import { avatarEmoji, avatarBackgrounds, defaultSpaceAvatar, spaceAvatarMarkup, bindSpaceAvatarPlayback, MAX_AVATAR_IMAGE_BYTES, type SpaceAvatar, type SpaceProfile } from './space-avatar';
import { bindAvatarCrop, neutralCrop, type AvatarCrop } from './avatar-crop';
const icon = (value: Parameters<typeof createElement>[0]) => createElement(value).outerHTML;
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** All editing is ephemeral until the caller successfully creates a space. */
export function createSpaceProfile(root: HTMLElement, options: {
  initialProfile?: SpaceProfile; avatarOnly?: boolean; saveAvatar?: (avatar: SpaceAvatar) => Promise<void>;
  signal: AbortSignal; active: () => boolean; hasCredential: boolean; submitted?: (source: HTMLElement) => void;
  picker: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<SpaceProfile | null> {
  return new Promise(resolve => {
    const lifetime = new AbortController(), signal = AbortSignal.any([options.signal, lifetime.signal]);
    const overlay = document.createElement('div'); overlay.className = 'space-profile-overlay';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', options.avatarOnly ? uiLiteral('修改密室头像') : uiLiteral('创建密室'));
    let sourceChosen = false;
    let name = options.initialProfile?.name ?? '', avatar = options.initialProfile?.avatar ?? defaultSpaceAvatar(), result: SpaceProfile | null = null;
    let pageLifetime = new AbortController();
    const urls = new Set<string>();
    const active = () => !signal.aborted && options.active() && root.isConnected;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true; pageLifetime.abort(); lifetime.abort();
      urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); resolve(result);
    };
    let dialog: ReturnType<typeof mountDialog> | null = null;
    const close = () => dialog ? dialog.close() : finish();
    signal.addEventListener('abort', finish, { once: true });
    const mountEditor = () => {
      if (dialog) return;
      root.append(overlay);
      dialog = mountDialog(overlay, { signal, isActive: active, onClose: finish });
      fitViewport(overlay, signal);
    };
    const page = (title: string, body: string, action: string, back: () => void, cancel = false) => {
      const previous = overlay.querySelector<HTMLElement>(':scope > .space-profile-page');
      pageLifetime.abort(); pageLifetime = new AbortController();
      const pageSignal = AbortSignal.any([signal, pageLifetime.signal]);
      overlay.innerHTML = `<section class="space-profile-page"><header class="space-profile-header"><button class="icon-button" id="profile-back" type="button" aria-label="${cancel ? uiLiteral('取消编辑头像') : uiLiteral('返回')}">${icon(ArrowLeft)}</button><h2>${title}</h2><span></span></header><div class="space-profile-scroll"><div class="space-profile-content">${body}<p class="form-error" role="alert"></p></div></div><footer class="space-profile-footer"><button class="primary-button" id="profile-done" type="button">${action}</button></footer></section>`;
      mountEditor();
      animatePageReplacement(overlay, previous, overlay.querySelector<HTMLElement>(':scope > .space-profile-page')!, title === uiLiteral('创建密室'), signal);
      overlay.querySelector('#profile-back')!.addEventListener('click', back, { signal: pageSignal });
      overlay.querySelector<HTMLElement>('#profile-back')!.focus({ preventScroll: true });
      return { signal: pageSignal, playback: bindSpaceAvatarPlayback(overlay, pageSignal) };
    };
    const finishAvatar = async (value: SpaceAvatar) => {
      if (!active()) return;
      if (!options.avatarOnly) { avatar = value; details(); return; }
      const controls = overlay.querySelectorAll<HTMLButtonElement>('button'); controls.forEach(b => b.disabled = true);
      try { await options.saveAvatar?.(value); if (!active()) return; result = { name, avatar: value }; dialog!.close({ animate: false, restoreFocus: false }); }
      catch (cause) { if (active()) uiNotice(root,cause instanceof Error ? t(cause.message) : uiLiteral('头像未能保存，请重试')); }
      finally { controls.forEach(b => b.disabled = false); }
    };
    const details = () => {
      const view = page(options.avatarOnly ? uiLiteral('修改密室头像') : uiLiteral('创建密室'), uiTemplate`<div class="space-profile-identity"><div id="space-profile-avatar">${spaceAvatarMarkup(avatar)}</div><button class="text-button" id="change-space-avatar" type="button">更改头像</button></div><form id="create-space-profile" novalidate><label class="space-profile-label" for="new-space-name">密室名称</label><input id="new-space-name" name="name" maxlength="40" value="${escape(name)}" autocomplete="off" placeholder="给这个密室起个名字" aria-describedby="space-profile-hint"><p class="field-hint" id="space-profile-hint">头像和名称仅自己这一侧可见。</p></form>`, options.hasCredential ? uiLiteral('创建密室') : uiLiteral('下一步'), () => dialog!.close());
      if (options.avatarOnly) {
        overlay.querySelector('#create-space-profile')!.remove();
        overlay.querySelector('#profile-done')!.textContent = uiLiteral('选择头像');
        overlay.querySelector('#profile-done')!.addEventListener('click', () => sources(), { signal: view.signal });
        overlay.querySelector('#change-space-avatar')!.addEventListener('click', () => sources(), { signal: view.signal });
        return;
      }
      const input = overlay.querySelector<HTMLInputElement>('#new-space-name')!;
      input.addEventListener('input', () => { name = input.value; input.removeAttribute('aria-invalid'); overlay.querySelector('.form-error')!.textContent = '';  }, { signal: view.signal });
      overlay.querySelector('#change-space-avatar')!.addEventListener('click', () => sources(), { signal: view.signal });
      const submit = () => {
        if (!active()) return;
        name = input.value.trim();
        if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) { uiNotice(root,uiLiteral('请输入 1–40 个字符的密室名称')); input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
        result = { name, avatar }; options.submitted?.(overlay); dialog!.close({ animate: false, restoreFocus: false });
      };
      overlay.querySelector('#profile-done')!.addEventListener('click', submit, { signal: view.signal });
      overlay.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); submit(); }, { signal: view.signal });
    };
    const sources = (error = '') => {
      sourceChosen = false;
      const sheetLifetime = new AbortController(), sheetSignal = AbortSignal.any([signal, sheetLifetime.signal]);
      const sheet = document.createElement('div'); sheet.className = 'avatar-source-overlay';
      sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', uiLiteral('更改头像'));
      sheet.innerHTML = uiTemplate`<section class="avatar-source-sheet"><button class="half-sheet-handle" type="button" aria-label="关闭头像选项"><span></span></button><div class="avatar-source-options"><button id="choose-art" type="button">${icon(Smile)}<span>使用表情<small>选择动态表情和背景色</small></span>${icon(ChevronRight)}</button><button id="choose-photo" type="button">${icon(Image)}<span>使用图片<small>从相册选取并裁剪</small></span>${icon(ChevronRight)}</button></div><p class="form-error" role="alert">${escape(error)}</p></section>`;
      root.append(sheet);
      const chooser = mountDialog(sheet, { signal: sheetSignal, isActive: active, onClose: () => { sheetLifetime.abort(); if (options.avatarOnly && !sourceChosen && active()) close(); } });
      bindHalfSheetHandle(sheet.querySelector<HTMLButtonElement>('.half-sheet-handle')!, sheet.firstElementChild as HTMLElement, sheetSignal, () => chooser.close());
      sheet.addEventListener('click', event => { if (event.target === sheet) chooser.close(); }, { signal: sheetSignal });
      sheet.querySelector('#choose-art')!.addEventListener('click', () => { sourceChosen = true; chooser.close({ animate: false, restoreFocus: false }); art(); }, { signal: sheetSignal });
      const photoButton = sheet.querySelector<HTMLButtonElement>('#choose-photo')!;
      let picking = false;
      photoButton.addEventListener('click', () => {
        if (picking) return;
        picking = true; photoButton.disabled = true;
        // The picker must be invoked in this trusted source-button click stack.
        void options.picker(pickImage).then(async file => {
          if (!file || !active() || sheetSignal.aborted) return;
          // Decode/validate before retiring the source: cancel and errors keep this same sheet.
          await photo(file, () => {
            if (sheetSignal.aborted || !active()) return false;
            sourceChosen = true; chooser.close({ animate: false, restoreFocus: false }); return true;
          });
        }).catch(cause => {
          if (active() && !sheetSignal.aborted) uiNotice(root,cause instanceof Error ? t(cause.message) : uiLiteral('图片未能打开，请重试'));
        }).finally(() => { picking = false; if (!sheetSignal.aborted) photoButton.disabled = false; });
      }, { signal: sheetSignal });
    };
    const art = () => {
      let draft: SpaceAvatar = avatar.kind === 'emoji' ? { ...avatar } : defaultSpaceAvatar();
      const view = page(uiLiteral('设置头像'), uiTemplate`<div class="avatar-editor-preview" id="avatar-preview">${spaceAvatarMarkup(draft)}</div><h3>背景</h3><div class="avatar-backgrounds" role="group" aria-label="头像背景">${avatarBackgrounds.map((colors, index) => `<button type="button" data-background="${index}" aria-label="${uiLiteral(colors[0])}" aria-pressed="${index === (draft.kind === 'emoji' ? draft.background : 0)}" style="--avatar-start:${colors[1]};--avatar-end:${colors[2]}"><span>${icon(Check)}</span></button>`).join('')}</div><h3>表情</h3><div class="avatar-emoji-grid" role="group" aria-label="动态头像表情">${avatarEmoji.map(item => `<button type="button" data-avatar-choice="${item.id}" aria-label="${escape(item.emoji + ' ' + item.label)}" aria-pressed="${draft.kind === 'emoji' && draft.emoji === item.id}"><span class="space-avatar" aria-hidden="true"><img data-avatar-emoji="${item.id}" src="/space-avatars/${item.id}-still.webp" alt="" draggable="false"></span></button>`).join('')}</div><p class="avatar-credit">动画：Microsoft Fluent Emoji · MIT</p>`, uiLiteral('设置为头像'), options.avatarOnly ? close : details, true);
      const paint = () => {
        if (!active()) return;
        overlay.querySelector('#avatar-preview')!.innerHTML = spaceAvatarMarkup(draft);
        overlay.querySelectorAll<HTMLButtonElement>('[data-background]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.background) === (draft.kind === 'emoji' ? draft.background : 0))));
        overlay.querySelectorAll<HTMLButtonElement>('[data-avatar-choice]').forEach(button => button.setAttribute('aria-pressed', String(draft.kind === 'emoji' && button.dataset.avatarChoice === draft.emoji)));
        view.playback();
      };
      overlay.querySelectorAll<HTMLButtonElement>('[data-background]').forEach(button => button.addEventListener('click', () => { if (draft.kind === 'emoji') draft.background = Number(button.dataset.background); paint(); }, { signal: view.signal }));
      overlay.querySelectorAll<HTMLButtonElement>('[data-avatar-choice]').forEach(button => button.addEventListener('click', () => { if (draft.kind === 'emoji') draft.emoji = button.dataset.avatarChoice!; paint(); }, { signal: view.signal }));
      overlay.querySelector('#profile-done')!.addEventListener('click', () => { void finishAvatar(draft); }, { signal: view.signal });
    };
    const pickImage = (): Promise<File | null> => new Promise((finish, reject) => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp'; input.hidden = true; root.append(input);
      let settled = false;
      const done = (value: File | null, failure?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); input.remove();
        if (failure) reject(failure); else finish(value);
      };
      const abort = () => done(null);
      const timer = window.setTimeout(() => done(null, new Error(uiLiteral('选图已超时，请重试'))), 60_000);
      signal.addEventListener('abort', abort, { once: true });
      input.addEventListener('cancel', () => done(null), { once: true });
      input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
      input.click();
    });
    const photo = async (file: File, ready: () => boolean) => {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024 || !file.size) throw new Error(uiLiteral('请选择 5 MB 以内的 JPG、PNG 或 WebP 图片'));
      const url = URL.createObjectURL(file); urls.add(url);
      const image = new window.Image(); image.src = url;
      try { await image.decode(); } catch { URL.revokeObjectURL(url); urls.delete(url); throw new Error(uiLiteral('图片无法读取，请重新选择')); }
      if (!active()) { URL.revokeObjectURL(url); urls.delete(url); image.removeAttribute('src'); return; }
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) { URL.revokeObjectURL(url); urls.delete(url); throw new Error(uiLiteral('图片尺寸过大，请选择 4000 万像素以内的图片')); }
      const ratio = image.naturalWidth / image.naturalHeight;
      if (!ready()) { URL.revokeObjectURL(url); urls.delete(url); image.removeAttribute('src'); return; }
      const view = page(uiLiteral('裁剪图片'), uiTemplate`<div class="avatar-crop-stage" id="photo-crop-stage" tabindex="0" role="group" aria-label="头像裁剪区域，拖动移动，双指缩放，方向键移动，加减号缩放"><img src="${url}" alt="" draggable="false" style="width:${Math.max(1, ratio) * 100}%;height:${Math.max(1, 1 / ratio) * 100}%"></div><p class="avatar-crop-hint">单指拖动调整位置，双指缩放。</p><div class="avatar-crop-controls"><button class="icon-button" id="crop-minus" type="button" aria-label="缩小图片">${icon(Minus)}</button><output id="crop-zoom" aria-live="off">100%</output><button class="icon-button" id="crop-plus" type="button" aria-label="放大图片">${icon(Plus)}</button><button class="text-button" id="crop-reset" type="button">重置</button></div>`, uiLiteral('设置为头像'), () => { URL.revokeObjectURL(url); urls.delete(url); if (options.avatarOnly) dialog!.close(); else details(); }, true);
      const stage = overlay.querySelector<HTMLElement>('#photo-crop-stage')!, target = stage.querySelector<HTMLImageElement>('img')!;
      view.signal.addEventListener('abort', () => { URL.revokeObjectURL(url); urls.delete(url); image.removeAttribute('src'); }, { once: true });
      let current = neutralCrop();
      const paint = (crop: AvatarCrop) => {
        current = crop;
        target.style.transform = `translate(-50%,-50%) translate(${crop.x * stage.clientWidth}px,${crop.y * stage.clientWidth}px) scale(${crop.zoom})`;
        overlay.querySelector('#crop-zoom')!.textContent = `${Math.round(crop.zoom * 100)}%`;
      };
      const gesture = bindAvatarCrop(stage, ratio, view.signal, paint);
      paint(current);
      const size = new ResizeObserver(() => paint(current)); size.observe(stage); view.signal.addEventListener('abort', () => size.disconnect(), { once: true });
      overlay.querySelector('#crop-minus')!.addEventListener('click', () => gesture.zoom(-.2), { signal: view.signal });
      overlay.querySelector('#crop-plus')!.addEventListener('click', () => gesture.zoom(.2), { signal: view.signal });
      overlay.querySelector('#crop-reset')!.addEventListener('click', gesture.reset, { signal: view.signal });
      overlay.querySelector('#profile-done')!.addEventListener('click', () => {
        if (!active()) return;
        try {
          avatar = { v: 1, kind: 'image', data: cropAvatarImage(image, gesture.value()) };
          // The crop stays available for retry if persistence fails; page teardown releases it.
          void finishAvatar(avatar);
        } catch (cause) { uiNotice(root,(cause as Error).message); }
      }, { signal: view.signal });
    };
    if (options.avatarOnly) sources(); else details();
  });
}

/** A tiny derived thumbnail fits the participant catalog; originals/EXIF never persist. */
export function cropAvatarImage(image: HTMLImageElement, crop: AvatarCrop): string {
  for (const edge of [128, 96, 80, 64]) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = edge;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, edge, edge);
    const scale = edge / Math.min(image.naturalWidth, image.naturalHeight) * crop.zoom;
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    context.drawImage(image, (edge - width) / 2 + crop.x * edge, (edge - height) / 2 + crop.y * edge, width, height);
    for (const quality of [.86, .7, .5, .3]) {
      const data = canvas.toDataURL('image/jpeg', quality);
      const bytes = (data.length - 23) * 3 / 4;
      if (bytes <= MAX_AVATAR_IMAGE_BYTES) { canvas.width = canvas.height = 0; return data; }
    }
    canvas.width = canvas.height = 0;
  }
  throw new Error(uiLiteral('图片未能生成头像，请重新选择'));
}
