import axios from 'axios';
import { HTTPRequest, Page } from 'puppeteer';
import Utility from './Utility.js';
import logger from './logger.js';

const API_BASE = (process.env.CAPSOLVER_API_BASE || 'https://api.capsolver.com').replace(/\/$/, '');
const SITEKEY_PATTERN = /0x[0-9A-Za-z_-]{20,}/;
const DEFAULT_FUNCAPTCHA_KEY = 'B7D8911C-5CC8-A9A3-35B0-554ACEE604DA';

interface TurnstileParams {
    sitekey: string;
    url: string;
    action?: string;
    cdata?: string;
}

interface FunCaptchaParams {
    publicKey: string;
    url: string;
    subdomain?: string;
    blob?: string;
}

const TURNSTILE_HOOK = `
(() => {
  if (window.__cfHookInstalled) return;
  window.__cfHookInstalled = true;
  window.__cfTurnstileCallbacks = [];
  window.__cfTurnstileParams = [];
  window.__cfToken = '';
  const record = (container, params = {}) => {
    window.__cfTurnstileParams.push({
      sitekey: params.sitekey || params.siteKey || '',
      action: params.action || '',
      cdata: params.cData || params.cdata || ''
    });
    if (typeof params.callback === 'function') window.__cfTurnstileCallbacks.push(params.callback);
  };
  let id = 0;
  const fake = {
    render(container, params) { record(container, params); return 'cf-solver-' + (++id); },
    execute(container, params) { record(container, params); },
    ready(callback) { if (typeof callback === 'function') callback(); },
    reset() {}, remove() {}, isExpired() { return false; },
    getResponse() { return window.__cfToken || ''; }
  };
  try {
    Object.defineProperty(window, 'turnstile', { configurable: true, get: () => fake, set() {} });
  } catch (_) {
    window.turnstile = fake;
  }
})();`;

const READ_PAGE_PARAMS = `() => {
  const captured = (window.__cfTurnstileParams || []).find(item => item.sitekey);
  if (captured) return captured;
  const element = document.querySelector('[data-sitekey]');
  if (element) return {
    sitekey: element.getAttribute('data-sitekey') || '',
    action: element.getAttribute('data-action') || '',
    cdata: element.getAttribute('data-cdata') || ''
  };
  const match = document.documentElement.outerHTML.match(/0x[0-9A-Za-z_-]{20,}/);
  return match ? { sitekey: match[0], action: '', cdata: '' } : null;
}`;

const INJECT_TOKEN = `(token) => {
  window.__cfToken = token;
  const selectors = [
    'input[name="cf-turnstile-response"]',
    'textarea[name="cf-turnstile-response"]',
    'input[name="g-recaptcha-response"]',
    'textarea[name="g-recaptcha-response"]',
    'input[name="bot_detection_token"]'
  ];
  let fields = 0;
  for (const element of document.querySelectorAll(selectors.join(','))) {
    element.value = token;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    fields++;
  }
  let callbacks = 0;
  for (const callback of window.__cfTurnstileCallbacks || []) {
    try { callback(token); callbacks++; } catch (_) {}
  }
  return { fields, callbacks };
}`;

function apiKey(): string {
    const key = process.env.CAPSOLVER_API_KEY?.trim();
    if (!key)
        throw new Error('未配置 CAPSOLVER_API_KEY，无法通过验证码');
    return key;
}

async function post(endpoint: string, payload: object): Promise<any> {
    const { data } = await axios.post(`${API_BASE}/${endpoint}`, payload, { timeout: 30_000 });
    if (data.errorId)
        throw new Error(`CapSolver ${endpoint} 失败: ${data.errorCode} ${data.errorDescription}`);
    return data;
}

export async function validateCapSolver(): Promise<void> {
    const data = await post('getBalance', { clientKey: apiKey() });
    logger.info('CapSolver 密钥有效，余额：%s', data.balance);
}

