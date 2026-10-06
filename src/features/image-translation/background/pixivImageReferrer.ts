/**
 * @file src/features/image-translation/background/pixivImageReferrer.ts
 * 文件职责：让已获页面短期授权的 Pixiv 正文图片读取携带其真实站点来源，处理图片 CDN 的防盗链要求。
 * 主要内容：仅接受 HTTPS Pixiv 作品页到 i.pximg.net 的读取；串行临时 session rule 精确绑定图片 URL 与本扩展发起者，结束即移除，同一规则编号在下次执行前清理。
 * 模块边界：调用前必须通过当前 DOM 图片授权；不更改宿主请求，不附带 Cookie，不修改响应/CORS，不绕过登录付费限制；网络读取和字节验证仍属于 Offscreen。
 */
import type {DeclarativeNetRequest} from 'webextension-polyfill';

const RULE_ID = 2_001_460;
type RulesPort = Pick<typeof browser.declarativeNetRequest, 'updateSessionRules'>;
type SessionRule = DeclarativeNetRequest.Rule;
let tail: Promise<unknown> = Promise.resolve();

export function withPixivImageReferrer<T>(source: string, documentUrl: string | undefined, operation: () => Promise<T>,
    api?: RulesPort, extensionId?: string): Promise<T> {
    let eligible = false;
    try {
        const page = new URL(documentUrl || 'about:blank'), image = new URL(source);
        eligible = page.protocol === 'https:' && ['pixiv.net','www.pixiv.net'].includes(page.hostname)
            && /^\/(?:[a-z]{2}\/)?artworks\/\d+\/?$/.test(page.pathname)
            && image.protocol === 'https:' && image.hostname === 'i.pximg.net' && !image.port && !image.username && !image.password;
    } catch { /* 非 Pixiv 请求沿用原有读取；来源授权与 URL 策略已经在调用方验证。 */ }
    if (!eligible) return operation();
    const port = api ?? browser.declarativeNetRequest;
    if (!port?.updateSessionRules) return operation();
    const id = extensionId ?? new URL(browser.runtime.getURL('')).hostname;
    const rule: SessionRule = {id:RULE_ID,priority:1,
        action:{type:'modifyHeaders',requestHeaders:[{header:'Referer',operation:'set',value:'https://www.pixiv.net/'}]},
        condition:{regexFilter:`^${source.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,initiatorDomains:[id],resourceTypes:['xmlhttprequest']}};
    const result = tail.then(async () => {
        await port.updateSessionRules({removeRuleIds:[RULE_ID],addRules:[rule]});
        try {return await operation();}
        finally {await port.updateSessionRules({removeRuleIds:[RULE_ID]});}
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
}
