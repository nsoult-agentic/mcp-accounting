/**
 * Payroll tax calculation — pure, deterministic logic.
 *
 * Extracted from http.ts so the high-stakes withholding math can be unit
 * tested without booting the HTTP server. No I/O, no side effects.
 */

export const TAX_CONFIG = {
  year: 2026,
  standardDeduction: 16_100,
  federalBrackets: [
    { min: 0, max: 12_400, rate: 0.1 },
    { min: 12_400, max: 50_400, rate: 0.12 },
    { min: 50_400, max: 105_700, rate: 0.22 },
    { min: 105_700, max: 201_775, rate: 0.24 },
    { min: 201_775, max: 256_225, rate: 0.32 },
    { min: 256_225, max: 640_600, rate: 0.35 },
    { min: 640_600, max: Infinity, rate: 0.37 },
  ],
  socialSecurityRate: 0.062,
  socialSecurityWageCap: 184_500,
  medicareRate: 0.0145,
  medicareAdditionalRate: 0.009,
  medicareAdditionalThreshold: 200_000,
  stateWithholding: 0,
  employerSocialSecurityRate: 0.062,
  employerMedicareRate: 0.0145,
  futaRate: 0.006,
  futaWageCap: 7_000,
};

export interface PayrollResult {
  grossPay: number;
  federalWithholding: number;
  socialSecurity: number;
  medicare: number;
  stateWithholding: number;
  totalDeductions: number;
  netPay: number;
  employerSocialSecurity: number;
  employerMedicare: number;
  employerFUTA: number;
  totalEmployerCost: number;
  ytdGross: number;
}

export function calculatePayroll(monthlySalary: number, month: number): PayrollResult {
  const ytdGross = monthlySalary * month;
  const priorYtdGross = monthlySalary * (month - 1);

  const annualGross = monthlySalary * 12;
  const annualTaxable = Math.max(0, annualGross - TAX_CONFIG.standardDeduction);
  let annualFederalTax = 0;
  let remaining = annualTaxable;
  for (const bracket of TAX_CONFIG.federalBrackets) {
    const taxableInBracket = Math.min(remaining, bracket.max - bracket.min);
    if (taxableInBracket <= 0) break;
    annualFederalTax += taxableInBracket * bracket.rate;
    remaining -= taxableInBracket;
  }
  const federalWithholding = annualFederalTax / 12;

  const ssThisMonth =
    priorYtdGross < TAX_CONFIG.socialSecurityWageCap
      ? Math.min(monthlySalary, TAX_CONFIG.socialSecurityWageCap - priorYtdGross) *
        TAX_CONFIG.socialSecurityRate
      : 0;

  let medicare = monthlySalary * TAX_CONFIG.medicareRate;
  if (ytdGross > TAX_CONFIG.medicareAdditionalThreshold) {
    const additionalBase = Math.min(
      monthlySalary,
      ytdGross - TAX_CONFIG.medicareAdditionalThreshold,
    );
    if (additionalBase > 0) {
      medicare += additionalBase * TAX_CONFIG.medicareAdditionalRate;
    }
  }

  const stateWithholding = TAX_CONFIG.stateWithholding;
  const totalDeductions = federalWithholding + ssThisMonth + medicare + stateWithholding;
  const netPay = monthlySalary - totalDeductions;

  const employerSS =
    priorYtdGross < TAX_CONFIG.socialSecurityWageCap
      ? Math.min(monthlySalary, TAX_CONFIG.socialSecurityWageCap - priorYtdGross) *
        TAX_CONFIG.employerSocialSecurityRate
      : 0;
  const employerMedicare = monthlySalary * TAX_CONFIG.employerMedicareRate;
  const employerFUTA =
    priorYtdGross < TAX_CONFIG.futaWageCap
      ? Math.min(monthlySalary, TAX_CONFIG.futaWageCap - priorYtdGross) * TAX_CONFIG.futaRate
      : 0;

  return {
    grossPay: monthlySalary,
    federalWithholding: Math.round(federalWithholding * 100) / 100,
    socialSecurity: Math.round(ssThisMonth * 100) / 100,
    medicare: Math.round(medicare * 100) / 100,
    stateWithholding,
    totalDeductions: Math.round(totalDeductions * 100) / 100,
    netPay: Math.round(netPay * 100) / 100,
    employerSocialSecurity: Math.round(employerSS * 100) / 100,
    employerMedicare: Math.round(employerMedicare * 100) / 100,
    employerFUTA: Math.round(employerFUTA * 100) / 100,
    totalEmployerCost:
      Math.round((monthlySalary + employerSS + employerMedicare + employerFUTA) * 100) / 100,
    ytdGross,
  };
}
