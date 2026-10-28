import english from '../locales/en.json';
export const LANGUAGES = [
  { id: 'en', name: 'English' }, { id: 'zh-Hans', name: '简体中文' }, { id: 'zh-Hant', name: '繁體中文' },
  { id: 'es', name: 'Español' }, { id: 'fr', name: 'Français' }, { id: 'de', name: 'Deutsch' },
  { id: 'pt', name: 'Português' }, { id: 'ru', name: 'Русский' }, { id: 'ar', name: 'العربية' },
  { id: 'ja', name: '日本語' }, { id: 'hi', name: 'हिन्दी' },
] as const;
export type Language = typeof LANGUAGES[number]['id'];
export type LanguagePreference = Language | 'system';
export const LANGUAGE_KEY = 'quiet-room:language';
export const isLanguage = (value: unknown): value is Language => LANGUAGES.some(item => item.id === value);
export function matchLanguage(tags: readonly string[]): Language {
  for (const tag of tags) {
    try {
      const locale = new Intl.Locale(tag.replaceAll('_','-'));
      if (locale.language === 'zh') return locale.script === 'Hant' ? 'zh-Hant' : locale.script === 'Hans' ? 'zh-Hans' : ['TW','HK','MO'].includes(locale.region ?? '') ? 'zh-Hant' : 'zh-Hans';
      if (isLanguage(locale.language)) return locale.language;
    } catch { /* Ignore malformed device tags. */ }
  }
  return 'en';
}
export function readLanguage(storage: Pick<Storage,'getItem'>): LanguagePreference {
  try { const value=storage.getItem(LANGUAGE_KEY); return isLanguage(value) ? value : 'system'; } catch { return 'system'; }
}
// Chinese is the source language; initialization runs before the real app mounts.
let current: Language = 'zh-Hans';
let preference: LanguagePreference = 'system';
let catalog: Record<string,string> = {};
let generation=0;
let reverse:Map<string,string[]>|undefined;
const loaders=import.meta.glob<Record<string,string>>('../locales/{zh-Hant,es,fr,de,pt,ru,ar,ja,hi}.json',{import:'default'});
export const currentLanguage=()=>current;
export const languagePreference=()=>preference;
export const t=(source:string):string=>current==='zh-Hans'?source:catalog[source] ?? (english as Record<string,string>)[source] ?? source;
export async function setLanguage(value: LanguagePreference, persist=true): Promise<void> {
  if (value!=='system' && !isLanguage(value)) throw new Error('INVALID_LANGUAGE');
  const next=value==='system'?matchLanguage(navigator.languages?.length?navigator.languages:[navigator.language]):value;
  const turn=++generation;
  const load=loaders[`../locales/${next}.json`];
  const strings=next==='zh-Hans'?{}:next==='en'?english:load?await load():english;
  if(turn!==generation)return;
  // A failed write must leave both the visible language and preference unchanged.
  if(persist)localStorage.setItem(LANGUAGE_KEY,value);
  current=next;preference=value;catalog=strings;reverse=undefined;
  document.documentElement.lang=next;
  document.documentElement.dir=next==='ar'?'rtl':'ltr';
  window.dispatchEvent(new Event('languagechange:app'));
}
export async function mountLanguage(): Promise<void> {
  let value:LanguagePreference='system';try{value=readLanguage(localStorage);}catch{/* Storage access itself may fail. */}
  try { await setLanguage(value,false); } catch { await setLanguage('en',false); }
  window.addEventListener('languagechange',()=>{if(preference==='system')void setLanguage('system',false).catch(()=>{});});
  window.addEventListener('storage',event=>{if(event.key===LANGUAGE_KEY||event.key===null){let next:LanguagePreference='system';try{next=readLanguage(localStorage);}catch{}void setLanguage(next,false).catch(()=>{});}});
}

/** Only source-code literals enter this function. Never pass user text or template values. */
export function uiLiteral<T extends string>(source:T):T {
  if(current==='zh-Hans')return source;
  return source.replace(/[\u3400-\u9fff][\u3400-\u9fffA-Za-z0-9\s…，。！？：；、（）「」《》·／%+\-–—/.,!?():;]*/g,part=>{
    const key=part.trimEnd(), translated=catalog[key] ?? (english as Record<string,string>)[key];
    return translated===undefined?part:translated+part.slice(key.length);
  }) as T;
}
/** Preserve all interpolated values byte-for-byte; translate static source fragments only. */
export function uiTemplate(parts:TemplateStringsArray,...values:unknown[]):string {
  let result=uiLiteral(parts[0]??'');
  const spaced=!['zh-Hans','zh-Hant','ja'].includes(current);
  for(let i=0;i<values.length;i++){
    const value=String(values[i]),raw=parts[i+1]??'',next=uiLiteral(raw);
    const before=spaced&&/[\p{Script=Han}：]$/u.test(parts[i]??'')&&/[\p{Letter}\p{Number}:]$/u.test(result)&&/^[\p{Letter}\p{Number}]/u.test(value)?' ':'';
    const after=spaced&&/^\p{Script=Han}/u.test(raw)&&/[\p{Letter}\p{Number}]$/u.test(value)&&/^[\p{Letter}\p{Number}]/u.test(next)?' ':'';
    result+=before+value+after+next;
  }
  return result;
}

/** Match authored UI copy without making behavior depend on translated wording. */
export function matchesSourceText(text:string,pattern:RegExp):boolean {
  if(pattern.test(text))return true;
  if(!reverse){
    reverse=new Map();
    for(const [source,value] of Object.entries({...english,...catalog})){
      const list=reverse.get(value)??[];list.push(source);reverse.set(value,list);
    }
  }
  return reverse.get(text)?.some(source=>pattern.test(source))??false;
}