export async function installTurnstileHook(page: Page): Promise<void> {
    await page.evaluateOnNewDocument(TURNSTILE_HOOK);
}

/** 监听 Arkose 请求，捕获 Microsoft FunCaptcha 的 public key / blob */
export function installFunCaptchaCapture(page: Page): { latest: () => FunCaptchaParams | undefined } {
    let latest: FunCaptchaParams | undefined;

    const onRequest = (request: HTTPRequest) => {
        const url = request.url();
        if (!/arkoselabs\.com|funcaptcha\.com|\/fc\//i.test(url))
            return;
        const publicKey = url.match(/public_key\/([^/?&#]+)/i)?.[1]
            ?? new URL(url).searchParams.get('public_key')
            ?? undefined;
        let blob: string | undefined;
        const postData = request.postData();
        if (postData) {
            try {
                const parsed = JSON.parse(postData);
                blob = parsed?.blob ?? parsed?.data?.blob;
            }
            catch {
                blob = new URLSearchParams(postData).get('blob') ?? undefined;
                if (!blob) {
                    const match = postData.match(/"blob"\s*:\s*"([^"]+)"/);
                    blob = match?.[1];
                }
            }
        }
        latest = {
            publicKey: publicKey || latest?.publicKey || DEFAULT_FUNCAPTCHA_KEY,
            url: page.url(),
            subdomain: url.includes('arkoselabs.com') ? new URL(url).origin : latest?.subdomain,
            blob: blob || latest?.blob
        };
    };

    page.on('request', onRequest);
    return {
        latest: () => latest ? { ...latest, url: page.url() } : undefined
    };
}

async function detectTurnstile(page: Page): Promise<TurnstileParams | undefined> {
    for (const frame of page.frames()) {
        try {
            const params = await frame.evaluate(READ_PAGE_PARAMS) as Omit<TurnstileParams, 'url'> | null;
            if (params?.sitekey)
                return { ...params, url: page.url() };
        }
        catch (_) {
            // 跨域或已卸载的挑战 frame 可能在扫描时消失
        }

        const match = frame.url().match(SITEKEY_PATTERN);
        if (match)
            return { sitekey: match[0], url: page.url() };
    }

    const override = process.env.CAPSOLVER_SITEKEY?.trim();
    return override ? { sitekey: override, url: page.url() } : undefined;
}

async function detectFunCaptcha(page: Page, captured?: FunCaptchaParams): Promise<FunCaptchaParams | undefined> {
    for (const frame of page.frames()) {
        const src = frame.url();
        const publicKey = src.match(/public_key\/([^/?&#]+)/i)?.[1]
            ?? await frame.$eval('[data-pkey]', el => el.getAttribute('data-pkey')).catch(() => null);
        if (publicKey)
            return {
                publicKey,
                url: page.url(),
                subdomain: /arkoselabs\.com/i.test(src) ? new URL(src).origin : captured?.subdomain,
                blob: captured?.blob
            };
    }
    if (await page.$('iframe[data-e2e="enforcement-frame"], iframe#enforcementFrame, iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]'))
        return {
            publicKey: captured?.publicKey || DEFAULT_FUNCAPTCHA_KEY,
            url: page.url(),
            subdomain: captured?.subdomain,
            blob: captured?.blob
        };
    return captured?.publicKey || captured?.blob ? { ...captured!, url: page.url() } : undefined;
}

async function pollSolution(taskId: string, label: string): Promise<string> {
    logger.info('CapSolver 任务已创建，等待 %s 结果', label);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
        await Utility.waitForSeconds(3);
        const result = await post('getTaskResult', { clientKey: apiKey(), taskId });
        if (result.status === 'ready') {
            const token = result.solution?.token;
            if (!token)
                throw new Error(`CapSolver 任务完成但没有返回 ${label} token`);
            return token;
        }
    }
    throw new Error(`CapSolver ${label} 求解超时`);
}

async function solveTurnstile(params: TurnstileParams): Promise<string> {
    const metadata = Object.fromEntries(Object.entries({ action: params.action, cdata: params.cdata }).filter(([, value]) => value));
    const task: Record<string, unknown> = {
        type: 'AntiTurnstileTaskProxyLess',
        websiteURL: params.url,
        websiteKey: params.sitekey
    };
    if (Object.keys(metadata).length)
        task.metadata = metadata;

    const created = await post('createTask', { clientKey: apiKey(), task });
    if (!created.taskId)
        throw new Error('CapSolver createTask 未返回 taskId');
    return pollSolution(created.taskId, 'Turnstile');
}

async function solveFunCaptcha(params: FunCaptchaParams): Promise<string> {
    const task: Record<string, unknown> = {
        type: 'FunCaptchaTaskProxyLess',
        websiteURL: params.url,
        websitePublicKey: params.publicKey
    };
    if (params.subdomain)
        task.funcaptchaApiJSSubdomain = params.subdomain;
    if (params.blob)
        task.data = JSON.stringify({ blob: params.blob });

    const created = await post('createTask', { clientKey: apiKey(), task });
    if (!created.taskId)
        throw new Error('CapSolver createTask 未返回 taskId');
    return pollSolution(created.taskId, 'FunCaptcha');
}

async function injectTurnstile(page: Page, token: string): Promise<boolean> {
    let applied = false;
    for (const frame of page.frames()) {
        try {
            const result = await frame.evaluate(INJECT_TOKEN, token) as { fields: number; callbacks: number };
            applied ||= result.fields > 0 || result.callbacks > 0;
        }
        catch (_) {
            // 挑战 frame 在接受 token 后可能立刻导航
        }
    }
    return applied;
}

async function injectFunCaptcha(page: Page, token: string): Promise<boolean> {
    const applied = await page.evaluate(sessionToken => {
        let fields = 0;
        for (const selector of ['#hip-solution', 'input[name="hip-solution"]', 'textarea[name="hip-solution"]', '#captchaToken']) {
            const element = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
            if (!element)
                continue;
            element.value = sessionToken;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            fields++;
        }
        const payload = JSON.stringify({ eventId: 'challenge-complete', payload: { sessionToken } });
        window.postMessage(payload, '*');
        for (const frame of Array.from(window.frames)) {
            try {
                frame.postMessage(payload, '*');
            }
            catch (_) {
                // 跨域 frame 可能拒绝 postMessage
            }
        }
        return fields > 0;
    }, token);
    await Utility.waitForSeconds(2);
    return applied;
}

export async function solveCloudflareIfPresent(page: Page, waitSeconds = 15): Promise<boolean> {
    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
        const params = await detectTurnstile(page);
        if (params) {
            logger.info('检测到 Cloudflare Turnstile，使用 CapSolver 求解');
            const token = await solveTurnstile(params);
            const applied = await injectTurnstile(page, token);
            if (!applied)
                throw new Error('已取得 Turnstile token，但页面中没有可注入的字段或回调');
            logger.info('Cloudflare Turnstile token 已注入');
            await Utility.waitForSeconds(3);
            return true;
        }
        await Utility.waitForSeconds(1);
    }
    return false;
}

export async function solveFunCaptchaIfPresent(
    page: Page,
    capture: { latest: () => FunCaptchaParams | undefined },
    waitSeconds = 20
): Promise<boolean> {
    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
        const params = await detectFunCaptcha(page, capture.latest());
        if (params) {
            logger.info('检测到 FunCaptcha，使用 CapSolver 求解');
            const token = await solveFunCaptcha(params);
            await injectFunCaptcha(page, token);
            logger.info('FunCaptcha token 已注入');
            await Utility.waitForSeconds(3);
            return true;
        }
        await Utility.waitForSeconds(1);
    }
    return false;
}
