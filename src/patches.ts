import util from 'util';
import moment from 'moment';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Awaitable, ClickOptions, ElementHandle, Frame, GoToOptions, HTTPResponse, KeyboardTypeOptions, NodeFor, Page, QueryOptions, ScreenshotOptions, WaitForNetworkIdleOptions, WaitForOptions, WaitForSelectorOptions, WaitTimeoutOptions } from 'puppeteer';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { STATUS_CODES } from 'http';
import logger from './logger.js';
import Utility from './Utility.js';

const $ = Frame.prototype.$;

Date.prototype[util.inspect.custom] = function () {
    return moment(this).format('YYYY-MM-DD HH:mm:ss.SSS');
};

Date.prototype.toString = function () {
    return moment(this).format('YYYY-MM-DD HH:mm:ss.SSS');
};

const originalScreenshot = Page.prototype.screenshot;
Page.prototype.screenshot = async function (this: Page, options?: Readonly<ScreenshotOptions>): Promise<Uint8Array> {
    logger.info("screenshot", this.url(), options?.path || "");

    for (const frame of this.frames()) {
        logger.info({ title: await frame.title(), url: frame.url() });
    }

    if (options?.path) {
        const dir = path.dirname(options.path);
        fs.mkdirSync(dir, { recursive: true });
    }

    return originalScreenshot.call(this, options);
} as any;

const originalGoto = Page.prototype.goto;
Page.prototype.goto = async function (
    this: Page,
    url: string,
    options?: GoToOptions
): Promise<HTTPResponse | null> {
    const defaultUA = await this.browser().userAgent();
    await this.setUserAgent(defaultUA.replace('HeadlessChrome/', 'Chrome/'));

    let retries = options?.retries ?? 5;
    while (retries-- > 0) {
        try {
            logger.info("⏳goto", url, (options && JSON.stringify(options)) ?? "");

            const response = await originalGoto.call(this, url, options);
            if (response) {
                if (response.ok())
                    return response;

                logger.error("❌goto", url, (options && JSON.stringify(options)) ?? "", response.status(), STATUS_CODES[response.status()]);
            }
            else {
                logger.warn("⚠️goto", url, (options && JSON.stringify(options)) ?? "");
            }
        }
        catch (e) {
            logger.error("❌goto", url, (options && JSON.stringify(options)) ?? "", e.message);
        }

        await Utility.waitForSeconds(1);
    }
};

const originalWaitForNavigation = Page.prototype.waitForNavigation;
Page.prototype.waitForNavigation = async function (
    this: Page,
    options?: WaitForOptions
): Promise<HTTPResponse | null> {
    logger.info("⏳waitForNavigation", this.url(), (options && JSON.stringify(options)) ?? "");

    try {
        const response = await originalWaitForNavigation.call(this, options);

        if (response) {
            if (response.ok())
                logger.info("✅waitForNavigation", this.url());
            else
                logger.error("❌waitForNavigation", this.url(), (options && JSON.stringify(options)) ?? "", response.status(), STATUS_CODES[response.status()]);
        }
        else {
            logger.warn("⚠️waitForNavigation", this.url(), (options && JSON.stringify(options)) ?? "");
        }

        return response;
    }
    catch (e) {
        logger.error("❌waitForNavigation", this.url(), (options && JSON.stringify(options)) ?? "", e.message);
    }
};

const originalWaitForNetworkIdle = Page.prototype.waitForNetworkIdle;
Page.prototype.waitForNetworkIdle = async function (
    this: Page,
    options?: WaitForNetworkIdleOptions
): Promise<void> {
    logger.info("⏳waitForNetworkIdle", this.url(), (options && JSON.stringify(options)) ?? "");

    try {
        await originalWaitForNetworkIdle.call(this, options);
        logger.info("✅waitForNetworkIdle", this.url());
    }
    catch (e) {
        logger.error("❌waitForNetworkIdle", this.url(), (options && JSON.stringify(options)) ?? "", e.message);
    }
};

Frame.prototype.click = async function (
    this: Frame,
    selector: string,
    options?: Readonly<ClickOptions>
): Promise<void> {
    const handle = await this.waitForSelector(selector, options);
    if (!handle)
        throw new Error(`无法点击元素，选择器未匹配: ${selector}`);
    return handle.click(options);
};

const originalType = Frame.prototype.type;
Frame.prototype.type = async function (
    this: Frame,
    selector: string,
    text: string,
    options?: Readonly<KeyboardTypeOptions>
): Promise<void> {
    const handle = await this.waitForSelector(selector, options);
    if (!handle)
        throw new Error(`无法输入文本，选择器未匹配: ${selector}`);
    await handle.click({ count: 3 });
    return originalType.call(this, selector.startsWith("xpath=") ? selector : `xpath=${selector}`, text, options);
};

