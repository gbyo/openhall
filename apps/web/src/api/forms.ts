export function formString(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

export function formStrings(data: FormData, name: string): string[] {
  return data.getAll(name).filter((value): value is string => typeof value === 'string');
}
