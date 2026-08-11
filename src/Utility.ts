import fs from 'fs';
import { Mouse, Page } from "puppeteer";
import logger from './logger.js';

export default class Utility {
    static async waitForSeconds(delay: number) {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                resolve(null);
            }, Math.min(delay * 1000, Math.pow(2, 31) - 1));
        });
    }

    /**
     * Node 端实现的 waitForFunction，用于轮询等待某个异步条件成立
     * @param conditionFn - 返回你需要的值，不满足时返回 null/undefined
     * @param options - 轮询间隔和超时时间
     * @returns Promise<any>
     */
    static async waitForFunction<T>(
        conditionFn: () => Promise<T | null | undefined>,
        options: { pollInterval?: number; timeout?: number } = {}
    ): Promise<T> {
        const { pollInterval = 300, timeout = 300_000 } = options;
        const start = Date.now();

        while (true) {
            const result = await conditionFn();
            if (result !== null && result !== undefined)
                return result;

            if (Date.now() - start > timeout)
                throw new Error('waitForFunction timeout');

            await this.waitForSeconds(pollInterval / 1000);
        }
    }

    static appendStepSummary(data: string, logFunc: (_: string) => void = logger.info) {
        const { GITHUB_STEP_SUMMARY } = process.env;
        data = typeof data == "string" ? data : JSON.stringify(data, null, 4);
        GITHUB_STEP_SUMMARY && fs.appendFileSync(GITHUB_STEP_SUMMARY, data + "\n");
        logFunc(data);
    }

    /**
     * 获取指定页面坐标下的元素基本信息
     * @param page Playwright 或 Puppeteer 的 Page 对象
     * @param x 坐标 X
     * @param y 坐标 Y
     */
    static async getElementAtPoint(page: Page, x: number, y: number) {
        return await page.evaluate(([targetX, targetY]) => {
            const el = document.elementFromPoint(targetX, targetY) as HTMLElement;

            if (!el)
                return null;

            return {
                tagName: el.tagName,
                id: el.id,
                className: el.className,
                innerText: el.innerText,
                outerHTML: el.outerHTML.substring(0, 200),
                isVisible: el.offsetWidth > 0 && el.offsetHeight > 0
            };
        }, [x, y]);
    }

    static async humanLikeMouseMove(
        mouse: Mouse,
        from: { x: number, y: number },
        to: { x: number, y: number },
        steps = 45
    ) {
        const { x: startX, y: startY } = from;
        const { x: endX, y: endY } = to;

        // 随机控制点，生成一条自然的弧线
        const cx = startX + (endX - startX) / 2 + (Math.random() - 0.5) * 120;
        const cy = startY + (endY - startY) / 2 + (Math.random() - 0.5) * 120;

        for (let i = 1; i <= steps; i++) {
            let t = i / steps;
            
            // 使用 Ease-Out 缓动：人类移动鼠标通常是开头快，接近目标时减速瞄准
            t = t * (2 - t); 

            // 纯净的二次贝塞尔曲线，不加任何坐标 noise (重要！)
            const x = (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * cx + t * t * endX;
            const y = (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * cy + t * t * endY;

            await mouse.move(x, y);

            // 抖动体现在“速度”上，而不是“位置”上
            // 接近终点时，步间延迟变长（减速）
            const baseDelay = t > 0.8 ? 15 : 5; 
            const jitter = Math.random() * 8;
            await new Promise(r => setTimeout(r, baseDelay + jitter));
        }
    }
}