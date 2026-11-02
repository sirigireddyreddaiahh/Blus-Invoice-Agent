namespace ap;

using { cuid, managed } from '@sap/cds/common';

// One row per invoice check run (upload or S/4HANA extract).
entity Checks : cuid, managed {
  source        : String(10);
  fileName      : String(255);
  supplierName  : String(120);
  supplierGstin : String(15);
  invoiceNo     : String(60);
  invoiceDate   : Date;
  total         : Decimal(15,2);
  status        : String(10);   // REJECT | HOLD | FLAG | PASS
  resultJson    : LargeString;
  results       : Composition of many CheckResults on results.check = $self;
}

// One row per rule per check: all rules, including PASS and DISABLED.
entity CheckResults : cuid {
  check   : Association to Checks;
  ruleId  : String(20);
  title   : String(120);
  tier    : String(10);
  text    : String(1000);
}

// One row per REJECT, HOLD or FLAG. This is the review queue.
entity Alerts : cuid, managed {
  check     : Association to Checks;
  ruleId    : String(20);
  title     : String(120);
  tier      : String(10);
  text      : String(1000);
  decision  : String(12);   // OPEN | CLEAR | CONFIRM | ESCALATE
  comment   : String(1000);
  decidedBy : String(100);
  decidedAt : String(30);
}

// Ledger of invoices that passed, or were posted with a payment block.
entity Posted : cuid {
  invoiceNo     : String(60);
  supplierGstin : String(15);
  invoiceDate   : Date;
  total         : Decimal(15,2);
  description   : String(255);
  irn           : String(64);
  blocked       : Boolean;
  recurringPo   : Boolean;
  postedAt      : String(30);
}

// Hash-chained audit trail. ts and hashes are strings so the chain can be re-verified exactly.
entity AuditLog {
  key idx    : Integer;
  ts         : String(30);
  action     : String(40);
  checkId    : String(36);
  detail     : String(1000);
  prevHash   : String(64);
  hash       : String(64);
}
