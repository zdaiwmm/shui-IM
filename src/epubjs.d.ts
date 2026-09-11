declare module 'epubjs/src/packaging.js' {
  export default class Packaging {
    constructor(document: Document);
    manifest: Record<string, { href: string; type: string; properties: string[] }>;
    spine: Array<{ idref: string; linear: string }>;
    navPath: string;
    ncxPath: string;
    coverPath: string;
    destroy(): void;
  }
}
declare module 'epubjs/src/navigation.js' {
  export interface NavigationItem { href: string; label: string; subitems: NavigationItem[] }
  export default class Navigation {
    constructor(document: Document);
    toc: NavigationItem[];
  }
}
