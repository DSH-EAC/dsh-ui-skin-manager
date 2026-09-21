export async function activate(): Promise<never> {
  return Promise.reject(new Error("broken fixture: rejected activation"));
}
