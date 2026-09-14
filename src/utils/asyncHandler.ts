/** Bridge promise-based handlers to EventEmitter/timers without losing rejections. */
export function asyncHandler<Args extends unknown[]>(
  handler: (...args: Args) => Promise<unknown>,
  onError: (error: unknown) => void,
): (...args: Args) => void {
  return (...args: Args): void => {
    void Promise.resolve().then(() => handler(...args)).catch(onError);
  };
}
