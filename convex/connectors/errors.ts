/**
 * An error whose message a connector wrote itself, in words chosen to be safe
 * to store. The run log shows these and the registry's validation messages,
 * and nothing else: any other thrown message may quote a URL, a header or a
 * response body.
 *
 * The registry's validation messages are safe to store only while a
 * connector's rows hold no strings chosen by the source: a message such as
 * `Unsupported currency "…"` quotes the row. Mercury's rows are built from
 * literals (the metric key, scope, period and currency are ours; only numbers
 * and dates come from Mercury), so its messages cannot carry anything Mercury
 * sent. A future connector must keep to that, or validate differently.
 */
export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorError";
  }
}
