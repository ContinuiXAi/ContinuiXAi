import type { BarcodeSymbology } from "./schemas/barcode.js";

export type RetailBarcodeFormat = "UPC_E" | "EAN_8" | "UPC_A" | "EAN_13";

// 스캔/수동 입력으로 들어온 바코드 문자열의 자릿수만으로 심볼로지를 추정한다.
// 실제 체크섬 검증은 하지 않는다 — 라벨 렌더링(bwip-js bcid 선택)용 힌트면 충분하다.
// 스캔 포맷(실제 인식된 심볼로지)을 알고 있는 경우에는 이 추측 대신 그 값을 그대로 써야 한다.
export function guessSymbology(value: string): BarcodeSymbology {
  if (/^\d{13}$/.test(value)) return "EAN13";
  if (/^\d{12}$/.test(value)) return "UPCA";
  if (/^\d{6,}$/.test(value)) return "CODE128";
  return "OTHER";
}

function hasValidRetailCheckDigit(value: string) {
  if (!/^\d+$/.test(value) || value.length < 2) return false;
  let sum = 0;
  for (let index = 0; index < value.length - 1; index += 1) {
    const distanceFromCheck = value.length - 1 - index;
    sum += Number(value[index]) * (distanceFromCheck % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(value.at(-1));
}

function expandUpcEToUpcA(value: string) {
  if (!/^[01]\d{7}$/.test(value)) return null;
  const numberSystem = value[0];
  const compressed = value.slice(1, 7);
  const checkDigit = value[7];
  const lastCompressedDigit = compressed[5];
  let body: string;

  if (["0", "1", "2"].includes(lastCompressedDigit)) {
    body = `${numberSystem}${compressed.slice(0, 2)}${lastCompressedDigit}0000${compressed.slice(2, 5)}`;
  } else if (lastCompressedDigit === "3") {
    body = `${numberSystem}${compressed.slice(0, 3)}00000${compressed.slice(3, 5)}`;
  } else if (lastCompressedDigit === "4") {
    body = `${numberSystem}${compressed.slice(0, 4)}00000${compressed[4]}`;
  } else {
    body = `${numberSystem}${compressed.slice(0, 5)}0000${lastCompressedDigit}`;
  }

  const expanded = `${body}${checkDigit}`;
  return hasValidRetailCheckDigit(expanded) ? expanded : null;
}

function compressUpcAToUpcE(value: string) {
  if (!/^[01]\d{11}$/.test(value) || !hasValidRetailCheckDigit(value)) return null;
  const body = value.slice(0, 11);
  const numberSystem = body[0];
  const checkDigit = value[11];
  let compressed: string | null = null;

  if (["0", "1", "2"].includes(body[3]) && body.slice(4, 8) === "0000") {
    compressed = `${numberSystem}${body.slice(1, 3)}${body.slice(8, 11)}${body[3]}${checkDigit}`;
  } else if (body.slice(4, 9) === "00000") {
    compressed = `${numberSystem}${body.slice(1, 4)}${body.slice(9, 11)}3${checkDigit}`;
  } else if (body.slice(5, 10) === "00000") {
    compressed = `${numberSystem}${body.slice(1, 5)}${body[10]}4${checkDigit}`;
  } else if (body.slice(6, 10) === "0000" && /^[5-9]$/.test(body[10])) {
    compressed = `${numberSystem}${body.slice(1, 6)}${body[10]}${checkDigit}`;
  }

  return compressed && expandUpcEToUpcA(compressed) === value ? compressed : null;
}

/**
 * Returns the zero-suppressed UPC-E representation of a UPC identity when one
 * exists. Callers must retain it as a typed UPC alias: an eight-digit value can
 * independently be a valid EAN-8 and must never be treated as an untyped alias.
 */
export function upcEAliasForRetailBarcode(value: string) {
  const raw = value.trim();
  const upcA = /^[01]\d{7}$/.test(raw)
    ? expandCanonicalUpcE(raw)
    : /^\d{12}$/.test(raw) && hasValidRetailCheckDigit(raw)
      ? raw
      : /^0\d{12}$/.test(raw) && hasValidRetailCheckDigit(raw)
        ? raw.slice(1)
        : null;
  return upcA ? compressUpcAToUpcE(upcA) : null;
}

function expandCanonicalUpcE(value: string) {
  const expanded = expandUpcEToUpcA(value);
  return expanded && compressUpcAToUpcE(expanded) === value ? expanded : null;
}

/**
 * Infers a retail format only when the digits and check digit establish one
 * meaning. Some eight-digit values are valid as both UPC-E and EAN-8; those
 * deliberately return null so callers retain or request explicit metadata.
 */
export function inferRetailBarcodeFormat(value: string): RetailBarcodeFormat | null {
  const raw = value.trim();
  if (/^\d{12}$/.test(raw)) return hasValidRetailCheckDigit(raw) ? "UPC_A" : null;
  if (/^\d{13}$/.test(raw)) return hasValidRetailCheckDigit(raw) ? "EAN_13" : null;
  if (!/^\d{8}$/.test(raw)) return null;

  const isUpcE = Boolean(expandCanonicalUpcE(raw));
  const isEan8 = hasValidRetailCheckDigit(raw);
  if (isUpcE === isEan8) return null;
  return isUpcE ? "UPC_E" : "EAN_8";
}

export function normalizeRetailBarcode(value: string, format?: string) {
  const trimmed = value.trim();
  const normalizedFormat = format?.toLowerCase().replaceAll("-", "_");
  if (normalizedFormat === "upc_e") return expandCanonicalUpcE(trimmed);
  if (!["upc_a", "ean_13", "ean_8"].includes(normalizedFormat ?? "")) return trimmed || null;
  const expectedLength = normalizedFormat === "ean_8" ? 8 : normalizedFormat === "ean_13" ? 13 : 12;
  if (trimmed.length !== expectedLength || !hasValidRetailCheckDigit(trimmed)) return null;
  return normalizedFormat === "ean_13" && trimmed.startsWith("0") ? trimmed.slice(1) : trimmed;
}

/**
 * Returns every safe textual representation of the same retail identity.
 * The scanned value is always first so exact catalog matches retain priority.
 * An unknown 8-digit value is expanded only when it is valid UPC-E and is not
 * also valid EAN-8; ambiguous labels must keep their exact identity.
 */
export function retailBarcodeEquivalents(value: string) {
  const raw = value.trim();
  if (!raw) return [];
  const equivalents = new Set<string>([raw]);
  let upcA: string | null = null;

  if (/^\d{12}$/.test(raw) && hasValidRetailCheckDigit(raw)) {
    upcA = raw;
  } else if (/^0\d{12}$/.test(raw) && hasValidRetailCheckDigit(raw)) {
    upcA = raw.slice(1);
  } else if (/^[01]\d{7}$/.test(raw) && !hasValidRetailCheckDigit(raw)) {
    upcA = expandCanonicalUpcE(raw);
  }

  if (!upcA) return [...equivalents];
  equivalents.add(upcA);
  equivalents.add(`0${upcA}`);
  const upcE = compressUpcAToUpcE(upcA);
  if (upcE && !hasValidRetailCheckDigit(upcE)) equivalents.add(upcE);
  return [...equivalents];
}

/**
 * Returns the alternate identity only when an eight-digit value is valid both
 * as EAN-8 and as UPC-E (or when a UPC-A/EAN-13 value compresses to that dual-
 * valid form). The two values are intentionally NOT declared equivalent: a
 * caller may use this only to detect catalog conflicts and request symbology.
 */
export function ambiguousRetailBarcodeAlternate(value: string) {
  const raw = value.trim();
  if (/^[01]\d{7}$/.test(raw) && hasValidRetailCheckDigit(raw)) {
    return expandCanonicalUpcE(raw);
  }

  const upcA = /^\d{12}$/.test(raw) && hasValidRetailCheckDigit(raw)
    ? raw
    : /^0\d{12}$/.test(raw) && hasValidRetailCheckDigit(raw)
      ? raw.slice(1)
      : null;
  if (!upcA) return null;
  const compressed = compressUpcAToUpcE(upcA);
  return compressed && hasValidRetailCheckDigit(compressed) ? compressed : null;
}

export function retailBarcodeLookupCandidates(value: string) {
  const candidates = new Set(retailBarcodeEquivalents(value));
  const ambiguousAlternate = ambiguousRetailBarcodeAlternate(value);
  if (ambiguousAlternate) {
    for (const candidate of retailBarcodeEquivalents(ambiguousAlternate)) candidates.add(candidate);
  }
  return [...candidates];
}

export function preferredRetailBarcode(value: string) {
  const raw = value.trim();
  return retailBarcodeEquivalents(raw).find((candidate) => /^\d{12}$/.test(candidate)) ?? raw;
}
