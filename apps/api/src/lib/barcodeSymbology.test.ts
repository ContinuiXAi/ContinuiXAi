import { describe, expect, it } from "vitest";
import { guessSymbology } from "@continuixai/shared";
import * as sharedBarcode from "@continuixai/shared";

describe("guessSymbology", () => {
  it("detects EAN13 for 13-digit values", () => {
    expect(guessSymbology("0049000028911")).toBe("EAN13");
  });

  it("detects UPCA for 12-digit values", () => {
    expect(guessSymbology("012345678905")).toBe("UPCA");
  });

  it("detects CODE128 for other numeric values with 6+ digits", () => {
    expect(guessSymbology("123456")).toBe("CODE128");
    expect(guessSymbology("1234567890")).toBe("CODE128");
  });

  it("falls back to OTHER for short or non-numeric values", () => {
    expect(guessSymbology("12345")).toBe("OTHER");
    expect(guessSymbology("HD-abc123")).toBe("OTHER");
    expect(guessSymbology("http://localhost:3000/i/abc123")).toBe("OTHER");
  });
});

describe("retail barcode identity", () => {
  it("treats the camera, handheld, and EAN wrapper forms of one UPC as equivalent", () => {
    const equivalents = (sharedBarcode as typeof sharedBarcode & {
      retailBarcodeEquivalents?: (value: string) => string[];
    }).retailBarcodeEquivalents;

    expect(equivalents).toBeTypeOf("function");
    expect(equivalents?.("04210007")).toEqual([
      "04210007",
      "042000001007",
      "0042000001007",
    ]);
    expect(equivalents?.("042000001007")).toEqual([
      "042000001007",
      "0042000001007",
      "04210007",
    ]);
    expect(equivalents?.("0042000001007")).toEqual([
      "0042000001007",
      "042000001007",
      "04210007",
    ]);
  });

  it("does not reinterpret a valid EAN-8 as UPC-E when the symbology is unknown", () => {
    const equivalents = (sharedBarcode as typeof sharedBarcode & {
      retailBarcodeEquivalents?: (value: string) => string[];
    }).retailBarcodeEquivalents;
    const preferred = (sharedBarcode as typeof sharedBarcode & {
      preferredRetailBarcode?: (value: string) => string;
    }).preferredRetailBarcode;

    expect(equivalents).toBeTypeOf("function");
    expect(preferred).toBeTypeOf("function");
    expect(equivalents?.("96385074")).toEqual(["96385074"]);
    expect(preferred?.("96385074")).toBe("96385074");
    expect(equivalents?.("00000055")).toEqual(["00000055"]);
    expect(preferred?.("00000055")).toBe("00000055");
  });

  it("exposes a dual-valid EAN-8/UPC-E alternate for conflict detection without treating it as equivalent", () => {
    const ambiguousAlternate = (sharedBarcode as typeof sharedBarcode & {
      ambiguousRetailBarcodeAlternate?: (value: string) => string | null;
    }).ambiguousRetailBarcodeAlternate;

    expect(ambiguousAlternate).toBeTypeOf("function");
    expect(ambiguousAlternate?.("01234558")).toBe("012345000058");
    expect(ambiguousAlternate?.("012345000058")).toBe("01234558");
    expect(ambiguousAlternate?.("04210007")).toBeNull();

    const lookupCandidates = (sharedBarcode as typeof sharedBarcode & {
      retailBarcodeLookupCandidates?: (value: string) => string[];
    }).retailBarcodeLookupCandidates;
    expect(lookupCandidates?.("01234558")).toEqual([
      "01234558",
      "012345000058",
      "0012345000058",
    ]);
  });

  it("returns a typed UPC-E alias without declaring it to be an EAN-8 equivalent", () => {
    const alias = (sharedBarcode as typeof sharedBarcode & {
      upcEAliasForRetailBarcode?: (value: string) => string | null;
    }).upcEAliasForRetailBarcode;

    expect(alias).toBeTypeOf("function");
    expect(alias?.("012345000058")).toBe("01234558");
    expect(alias?.("042000001007")).toBe("04210007");
  });

  it("infers a retail format only when the check digit and meaning are unambiguous", () => {
    const infer = (sharedBarcode as typeof sharedBarcode & {
      inferRetailBarcodeFormat?: (value: string) => string | null;
    }).inferRetailBarcodeFormat;

    expect(infer).toBeTypeOf("function");
    expect(infer?.("04210007")).toBe("UPC_E");
    expect(infer?.("96385074")).toBe("EAN_8");
    expect(infer?.("01234558")).toBeNull();
    expect(infer?.("042000001007")).toBe("UPC_A");
    expect(infer?.("0042000001007")).toBe("EAN_13");
    expect(infer?.("000123456789")).toBeNull();
  });
});
