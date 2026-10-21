import QRCode from 'qrcode';
import { chamberMark } from './entry-art';
import { sha256 } from '@noble/hashes/sha2.js';
import { MAX_CARD_BYTES } from './room-archive-crypto';
const GRID=192, SCALE=2, LEFT=64, TOP=144, WIDTH=512, HEIGHT=640;
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
/** Fixed binary raster with a checksum. The payload is already password encrypted. */
export function cardRaster(text:string):Uint8Array {
  const payload=encoder.encode(text);
  if(!payload.length||payload.length>MAX_CARD_BYTES)throw new Error('恢复图片内容过大');
  const packet=new Uint8Array(GRID*GRID/8);
  packet.set([81,82,65,50]);new DataView(packet.buffer).setUint32(4,payload.length);
  packet.set(sha256(payload),8);packet.set(payload,40);return packet;
}
export function readCardRaster(packet:Uint8Array):string {
  if(packet.length!==GRID*GRID/8||packet.slice(0,4).join(',')!=='81,82,65,50')throw new Error('请选择保存的恢复图片原文件');
  const size=new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(4);
  if(!size||size>MAX_CARD_BYTES)throw new Error('恢复图片格式不正确');
  const payload=packet.slice(40,40+size),hash=sha256(payload);
  if(!hash.every((x,i)=>x===packet[8+i]))throw new Error('恢复图片已损坏，请选择未裁剪、未压缩的原图');
  return decoder.decode(payload);
}
// Private ancillary PNG chunk carries the same checksummed, password-encrypted
// envelope as the visible QR. Reading the original does not depend on platform QR APIs.
function crc32(bytes: Uint8Array): number {
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
async function embedEnvelope(blob: Blob, text: string): Promise<Blob> {
  const png=new Uint8Array(await blob.arrayBuffer()),data=cardRaster(text),type=encoder.encode('qrAc');
  const chunk=new Uint8Array(data.length+12),view=new DataView(chunk.buffer);
  view.setUint32(0,data.length);chunk.set(type,4);chunk.set(data,8);view.setUint32(data.length+8,crc32(chunk.subarray(4,data.length+8)));
  // Canvas PNG ends with a twelve-byte IEND chunk.
  return new Blob([png.slice(0,-12),chunk,png.slice(-12)],{type:'image/png'});
}
export async function createArchiveCardImage(text:string,name='Chamber'):Promise<Blob> {
  cardRaster(text); // Keep the bounded format validation before QR allocation.
  const canvas=document.createElement('canvas');canvas.width=900;canvas.height=1200;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('此浏览器无法生成恢复图片');
  ctx.fillStyle='#f3f5f3';ctx.fillRect(0,0,900,1200);
  ctx.fillStyle='#244936';ctx.fillRect(0,0,900,244);
  const mark=new Image();mark.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(chamberMark().replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" style="color:#edf3ee" '))}`;
  await mark.decode();ctx.drawImage(mark,43,42,100,100);mark.src='';
  ctx.fillStyle='#edf3ee';
  ctx.font='500 28px system-ui';ctx.fillText('CHAMBER',146,105);
  ctx.font='600 42px system-ui';
  let title=name;while(ctx.measureText(title).width>772&&title.length>1)title=title.slice(0,-2)+'…';ctx.fillText(title,64,184);
  ctx.fillStyle='#21382a';ctx.font='600 32px system-ui';ctx.fillText('聊天记录恢复凭证',64,310);
  ctx.fillStyle='#5c6e63';ctx.font='24px system-ui';ctx.fillText('与凭证密码一起使用，找回已备份的聊天记录',64,355);
  const qr=document.createElement('canvas');await QRCode.toCanvas(qr,text,{width:720,margin:4,errorCorrectionLevel:'M',color:{dark:'#18271e',light:'#ffffff'}});
  ctx.drawImage(qr,90,400,720,720);
  ctx.font='22px system-ui';ctx.textAlign='center';ctx.fillText('请保留原图 · 凭证密码请单独保管',450,1157);
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('恢复图片生成失败')),'image/png'));
  return embedEnvelope(blob,text);
}
export async function readArchiveCardImage(file:Blob):Promise<string> {
  if(file.size>4*1024*1024||file.size<24)throw new Error('请选择 4 MB 以内的恢复图片原文件');
  const header=new Uint8Array(await file.slice(0,24).arrayBuffer()),view=new DataView(header.buffer);
  if(header.slice(0,8).join(',')!=='137,80,78,71,13,10,26,10')throw new Error('请选择凭证 PNG 原图');
  const width=view.getUint32(16),height=view.getUint32(20);
  if(width===900&&height===1200){
    const bytes=new Uint8Array(await file.arrayBuffer()),dataView=new DataView(bytes.buffer);let envelope:string|undefined;
    for(let offset=8;offset+12<=bytes.length;){
      const length=dataView.getUint32(offset);if(length>bytes.length-offset-12)throw new Error('凭证图片已损坏');
      const type=decoder.decode(bytes.slice(offset+4,offset+8));
      if(type==='qrAc'){
        if(envelope!==undefined||length!==GRID*GRID/8||crc32(bytes.subarray(offset+4,offset+8+length))!==dataView.getUint32(offset+8+length))throw new Error('凭证图片已损坏');
        envelope=readCardRaster(bytes.slice(offset+8,offset+8+length));
      }
      offset+=length+12;
    }
    if(!envelope)throw new Error('请选择未压缩、未裁剪的凭证原图');return envelope;
  }
  if(width!==WIDTH||height!==HEIGHT)throw new Error('图片尺寸或格式不正确，请选择恢复卡原图');
  const url=URL.createObjectURL(file),image=new Image();
  try {
    image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=WIDTH;canvas.height=HEIGHT;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)throw new Error('无法读取恢复图片');
    ctx.drawImage(image,0,0);const data=ctx.getImageData(LEFT,TOP,GRID*SCALE,GRID*SCALE).data,packet=new Uint8Array(GRID*GRID/8);
    for(let bit=0;bit<GRID*GRID;bit++) {
      const offset=((Math.floor(bit/GRID)*SCALE+1)*GRID*SCALE+bit%GRID*SCALE+1)*4;
      if(data[offset]!+data[offset+1]!+data[offset+2]!<384)packet[bit>>3]!|=1<<(7-bit%8);
    }
    return readCardRaster(packet);
  }finally{image.src='';URL.revokeObjectURL(url);}
}