const title = Frame.prototype.title;
Frame.prototype.title = async function (
    this: Frame
): Promise<string> {
    try {
        return await title.call(this);
    }
    catch (e) {
        logger.error("title", e.message);
    }
};

Frame.prototype.waitForSelector = async function <Selector extends string>(
    this: Frame,
    selector: Selector,
    options?: WaitForSelectorOptions
): Promise<ElementHandle<NodeFor<Selector>> | null> {
    const config = { visible: true, timeout: 10_000, ...options };

    if (config.hidden)
        config.visible = false;

    const timeout = config.timeout ?? 10_000;
    const endTime = Date.now() + timeout;

    const page = this.page();
    const isMainFrame = page.mainFrame() == this;

    if (timeout >= 30_000)
        logger.info("⏳waitForSelector", selector, (options && JSON.stringify(options)) ?? "");

    do {
        try {
            const elementHandle = await $.call(isMainFrame ? page.mainFrame() : this, selector.startsWith("xpath=") ? selector : `xpath=${selector}`);
            if (elementHandle) {
                if (config.visible && await elementHandle.isVisible())
                    return elementHandle;

                if (config.hidden && await elementHandle.isHidden())
                    return elementHandle;

                if (!config.visible && !config.hidden)
                    return elementHandle;
            }
        }
        catch (e) {
            logger.warn("⚠️waitForSelector", selector, (options && JSON.stringify(options)) ?? "", e.message);
        }

        if (Date.now() >= endTime)
            break;

        await Utility.waitForSeconds(0.2);
    } while (true);

    if (config.timeout)
        logger.error(`❌Waiting for selector \`${selector}\` failed: ${config.timeout}ms exceeded`);
};

Page.prototype.waitForFrame = async function (
    this: Page,
    urlOrPredicate: string | ((frame: Frame) => Awaitable<boolean>),
    options?: WaitTimeoutOptions
): Promise<Frame> {
    const timeout = options?.timeout ?? 30_000;
    const endTime = Date.now() + timeout;

    logger.info("⏳waitForFrame", (options && JSON.stringify(options)) ?? "");

    do {
        for (const frame of this.frames()) {
            if (frame.url() == urlOrPredicate)
                return frame;

            try {
                if (typeof urlOrPredicate == 'function' && await urlOrPredicate(frame))
                    return frame;
            }
            catch (e) {
                logger.warn("⚠️waitForFrame", (options && JSON.stringify(options)) ?? "", e.message);
            }
        }

        if (Date.now() >= endTime)
            break;

        await Utility.waitForSeconds(0.2);
    } while (true);

    logger.error(`❌waitForFrame TimeoutError: Timed out after waiting ${timeout}ms`);
};

Frame.prototype.$ = function <Selector extends string>(
    this: Frame,
    selector: Selector
): Promise<ElementHandle<NodeFor<Selector>> | null> {
    return this.$x(selector, { timeout: 0 });
};

const $$ = Frame.prototype.$$;
Frame.prototype.$$ = async function <Selector extends string>(
    this: Frame,
    selector: Selector,
    options?: QueryOptions
): Promise<Array<ElementHandle<NodeFor<Selector>>>> {
    if (options?.timeout)
        await this.waitForSelector(selector, options);

    return $$.call(this, selector.startsWith("xpath=") ? selector : `xpath=${selector}`, options);
};

Frame.prototype.$x = function <Selector extends string>(
    this: Frame,
    selector: Selector,
    options?: WaitForSelectorOptions
): Promise<ElementHandle<NodeFor<Selector>> | null> {
    return this.waitForSelector(selector, options);
};

Page.prototype.$x = function <Selector extends string>(
    this: Page,
    selector: Selector,
    options?: WaitForSelectorOptions
): Promise<ElementHandle<NodeFor<Selector>> | null> {
    return this.mainFrame().$x(selector, options);
};

Frame.prototype.textContent = async function <Selector extends string>(
    this: Frame,
    selector: Selector,
    options?: WaitForSelectorOptions
): Promise<string> {
    const el = await this.$x(selector, options);
    return el && el.evaluate((el: Element) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
            return el.value.trim();

        return (el.textContent ?? '').trim();
    });
};

Page.prototype.textContent = async function <Selector extends string>(
    this: Page,
    selector: Selector,
    options?: WaitForSelectorOptions
): Promise<string> {
    return this.mainFrame().textContent(selector, options);
};

const agent = os.platform() == 'linux' ? undefined : new SocksProxyAgent('socks5://127.0.0.1:10808');
const originalGet = axios.get;
axios.get = function <T = any, R = AxiosResponse<T>, D = any>(
    url: string,
    config?: AxiosRequestConfig<D>
): Promise<R> {
    const newConfig: AxiosRequestConfig<D> = {
        ...config,
        httpAgent: agent,
        httpsAgent: agent,
    };
    return originalGet.call(this, url, newConfig);
};