
/** Stands in for any `.svelte` import; the components need a DOM to compile. */
export default class SvelteComponentStub {
  constructor(_options?: any) {}
  $set(_props?: any) {}
  $destroy() {}
}
