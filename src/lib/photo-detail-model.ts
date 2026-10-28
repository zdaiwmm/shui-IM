import { uiLiteral, uiTemplate, currentLanguage } from './language';
import type { ImageManifest } from './types';

export type PhotoTags = Record<string, unknown>;
export type PhotoMetadata = { tags: PhotoTags; unavailable: boolean };
export const PHOTO_TAGS = [
  'DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'OffsetTimeDigitized', 'GPSLatitude', 'GPSLatitudeRef',
  'GPSLongitude', 'GPSLongitudeRef', 'GPSAltitude', 'GPSAltitudeRef', 'Make', 'Model', 'LensMake', 'LensModel',
  'FNumber', 'ExposureTime', 'ISO', 'FocalLength', 'FocalLengthIn35mmFormat', 'ExposureCompensation',
  'ExposureProgram', 'MeteringMode', 'WhiteBalance', 'Flash', 'Orientation', 'ColorSpace', 'ExifImageWidth',
  'ExifImageHeight', 'ImageWidth', 'ImageHeight', 'ImageDescription', 'Artist', 'Copyright', 'Software',
  'XResolution', 'YResolution', 'ResolutionUnit', 'BitsPerSample', 'width', 'height', 'bitDepth',
];

export function boundedPhotoTags(input: unknown): PhotoTags {
  const result: PhotoTags = {};
  if (!input || typeof input !== 'object') return result;
  for (const key of PHOTO_TAGS) {
    if (!Object.hasOwn(input, key)) continue;
    const value = (input as PhotoTags)[key];
    if (typeof value === 'string') result[key] = value.slice(0, 512);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (Array.isArray(value) && value.length <= 8 && value.every(item => typeof item === 'number' && Number.isFinite(item))) result[key] = value;
  }
  return result;
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim()
  ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 512) : undefined;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const decimal = (value: number) => new Intl.NumberFormat(currentLanguage(), { maximumFractionDigits: 3 }).format(value);
export type PhotoDetailGroup = { title: string; rows: { label: string; value: string }[] };

