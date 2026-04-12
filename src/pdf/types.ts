/**
 * PDF renderer interface — library-agnostic types.
 *
 * Tools produce data objects (InvoiceData, PaystubData).
 * Renderers turn data into PDF buffers.
 * To swap PDF libraries: implement PdfRenderer, change the factory in index.ts.
 */

// ── Company / Client ──────────────────────────────────

export interface CompanyInfo {
  name: string;
  address: string[];
  email: string;
  phone: string;
  website: string;
}

// ── Invoice ───────────────────────────────────────────

export interface InvoiceLineItem {
  service: string;
  description: string; // e.g., "March Hours Worked\n03/02 - 03/06\n..."
  quantity: number;
  rate: number;
}

export interface InvoiceData {
  invoiceNumber: number;
  invoiceDate: string; // MM/DD/YYYY
  dueDate: string; // MM/DD/YYYY
  terms: string; // e.g., "Net 15"
  from: CompanyInfo;
  billTo: string;
  shipTo: string;
  lineItems: InvoiceLineItem[];
  logo?: Buffer; // PNG bytes (optional)
}

// ── Pay Stub ──────────────────────────────────────────

export interface PaystubDeduction {
  label: string;
  amount: number;
}

export interface PaystubData {
  employee: string;
  entity: string;
  period: string; // e.g., "April 2026"
  payDate: string; // MM/DD/YYYY
  gross: number;
  deductions: PaystubDeduction[];
  adjustments?: PaystubDeduction[]; // e.g., catch-up withholding corrections
  netPay: number;
  ytdGross: number;
  employerCosts: PaystubDeduction[];
}

// ── Renderer Interface ────────────────────────────────

export interface PdfRenderer {
  renderInvoice(data: InvoiceData): Promise<Buffer>;
  renderPaystub(data: PaystubData): Promise<Buffer>;
}
