import type { Knex } from 'knex';
import { config } from '../../config';
import { hashPassword } from '../../services/auth';

/**
 * Development data. Wipes the tables it owns and re-inserts a known set, so it
 * is safe to run repeatedly. Refuses to run against NODE_ENV=production.
 */
export async function seed(knex: Knex): Promise<void> {
  if (config.isProduction) {
    throw new Error('Refusing to run seeds with NODE_ENV=production');
  }

  await knex('inspections').del();
  await knex('payments').del();
  await knex('contracts').del();
  await knex('jobs').del();
  await knex('customers').del();
  await knex('users').del();
  await knex('branches').del();

  const branches = await knex('branches')
    .insert([
      { name: 'North Shore', region: 'North' },
      { name: 'Downtown', region: 'Central' },
    ])
    .returning(['id', 'name']);

  const north = branches.find((b) => b.name === 'North Shore');
  const downtown = branches.find((b) => b.name === 'Downtown');
  if (!north || !downtown) {
    throw new Error('Branch seed failed');
  }

  const password_hash = await hashPassword(config.seed.password);

  const users = await knex('users')
    .insert([
      {
        email: 'admin@avcrm.test',
        password_hash,
        name: 'Ada Admin',
        role: 'admin',
        branch_id: north.id,
      },
      {
        email: 'manager.north@avcrm.test',
        password_hash,
        name: 'Marty Manager',
        role: 'manager',
        branch_id: north.id,
      },
      {
        email: 'dispatch.north@avcrm.test',
        password_hash,
        name: 'Dana Dispatcher',
        role: 'dispatcher',
        branch_id: north.id,
      },
      {
        email: 'operator.north@avcrm.test',
        password_hash,
        name: 'Otto Operator',
        role: 'operator',
        branch_id: north.id,
      },
      {
        email: 'manager.downtown@avcrm.test',
        password_hash,
        name: 'Dee Downtown',
        role: 'manager',
        branch_id: downtown.id,
      },
    ])
    .returning(['id', 'email']);

  const operator = users.find((u) => u.email === 'operator.north@avcrm.test');
  if (!operator) {
    throw new Error('User seed failed');
  }

  const customers = await knex('customers')
    .insert([
      {
        branch_id: north.id,
        name: 'Birchwood Medical Plaza',
        phone: '902-555-0117',
        address: '18 Birchwood Ave, Bedford',
        email: 'facilities@birchwoodplaza.test',
        contract_status: 'active',
      },
      {
        branch_id: north.id,
        name: 'Harbour Ridge Condos',
        phone: '902-555-0142',
        address: '400 Harbour Ridge Rd, Halifax',
        email: 'board@harbourridge.test',
        contract_status: 'active',
      },
      {
        branch_id: north.id,
        name: 'Sackville Auto Group',
        phone: '902-555-0188',
        address: '95 Sackville Dr, Lower Sackville',
        email: 'ops@sackvilleauto.test',
        contract_status: 'pending',
      },
      {
        branch_id: north.id,
        name: 'Fall River Storage',
        phone: '902-555-0163',
        address: '2200 Fall River Rd, Fall River',
        email: null,
        contract_status: 'none',
      },
      {
        branch_id: downtown.id,
        name: 'Granville Retail Block',
        phone: '902-555-0104',
        address: '1601 Granville St, Halifax',
        email: 'property@granvilleblock.test',
        contract_status: 'active',
      },
    ])
    .returning(['id', 'name', 'branch_id']);

  const byName = (name: string) => {
    const found = customers.find((c) => c.name === name);
    if (!found) throw new Error(`Customer seed failed: ${name}`);
    return found;
  };

  const birchwood = byName('Birchwood Medical Plaza');
  const harbour = byName('Harbour Ridge Condos');
  const granville = byName('Granville Retail Block');

  const day = (offset: number) => {
    const d = new Date();
    d.setUTCHours(6, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + offset);
    return d;
  };

  const jobs = await knex('jobs')
    .insert([
      {
        customer_id: birchwood.id,
        branch_id: north.id,
        status: 'completed',
        scheduled_date: day(-2),
        completed_date: day(-2),
        notes: 'Full lot plow plus salt. 8cm overnight.',
      },
      {
        customer_id: birchwood.id,
        branch_id: north.id,
        status: 'scheduled',
        scheduled_date: day(1),
        completed_date: null,
        notes: 'Salt only unless accumulation exceeds 2cm.',
      },
      {
        customer_id: harbour.id,
        branch_id: north.id,
        status: 'in_progress',
        scheduled_date: day(0),
        completed_date: null,
        notes: 'Visitor lot first, then the ramp.',
      },
      {
        customer_id: harbour.id,
        branch_id: north.id,
        status: 'cancelled',
        scheduled_date: day(-1),
        completed_date: null,
        notes: 'Called off, storm tracked south.',
      },
      {
        customer_id: granville.id,
        branch_id: downtown.id,
        status: 'scheduled',
        scheduled_date: day(1),
        completed_date: null,
        notes: 'Sidewalk crew, 04:00 start.',
      },
    ])
    .returning(['id', 'status']);

  const completedJob = jobs.find((j) => j.status === 'completed');
  if (!completedJob) {
    throw new Error('Job seed failed');
  }

  const season = (year: number) => ({
    start_date: `${year}-11-01`,
    end_date: `${year + 1}-04-30`,
  });

  await knex('contracts').insert([
    {
      customer_id: birchwood.id,
      price: '18500.00',
      ...season(2025),
      auto_renew: true,
      terms: 'Seasonal flat rate. 24h response, unlimited visits.',
    },
    {
      customer_id: harbour.id,
      price: '12750.00',
      ...season(2025),
      auto_renew: false,
      terms: 'Seasonal flat rate. Sidewalks included, no roof clearing.',
    },
    {
      customer_id: granville.id,
      price: '9400.00',
      ...season(2025),
      auto_renew: true,
      terms: 'Per-event billing capped at 30 events.',
    },
  ]);

  await knex('payments').insert([
    {
      customer_id: birchwood.id,
      amount: '9250.00',
      status: 'succeeded',
      method: 'ach',
      reference: 'mock_ch_seed0000000000000001',
      date: day(-30),
    },
    {
      customer_id: harbour.id,
      amount: '6375.00',
      status: 'succeeded',
      method: 'card',
      reference: 'mock_ch_seed0000000000000002',
      date: day(-25),
    },
    {
      customer_id: granville.id,
      amount: '4700.00',
      status: 'pending',
      method: 'check',
      reference: null,
      date: day(-3),
    },
  ]);

  await knex('inspections').insert([
    {
      job_id: completedJob.id,
      timestamp: day(-2),
      photo_url: 'https://example.test/mock/inspections/birchwood-lot.jpg',
      notes: 'Lot clear, salt applied at entrances and the loading bay.',
      operator_id: operator.id,
    },
  ]);
}
