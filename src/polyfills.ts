if (typeof globalThis.CustomEvent === "undefined") {
  class CustomEventPolyfill<T = any> extends Event {
    detail: T;

    constructor(type: string, eventInitDict?: CustomEventInit<T>) {
      super(type, eventInitDict);
      this.detail = eventInitDict?.detail as T;
    }
  }

  globalThis.CustomEvent = CustomEventPolyfill as any;
}
