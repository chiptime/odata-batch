export function flatten<T>(arr: (T | T[])[]): T[] {
    return ([] as T[]).concat(...arr);
}
