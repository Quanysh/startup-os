// A top-level navigation away from the app: where OAuth's consent page sends
// the browser back to the client. In a module of its own so a test can see
// where it went.
export function leaveTo(address: string): void {
  window.location.assign(address);
}
