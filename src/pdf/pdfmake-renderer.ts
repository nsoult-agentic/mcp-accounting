/**
 * pdfmake implementation of PdfRenderer.
 *
 * THIS IS THE ONLY FILE THAT IMPORTS PDFMAKE.
 * All other code uses the PdfRenderer interface from types.ts.
 */

import type {
  PdfRenderer,
  InvoiceData,
  PaystubData,
} from "./types.js";

// pdfmake 0.3.x — no TypeScript declarations, use require + any
// @ts-expect-error — pdfmake has no .d.ts
import pdfMake from "pdfmake";
// @ts-expect-error — pdfmake font module
import RobotoFonts from "pdfmake/fonts/Roboto.js";

// Register fonts
pdfMake.fonts = RobotoFonts;

// ── Types (internal to this file) ─────────────────────

type Content = any;
type TableCell = any;
type DocDefinition = any;

// ── Helpers ───────────────────────────────────────────

function usd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function pdfToBuffer(docDefinition: DocDefinition): Promise<Buffer> {
  const doc = pdfMake.createPdf(docDefinition);
  return doc.getBuffer();
}

// ── Colors ────────────────────────────────────────────

const BLUE_HEADER = "#3B82F6";
const LIGHT_BG = "#EFF6FF";
const DARK_TEXT = "#1F2937";
const GRAY_TEXT = "#6B7280";

// ── Invoice Renderer ──────────────────────────────────

function buildInvoiceDoc(data: InvoiceData): DocDefinition {
  const lineTotal = (item: { quantity: number; rate: number }) =>
    item.quantity * item.rate;
  const total = data.lineItems.reduce((sum, item) => sum + lineTotal(item), 0);

  // Line items table
  const tableHeader: TableCell[] = [
    { text: "#", style: "tableHeader" },
    { text: "Product or service", style: "tableHeader" },
    { text: "Description", style: "tableHeader" },
    { text: "Qty", style: "tableHeader", alignment: "right" },
    { text: "Rate", style: "tableHeader", alignment: "right" },
    { text: "Amount", style: "tableHeader", alignment: "right" },
  ];

  const tableRows: TableCell[][] = data.lineItems.map((item, i) => [
    { text: `${i + 1}.`, color: DARK_TEXT },
    { text: item.service, bold: true, color: DARK_TEXT },
    { text: item.description, color: DARK_TEXT },
    { text: String(item.quantity), alignment: "right", color: DARK_TEXT },
    { text: usd(item.rate), alignment: "right", color: DARK_TEXT },
    { text: usd(lineTotal(item)), alignment: "right", color: DARK_TEXT },
  ]);

  // Logo (PNG buffer → base64 data URI, or text fallback)
  const logoContent: Content = data.logo
    ? { image: `data:image/png;base64,${data.logo.toString("base64")}`, width: 150, alignment: "right" }
    : { text: data.from.name, style: "logo", alignment: "right" };

  const content: Content[] = [
    // Header: company info + contact + logo
    {
      columns: [
        {
          width: "*",
          stack: [
            { text: "INVOICE", style: "invoiceTitle" },
            { text: data.from.name, bold: true, fontSize: 10, margin: [0, 4, 0, 0] },
            ...data.from.address.map((line: string) => ({
              text: line, fontSize: 9, color: GRAY_TEXT,
            })),
          ],
        },
        {
          width: "*",
          stack: [
            { text: data.from.email, fontSize: 9, color: GRAY_TEXT, alignment: "center" },
            { text: data.from.phone, fontSize: 9, color: GRAY_TEXT, alignment: "center" },
            { text: data.from.website, fontSize: 9, color: GRAY_TEXT, alignment: "center" },
          ],
        },
        { width: "auto", stack: [logoContent] },
      ],
      margin: [0, 0, 0, 20],
    },

    // Bill To / Ship To
    {
      columns: [
        {
          width: "*",
          stack: [
            { text: "Bill to", bold: true, fontSize: 10, color: DARK_TEXT },
            { text: data.billTo, fontSize: 10, color: DARK_TEXT, margin: [0, 2, 0, 0] },
          ],
          fillColor: LIGHT_BG,
          margin: [10, 8, 10, 8],
        },
        { width: 20, text: "" },
        {
          width: "*",
          stack: [
            { text: "Ship to", bold: true, fontSize: 10, color: DARK_TEXT },
            { text: data.shipTo, fontSize: 10, color: DARK_TEXT, margin: [0, 2, 0, 0] },
          ],
          fillColor: LIGHT_BG,
          margin: [10, 8, 10, 8],
        },
      ],
      margin: [0, 0, 0, 20],
    },

    // Invoice details
    {
      stack: [
        { text: "Invoice details", bold: true, fontSize: 11, color: DARK_TEXT },
        { text: `Invoice no.: ${data.invoiceNumber}`, fontSize: 9, color: DARK_TEXT, margin: [0, 4, 0, 0] },
        { text: `Terms: ${data.terms}`, fontSize: 9, color: DARK_TEXT },
        { text: `Invoice date: ${data.invoiceDate}`, fontSize: 9, color: DARK_TEXT },
        { text: `Due date: ${data.dueDate}`, fontSize: 9, color: DARK_TEXT },
      ],
      margin: [0, 0, 0, 20],
    },

    // Line items table
    {
      table: {
        headerRows: 1,
        widths: [20, 100, "*", 50, 60, 70],
        body: [tableHeader, ...tableRows],
      },
      layout: {
        hLineWidth: (i: number, node: any) =>
          i === 0 || i === 1 || i === node.table.body.length ? 1 : 0,
        vLineWidth: () => 0,
        hLineColor: () => "#D1D5DB",
        paddingTop: () => 6,
        paddingBottom: () => 6,
      },
      margin: [0, 0, 0, 10],
    },

    // Total
    {
      columns: [
        { width: "*", text: "" },
        {
          width: "auto",
          table: {
            body: [
              [
                { text: "Total", bold: true, fontSize: 11, alignment: "right", margin: [0, 0, 20, 0] },
                { text: usd(total), bold: true, fontSize: 16, alignment: "right" },
              ],
            ],
          },
          layout: {
            hLineWidth: (i: number) => (i === 1 ? 2 : 0),
            vLineWidth: () => 0,
            hLineColor: () => BLUE_HEADER,
            paddingTop: () => 4,
            paddingBottom: () => 4,
          },
        },
      ],
    },
  ];

  return {
    content,
    defaultStyle: { font: "Roboto", fontSize: 10, color: DARK_TEXT },
    styles: {
      invoiceTitle: { fontSize: 18, bold: true, color: BLUE_HEADER },
      logo: { fontSize: 28, bold: true, color: DARK_TEXT },
      tableHeader: { fontSize: 9, bold: true, color: GRAY_TEXT },
    },
    pageMargins: [40, 40, 40, 40],
  };
}

