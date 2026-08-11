import './loadEnv.js';
import './patches.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { createHash, randomBytes, randomInt } from 'crypto';
import puppeteer, { Browser, ElementHandle, Page } from 'puppeteer';
import Utility from './Utility.js';
import logger from './logger.js';
import githubAnnotation from './annotations.js';
import {
    OUTLOOK_CLIENT_ID,
    buildAuthorizeUrl,
    exchangeAuthorizationCode,
    preflightOutlook
} from './outlookMail.js';
import {
    installFunCaptchaCapture,
    installTurnstileHook,
    solveCloudflareIfPresent,
    solveFunCaptchaIfPresent,
    validateCapSolver
} from './capsolver.js';

const MAX_TIMEOUT = Math.pow(2, 31) - 1;
const EVIDENCE_TIMEOUT_MS = 15_000;
const FIRST_NAMES = ['james', 'maria', 'david', 'sarah', 'michael', 'emma', 'daniel', 'olivia', 'lucas', 'sophia'];
const LAST_NAMES = ['smith', 'jones', 'brown', 'taylor', 'wilson', 'clark', 'harris', 'lewis', 'young', 'walker'];

type RegistrationState =
    | 'member-name'
    | 'password'
    | 'profile'
    | 'captcha'
    | 'phone'
    | 'consent'
    | 'success'
    | 'oauth-login'
    | 'oauth-consent'
    | 'oauth-redirect'
    | 'unknown';

function generateLocalPart(): string {
    const first = FIRST_NAMES[randomInt(FIRST_NAMES.length)];
    const last = LAST_NAMES[randomInt(LAST_NAMES.length)];
    return `${first}${last}${randomInt(1000, 9999)}`;
}

function generatePassword(): string {
    return `Ol!${randomBytes(12).toString('base64url')}9Aa`;
}

