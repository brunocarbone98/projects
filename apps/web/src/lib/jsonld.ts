// Serialises a JSON-LD object for inline <script> injection.
// JSON.stringify does not escape "<", ">" or "&", so a value containing
// "</script>" (e.g. a courier-entered location) could break out of the script
// block — a stored-XSS vector. We escape those plus the JSON line separators
// (U+2028 / U+2029), keeping the JSON valid.
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), "g");
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), "g");

export function jsonLdString(data: unknown): string {
  return JSON.stringify(data)
    .replace(/[<>&]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(LINE_SEPARATOR, "\\u2028")
    .replace(PARAGRAPH_SEPARATOR, "\\u2029");
}
