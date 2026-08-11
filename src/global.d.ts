import 'puppeteer';

declare module 'puppeteer' {
    interface Frame {
        $x<Selector extends string>(
            selector: Selector,
            options?: WaitForSelectorOptions
        ): Promise<ElementHandle<NodeFor<Selector>> | null>;

        textContent<Selector extends string>(
            selector: Selector,
            options?: WaitForSelectorOptions
        ): Promise<string>;
    }

    interface Page {
        $x<Selector extends string>(
            selector: Selector,
            options?: WaitForSelectorOptions
        ): Promise<ElementHandle<NodeFor<Selector>> | null>;

        textContent<Selector extends string>(
            selector: Selector,
            options?: WaitForSelectorOptions
        ): Promise<string>;
    }

    interface GoToOptions {
        retries?: number;
    }

    interface QueryOptions {
        timeout?: number;
        isolate?: boolean;
    }

    interface ClickOptions {
        timeout?: number;
    }

    interface KeyboardTypeOptions {
        timeout?: number;
    }
}
