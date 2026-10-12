// Review-only entry. Product renderers and cascade are imported unchanged.
// No vault installation, real credential, API connection or production data.
import {loadProductStyles} from '/tests/fixtures/product-styles.ts';
import {QuietRoomApp} from '/src/app.ts';
import {generateIdentity} from '/src/lib/crypto.ts';
import {mountSystemChrome} from '/src/lib/system-chrome.ts';
import {mountSpaceDrawer,spaceIcons} from '/src/lib/space-drawer.ts';
const root=document.querySelector('#app');
const screen=new URLSearchParams(location.search).get('screen')||'chat';
const notify=data=>parent.postMessage(data,location.origin);
try{
await loadProductStyles();mountSystemChrome();
const app=new QuietRoomApp(root),identity=await generateIdentity(),peer=await generateIdentity();
const session={vault:{v:3,roomId:'synthetic-review-room',role:'creator',identity,accessToken:'synthetic-only',pairingSecret:'',creatorFingerprint:'synthetic-only',lastSeq:3,createdAt:new Date().toISOString(),protocol:'legacy-v1',members:[{...identity.publicBundle,role:'creator',status:'active',deviceName:'本机合成设备'},{...peer.publicBundle,role:'joiner',status:'active',deviceName:'对方合成设备'}]},key:await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),stored:{v:3,unlockMethod:'password',spaceId:'synthetic-review-only'}};
app.session=session;app.privacyCovered=false;app.runtimeAbort=new AbortController();app.uiPreferencesHydrated=true;app.uiPreferences={entranceCardDismissed:true,hiddenAlbumHintDismissed:true};app.connectionState='connected';app.rolePresence={creator:true,joiner:true};app.currentSpaceName='视觉验收空间';app.currentSpaceAvatar={v:1,kind:'emoji',emoji:'1f331',background:0};
app.updateSafetyCode=async()=>{};app.updateBackgroundNotificationControl=async()=>{};app.scheduleUiPreferencesSave=()=>{};app.unreadCounter.markRead=async()=>{};
app.messages=new Map([1,2,3].map(i=>[i,{seq:i,clientMsgId:'synthetic-live-'+i,senderId:i%2?peer.publicBundle.deviceId:identity.publicBundle.deviceId,payload:{v:1,kind:'text',text:['下午有空，一起散步吗？','好呀，五点见。','我带上相机。'][i-1],sentAt:'2026-10-12T01:41:00Z'},status:'delivered'}]));
document.body.className='app-mode';app.renderChat();app.renderMessages({scroll:'bottom'});
const simple={profile:'renderCreate',appearance:'renderAppearanceSettings',autoLock:'renderAutoLockSettings',recovery:'renderRecoveryCenter',joint:'renderJointRecovery',help:'renderFeatureHelp',history:'renderReleaseHistory',practice:'renderCoverPractice',entrance:'renderEntranceCard'};
if(simple[screen])app[simple[screen]]();
if(screen==='create')app.renderCreateProtection({name:'视觉验收空间',avatar:app.currentSpaceAvatar});
if(['backupExport','backupImport','historyCode','backupPrivacy'].includes(screen))app.renderLocalHistoryBackup(screen==='backupExport'||screen==='backupPrivacy'?'export':'import');
if(screen==='historyCode')root.querySelector('[data-restore]').click();
if(screen==='jointCode'){app.renderJointRecovery(null);root.querySelector('#joint-open-code').click();}
if(screen==='backupPrivacy'){session.vault.cloudBackupPreference={enabled:false};const {paintCloudBackup}=await import('/src/lib/backup-settings-ui.ts');paintCloudBackup(root,session);root.querySelector('[data-cloud-switch]').click();}
if(screen==='tools')app.toggleChatTools();
if(screen==='info')app.showMessageInfo([...app.messages.values()][1]);
if(screen==='menu')app.openMessageActions(root.querySelector('.message'),[...app.messages.values()][0]);
if(screen==='coverConfirm')app.confirmDisableCover();
if(screen.startsWith('password')){const {requestPassword}=await import('/src/lib/password-dialog.ts');void requestPassword(root,{presentation:screen==='passwordReturn'?'page':'sheet',title:'验证操作密码',context:'合成界面验证，不接受真实密码。',spaceName:'视觉验收空间',operation:'导出聊天备份',signal:app.runtimeAbort.signal,isActive:()=>!app.privacyCovered,verify:async()=>{throw Error('合成错误状态，请勿输入真实密码')}}).catch(()=>{});}
if(screen==='settings'||screen==='spaces'){
const destinations=[['appearance-settings','主题外观','appearance',()=>app.renderAppearanceSettings()],['auto-lock-settings','自动锁定','key',()=>app.renderAutoLockSettings()],['backup-settings','备份与恢复','history',()=>app.renderLocalHistoryBackup()],['cover-practice-menu','自动遮蔽','cover',()=>app.renderCoverPractice()],['release-history','更新记录','history',()=>app.renderReleaseHistory()]];
mountSpaceDrawer(root,{spaces:['视觉验收空间','周末计划','慢慢说'].map((name,i)=>({roomId:i?'synthetic-'+i:session.vault.roomId,name})),currentRoom:session.vault.roomId,signal:app.runtimeAbort.signal,initialSettings:screen==='settings',actions:destinations.map(([id,label,icon,run])=>({id,label,icon:spaceIcons[icon],run})),select:async()=>{app.renderChat();app.renderMessages({scroll:'bottom'});},create:async()=>app.renderCreate(),rename:async()=>{},styleChanged:()=>{},closed:()=>{}});
}
window.addEventListener('pagehide',()=>app.runtimeAbort?.abort(),{once:true});
requestAnimationFrame(()=>notify({type:'live-ready',screen,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,touch:matchMedia('(pointer:coarse)').matches}));
}catch(error){root.textContent='当前样例未完成载入。请返回页面选择器选择其他页面。';notify({type:'live-error',message:error.message});console.error(error);}
