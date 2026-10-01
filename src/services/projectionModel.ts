/**
 * The arithmetic behind Financial Projections, kept free of the database so
 * the page runs the same formulas the server does, as the inputs change.
 *
 * The season is always exactly five months, 1 November to 31 March. Labour and
 * other expenses are monthly figures, so over a season they count five times.
 */

export const SEASON_MONTHS = ['Nov', 'Dec', 'Jan', 'Feb', 'Mar'] as const;
export const SEASON_LENGTH = SEASON_MONTHS.length;

export interface Season {
  /** YYYY-MM-DD, always a 1 November. */
  start: string;
  /** YYYY-MM-DD, always the 31 March after it. */
  end: string;
  /** "2026–27" */
  label: string;
}

/**
 * The season a projection is for, given today: the one under way from November
 * to March, and otherwise the next one coming.
 */
export function seasonFor(today: string): Season {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const first = month <= 3 ? year - 1 : year;
  return {
    start: `${first}-11-01`,
    end: `${first + 1}-03-31`,
    label: `${first}–${String(first + 1).slice(-2)}`,
  };
}

/** Money rounded to the cent, so sums of many small figures stay honest. */
export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export interface ContractTerms {
  billing_type: 'monthly' | 'seasonal_upfront';
  discounted_price: number;
  recurring_price: number | null;
  /** Billing periods the contract actually runs for; at most five count. */
  periods: number;
}

/**
 * What one contract brings in, month by month over the season, the way it is
 * billed: a seasonal contract pays once, in November; a monthly one pays the
 * discounted first month, then its recurring price (or the same again) each
 * month after, for as many months as it runs.
 */
export function contractRevenueByMonth(terms: ContractTerms): number[] {
  const months = new Array<number>(SEASON_LENGTH).fill(0);
  if (terms.billing_type === 'seasonal_upfront') {
    months[0] = terms.discounted_price;
    return months;
  }
  const runs = Math.max(1, Math.min(SEASON_LENGTH, terms.periods));
  for (let i = 0; i < runs; i += 1) {
    months[i] = i === 0 || terms.recurring_price === null ? terms.discounted_price : terms.recurring_price;
  }
  return months;
}

export interface ProjectionMonth {
  month: (typeof SEASON_MONTHS)[number];
  revenue: number;
  labor: number;
  cumulative_revenue: number;
  cumulative_labor: number;
  /** Cumulative revenue less cumulative labour: where the season stands so far. */
  cumulative_net: number;
  /** cumulative_net as a share of cumulative revenue; null before any revenue. */
  margin: number | null;
}

export interface BaseProjection {
  months: ProjectionMonth[];
  revenue: number;
  /** Monthly operator salaries × 5. */
  labor: number;
  /** Revenue less labour. */
  net: number;
  margin: number | null;
}

/**
 * The baseline: contracted revenue against operator salaries over the season.
 * `monthlyRevenue` is the five months of revenue, November first.
 */
export function baseProjection(monthlyRevenue: number[], monthlySalaries: number): BaseProjection {
  const salaries = Math.max(0, finite(monthlySalaries));
  let revenueSoFar = 0;
  let laborSoFar = 0;
  const months = SEASON_MONTHS.map((month, i) => {
    const revenue = finite(monthlyRevenue[i] ?? 0);
    revenueSoFar = roundCents(revenueSoFar + revenue);
    laborSoFar = roundCents(laborSoFar + salaries);
    const net = roundCents(revenueSoFar - laborSoFar);
    return {
      month,
      revenue: roundCents(revenue),
      labor: roundCents(salaries),
      cumulative_revenue: revenueSoFar,
      cumulative_labor: laborSoFar,
      cumulative_net: net,
      margin: revenueSoFar > 0 ? net / revenueSoFar : null,
    };
  });
  const revenue = revenueSoFar;
  const labor = roundCents(salaries * SEASON_LENGTH);
  const net = roundCents(revenue - labor);
  return { months, revenue, labor, net, margin: revenue > 0 ? net / revenue : null };
}

export interface ScenarioInput {
  target_customers: number;
  /** Average contract value: revenue per customer for the season. */
  average_contract_value: number;
  /** Percent, 0–100. */
  churn_rate: number;
  /** Collected from each customer who cancels. */
  cancellation_fee: number;
  /** Fuel, equipment, insurance, overhead: everything but operator pay. */
  other_monthly_expenses: number;
  /** Total operator salaries per month. */
  monthly_salaries: number;
}

export interface ScenarioReport {
  effective_customers: number;
  churned_customers: number;
  gross_service_revenue: number;
  cancellation_fee_income: number;
  total_revenue: number;
  /** Operator salaries × 5. */
  total_labor: number;
  /** Other monthly expenses × 5. */
  total_operating: number;
  total_expenses: number;
  /** Net seasonal income by 31 March. */
  net: number;
  /** net as a share of total revenue; null when there is no revenue. */
  margin: number | null;
}

/**
 * The What-If model:
 *   effective   = target × (1 − churn% / 100)
 *   service     = effective × ACV
 *   fees        = (target − effective) × cancellation fee
 *   revenue     = service + fees
 *   expenses    = salaries × 5 + other monthly expenses × 5
 *   net         = revenue − expenses
 */
export function scenarioReport(input: ScenarioInput): ScenarioReport {
  const target = Math.max(0, finite(input.target_customers));
  const churn = Math.min(100, Math.max(0, finite(input.churn_rate)));
  const effective = target * (1 - churn / 100);
  const churned = target - effective;

  const gross = roundCents(effective * finite(input.average_contract_value));
  const fees = roundCents(churned * finite(input.cancellation_fee));
  const totalRevenue = roundCents(gross + fees);
  const labor = roundCents(Math.max(0, finite(input.monthly_salaries)) * SEASON_LENGTH);
  const operating = roundCents(Math.max(0, finite(input.other_monthly_expenses)) * SEASON_LENGTH);
  const expenses = roundCents(labor + operating);
  const net = roundCents(totalRevenue - expenses);

  return {
    effective_customers: effective,
    churned_customers: churned,
    gross_service_revenue: gross,
    cancellation_fee_income: fees,
    total_revenue: totalRevenue,
    total_labor: labor,
    total_operating: operating,
    total_expenses: expenses,
    net,
    margin: totalRevenue > 0 ? net / totalRevenue : null,
  };
}
