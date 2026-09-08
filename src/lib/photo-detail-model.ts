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
const decimal = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(value);
export type PhotoDetailGroup = { title: string; rows: { label: string; value: string }[] };

export function photoDetailGroups(manifest: ImageManifest, sentAt: string | undefined, tags: PhotoTags, dimensions?: { width: number; height: number }): PhotoDetailGroup[] {
  const missing = '未记录';
  const localTime = (value: number | string | undefined) => {
    if (!value) return missing;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', {
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
    return `${match[1]}年${match[2]}月${match[3]}日 ${match[4]}${zone && /^[+-]\d{2}:\d{2}$/.test(zone) ? ` ${zone}` : ''}`;
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
  const mime = text(manifest.mimeType) ?? '未知格式';
  const basics = [
    row('拍摄时间', captureTime(tags.DateTimeOriginal, tags.OffsetTimeOriginal)),
    row('拍摄地点', latitude && longitude ? `${latitude}, ${longitude}` : undefined),
    row('格式 / 大小', `${mime.replace(/^image\//, '').toUpperCase()} · ${bytes >= 1048576 ? `${decimal(bytes / 1048576)} MiB` : `${decimal(bytes / 1024)} KiB`}`),
    row('像素尺寸', width && height ? `${width} × ${height} · ${decimal(width * height / 1_000_000)} 百万像素` : undefined),
  ];
  const camera: PhotoDetailGroup['rows'] = [];
  const add = (label: string, value: string | undefined) => { if (value) camera.push(row(label, value)); };
  add('相机', [text(tags.Make), text(tags.Model)].filter(Boolean).join(' '));
  add('镜头', [text(tags.LensMake), text(tags.LensModel)].filter(Boolean).join(' '));
  const units = [['光圈', 'FNumber', 'ƒ/'], ['感光度', 'ISO', 'ISO '], ['焦距', 'FocalLength', ''], ['等效焦距', 'FocalLengthIn35mmFormat', '']] as const;
  for (const [label, key, prefix] of units) {
    const value = number(tags[key]);
    if (value !== undefined && value > 0) add(label, `${prefix}${decimal(value)}${key.startsWith('Focal') ? ' mm' : ''}`);
  }
  const exposure = number(tags.ExposureTime);
  if (exposure !== undefined && exposure > 0) add('快门', exposure < 1 ? `1/${decimal(1 / exposure)} 秒` : `${decimal(exposure)} 秒`);
  const compensation = number(tags.ExposureCompensation);
  if (compensation !== undefined) add('曝光补偿', `${decimal(compensation)} EV`);
  const flash = number(tags.Flash);
  if (flash !== undefined) add('闪光灯', flash & 1 ? '已闪光' : '未闪光');
  const white = number(tags.WhiteBalance);
  if (white === 0 || white === 1) add('白平衡', white === 0 ? '自动' : '手动');
  const program = number(tags.ExposureProgram);
  if (program !== undefined) add('曝光程序', ['未定义', '手动', '程序自动', '光圈优先', '快门优先', '创意程序', '运动程序', '人像', '风景'][program]);
  const metering = number(tags.MeteringMode);
  if (metering !== undefined) add('测光模式', ({ 0: '未知', 1: '平均', 2: '中央重点', 3: '点测光', 4: '多点', 5: '分区', 6: '局部', 255: '其他' } as Record<number, string>)[metering]);
  const orientation = number(tags.Orientation);
  const orientations = ['正常', '水平镜像', '旋转 180°', '垂直镜像', '转置', '顺时针 90°', '横向转置', '逆时针 90°'];
  if (orientation !== undefined) add('方向', orientations[orientation - 1]);
  const color = number(tags.ColorSpace);
  if (color !== undefined) add('色彩空间', color === 1 ? 'sRGB' : color === 65535 ? '未校准' : String(color));
  const altitude = number(tags.GPSAltitude);
  if (altitude !== undefined) add('海拔', `${decimal(tags.GPSAltitudeRef === 1 ? -altitude : altitude)} m`);
  const depth = number(tags.bitDepth);
  if (depth !== undefined) add('位深', `${depth} bit`);
  if (Array.isArray(tags.BitsPerSample) && tags.BitsPerSample.every(v => number(v) !== undefined && v > 0 && v <= 64)) add('通道位深', `${tags.BitsPerSample.slice(0, 8).join(' / ')} bit`);
  const resolution = number(tags.XResolution);
  if (resolution !== undefined) add('水平分辨率', `${decimal(resolution)}${tags.ResolutionUnit === 2 ? ' dpi' : tags.ResolutionUnit === 3 ? ' 点/厘米' : ''}`);
  const vertical = number(tags.YResolution);
  if (vertical !== undefined) add('垂直分辨率', `${decimal(vertical)}${tags.ResolutionUnit === 2 ? ' dpi' : tags.ResolutionUnit === 3 ? ' 点/厘米' : ''}`);
  for (const [label, key] of [['描述', 'ImageDescription'], ['作者', 'Artist'], ['版权', 'Copyright'], ['处理软件', 'Software']] as const) add(label, text(tags[key]));
  return [
    { title: '基本信息', rows: basics },
    ...(camera.length ? [{ title: '拍摄与其他属性', rows: camera }] : []),
    { title: '文件信息', rows: [row('文件名', text(manifest.originalName)), row('MIME 类型', mime),
      row('图像创建时间', captureTime(tags.CreateDate, tags.OffsetTimeDigitized)),
      row('上传 / 发送时间', localTime(sentAt)), row('文件修改时间', localTime(manifest.lastModified))] },
  ];
}
