import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { adminConfigId, validateAdminConfig, verifyAdmin } from './admin-auth.mjs';
import { isUuid } from './protocol.mjs';

const cookieName = '__Host-qr-admin';
const sessionIdleMs = 7 * 24 * 60 * 60_000;
const sessionAbsoluteMs = 7 * 24 * 60 * 60_000;
const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');

export async function createAdminConsole({ config: suppliedConfig, configFile, origin = 'https://admin.mijiu.cloud',
  data, readModel, diagnostics, expressions, json, readJson, readExpressionJson = readJson, headers, staticDir, onDelete }) {
  let config = suppliedConfig;
  if (!config && configFile) {
    const info = await stat(configFile);
    if ((info.mode & 0o077) !== 0) throw new Error('ADMIN_CONFIG_PERMISSIONS');
    config = JSON.parse(await readFile(configFile, 'utf8'));
  }
  if (config) validateAdminConfig(config);
  const adminOrigin = new URL(origin);
  if (adminOrigin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(adminOrigin.hostname)) throw new Error('ADMIN_REQUIRES_HTTPS');
  const configId = config ? adminConfigId(config) : '';
  const sessions = new Map();
  let authBusy = false;
  let attempts = 0, attemptsUntil = 0;
  const clearCookie = response => response.setHeader('Set-Cookie', `${cookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`);
  const setCookie = (response, token, expires, now) => response.setHeader('Set-Cookie',
    `${cookieName}=${token}; Path=/; Max-Age=${Math.ceil((expires - now) / 1000)}; Secure; HttpOnly; SameSite=Strict`);

  async function authenticate(password, code) {
    const now = Date.now();
    if (now > attemptsUntil) { attempts = 0; attemptsUntil = now + 60_000; }
    if (authBusy || ++attempts > 8) return { limited: true };
    authBusy = true;
    try {
      const counter = await verifyAdmin(config, password, code, data.adminCounter(configId), now);
      if (counter === null || !data.consumeAdminCounter(configId, counter)) return { ok: false };
      return { ok: true };
    } finally { authBusy = false; }
  }

  return async (request, response, pathname) => {
    const adminHost = request.headers.host === adminOrigin.host;
    const api = pathname.startsWith('/admin-api/');
    if (!adminHost && !api && pathname !== '/admin.html') return false;
    if (!adminHost || !config) { json(request, response, 404, { error: 'NOT_FOUND' }); return true; }
    if (request.headers.origin && request.headers.origin !== adminOrigin.origin) { json(request, response, 403, { error: '来源验证失败' }); return true; }
    if (!api) {
      if (request.method === 'GET' && (pathname === '/' || pathname === '/admin.html')) {
        const bytes = await readFile(path.join(staticDir, 'admin.html'));
        headers(request, response);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(bytes); return true;
      }
      if (request.method === 'GET' && pathname.startsWith('/assets/')) return false;
      json(request, response, 404, { error: 'NOT_FOUND' }); return true;
    }
    if (request.method !== 'GET' && request.headers.origin !== adminOrigin.origin) { json(request, response, 403, { error: '来源验证失败' }); return true; }
    if (pathname === '/admin-api/login' && request.method === 'POST') {
      const body = await readJson(request);
      const verified = await authenticate(body?.password, body?.code);
      if (!verified.ok) { json(request, response, verified.limited ? 429 : 401, { error: verified.limited ? '尝试过于频繁，请稍后重试' : '密码或动态验证码不正确，已使用的动态码不能重复使用' }); return true; }
      const token = secret(); const csrf = secret(); const now = Date.now();
      for (const [key, session] of sessions) if (session.expires < now || session.absolute < now) sessions.delete(key);
      while (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
      sessions.set(hash(token), { csrf, expires: now + sessionIdleMs, absolute: now + sessionAbsoluteMs });
      setCookie(response, token, now + sessionIdleMs, now);
      json(request, response, 200, { csrf }); return true;
    }
    const cookies = String(request.headers.cookie ?? '').split(';').map(value => value.trim());
    const token = cookies.find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
    const session = /^[A-Za-z0-9_-]{43}$/.test(token) ? sessions.get(hash(token)) : null;
    if (!session || session.expires <= Date.now() || session.absolute <= Date.now()) {
      if (token) sessions.delete(hash(token)); clearCookie(response);
      json(request, response, 401, { error: '后台登录已过期，请重新验证', code: 'SESSION_EXPIRED' }); return true;
    }
    if (request.method !== 'GET' && request.headers['x-csrf-token'] !== session.csrf) { json(request, response, 403, { error: '请求验证失败' }); return true; }
    const now = Date.now();
    session.expires = Math.min(now + sessionIdleMs, session.absolute);
    setCookie(response, token, session.expires, now);
    if (['GET', 'POST'].includes(request.method) && pathname === '/admin-api/session') {
      json(request, response, 200, { csrf: session.csrf, expiresAt: new Date(session.absolute).toISOString() }); return true;
    }
    if (request.method === 'POST' && pathname === '/admin-api/logout') {
      sessions.delete(hash(token)); clearCookie(response); json(request, response, 200, { loggedOut: true }); return true;
    }
    const url = new URL(request.url, adminOrigin);
    if (request.method === 'GET' && readModel) {
      try {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (pathname === '/admin-api/overview') {
          const jobs=expressions?.jobs()??[];
          json(request,response,200,{...readModel.summary(),diagnostics:await diagnostics(),jobs:{running:jobs.filter(j=>j.status==='running').length,queued:jobs.filter(j=>j.status==='queued').length,failed:jobs.filter(j=>j.status==='failed').length},
            resources:{stickers:expressions?.list({kind:'stickers',keyword:'',page:1,status:'all'}).total??0,gifs:expressions?.list({kind:'gifs',keyword:'',page:1,status:'all'}).total??0}});return true;
        }
        if(pathname==='/admin-api/archives') {json(request,response,200,readModel.archives({offset,roomId:url.searchParams.get('roomId')??'',source:url.searchParams.get('source')??'all'}));return true;}
        if(/^\/admin-api\/archives\/[A-Za-z0-9_-]{43}$/.test(pathname)) {
          const value=readModel.archive(pathname.split('/')[3]);json(request,response,value?200:404,value??{error:'归档不存在'});return true;
        }
        if(pathname==='/admin-api/events') {json(request,response,200,readModel.events({offset,q:url.searchParams.get('q')??''}));return true;}
        if(pathname==='/admin-api/diagnostics') {json(request,response,200,{...readModel.summary(),diagnostics:await diagnostics()});return true;}
      }catch(error){if(error.message!=='INVALID_ADMIN_FILTER')throw error;json(request,response,400,{error:'筛选条件不正确'});return true;}
    }
    if (expressions && pathname.startsWith('/admin-api/expressions')) {
      let auditTargets=[];
      const expressionJson=(request,response,status,body)=>{
        if(request.method!=='GET'&&readModel&&status<400){
          const parts=pathname.split('/'),target=parts[3]==='jobs'?parts[4]:parts[3];
          const action=pathname.endsWith('/cancel')?'collection-cancel':pathname.endsWith('/retry')?'collection-retry':pathname.endsWith('/collect')?'collection-start':
            request.method==='POST'?'expression-create':request.method==='PATCH'?(pathname.endsWith('/status')?'expression-status':'expression-update'):url.searchParams.has('position')?'expression-item-delete':'expression-delete';
          const targets=auditTargets.length?auditTargets:[typeof body?.id==='string'?body.id:target&&/^[A-Za-z0-9_-]{1,128}$/.test(target)?target:'catalog'];
          try{for(const id of targets)readModel.recordEvent(action,action.startsWith('collection')?'collection':'expression',id);}
          catch{json(request,response,503,{error:'操作可能已完成，但审计记录失败。请刷新确认结果，不要重复提交。'});return;}
        }
        json(request,response,status,body);
      };
      try {
        const match = pathname.match(/^\/admin-api\/expressions\/([a-zA-Z0-9_-]{1,128})(?:\/media\/(\d{1,3}))?$/);
        if (pathname === '/admin-api/expressions' && request.method === 'GET') {
          expressionJson(request, response, 200, expressions.list({ kind: url.searchParams.get('kind') ?? 'gifs', keyword: url.searchParams.get('keyword') ?? '',
            status: url.searchParams.get('status') ?? 'all', page: Number(url.searchParams.get('page') ?? 1) }));
        } else if (pathname === '/admin-api/expressions' && request.method === 'POST') {
          expressionJson(request, response, 201, await expressions.create(await readExpressionJson(request)));
        } else if (pathname === '/admin-api/expressions/status' && request.method === 'PATCH') {
          const body=await readJson(request);const result=expressions.updateStatus(body);auditTargets=body.ids;expressionJson(request,response,200,result);
        } else if (pathname === '/admin-api/expressions/collect' && request.method === 'POST') {
          expressionJson(request, response, 202, expressions.start(await readJson(request)));
        } else if (pathname === '/admin-api/expressions/source' && request.method === 'GET') {
          expressionJson(request, response, 200, await expressions.sourceSearch({ keyword: url.searchParams.get('keyword') ?? '', channel: url.searchParams.get('channel') ?? 'signal', kind: url.searchParams.get('channel') === 'noto' ? 'gifs' : 'stickers', page: Number(url.searchParams.get('page') ?? 1) }));
        } else if (pathname.match(/^\/admin-api\/expressions\/source\/(?:[a-f0-9]{32}|noto-[a-f0-9_]{4,80})\/media$/) && request.method === 'GET') {
          const result = await expressions.sourcePreview(pathname.split('/')[4]);
          headers(request, response); response.writeHead(200, { 'Content-Type': result.type, 'Content-Length': result.bytes.length, 'Cache-Control': 'no-store' }); response.end(result.bytes);
        } else if (match && match[2] === undefined && request.method === 'DELETE' && url.searchParams.has('position')) {
          expressionJson(request, response, 200, expressions.removeItem(match[1], Number(url.searchParams.get('position'))));
        } else if (pathname === '/admin-api/expressions/jobs' && request.method === 'GET') {
          expressionJson(request, response, 200, { jobs: expressions.jobs() });
        } else if (pathname.match(/^\/admin-api\/expressions\/jobs\/[a-f0-9-]{36}\/cancel$/) && request.method === 'POST') {
          expressionJson(request, response, 200, expressions.cancel(pathname.split('/')[4]));
        } else if (pathname.match(/^\/admin-api\/expressions\/jobs\/[a-f0-9-]{36}\/retry$/) && request.method === 'POST') {
          expressionJson(request, response, 202, expressions.retry(pathname.split('/')[4]));
        } else if (match && match[2] !== undefined && request.method === 'GET') {
          const result = expressions.preview(match[1], Number(match[2]));
          headers(request, response); response.writeHead(200, { 'Content-Type': result.type, 'Content-Length': result.bytes.length, 'Cache-Control': 'no-store' }); response.end(result.bytes);
        } else if (match && match[2] === undefined && request.method === 'GET') {
          expressionJson(request, response, 200, expressions.detail(match[1]));
        } else if (match && match[2] === undefined && request.method === 'PATCH') {
          expressionJson(request, response, 200, expressions.update(match[1], await readJson(request)));
        } else if (match && match[2] === undefined && request.method === 'DELETE') {
          expressionJson(request, response, 200, expressions.remove(match[1]));
        } else expressionJson(request, response, 404, { error: 'NOT_FOUND' });
      } catch (error) {
        const code = error.message;
        const upstreamError = ['MEME_UPSTREAM_UNAVAILABLE', 'MEME_DNS_REJECTED', 'MEME_INVALID_CATALOG', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR'].includes(code)
          || ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR'].includes(error.code);
        expressionJson(request, response, code === 'MEME_NOT_FOUND' ? 404 : code === 'MEME_BUSY' ? 409 : upstreamError ? 503 : 400,
          { error: code === 'MEME_NOT_FOUND' ? '资源不存在' : code === 'MEME_BUSY' ? '任务队列或预览繁忙，请稍后重试' : upstreamError ? '来源连接或目录读取失败，请重新搜索' : '资源参数不正确或操作失败' });
      }
      return true;
    }
    if (request.method === 'GET' && pathname === '/admin-api/rooms') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) { json(request, response, 400, { error: '页码不正确' }); return true; }
      try { json(request,response,200,readModel?readModel.roomList({offset,q:url.searchParams.get('q')??'',format:url.searchParams.get('format')??'all',state:url.searchParams.get('state')??'all'}):{rooms:data.rooms(offset)}); }
      catch(error){if(error.message!=='INVALID_ADMIN_FILTER')throw error;json(request,response,400,{error:'筛选条件不正确'});}return true;
    }
    const match = pathname.match(/^\/admin-api\/rooms\/([0-9a-f-]{36})$/i);
    if (match && isUuid(match[1])) {
      if (request.method === 'GET') {
        try { json(request, response, 200, { ...(readModel?.room(match[1])??{}), ...data.room(match[1]) }); }
        catch (error) { if (error.message !== 'BACKUP_UNAVAILABLE') throw error; json(request, response, 404, { error: '会话不存在或已清理' }); }
        return true;
      }
      if (request.method === 'DELETE') {
        const body = await readJson(request);
        if (body?.confirmRoomId !== match[1]) { json(request, response, 400, { error: '请完整输入会话编号确认清理' }); return true; }
        const verified = await authenticate(body?.password, body?.code);
        if (!verified.ok) { json(request, response, verified.limited ? 429 : 401, { error: '清理需要重新验证密码和未使用的动态码' }); return true; }
        const result = data.deleteRoom(match[1]);
        await onDelete(match[1]);
        json(request, response, 200, result); return true;
      }
    }
    json(request, response, 404, { error: 'NOT_FOUND' }); return true;
  };
}
