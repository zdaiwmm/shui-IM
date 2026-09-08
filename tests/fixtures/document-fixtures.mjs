import { ZipWriter, Uint8ArrayWriter, TextReader, Uint8ArrayReader } from '@zip.js/zip.js';

// Small, valid two-page PDF with a standard embedded reference font. No user data.
export function readerPdf() {
  const streams = [
    '0.15 0.45 0.38 rg 48 590 324 130 re f BT /F1 24 Tf 48 540 Td (Quiet Room) Tj 0 -40 Td /F1 15 Tf (A private place to read.) Tj ET',
    '0.2 0.35 0.65 rg 48 590 324 130 re f BT /F1 24 Tf 48 540 Td (Second page) Tj 0 -40 Td /F1 15 Tf (Needle search result.) Tj ET',
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 760] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 760] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map(stream => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return [...Buffer.from(pdf)];
}

export async function readerEpub({ badPath = false, encrypted = false, oversized = false, epub2 = false, long = false, cover = false } = {}) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  const add = (name, content) => writer.add(name, new TextReader(content));
  const xhtml = body => `<?xml version="1.0"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Sample</title></head><body>${body}</body></html>`;
  await add('mimetype', 'application/epub+zip');
  await add('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  await add('OPS/book.opf', `<package xmlns="http://www.idpf.org/2007/opf" version="${epub2 ? '2.0' : '3.0'}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quiet Room</dc:title>${cover && epub2 ? '<meta name="cover" content="image"/>' : ''}</metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="image" href="cover.png" media-type="image/png" ${cover && !epub2 ? 'properties="cover-image"' : ''}/><item id="nav" href="${epub2 ? 'toc.ncx' : 'nav.xhtml'}" ${epub2 ? 'media-type="application/x-dtbncx+xml"' : 'media-type="application/xhtml+xml" properties="nav"'}/></manifest><spine toc="nav"><itemref idref="one"/><itemref idref="two"/></spine></package>`);
  await add('OPS/nav.xhtml', xhtml('<nav epub:type="toc"><ol><li><a href="one.xhtml">第一章 · 初见</a></li><li><a href="two.xhtml">第二章 · 星光</a></li></ol></nav>'));
  await add('OPS/toc.ncx', '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="one"><navLabel><text>第一章 · 初见</text></navLabel><content src="one.xhtml"/></navPoint><navPoint id="two"><navLabel><text>第二章 · 星光</text></navLabel><content src="two.xhtml"/></navPoint></navMap></ncx>');
  await add('OPS/one.xhtml', xhtml(`<h1>初见</h1><p>窗外的光落在书页上，时间慢了下来。</p><img src="cover.png" alt="书内插图"/><p>每一次翻页，都是一段新的旅程。</p><a href="two.xhtml#note">阅读下一章</a><script>window.readerExecuted = true</script><img src="https://blocked.invalid/image.png"/><iframe src="https://blocked.invalid/"></iframe><style>@import 'https://blocked.invalid/style.css';</style><a href="javascript:window.readerExecuted=true">恶意链接</a><p id="app" style="position:fixed" onclick="window.readerExecuted=true">安全正文</p>${oversized ? 'x'.repeat(2 * 1024 * 1024) : ''}`));
  await add('OPS/two.xhtml', xhtml('<h1>星光</h1><p id="note">星光落在安静的房间里。Needle in an EPUB chapter.</p>' + (long ? Array.from({ length: 120 }, (_, i) => `<p>段落 ${i + 1}。星光落在安静的房间里，每一次翻页都是一段新的旅程。</p>`).join('') : '') + '<table><tr><th>章节</th><th>内容</th></tr><tr><td>二</td><td>夜读</td></tr></table>'));
  await writer.add('OPS/cover.png', new Uint8ArrayReader(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64')));
  if (badPath) await add('../escape.txt', 'outside');
  if (encrypted) await add('META-INF/encryption.xml', '<encryption/>');
  return [...await writer.close()];
}
