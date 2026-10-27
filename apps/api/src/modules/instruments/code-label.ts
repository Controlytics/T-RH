// An instrument code as it may appear inside an audit row's signature meaning.
// `audit_trail.signature_meaning` is VARCHAR(255) and the insert is raw SQL, so
// an over-long meaning is a 500, not a truncation — a free-text code is capped.
const SIGNATURE_CODE_MAX = 80;

export function codeLabel(code: string): string {
  return code.length <= SIGNATURE_CODE_MAX ? code : `${code.slice(0, SIGNATURE_CODE_MAX)}…`;
}
