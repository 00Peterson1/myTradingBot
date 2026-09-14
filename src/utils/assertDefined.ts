/** Fail explicitly when a required indexed value or initialized resource is absent. */
export function assertDefined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Required value is missing');
  }
  return value;
}
