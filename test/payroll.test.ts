import { describe, test, expect } from "bun:test";

import { calculatePayroll, TAX_CONFIG } from "../src/payroll.js";

// Expected values below are computed BY HAND from the 2026 brackets in
// TAX_CONFIG — not by re-running the implementation — so a logic regression
// (e.g. a wrong bracket or rate) is actually caught rather than mirrored.

describe("calculatePayroll — golden case ($10,000/mo, month 1)", () => {
  const r = calculatePayroll(10_000, 1);

  // Annual taxable = 120,000 - 16,100 = 103,900.
  // Fed tax = 12,400*.10 + 38,000*.12 + 53,500*.22
  //         = 1,240 + 4,560 + 11,770 = 17,570  →  /12 = 1,464.1666… → 1,464.17
  test("federal withholding (progressive brackets)", () => {
    expect(r.federalWithholding).toBe(1_464.17);
  });

  test("social security = 6.2% of salary below wage cap", () => {
    expect(r.socialSecurity).toBe(620.0); // 10,000 * 0.062
  });

  test("medicare = 1.45% with no additional below $200k YTD", () => {
    expect(r.medicare).toBe(145.0); // 10,000 * 0.0145
  });

  test("state withholding is zero", () => {
    expect(r.stateWithholding).toBe(0);
  });

  test("total deductions and net pay", () => {
    expect(r.totalDeductions).toBe(2_229.17); // 1,464.1666 + 620 + 145
    expect(r.netPay).toBe(7_770.83); // 10,000 - 2,229.1666
  });

  test("employer-side taxes", () => {
    expect(r.employerSocialSecurity).toBe(620.0);
    expect(r.employerMedicare).toBe(145.0);
    expect(r.employerFUTA).toBe(42.0); // 7,000 wage base * 0.006
    expect(r.totalEmployerCost).toBe(10_807.0); // 10,000 + 620 + 145 + 42
  });

  test("ytd gross", () => {
    expect(r.ytdGross).toBe(10_000);
  });
});

describe("Social Security wage cap ($184,500)", () => {
  test("partial SS in the month earnings cross the cap", () => {
    // $50k/mo, month 4: prior YTD = 150,000; only 34,500 of this month is
    // still under the 184,500 cap → 34,500 * 0.062 = 2,139.00
    const r = calculatePayroll(50_000, 4);
    expect(r.socialSecurity).toBe(2_139.0);
    expect(r.employerSocialSecurity).toBe(2_139.0);
  });

  test("no SS once prior YTD already exceeds the cap", () => {
    // $50k/mo, month 5: prior YTD = 200,000 > 184,500 → SS = 0
    const r = calculatePayroll(50_000, 5);
    expect(r.socialSecurity).toBe(0);
    expect(r.employerSocialSecurity).toBe(0);
  });
});

describe("FUTA wage base ($7,000)", () => {
  test("charged on the first $7,000 in month 1", () => {
    const r = calculatePayroll(10_000, 1);
    expect(r.employerFUTA).toBe(42.0); // 7,000 * 0.006
  });

  test("zero once the wage base is exhausted", () => {
    // month 2: prior YTD = 10,000 > 7,000 → no FUTA left
    const r = calculatePayroll(10_000, 2);
    expect(r.employerFUTA).toBe(0);
  });
});

describe("Additional Medicare (0.9% above $200k YTD)", () => {
  test("not applied at exactly the threshold", () => {
    // $50k/mo, month 4: YTD = 200,000 (not > 200,000) → plain 1.45%
    const r = calculatePayroll(50_000, 4);
    expect(r.medicare).toBe(725.0); // 50,000 * 0.0145
  });

  test("applied to the portion of YTD above the threshold", () => {
    // $50k/mo, month 5: YTD = 250,000; whole 50,000 is above 200,000
    // 50,000 * 0.0145 + 50,000 * 0.009 = 725 + 450 = 1,175.00
    const r = calculatePayroll(50_000, 5);
    expect(r.medicare).toBe(1_175.0);
  });
});

describe("invariants", () => {
  for (const [salary, month] of [
    [10_000, 1],
    [50_000, 5],
    [3_000, 7],
    [184_500, 1],
  ] as const) {
    test(`net + deductions ≈ gross ($${salary}/mo, m${month})`, () => {
      const r = calculatePayroll(salary, month);
      // independent per-field rounding can drift by at most a cent
      expect(Math.abs(r.netPay + r.totalDeductions - r.grossPay)).toBeLessThanOrEqual(0.01);
    });

    test(`all money fields rounded to ≤2 decimals ($${salary}/mo, m${month})`, () => {
      const r = calculatePayroll(salary, month);
      for (const v of [
        r.federalWithholding,
        r.socialSecurity,
        r.medicare,
        r.totalDeductions,
        r.netPay,
        r.employerSocialSecurity,
        r.employerMedicare,
        r.employerFUTA,
        r.totalEmployerCost,
      ]) {
        expect(Math.round(v * 100) / 100).toBe(v);
      }
    });
  }
});

describe("TAX_CONFIG sanity", () => {
  test("federal brackets are contiguous and ascending", () => {
    const b = TAX_CONFIG.federalBrackets;
    for (let i = 1; i < b.length; i++) {
      expect(b[i]!.min).toBe(b[i - 1]!.max);
    }
    expect(b[0]!.min).toBe(0);
    expect(b[b.length - 1]!.max).toBe(Infinity);
  });
});
