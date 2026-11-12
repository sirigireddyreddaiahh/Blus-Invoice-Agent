using { ap } from '../db/schema';

service FraudService @(path: '/fraud') {
  @readonly entity Checks as projection on ap.Checks;
  @readonly entity CheckResults as projection on ap.CheckResults;
  entity Alerts as projection on ap.Alerts actions {
    action decide(decision: String, comment: String) returns String;
  };
  @readonly entity Posted as projection on ap.Posted;
  @readonly entity AuditLog as projection on ap.AuditLog;
  @readonly entity Jobs as projection on ap.Jobs;

  function whoami() returns String;
  function fetchS4Invoices() returns String;
  function testSapConnection(reference: String) returns String;
  action fetchFromSapNow(top: Integer, reference: String, runCheck: Boolean) returns String;
  function verifyAuditChain() returns String;
  function getJob(jobId: String) returns String;

  action importS4Extract(fileName: String, content: String) returns String;
  action importToLedger(fileName: String, content: String) returns String;
  function searchDatabase(query: String) returns String;
  action extractPdf(fileName: String, pdfBase64: String) returns String;
  action uploadDocument(fileName: String, fileSize: Integer, fileBase64: String, source: String) returns String;
  action chatCheckInvoice(fileName: String, fileSize: Integer, fileBase64: String) returns String;
  action checkInvoice(invoice: String) returns String;
  action checkBatch(invoices: String, sync: Boolean, errors: String, fileName: String) returns String;
  action createBatchJob(invoices: String, errors: String) returns String;
  action uploadBatchDocuments(files: String) returns String;
  action cancelJob(jobId: String) returns String;
  action resumeJob(jobId: String) returns String;
  action postInvoice(invoice: String) returns String;
  action postToLedger(invoiceNo: String, supplierName: String, supplierGstin: String, invoiceDate: String, postingDate: String, total: Decimal, fiscalYear: String) returns String;
  action decideAlert(alertId: String, decision: String, comment: String) returns String;

  // Server-side paginated queries & summary
  function getSummary() returns String;
  function getLedger(page: Integer, limit: Integer, search: String) returns String;
  function getS4Results(jobId: String, page: Integer, limit: Integer, status: String, search: String) returns String;
  function getReviewQueue(page: Integer, limit: Integer, status: String) returns String;
  function getCheckHistory(page: Integer, limit: Integer, status: String, fromDate: String, toDate: String, supplier: String) returns String;
  function getActivityLogs(page: Integer, limit: Integer, action: String) returns String;

  // Read-only server-side AI Assistant actions
  action chat(message: String, checkId: String) returns String;
  action askInvoice(checkId: String, question: String) returns String;
}

