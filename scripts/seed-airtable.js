/**
 * Seed / update Customers and Claims in Airtable.
 *
 * dob_last4 = last 4 digits of date of birth (MMDDYYYY format → birth year).
 * Demo verification: caller says "one nine eight five" for dob_last4 "1985".
 *
 * Usage: node scripts/seed-airtable.js
 */

require('dotenv').config();
const Airtable = require('airtable');

const base = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN })
  .base(process.env.AIRTABLE_BASE_ID);

// ─── Customer updates (fix dob_last4 to birth-year values) ───────────────────
const CUSTOMER_UPDATES = [
  { customer_id: 'CUST001', dob_last4: '1985', note: 'DOB 04/12/1985' },
  { customer_id: 'CUST002', dob_last4: '1990', note: 'DOB 08/03/1990' },
  { customer_id: 'CUST003', dob_last4: '1992', note: 'DOB 11/25/1992' },
  { customer_id: 'CUST004', dob_last4: '1990', note: 'DOB 09/09/1990' },
];

// ─── New customers ───────────────────────────────────────────────────────────
const NEW_CUSTOMERS = [
  {
    customer_id: 'CUST005',
    first_name: 'David',
    last_name: 'Chen',
    phone: '14155550102',
    dob_last4: '1998',
  },
  {
    customer_id: 'CUST006',
    first_name: 'Sarah',
    last_name: 'Miller',
    phone: '16505550103',
    dob_last4: '2001',
  },
  {
    customer_id: 'CUST007',
    first_name: 'Robert',
    last_name: 'Taylor',
    phone: '18185550104',
    dob_last4: '1978',
  },
  {
    customer_id: 'CUST008',
    first_name: 'Emily',
    last_name: 'Davis',
    phone: '17135550105',
    dob_last4: '1988',
  },
  {
    customer_id: 'CUST009',
    first_name: 'Michael',
    last_name: 'Johnson',
    phone: '19175550106',
    dob_last4: '1995',
  },
  {
    customer_id: 'CUST010',
    first_name: 'Priya',
    last_name: 'Patel',
    phone: '14045550107',
    dob_last4: '2003',
  },
];

// ─── New claims (varied conditions for demo) ─────────────────────────────────
const NEW_CLAIMS = [
  {
    claim_id: 'CLM-006',
    customer_id: 'CUST005',
    type: 'Auto',
    status: 'Under Review',
    status_detail:
      'Your collision claim is under review. A field adjuster will contact you within 48 hours to schedule a damage assessment.',
    docs_required: false,
    last_updated: '2026-06-29',
  },
  {
    claim_id: 'CLM-007',
    customer_id: 'CUST006',
    type: 'Home',
    status: 'Pending Documents',
    status_detail:
      'We received your water damage claim but still need documentation before we can assign an adjuster.',
    docs_required: true,
    docs_list: ['Photos of damage', 'Proof of loss form', 'Contractor estimate'],
    last_updated: '2026-06-27',
  },
  {
    claim_id: 'CLM-008',
    customer_id: 'CUST006',
    type: 'Auto',
    status: 'Under Review',
    status_detail:
      'Your auto claim is in the initial review stage. No action is needed from you at this time.',
    docs_required: false,
    last_updated: '2026-06-26',
  },
  {
    claim_id: 'CLM-009',
    customer_id: 'CUST007',
    type: 'Home',
    status: 'Approved',
    status_detail:
      'Your home insurance claim has been approved. Repair reimbursement will be issued within 5 business days.',
    docs_required: false,
    last_updated: '2026-06-24',
  },
  {
    claim_id: 'CLM-010',
    customer_id: 'CUST008',
    type: 'Auto',
    status: 'Pending Documents',
    status_detail:
      'Your claim is on hold until we receive the police report and repair estimates from your body shop.',
    docs_required: true,
    docs_list: ['Photos of damage', 'Proof of loss form', 'Contractor estimate'],
    last_updated: '2026-06-23',
  },
  {
    claim_id: 'CLM-011',
    customer_id: 'CUST009',
    type: 'Life',
    status: 'Under Review',
    status_detail:
      'Your beneficiary claim is being reviewed by our life insurance team. Processing typically takes 10-15 business days.',
    docs_required: false,
    last_updated: '2026-06-21',
  },
  {
    claim_id: 'CLM-012',
    customer_id: 'CUST010',
    type: 'Auto',
    status: 'Approved',
    status_detail:
      'Your auto claim was approved after inspection. Your payment has been scheduled for this week.',
    docs_required: false,
    last_updated: '2026-06-30',
  },
  {
    claim_id: 'CLM-013',
    customer_id: 'CUST010',
    type: 'Home',
    status: 'Under Review',
    status_detail:
      'A home adjuster has been assigned to evaluate roof damage from the recent storm. Inspection is scheduled within 7 days.',
    docs_required: false,
    last_updated: '2026-06-28',
  },
];

