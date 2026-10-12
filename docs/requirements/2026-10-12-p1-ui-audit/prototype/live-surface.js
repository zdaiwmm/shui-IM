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
if(screen==='menuBottom')app.openMessageActions([...root.querySelectorAll('.message')].at(-1),[...app.messages.values()].at(-1));
if(screen==='notificationCopy')app.renderNotificationCopy();
if(screen==='reader'){
  const {DocumentReader}=await import('/src/lib/document-reader.ts');
  const reader=new DocumentReader(root,'周末的散步.txt','text/plain',()=>reader.destroy());
  await reader.load(new Blob([('离开熟悉的街道，沿着河边慢慢走。没有急着抵达的地方，视线就有了停留的余地。\n\n').repeat(36)],{type:'text/plain'}));
  window.addEventListener('pagehide',()=>reader.destroy(),{once:true});
}
if(screen==='mediaUpload'||screen==='photoDetails'){
  const canvas=document.createElement('canvas');canvas.width=288;canvas.height=192;
  const context=canvas.getContext('2d');context.fillStyle='#c5dacc';context.fillRect(0,0,288,192);
  context.fillStyle='#659477';context.beginPath();context.moveTo(0,192);context.lineTo(96,64);context.lineTo(220,192);context.fill();
  context.fillStyle='#8bad91';context.beginPath();context.moveTo(110,192);context.lineTo(214,80);context.lineTo(288,192);context.fill();
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(screen==='mediaUpload'){
    const {MediaUploadView}=await import('/src/lib/media-upload-view.ts');
    const view=new MediaUploadView('synthetic-live-upload',[new File([blob],'合成样例.png',{type:'image/png'})],false,false,()=>{view.update('uploading',.64);parent.postMessage({type:'live-media-current',state:'uploading'},location.origin);},()=>view.destroy(),()=>{});
    await view.ready;root.querySelector('#message-list').replaceChildren(view.element);view.update('uploading',.64);
    window.addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin||event.data.type!=='live-media-state'||!['preparing','uploading','finishing','failed'].includes(event.data.state))return;view.update(event.data.state,.64);});
    window.addEventListener('pagehide',()=>view.destroy(),{once:true});
  }else{
    const {mountPhotoDetails}=await import('/src/lib/photo-details.ts');
    const viewer=document.createElement('section');viewer.className='image-viewer is-open';viewer.style.setProperty('--photo-details-height','54%');
    const image=document.createElement('img'),url=URL.createObjectURL(blob);image.src=url;image.alt='合成图片';image.style.cssText='width:min(80%,288px);height:auto;position:absolute;top:80px;left:50%;translate:-50% 0';viewer.append(image);root.append(viewer);
    const manifest={v:1,blobId:'synthetic-photo',mimeType:'image/png',originalName:'合成样例.png',originalSize:blob.size,width:288,height:192,chunkSize:262144,chunkCount:1};
    const close=mountPhotoDetails(viewer,{manifest,sentAt:'2026-10-12T01:41:00Z',signal:app.runtimeAbort.signal,load:async()=>({blob,width:288,height:192}),close:()=>close(true)});
    window.addEventListener('pagehide',()=>{close(false);URL.revokeObjectURL(url);},{once:true});
  }
}
if(screen==='call'){
  const {CallView}=await import('/src/lib/call-view.ts');
  const state={phase:'connected',callId:'synthetic-review-call',kind:'audio',peerName:'视觉验收空间',localStream:null,remoteStream:null,micMuted:false,cameraEnabled:false,remoteVideoEnabled:false,remoteMuted:false,facingMode:'user',startedAt:Date.now()-204000,statusText:'通话中',quality:'good',canSwitchCamera:false};
  const view=new CallView({accept:()=>{},decline:()=>view.destroy(),hangup:()=>view.destroy(),dismiss:()=>view.destroy(),toggleMicrophone:()=>{state.micMuted=!state.micMuted;view.update(state);},toggleCamera:()=>{},switchCamera:()=>{}});
  root.append(view.element);view.update(state);window.addEventListener('pagehide',()=>view.destroy(),{once:true});
}
window.addEventListener('pagehide',()=>app.runtimeAbort?.abort(),{once:true});
requestAnimationFrame(()=>notify({type:'live-ready',screen,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,touch:matchMedia('(pointer:coarse)').matches}));
}catch(error){root.textContent='当前样例未完成载入。请返回页面选择器选择其他页面。';notify({type:'live-error',message:error.message});console.error(error);}
