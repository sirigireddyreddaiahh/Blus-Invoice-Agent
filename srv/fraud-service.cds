using { ap } from '../db/schema';

service FraudService @(path: '/fraud') {
  @readonly entity Checks as projection on ap.Checks;
  @readonly entity CheckResults as projection on ap.CheckResults;
  entity Alerts as projection on ap.Alerts actions {
    action decide(decision: String, comment: String) returns String;
  };
  @readonly entity Posted as projection on ap.Posted;
  @readonly entity AuditLog as projection on ap.AuditLog;

  function whoami() returns String;
  function fetchS4Invoices() returns String;
  function verifyAuditChain() returns String;

  action importS4Extract(fileName: String, content: String) returns String;
  action extractPdf(fileName: String, pdfBase64: String) returns String;
  action uploadDocument(fileName: String, fileSize: Integer, fileBase64: String, source: String) returns String;
  action chatCheckInvoice(fileName: String, fileSize: Integer, fileBase64: String) returns String;
  action checkInvoice(invoice: String) returns String;
  action checkBatch(invoices: String) returns String;
  action postInvoice(invoice: String) returns String;
  action decideAlert(alertId: String, decision: String, comment: String) returns String;

  // Read-only server-side AI Assistant actions
  action chat(message: String, checkId: String) returns String;
  action askInvoice(checkId: String, question: String) returns String;
}
