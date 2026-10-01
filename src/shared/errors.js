// Every expected failure in the lab is a LabError with a stable code.
// HTTP routes turn it into { error: { code, message, detail } } with `status`.
export class LabError extends Error {
  /**
   * @param {string} code    stable machine-readable code, e.g. 'CARD_NOT_ACTIVE'
   * @param {string} [message] human-readable English message
   * @param {number} [status]  HTTP status to use if this reaches an API response
   * @param {unknown} [detail] optional structured detail
   */
  constructor(code, message, status = 400, detail = undefined) {
    super(message || code);
    this.name = 'LabError';
    this.code = code;
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

export function isLabError(err) {
  return err instanceof LabError;
}
