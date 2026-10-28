import { describe,it,expect } from 'vitest';
import { LANGUAGES,matchLanguage,readLanguage } from '../src/lib/language';
describe('device language matching',()=>{
 it('supports eleven explicit languages and device preference ordering',()=>{
  expect(LANGUAGES).toHaveLength(11);
  expect(matchLanguage(['ko-KR','de-CH','en'])).toBe('de');
  expect(matchLanguage(['bad tag','uk-UA'])).toBe('en');
  expect(matchLanguage(['pt-BR'])).toBe('pt');
  expect(matchLanguage([])).toBe('en');
 });
 it('respects explicit script before region and recognizes traditional Chinese',()=>{
  for(const tag of ['zh-TW','zh-HK','zh-MO','zh-Hant','zh-Hant-CN'])expect(matchLanguage([tag])).toBe('zh-Hant');
  for(const tag of ['zh','zh-CN','zh-SG','zh-Hans-TW','zh_Hans'])expect(matchLanguage([tag])).toBe('zh-Hans');
 });
 it('treats invalid or unavailable storage as follow-system',()=>{
  expect(readLanguage({getItem:()=> 'es'})).toBe('es');
  expect(readLanguage({getItem:()=> 'unknown'})).toBe('system');
  expect(readLanguage({getItem:()=>{throw Error();}})).toBe('system');
 });
});

// Translation text is used inside trusted static markup; substitutions never
// receive user values. Reject markup/attribute delimiters in every catalog.
import {readFileSync} from 'node:fs';
import sources from '../src/locales/source.json';
describe('bundled locale contract',()=>{
 it('covers every extracted phrase in all ten translated catalogs without markup',()=>{
  for(const {id} of LANGUAGES.filter(item=>item.id!=='zh-Hans')){
   const data=JSON.parse(readFileSync(new URL(`../src/locales/${id}.json`,import.meta.url),'utf8'));
   const missing=sources.filter(key=>typeof data[key]!=='string'||!data[key].trim());
   expect(missing,`${id} missing translations`).toEqual([]);
   const unsafe=Object.entries(data).filter(([,value])=>typeof value!=='string'||/[<>&"'\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value as string));
   expect(unsafe,`${id} unsafe translation text`).toEqual([]);
  }
 });
});