export function photoDetailGroups(manifest: ImageManifest, sentAt: string | undefined, tags: PhotoTags, dimensions?: { width: number; height: number }): PhotoDetailGroup[] {
  const missing = uiLiteral('未记录');
  const localTime = (value: number | string | undefined) => {
    if (!value) return missing;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(currentLanguage(), {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(date) : missing;
  };
  const captureTime = (value: unknown, offset: unknown) => {
    const raw = text(value);
    const match = raw?.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
    if (!match) return undefined;
    const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}Z`);
    if (!Number.isFinite(date.getTime()) || date.getUTCMonth() + 1 !== Number(match[2]) || date.getUTCDate() !== Number(match[3])) return undefined;
    const zone = text(offset);
    return uiTemplate`${match[1]}年${match[2]}月${match[3]}日 ${match[4]}${zone && /^[+-]\d{2}:\d{2}$/.test(zone) ? ` ${zone}` : ''}`;
  };
  const row = (label: string, value: string | undefined) => ({ label, value: value || missing });
  const coordinate = (key: string, ref: string, max: number) => {
    const raw = tags[key];
    if (!Array.isArray(raw) || raw.length !== 3 || !raw.every(v => number(v) !== undefined && v >= 0) || raw[1] >= 60 || raw[2] >= 60) return undefined;
    const value = raw[0] + raw[1] / 60 + raw[2] / 3600;
    const direction = text(tags[ref]);
    return value <= max && direction && (max === 90 ? /^[NS]$/ : /^[EW]$/).test(direction)
      ? `${value.toFixed(5)}° ${direction}` : undefined;
  };
  const latitude = coordinate('GPSLatitude', 'GPSLatitudeRef', 90);
  const longitude = coordinate('GPSLongitude', 'GPSLongitudeRef', 180);
  const width = number(tags.ExifImageWidth) ?? number(tags.ImageWidth) ?? number(tags.width) ?? dimensions?.width;
  const height = number(tags.ExifImageHeight) ?? number(tags.ImageHeight) ?? number(tags.height) ?? dimensions?.height;
  const bytes = manifest.originalSize;
  const mime = text(manifest.mimeType) ?? uiLiteral('未知格式');
  const basics = [
    row(uiLiteral('拍摄时间'), captureTime(tags.DateTimeOriginal, tags.OffsetTimeOriginal)),
    row(uiLiteral('拍摄地点'), latitude && longitude ? `${latitude}, ${longitude}` : undefined),
    row(uiLiteral('格式 / 大小'), `${mime.replace(/^image\//, '').toUpperCase()} · ${bytes >= 1048576 ? `${decimal(bytes / 1048576)} MiB` : `${decimal(bytes / 1024)} KiB`}`),
    row(uiLiteral('像素尺寸'), width && height ? uiTemplate`${width} × ${height} · ${decimal(width * height / 1_000_000)} 百万像素` : undefined),
  ];
  const camera: PhotoDetailGroup['rows'] = [];
  const add = (label: string, value: string | undefined) => { if (value) camera.push(row(label, value)); };
  add(uiLiteral('相机'), [text(tags.Make), text(tags.Model)].filter(Boolean).join(' '));
  add(uiLiteral('镜头'), [text(tags.LensMake), text(tags.LensModel)].filter(Boolean).join(' '));
  const units = [[uiLiteral('光圈'), 'FNumber', 'ƒ/'], [uiLiteral('感光度'), 'ISO', 'ISO '], [uiLiteral('焦距'), 'FocalLength', ''], [uiLiteral('等效焦距'), 'FocalLengthIn35mmFormat', '']] as const;
  for (const [label, key, prefix] of units) {
    const value = number(tags[key]);
    if (value !== undefined && value > 0) add(label, `${prefix}${decimal(value)}${key.startsWith('Focal') ? ' mm' : ''}`);
  }
  const exposure = number(tags.ExposureTime);
  if (exposure !== undefined && exposure > 0) add(uiLiteral('快门'), exposure < 1 ? uiTemplate`1/${decimal(1 / exposure)} 秒` : uiTemplate`${decimal(exposure)} 秒`);
  const compensation = number(tags.ExposureCompensation);
  if (compensation !== undefined) add(uiLiteral('曝光补偿'), `${decimal(compensation)} EV`);
  const flash = number(tags.Flash);
  if (flash !== undefined) add(uiLiteral('闪光灯'), flash & 1 ? uiLiteral('已闪光') : uiLiteral('未闪光'));
  const white = number(tags.WhiteBalance);
  if (white === 0 || white === 1) add(uiLiteral('白平衡'), white === 0 ? uiLiteral('自动') : uiLiteral('手动'));
  const program = number(tags.ExposureProgram);
  if (program !== undefined) add(uiLiteral('曝光程序'), [uiLiteral('未定义'), uiLiteral('手动'), uiLiteral('程序自动'), uiLiteral('光圈优先'), uiLiteral('快门优先'), uiLiteral('创意程序'), uiLiteral('运动程序'), uiLiteral('人像'), uiLiteral('风景')][program]);
  const metering = number(tags.MeteringMode);
  if (metering !== undefined) add(uiLiteral('测光模式'), ({ 0: uiLiteral('未知'), 1: uiLiteral('平均'), 2: uiLiteral('中央重点'), 3: uiLiteral('点测光'), 4: uiLiteral('多点'), 5: uiLiteral('分区'), 6: uiLiteral('局部'), 255: uiLiteral('其他') } as Record<number, string>)[metering]);
  const orientation = number(tags.Orientation);
  const orientations = [uiLiteral('正常'), uiLiteral('水平镜像'), uiLiteral('旋转 180°'), uiLiteral('垂直镜像'), uiLiteral('转置'), uiLiteral('顺时针 90°'), uiLiteral('横向转置'), uiLiteral('逆时针 90°')];
  if (orientation !== undefined) add(uiLiteral('方向'), orientations[orientation - 1]);
  const color = number(tags.ColorSpace);
  if (color !== undefined) add(uiLiteral('色彩密室'), color === 1 ? 'sRGB' : color === 65535 ? uiLiteral('未校准') : String(color));
  const altitude = number(tags.GPSAltitude);
  if (altitude !== undefined) add(uiLiteral('海拔'), `${decimal(tags.GPSAltitudeRef === 1 ? -altitude : altitude)} m`);
  const depth = number(tags.bitDepth);
  if (depth !== undefined) add(uiLiteral('位深'), `${depth} bit`);
  if (Array.isArray(tags.BitsPerSample) && tags.BitsPerSample.every(v => number(v) !== undefined && v > 0 && v <= 64)) add(uiLiteral('通道位深'), `${tags.BitsPerSample.slice(0, 8).join(' / ')} bit`);
  const resolution = number(tags.XResolution);
  if (resolution !== undefined) add(uiLiteral('水平分辨率'), `${decimal(resolution)}${tags.ResolutionUnit === 2 ? ' dpi' : tags.ResolutionUnit === 3 ? uiLiteral(' 点/厘米') : ''}`);
  const vertical = number(tags.YResolution);
  if (vertical !== undefined) add(uiLiteral('垂直分辨率'), `${decimal(vertical)}${tags.ResolutionUnit === 2 ? ' dpi' : tags.ResolutionUnit === 3 ? uiLiteral(' 点/厘米') : ''}`);
  for (const [label, key] of [[uiLiteral('描述'), 'ImageDescription'], [uiLiteral('作者'), 'Artist'], [uiLiteral('版权'), 'Copyright'], [uiLiteral('处理软件'), 'Software']] as const) add(label, text(tags[key]));
  return [
    { title: uiLiteral('基本信息'), rows: basics },
    ...(camera.length ? [{ title: uiLiteral('拍摄与其他属性'), rows: camera }] : []),
    { title: uiLiteral('文件信息'), rows: [row(uiLiteral('文件名'), text(manifest.originalName)), row(uiLiteral('MIME 类型'), mime),
      row(uiLiteral('图像创建时间'), captureTime(tags.CreateDate, tags.OffsetTimeDigitized)),
      row(uiLiteral('上传 / 发送时间'), localTime(sentAt)), row(uiLiteral('文件修改时间'), localTime(manifest.lastModified))] },
  ];
}