// Fix incomplete CLM-004
const CLAIM_PATCHES = [
  {
    claim_id: 'CLM-004',
    status_detail:
      'Your life insurance claim is under review. Our team is verifying beneficiary documentation.',
    status: 'Under Review',
    type: 'Life',
    customer_id: 'CUST003',
    last_updated: '2026-06-25',
  },
];

async function findCustomerRecord(customer_id) {
  const records = await base('Customers')
    .select({ filterByFormula: `{customer_id} = "${customer_id}"`, maxRecords: 1 })
    .firstPage();
  return records[0] || null;
}

async function findClaimRecord(claim_id) {
  const records = await base('Claims')
    .select({ filterByFormula: `{claim_id} = "${claim_id}"`, maxRecords: 1 })
    .firstPage();
  return records[0] || null;
}

async function main() {
  console.log('Updating existing customer DOB values...\n');
  for (const u of CUSTOMER_UPDATES) {
    const rec = await findCustomerRecord(u.customer_id);
    if (!rec) {
      console.log(`  SKIP ${u.customer_id} — not found`);
      continue;
    }
    await base('Customers').update(rec.id, { dob_last4: u.dob_last4 });
    console.log(`  ✓ ${u.customer_id} dob_last4 → ${u.dob_last4} (${u.note})`);
  }

  console.log('\nCreating new customers...\n');
  for (const c of NEW_CUSTOMERS) {
    const existing = await findCustomerRecord(c.customer_id);
    if (existing) {
      await base('Customers').update(existing.id, c);
      console.log(`  ✓ ${c.customer_id} updated (${c.first_name} ${c.last_name})`);
    } else {
      await base('Customers').create([{ fields: c }]);
      console.log(`  ✓ ${c.customer_id} created (${c.first_name} ${c.last_name})`);
    }
  }

  console.log('\nPatching incomplete claims...\n');
  for (const patch of CLAIM_PATCHES) {
    const { claim_id, ...fields } = patch;
    const rec = await findClaimRecord(claim_id);
    if (!rec) {
      console.log(`  SKIP ${claim_id} — not found`);
      continue;
    }
    await base('Claims').update(rec.id, fields);
    console.log(`  ✓ ${claim_id} patched`);
  }

  console.log('\nCreating new claims...\n');
  for (const cl of NEW_CLAIMS) {
    const existing = await findClaimRecord(cl.claim_id);
    if (existing) {
      await base('Claims').update(existing.id, cl);
      console.log(`  ✓ ${cl.claim_id} updated (${cl.status})`);
    } else {
      await base('Claims').create([{ fields: cl }]);
      console.log(`  ✓ ${cl.claim_id} created (${cl.status})`);
    }
  }

  console.log('\n─── Demo quick reference ───');
  console.log('Phone (say aloud)     | Name           | DOB last-4 (say aloud)');
  console.log('----------------------|----------------|------------------------');
  const all = [
    ['617-934-9090', 'Jibin Baby', '1990', 'CUST004', '1 auto Under Review'],
    ['212-555-0101', 'Maria Gonzalez', '1985', 'CUST001', '2 claims — multi disambiguation'],
    ['310-555-0192', 'James Park', '1990', 'CUST002', '1 auto Approved'],
    ['718-555-0134', 'Aisha Khan', '1992', 'CUST003', '1 life Under Review'],
    ['415-555-0102', 'David Chen', '1998', 'CUST005', '1 auto Under Review'],
    ['650-555-0103', 'Sarah Miller', '2001', 'CUST006', '2 claims — Home pending docs + Auto'],
    ['818-555-0104', 'Robert Taylor', '1978', 'CUST007', '1 home Approved'],
    ['713-555-0105', 'Emily Davis', '1988', 'CUST008', '1 auto Pending Documents'],
    ['917-555-0106', 'Michael Johnson', '1995', 'CUST009', '1 life Under Review'],
    ['404-555-0107', 'Priya Patel', '2003', 'CUST010', '2 claims — Auto approved + Home review'],
  ];
  for (const [phone, name, dob, id, scenario] of all) {
    console.log(`${phone.padEnd(21)} | ${name.padEnd(14)} | ${dob}  (${id}: ${scenario})`);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Seed failed:', err.message, err.error || '');
  process.exit(1);
});
