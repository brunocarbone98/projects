// The visitor's address, as the web server forwards it to the API.
//
// The API's rate limits count per visitor because the web server, the only caller the API trusts
// with X-Forwarded-For (it trusts loopback only), tells it who the visitor is. That address comes
// from X-Real-IP, which Railway's edge documents as the client's address. X-Forwarded-For is never
// read: Railway does not document its format, and its last entry can be the edge's own address,
// shared by many visitors. Nor is an address of a host or platform network ever forwarded: it would
// put every visitor behind that hop in one bucket.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;

function ipv4Octets(value: string): number[] | undefined {
  const match = IPV4.exec(value);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

/** The eight 16-bit groups of an IPv6 address (with an optional dotted IPv4 tail), or undefined. */
function ipv6Groups(value: string): number[] | undefined {
  let text = value;
  const lastColon = text.lastIndexOf(":");
  if (lastColon === -1) return undefined;
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = ipv4Octets(tail);
    if (!octets) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const split = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const head = split(halves[0] ?? "");
  const rest = halves.length === 2 ? split(halves[1] ?? "") : [];
  if (![...head, ...rest].every((group) => HEX_GROUP.test(group))) return undefined;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const parse = (group: string): number => Number.parseInt(group, 16);
  const zeros = Array<number>(halves.length === 2 ? missing : 0).fill(0);
  return [...head.map(parse), ...zeros, ...rest.map(parse)];
}

/** "This network", private, shared (CGNAT), loopback, link-local, multicast and reserved ranges. */
function isInternalIpv4([a = 0, b = 0]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Unspecified, loopback, unique-local, link-local, multicast, or an IPv4-mapped internal address. */
function isInternalIpv6(groups: number[]): boolean {
  const [first = 0] = groups;
  const leadingZeros = groups.slice(0, 5).every((group) => group === 0);
  if (leadingZeros && groups[5] === 0xffff) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return isInternalIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  if (leadingZeros && groups[5] === 0 && groups[6] === 0 && (groups[7] ?? 0) <= 1) return true;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/** True when the value is an IP address that belongs to no host or platform network. */
export function isPublicAddress(value: string): boolean {
  const octets = ipv4Octets(value);
  if (octets) return !isInternalIpv4(octets);
  const groups = value.includes(":") ? ipv6Groups(value) : undefined;
  return groups !== undefined && !isInternalIpv6(groups);
}

/**
 * The address to forward to the API for the request whose X-Real-IP header is given, or undefined.
 * Without a public address (no proxy in front, as in local runs and CI) there is nothing to forward,
 * and the API applies its loopback rules instead of counting every visitor as one.
 */
export function visitorAddress(realIp: string | null | undefined): string | undefined {
  const address = realIp?.trim() ?? "";
  return isPublicAddress(address) ? address : undefined;
}
