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
export async function createArchiveCardImage(text:string):Promise<Blob> {
  const bytes=cardRaster(text),canvas=document.createElement('canvas');canvas.width=WIDTH;canvas.height=HEIGHT;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('此浏览器无法生成恢复图片');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,WIDTH,HEIGHT);ctx.fillStyle='#171717';
  ctx.font='600 25px system-ui';ctx.fillText('聊天归档恢复卡',64,64);
  ctx.font='14px system-ui';ctx.fillText('需配合你的恢复口令使用',64,100);
  for(let bit=0;bit<GRID*GRID;bit++)if(bytes[bit>>3]!&(1<<(7-bit%8)))ctx.fillRect(LEFT+bit%GRID*SCALE,TOP+Math.floor(bit/GRID)*SCALE,SCALE,SCALE);
  ctx.font='14px system-ui';ctx.fillText('请保存原图，不要裁剪或压缩',64,572);
  ctx.fillText('仅用于恢复记录，不用于进入密室',64,600);
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('恢复图片生成失败')),'image/png'));
}
export async function readArchiveCardImage(file:Blob):Promise<string> {
  if(file.size>4*1024*1024||file.size<24)throw new Error('请选择 4 MB 以内的恢复图片原文件');
  const header=new Uint8Array(await file.slice(0,24).arrayBuffer()),view=new DataView(header.buffer);
  if(header.slice(0,8).join(',')!=='137,80,78,71,13,10,26,10'||view.getUint32(16)!==WIDTH||view.getUint32(20)!==HEIGHT)throw new Error('图片尺寸或格式不正确，请选择恢复卡原图');
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