function redactHtml(html: string): string {
    return html
        .replace(/(<input\b[^>]*\b(?:type=["']password["']|name=["'](?:code|otp|token|password|passwd)["'])[^>]*\bvalue=["'])[^"']*(["'])/gi, '$1[REDACTED]$2')
        .replace(/(authorization|refresh_token|access_token|code=)(["'\s:=]+)[^"'\s<&]+/gi, '$1$2[REDACTED]');
}

async function withEvidenceTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
    return Promise.race([operation, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}超时`)), EVIDENCE_TIMEOUT_MS))]);
}

async function captureEvidence(page: Page, step: number, stage: string): Promise<void> {
    const safeStage = stage.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
    const prefix = `${String(step).padStart(2, '0')}-${safeStage}`;
    fs.mkdirSync('./evidence', { recursive: true });
    logger.info('注册阶段：%s，URL：%s，标题：%s', stage, page.url().replace(/[?#].*$/, ''), await page.title().catch(() => ''));
    const screenshotPath = path.join('./evidence', `${prefix}.png`) as `${string}.png`;
    await withEvidenceTimeout(page.screenshot({ path: screenshotPath, fullPage: true }), '截图').catch(error => logger.warn('证据截图失败：%s', error.message));
    await withEvidenceTimeout(page.content(), 'DOM 快照').then(html => fs.writeFileSync(path.join('./evidence', `${prefix}.html`), redactHtml(html))).catch(error => logger.warn('DOM 快照失败：%s', error.message));
}

async function screenshotAllPages(browser: Browser) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const [index, page] of (await browser.pages()).entries())
        await withEvidenceTimeout(page.screenshot({ path: `./evidence/error-${timestamp}-${index + 1}.png` }), '错误截图').catch(logger.error);
}

async function first(page: Page, selectors: string[]): Promise<ElementHandle<Element> | null> {
    for (const selector of selectors) {
        const element = await page.$x(selector, { timeout: 0 });
        if (element) return element as ElementHandle<Element>;
    }
    return null;
}

async function pageText(page: Page): Promise<string> {
    return page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
}

async function clickNext(page: Page): Promise<void> {
    const button = await first(page, [
        "//input[@type='submit' and not(@disabled)]",
        "//button[@type='submit' and not(@disabled)]",
        "//button[@id='iSignupAction' or @id='idSIButton9' or @data-testid='primaryButton']",
        "//input[@id='iSignupAction' or @id='idSIButton9']",
        "//button[normalize-space(.)='Next' or normalize-space(.)='Yes' or normalize-space(.)='Accept' or normalize-space(.)='Continue' or normalize-space(.)='Create account']",
        "//input[@type='button' and (@value='Next' or @value='Yes' or @value='Accept')]"
    ]);
    if (!button) throw new Error('找不到可用的 Next/Submit 按钮');
    await button.click();
}

async function detectState(page: Page): Promise<RegistrationState> {
    const url = page.url();
    if (/^https:\/\/localhost\/?/i.test(url) && /[?&]code=/.test(url))
        return 'oauth-redirect';
    if (/login\.live\.com|login\.microsoftonline\.com/i.test(url) && await first(page, ["//input[@name='passwd' or @type='password']"]))
        return 'oauth-login';
    if (/login\.live\.com|login\.microsoftonline\.com/i.test(url) && await first(page, [
        "//input[@id='idSIButton9']",
        "//*[contains(translate(normalize-space(.), 'STAY SIGNED IN', 'stay signed in'), 'stay signed in')]",
        "//*[contains(translate(normalize-space(.), 'PERMISSIONS REQUESTED', 'permissions requested'), 'permissions requested')]",
        "//button[normalize-space(.)='Accept' or normalize-space(.)='Yes']"
    ]))
        return 'oauth-consent';

    const text = await pageText(page);
    if (/phone number|verify your phone|add a phone|security info|电话|手机号|验证你的手机/i.test(text)
        || await first(page, [
            "//input[contains(translate(@id,'PHONENUMBER','phonenumber'),'phone') or contains(translate(@name,'PHONENUMBER','phonenumber'),'phone')]",
            "//input[@type='tel']"
        ]))
        return 'phone';

    if (await page.$('iframe[data-e2e="enforcement-frame"], iframe#enforcementFrame, iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]')
        || /solve a puzzle|robot|captcha|安全验证/i.test(text))
        return 'captcha';

    if (/account\.microsoft\.com|outlook\.live\.com|office\.com\/mail|privacynotice\.account\.microsoft\.com/i.test(url)
        || /you.?re all set|your microsoft account|welcome/i.test(text))
        return 'success';

    if (await first(page, ["//input[@id='FirstName' or @name='FirstName' or @id='LastName' or @name='LastName']", "//select[@id='BirthMonth' or @name='BirthMonth']", "//input[@id='BirthYear' or @name='BirthYear']"]))
        return 'profile';
    if (await first(page, ["//input[@type='password' and not(@disabled)]", "//input[@id='Password' or @name='Password' or @id='iPassword']"]))
        return 'password';
    if (await first(page, ["//input[@id='MemberName' or @name='MemberName' or @type='email' or @name='loginfmt']", "//*[contains(translate(normalize-space(.), 'GET A NEW EMAIL', 'get a new email'), 'get a new email')]"]))
        return 'member-name';
    if (await first(page, ["//button[normalize-space(.)='Accept' or normalize-space(.)='Yes' or normalize-space(.)='Agree']"]))
        return 'consent';
    return 'unknown';
}

async function waitForState(page: Page, expected: RegistrationState[], timeoutMs = 45_000): Promise<RegistrationState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const state = await detectState(page);
        if (expected.includes(state)) return state;
        await Utility.waitForSeconds(0.5);
    }
    return detectState(page);
}

async function ensureNewEmailOption(page: Page): Promise<void> {
    const link = await first(page, [
        "//*[contains(translate(normalize-space(.), 'GET A NEW EMAIL ADDRESS', 'get a new email address'), 'get a new email')]",
        "//a[contains(@id,'liveSwitch') or contains(@href,'live')]"
    ]);
    if (link) await link.click();
}

async function fillMemberName(page: Page, localPart: string): Promise<string> {
    await ensureNewEmailOption(page);
    const email = `${localPart}@outlook.com`;
    const input = await first(page, [
        "//input[@id='MemberName' or @name='MemberName']",
        "//input[@type='email' and not(@disabled)]"
    ]);
    if (!input) throw new Error('找不到邮箱用户名输入框');
    await input.click({ count: 3 });
    await input.type(localPart, { delay: 40 });

    const domain = await first(page, ["//select[contains(@id,'LiveDomain') or contains(@name,'LiveDomain') or contains(@id,'Domain')]"]);
    if (domain) await domain.select('outlook.com').catch(async () => {
        await page.select('select[id*="LiveDomain"], select[name*="LiveDomain"], select[id*="Domain"]', 'outlook.com');
    });

    await clickNext(page);
    await Utility.waitForSeconds(1.5);
    const text = await pageText(page);
    if (/someone already has this|not available|unavailable|已被使用|不可用/i.test(text))
        throw new Error(`用户名不可用：${localPart}`);
    return email;
}

async function fillPassword(page: Page, password: string): Promise<void> {
    const input = await first(page, ["//input[@type='password' and not(@disabled)]"]);
    if (!input) throw new Error('找不到密码输入框');
    await input.type(password, { delay: 25 });
    await clickNext(page);
}

async function fillProfile(page: Page, firstName: string, lastName: string): Promise<void> {
    const firstInput = await first(page, ["//input[@id='FirstName' or @name='FirstName']"]);
    const lastInput = await first(page, ["//input[@id='LastName' or @name='LastName']"]);
    if (firstInput) await firstInput.type(firstName, { delay: 30 });
    if (lastInput) await lastInput.type(lastName, { delay: 30 });

    const country = await first(page, ["//select[@id='Country' or @name='Country']"]);
    if (country) await page.select('#Country, select[name="Country"]', 'US').catch(() => undefined);

    const month = String(randomInt(1, 12));
    const day = String(randomInt(1, 28));
    const year = String(randomInt(1985, 2002));
    for (const [selector, value] of [
        ["//select[@id='BirthMonth' or @name='BirthMonth']", month],
        ["//select[@id='BirthDay' or @name='BirthDay']", day],
        ["//select[@id='BirthYear' or @name='BirthYear']", year]
    ] as const) {
        if (await first(page, [selector])) {
            const id = selector.includes('BirthMonth') ? '#BirthMonth, select[name="BirthMonth"]'
                : selector.includes('BirthDay') ? '#BirthDay, select[name="BirthDay"]'
                    : '#BirthYear, select[name="BirthYear"]';
            await page.select(id, value).catch(() => undefined);
        }
    }
    for (const [selector, value] of [
        ["//input[@id='BirthMonth' or @name='BirthMonth']", month],
        ["//input[@id='BirthDay' or @name='BirthDay']", day],
        ["//input[@id='BirthYear' or @name='BirthYear']", year]
    ] as const) {
        const input = await first(page, [selector]);
        if (input) await input.type(value, { delay: 20 });
    }
    await clickNext(page);
}

function phoneBlockedError(): Error {
    return new Error('OUTLOOK_EXTERNAL_BLOCK {"category":"phone_verification_required","action":"出现手机号验证，按约定停止，请更换环境或账号后重试"}');
}

async function obtainRefreshToken(page: Page, email: string, password: string, evidence: (stage: string) => Promise<void>): Promise<string> {
    const redirectCode = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 OAuth 回调超时')), 120_000);
        const onNav = (frame: { url(): string }) => {
            const url = frame.url();
            if (!/^https:\/\/localhost\/?/i.test(url))
                return;
            try {
                const code = new URL(url).searchParams.get('code');
                const err = new URL(url).searchParams.get('error_description') || new URL(url).searchParams.get('error');
                if (code) {
                    clearTimeout(timer);
                    page.off('framenavigated', onNav);
                    resolve(code);
                }
                else if (err) {
                    clearTimeout(timer);
                    page.off('framenavigated', onNav);
                    reject(new Error(`OAuth 回调失败：${err}`));
                }
            }
            catch {
                // URL 解析失败时继续等待
            }
        };
        page.on('framenavigated', onNav);
    });

    await page.goto(buildAuthorizeUrl(email), { waitUntil: 'domcontentloaded' });
    await evidence('oauth-authorize');

    for (let i = 0; i < 8; i++) {
        const state = await detectState(page);
        await evidence(`oauth-${state}`);
        if (state === 'oauth-redirect')
            break;
        if (state === 'phone')
            throw phoneBlockedError();
        if (state === 'oauth-login') {
            if (await first(page, ["//input[@type='email' or @name='loginfmt']"])) {
                await page.type("//input[@type='email' or @name='loginfmt']", email);
                await clickNext(page);
                await Utility.waitForSeconds(1);
            }
            if (await first(page, ["//input[@type='password' or @name='passwd']"])) {
                await page.type("//input[@type='password' or @name='passwd']", password);
                await clickNext(page);
                await Utility.waitForSeconds(1);
            }
            continue;
        }
        if (state === 'oauth-consent' || state === 'consent' || state === 'success') {
            await clickNext(page).catch(() => undefined);
            await Utility.waitForSeconds(1);
            continue;
        }
        await Utility.waitForSeconds(1);
    }

    const code = await redirectCode;
    const tokens = await exchangeAuthorizationCode(code);
    return tokens.refreshToken;
}

(async () => {
    let chrome: Browser | undefined;
    let exiting = false;
    let evidenceStep = 0;
    const evidence = (page: Page, stage: string) => captureEvidence(page, ++evidenceStep, stage);
    const fail = async (error: unknown) => {
        if (exiting) return;
        exiting = true;
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        githubAnnotation('error', message);
        if (chrome) await screenshotAllPages(chrome);
        await chrome?.close().catch(() => undefined);
        process.exitCode = 1;
    };
    process.once('SIGTERM', () => void fail(new Error('SIGTERM: 终止请求')));
    process.once('unhandledRejection', error => void fail(error));

    try {
        await validateCapSolver();
        const localPart = generateLocalPart();
        const firstName = localPart.replace(/\d+$/, '').slice(0, 5) || 'James';
        const lastName = LAST_NAMES[randomInt(LAST_NAMES.length)];
        const password = generatePassword();
        let email = `${localPart}@outlook.com`;

        chrome = await puppeteer.launch({
            headless: os.platform() === 'linux', defaultViewport: null, protocolTimeout: MAX_TIMEOUT, slowMo: 20,
            handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
            args: ['--lang=en-US', '--window-size=1920,1080', '--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-zygote', '--disable-gpu']
        });
        logger.info(chrome.process()?.spawnfile, await chrome.version());
        const page = await chrome.newPage();
        await installTurnstileHook(page);
        const funCapture = installFunCaptchaCapture(page);

        await page.goto('https://signup.live.com/signup?lic=1&mkt=en-US');
        await evidence(page, 'signup-opened');
        await solveCloudflareIfPresent(page);
        await evidence(page, 'after-turnstile');

        for (let attempt = 0; attempt < 5; attempt++) {
            const state = await waitForState(page, ['member-name', 'password', 'profile', 'captcha', 'phone', 'consent', 'success']);
            await evidence(page, `register-${state}`);
            if (state === 'phone')
                throw phoneBlockedError();
            if (state === 'captcha') {
                await solveFunCaptchaIfPresent(page, funCapture);
                await clickNext(page).catch(() => undefined);
                continue;
            }
            if (state === 'member-name') {
                try {
                    email = await fillMemberName(page, attempt === 0 ? localPart : generateLocalPart());
                }
                catch (error) {
                    if (/用户名不可用/.test(String(error))) {
                        logger.warn(String(error));
                        continue;
                    }
                    throw error;
                }
                continue;
            }
            if (state === 'password') {
                await fillPassword(page, password);
                continue;
            }
            if (state === 'profile') {
                await fillProfile(page, firstName[0].toUpperCase() + firstName.slice(1), lastName[0].toUpperCase() + lastName.slice(1));
                continue;
            }
            if (state === 'consent') {
                await clickNext(page);
                continue;
            }
            if (state === 'success')
                break;
            await solveFunCaptchaIfPresent(page, funCapture, 5);
            await Utility.waitForSeconds(1);
        }

        const finalState = await detectState(page);
        await evidence(page, `register-final-${finalState}`);
        if (finalState === 'phone')
            throw phoneBlockedError();
        if (finalState !== 'success' && finalState !== 'consent' && finalState !== 'oauth-consent') {
            // 部分流程直接停在 account 页或 privacy notice，再尝试继续
            if (!/account\.microsoft|outlook\.live|office\.com|privacynotice/i.test(page.url()))
                throw new Error(`Outlook 注册未完成，当前状态：${finalState}，URL：${page.url().replace(/[?#].*$/, '')}`);
        }

        const refreshToken = await obtainRefreshToken(page, email, password, stage => evidence(page, stage));
        const credentials = { email, clientId: OUTLOOK_CLIENT_ID, refreshToken };
        await preflightOutlook(credentials);

        const line = [email, password, OUTLOOK_CLIENT_ID, refreshToken].join('----');
        Utility.appendStepSummary(line);
        // 避免日志打印完整 refresh token
        logger.info('Outlook 注册成功：%s****，凭据指纹：%s', email.slice(0, 4), createHash('sha256').update(line).digest('hex').slice(0, 12));
    }
    catch (error) {
        await fail(error);
    }
    finally {
        if (!exiting) await chrome?.close().catch(() => undefined);
    }
})();
