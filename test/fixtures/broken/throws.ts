export async function activate(): Promise<never> {
  throw new Error("broken fixture: synchronous activation failure");
}
