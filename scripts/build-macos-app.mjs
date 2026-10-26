import {execFileSync} from 'node:child_process';
import {mkdir,copyFile,symlink,writeFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

if(process.platform!=='darwin')throw new Error('Build the macOS installer on macOS with Xcode Command Line Tools.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const destination=path.resolve(process.argv[2]??path.join(root,'.artifacts','macos'));
// The installer contains an Applications symlink. Keep staging outside the
// checkout so source/test scanners can never traverse installed applications.
await mkdir(destination,{recursive:true});
const build=await mkdtemp(path.join(tmpdir(),'chamber-macos-build-')),app=path.join(build,'Chamber.app'),contents=path.join(app,'Contents');
const run=(command,args)=>execFileSync(command,args,{cwd:root,stdio:'inherit'});
await mkdir(path.join(contents,'MacOS'),{recursive:true});await mkdir(path.join(contents,'Resources'),{recursive:true});
await copyFile(path.join(root,'desktop/macos/Info.plist'),path.join(contents,'Info.plist'));
for(const arch of ['arm64','x86_64'])run('xcrun',['swiftc','-O','-target',`${arch}-apple-macos13.0`,'-framework','AppKit','-framework','WebKit',path.join(root,'desktop/macos/Chamber.swift'),'-o',path.join(build,`Chamber-${arch}`)]);
run('lipo',['-create',path.join(build,'Chamber-arm64'),path.join(build,'Chamber-x86_64'),'-output',path.join(contents,'MacOS/Chamber')]);
const icons=path.join(build,'Chamber.iconset');await mkdir(icons);
for(const size of [16,32,128,256,512])for(const scale of [1,2])run('sips',['-z',String(size*scale),String(size*scale),path.join(root,'public/icon-512.png'),'--out',path.join(icons,`icon_${size}x${size}${scale===2?'@2x':''}.png`)]);
run('iconutil',['-c','icns',icons,'-o',path.join(contents,'Resources/Chamber.icns')]);
run('codesign',['--force','--sign','-',app]);run('codesign',['--verify','--deep','--strict',app]);
const stage=path.join(build,'installer');await mkdir(stage);run('ditto',[app,path.join(stage,'Chamber.app')]);await symlink('/Applications',path.join(stage,'Applications'));
await writeFile(path.join(stage,'安装说明.txt'),'将 Chamber.app 拖入 Applications（应用程序），打开后可在 Dock 右键选择“选项 → 在程序坞中保留”。\n\n这是独立的本机应用，网站数据与 Chrome/Safari 分开。首次进入需要按正常设备流程授权，旧历史不会自动迁移。\n\n此本机版本采用临时签名，尚未通过 Apple 开发者签名或公证。首次打开如被 macOS 拦截，请在系统设置 → 隐私与安全性中核对并允许。\n\n新保护使用应用密码。当前版本不声明支持内嵌 WebKit 的系统通行密钥，既有浏览器数据和通行密钥不会被导入或降级。\n');
const dmg=path.join(destination,`Chamber-1.0.0-universal-${Date.now()}.dmg`);
run('hdiutil',['create','-volname','Chamber','-srcfolder',stage,'-format','UDZO',dmg]);
const installedApp=path.join(destination,`Chamber-${Date.now()}.app`);run('ditto',[app,installedApp]);
await rm(build,{recursive:true,force:true});
await writeFile(path.join(destination,'latest-build.json'),JSON.stringify({app:installedApp,dmg,signing:'ad-hoc',notarized:false,architectures:['arm64','x86_64']},null,2)+'\n');
console.log(JSON.stringify({app:installedApp,dmg,signing:'ad-hoc',notarized:false}));