// ── Paystub Renderer ──────────────────────────────────

function buildPaystubDoc(data: PaystubData): DocDefinition {
  const deductionRows: TableCell[][] = data.deductions.map((d) => [
    { text: d.label, fontSize: 9 },
    { text: `-${usd(d.amount)}`, fontSize: 9, alignment: "right", color: "#DC2626" },
  ]);

  const employerRows: TableCell[][] = data.employerCosts.map((d) => [
    { text: d.label, fontSize: 9 },
    { text: usd(d.amount), fontSize: 9, alignment: "right" },
  ]);

  const content: Content[] = [
    // Header
    {
      columns: [
        {
          width: "*",
          stack: [
            { text: "PAY STUB", style: "title" },
            { text: data.entity, bold: true, fontSize: 11, margin: [0, 4, 0, 0] },
          ],
        },
        {
          width: "auto",
          stack: [
            { text: `Pay Period: ${data.period}`, fontSize: 10, alignment: "right" },
            { text: `Pay Date: ${data.payDate}`, fontSize: 10, alignment: "right" },
          ],
        },
      ],
      margin: [0, 0, 0, 20],
    },

    // Employee
    {
      table: {
        widths: ["*", "*"],
        body: [
          [
            { text: "Employee", bold: true, fillColor: LIGHT_BG, margin: [4, 4, 4, 4] },
            { text: data.employee, fillColor: LIGHT_BG, margin: [4, 4, 4, 4] },
          ],
        ],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
      margin: [0, 0, 0, 15],
    },

    // Earnings
    { text: "Earnings", bold: true, fontSize: 11, margin: [0, 0, 0, 5] },
    {
      table: {
        widths: ["*", "auto"],
        body: [
          [
            { text: "Gross Pay", fontSize: 9, bold: true },
            { text: usd(data.gross), fontSize: 9, alignment: "right", bold: true },
          ],
        ],
      },
      layout: {
        hLineWidth: (i: number) => (i === 0 || i === 1 ? 1 : 0),
        vLineWidth: () => 0,
        hLineColor: () => "#D1D5DB",
        paddingTop: () => 4,
        paddingBottom: () => 4,
      },
      margin: [0, 0, 0, 15],
    },

    // Deductions
    { text: "Employee Deductions", bold: true, fontSize: 11, margin: [0, 0, 0, 5] },
    {
      table: {
        widths: ["*", "auto"],
        body: [
          ...deductionRows,
          [
            { text: "Total Deductions", fontSize: 9, bold: true },
            {
              text: `-${usd(data.deductions.reduce((s, d) => s + d.amount, 0))}`,
              fontSize: 9, alignment: "right", bold: true, color: "#DC2626",
            },
          ],
        ],
      },
      layout: {
        hLineWidth: (i: number, node: any) =>
          i === 0 || i === node.table.body.length ? 1 : 0,
        vLineWidth: () => 0,
        hLineColor: () => "#D1D5DB",
        paddingTop: () => 4,
        paddingBottom: () => 4,
      },
      margin: [0, 0, 0, 15],
    },

    // Net Pay
    {
      table: {
        widths: ["*", "auto"],
        body: [
          [
            { text: "NET PAY", fontSize: 14, bold: true },
            { text: usd(data.netPay), fontSize: 14, bold: true, alignment: "right", color: "#059669" },
          ],
        ],
      },
      layout: {
        hLineWidth: (i: number) => (i === 0 || i === 1 ? 2 : 0),
        vLineWidth: () => 0,
        hLineColor: () => BLUE_HEADER,
        paddingTop: () => 8,
        paddingBottom: () => 8,
      },
      margin: [0, 0, 0, 20],
    },

    // Employer Taxes
    { text: "Employer Taxes", bold: true, fontSize: 11, color: GRAY_TEXT, margin: [0, 0, 0, 5] },
    {
      table: {
        widths: ["*", "auto"],
        body: [
          ...employerRows,
          [
            { text: "Total Employer Cost", fontSize: 9, bold: true },
            {
              text: usd(data.gross + data.employerCosts.reduce((s, d) => s + d.amount, 0)),
              fontSize: 9, alignment: "right", bold: true,
            },
          ],
        ],
      },
      layout: {
        hLineWidth: (i: number, node: any) =>
          i === 0 || i === node.table.body.length ? 1 : 0,
        vLineWidth: () => 0,
        hLineColor: () => "#D1D5DB",
        paddingTop: () => 4,
        paddingBottom: () => 4,
      },
      margin: [0, 0, 0, 15],
    },

    // YTD
    {
      table: {
        widths: ["*", "auto"],
        body: [
          [
            { text: "Year-to-Date Gross", fontSize: 10, bold: true, fillColor: LIGHT_BG, margin: [4, 4, 4, 4] },
            { text: usd(data.ytdGross), fontSize: 10, alignment: "right", fillColor: LIGHT_BG, margin: [4, 4, 4, 4] },
          ],
        ],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
    },
  ];

  return {
    content,
    defaultStyle: { font: "Roboto", fontSize: 10, color: DARK_TEXT },
    styles: {
      title: { fontSize: 18, bold: true, color: BLUE_HEADER },
    },
    pageMargins: [40, 40, 40, 40],
  };
}

// ── Renderer Class ────────────────────────────────────

export class PdfMakeRenderer implements PdfRenderer {
  async renderInvoice(data: InvoiceData): Promise<Buffer> {
    return pdfToBuffer(buildInvoiceDoc(data));
  }

  async renderPaystub(data: PaystubData): Promise<Buffer> {
    return pdfToBuffer(buildPaystubDoc(data));
  }
}
