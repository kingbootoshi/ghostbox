declare namespace JSX {
  type Element = {};
  type ElementClass = {};
  interface ElementAttributesProperty {
    props: {};
  }
  interface IntrinsicAttributes {
    key?: string | number;
  }
  interface IntrinsicElements {
    [elementName: string]: any;
  }
}

declare module "react" {
  export type ReactNode = any;
  export function useState<T>(initialState: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void];
  export function useEffect(
    effect: () => void | (() => void | Promise<void> | undefined),
    dependencies?: readonly unknown[]
  ): void;
  export function useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T;
  export function useCallback<T extends (...args: any[]) => any>(callback: T, dependencies: readonly unknown[]): T;
  export function useRef<T>(value: T): { current: T };
  export const Fragment: any;
}

declare module "react/jsx-runtime" {
  export const Fragment: any;
  export function jsx(type: any, props: any, key?: any): any;
  export function jsxs(type: any, props: any, key?: any): any;
  export function jsxDEV(type: any, props: any, key?: any): any;
}

declare module "ink" {
  export const Box: any;
  export const Text: any;
  export function render(tree: any): {
    waitUntilExit: () => Promise<void>;
    unmount: () => void;
  };
  export function useInput(
    handler: (
      input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        leftArrow?: boolean;
        rightArrow?: boolean;
        return?: boolean;
        escape?: boolean;
        ctrl?: boolean;
        tab?: boolean;
      }
    ) => void | Promise<void>
  ): void;
}

declare module "@inkjs/ui" {
  export const TextInput: any;
  export const Spinner: any;
}

declare module "ink-markdown" {
  const Markdown: any;
  export default Markdown;
}
