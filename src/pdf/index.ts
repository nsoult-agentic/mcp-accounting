/**
 * PDF renderer factory.
 *
 * To swap PDF libraries:
 * 1. Create a new renderer (e.g., jspdf-renderer.ts) implementing PdfRenderer
 * 2. Change the import and return below
 * 3. No other files need to change
 */

import { PdfMakeRenderer } from "./pdfmake-renderer.js";
import type { PdfRenderer } from "./types.js";

export function createRenderer(): PdfRenderer {
  return new PdfMakeRenderer();
}

export type {
  PdfRenderer,
  InvoiceData,
  InvoiceLineItem,
  CompanyInfo,
  PaystubData,
  PaystubDeduction,
} from "./types.js";
